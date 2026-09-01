# dsh-docker

Typed, guarded container control for DSH — structured Docker access that is hard to destroy by accident.

`dsh-docker` is a plugin bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It wraps the `docker` CLI through DSH's `ctx.shell` seam and gives your agent a **typed, project-aware, guarded** surface for containers and compose stacks — every tool returns structured JSON (`await tools.docker_ps(...)` gets real objects, never scraped prose), destructive operations require **human sign-off through the approval gate**, and `stop dev-api` means *your* local compose service, not a coincidentally-named container on the machine.

```
┌──────────────┐   docker ps --format json    ┌──────────────┐
│  agent tool  │ ───────────────────────────▶ │  ctx.shell   │ ──▶ docker CLI
│  call        │                              │  (sandbox/   │
└──────┬───────┘                              │   remote)    │
       │ classify()                           └──────────────┘
       ▼
┌──────────────┐   destructive?  ┌──────────────────────┐
│ pre-execute  │ ──────────────▶ │ approval gate         │  allowed-once → run
│ policy       │  (guarded)      │ (ctx.approval,        │  rejected/unavailable
└──────┬───────┘                 │  fails closed)        │  → refused
       │ safe / token recorded   └──────────────────────┘
       ▼
┌──────────────┐   hard-destructive without a token? → refused (monotonic)
│ ctx.tools    │
│ .guard()     │   backstop: no later listener can undo a denial
└──────────────┘
```

## Flagship demo — debug a failing integration test

Your agent runs a failing test against `docker-compose.yml`:

```
$ docker_ps            → { containers: [{ name: "app-api-1", state: "running", ... }] }
$ docker_logs { container: "app-api-1", tail: 200 }
  → { lines: [...], truncated: true }        # capped pull never reads as complete
$ docker_compose_ps   → { project: "app", services: [{ name: "db", state: "running" }] }
```

The agent *reads* freely. The moment it tries something destructive — `docker_rm -f` on the running API container, `docker_rmi` on an image a container still uses, `docker system prune -a`, or `docker compose down -v` — the call is paused and routed to the human approval gate:

```
⏸ docker_rmi "app-api:latest" — image in use by container app-api-1
   [approve]  [reject]
```

No approval channel, or a denied request? The operation is **refused**. `execReadOnly` is on by default, so `docker_exec` without `write`/`interactive` never prompts, and a writeful exec is treated as destructive. And even if some other plugin's policy said "allow", the monotonic guard still refuses the hard-destructive set unless this call carries the dsh-docker approval token.

## Install

```console
# From the npm registry once published, or straight from this repository:
dsh plugin --profile web add @dsh-docker/bundle          # npm (when published)
dsh plugin --profile web add github:Jesse-njx/dsh-docker  # or: straight from GitHub
```

Install into whatever profile your agents run under (`web` for the desktop UI, `headless` for CLI sessions). The bundle mounts the tools, the policy, the opt-in health context, and the web status renderer.

## Tools

Every tool is a `defineTool` with typed parameters and a structured output schema — Code Mode sees `await tools.<name>(...)` returning the canonical JSON value, never rendered prose.

### Containers

| Tool | Output | Notes |
| --- | --- | --- |
| `docker_ps` | `{ containers: [{ id, name, image, state, status, ports[], project?, service? }] }` | `--all` flag; scoped to the detected compose project by default |
| `docker_logs` | `{ lines: string[], truncated }` | bounded pull (`tail`, default 200, cap 5000); pulls `tail+1` so `truncated` is honest |
| `docker_inspect` | raw engine JSON (open object) | the adapter — engine-native structure, validated |
| `docker_exec` | `{ exitCode, stdout, stderr }` | read-only by default (no TTY); `write`/`interactive` reclassifies into the approval bucket |
| `docker_start` / `docker_stop` / `docker_restart` | `{ affected: string[] }` | one ref, or the whole detected project with no ref |
| `docker_rm` | `{ affected: string[] }` | **guarded** when the target is running or `force` is set |

### Images

| Tool | Output | Notes |
| --- | --- | --- |
| `docker_images` | `{ images: [{ id, repository, tag, size, inUse }] }` | `inUse` from a `docker ps -a` cross-reference |
| `docker_rmi` | `{ removed: string[] }` | **guarded** when the image is in use |
| `docker_prune` | `{ scope, all, volumes, ok }` | **guarded** for `--all`, `--volumes`, or system scope |

### Compose

| Tool | Output | Notes |
| --- | --- | --- |
| `docker_compose_up` | `{ project, services, detached }` | detached by default; optional `services[]` |
| `docker_compose_down` | `{ project, affected, volumes }` | **guarded** when `volumes: true` (the `-v` flag) |
| `docker_compose_ps` | `{ project, services: [{ name, id, state, status, ports }] }` | one read builds the health context |

## Project-aware targeting

Every tool resolves the compose project once per call (a pure, unit-tested `ProjectResolver`):

1. Walk up from the tool's working directory for the first `composeFiles` match (`docker-compose.yml`, `compose.yaml`, config-ordered).
2. Derive the project name (directory basename, lowercased) and pass `-p <project> -f <file>` to every compose call; `docker_ps`/`start`/`stop` default filters scope to `--filter label=com.docker.compose.project=<project>`.
3. Every tool accepts an explicit `project: string` override; with no compose file and no override, container-scoped tools operate globally but the project-aware behaviors are off.

A bare container name resolves within the project first, falling back to a global match only when unambiguous. Ambiguous refs return an error listing candidates instead of guessing.

## Guardrails

Two layers, both in the tools pipeline:

- **`tools/pre-execute` policy** — `classify(toolName, args, resolved)` (a pure function, unit-tested without a daemon) judges each call's intended effect. Guarded ops route a one-shot approval request through `ctx.approval` (`approval/request` waterfall); approval absent fails **closed** to `unavailable` ⇒ refused. A guarded op not covered by the configured `approval` globs is refused outright.
- **`ctx.tools.guard()` backstop** — a monotonic deny that a later listener cannot undo. Even if another plugin's pre-execute said "allow", the guard refuses the hard-destructive set unless this call carries the dsh-docker approval token.

Read-only `docker_exec` is free by default; `execReadOnly: false` flips that for operators who accept the risk.

## Service-health context (opt-in)

```yaml
plugins:
  dsh-docker:
    healthContext: { enabled: true, maxServices: 12 }
```

When enabled, each pre-step injects one compact line per detected compose service — `dev-api ▲up  dev-db ▲up  worker ▼exited(1)` — as durable appended context the **next** model request sees (not a wake-up). Built from a single `docker_compose_ps` read, TTL-cached, capped at `maxServices`, and skipped entirely when no compose project is detected.

## Status renderer (web client)

The client half registers a replayable conversation node for `docker_ps` / `docker_compose_ps` / `docker_logs` output: one stable node per tool call (keyed by `callId`), a **table collapsed by default** and expandable on click, with a log pane whose `truncated` flag is surfaced so a capped pull never reads as complete. Replay-safe: the renderer consumes only the durable `tool/result` presentation metadata, never the execution-local value.

## Config

```yaml
plugins:
  dsh-docker:
    enabled: true
    composeFiles: [docker-compose.yml, compose.yaml]
    approval: ["rmi:*", "rm:*", "prune:*", "compose down -v", "exec:*"]
    execReadOnly: true
    timeoutMs: 30000
    healthContext: { enabled: false, maxServices: 12 }
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch |
| `composeFiles` | `[docker-compose.yml, compose.yaml]` | config-ordered discovery list |
| `approval` | `["rmi:*", "rm:*", "prune:*", "compose down -v", "exec:*"]` | ops routed to the approval gate (`*` matches any args; `compose down -v` matches only volume-removing downs) |
| `execReadOnly` | `true` | `false` runs `docker_exec` ungated |
| `timeoutMs` | `30000` | per docker invocation timeout |
| `healthContext.enabled` | `false` | inject per-service health lines before each step |
| `healthContext.maxServices` | `12` | cap on health lines (+ `N more` tail) |

The same schema registers as the `dsh-docker` user-settings section, so a live edit reaches the very next tool call.

## Non-goals (v0.1)

Docker contexts / remote-host management UI; building images from a Dockerfile with any DSL (raw `docker build` passthrough is fine — no wrapping); swarm / k8s; container runtime introspection beyond `docker inspect`; log streaming / follow; registry auth flows. Each is a v0.2+ question, not a config flag away.

## Testing

- **Unit (no daemon):** arg-schema acceptance/rejection per tool; `ProjectResolver` fixtures (compose-file discovery, project-name derivation, ambiguous-ref handling); the `classify()` policy matrix — every destructive op asserts `guarded`, every safe op asserts `safe`, the `execReadOnly` toggle flips `docker_exec`; the approval-glob matcher.
- **Guard (no daemon):** a mock approval gate that always denies — `rmi` in-use, `rm` running, `prune --all`, `compose down -v`, and writeful `exec` are **refused**; an approving mock — they proceed **exactly once**; a preempting "allow" from another listener is refused by the backstop.
- **Integration (feature-detected):** probes for a live daemon (`docker version`) and, when present, `compose up`/`ps`/`down` a tiny alpine `sleep` stack with a mock approval gate — typed rows match reality and `down -v` requires approval. **Skips cleanly** (marked skipped, not failed) when no daemon is available.

```sh
pnpm install
pnpm typecheck && pnpm build && pnpm test
```

## Model Experience

### Request context and condition

#### What the model sees

The 14 tool schemas (names, descriptions, parameters) flow into system-prompt assembly through the tool registry, exactly like every other registered tool; there is no additional fixed prompt prose owned by this package. When `healthContext.enabled` is on and a compose project is detected in the agent's working directory, each pre-step injects a `source: { kind: 'plugin', plugin: 'dsh-docker' }` user message:

```markdown
[dsh-docker] <project> services: dev-api ▲up  dev-db ▲up  worker ▼exited(1)
```

#### Token effect

The tool schemas are fixed prompt tokens owned by the registry. The health line is conditional: bounded to `maxServices` lines plus a `+N more` tail, present only while the feature is enabled and a compose project is detected.

#### KV Cache effect

Append-only in the sense that each step appends a fresh health message that the next request consumes and discards; the message text is data-dependent (service states change), so a stable prefix is preserved but the tail invalidates reuse whenever a service state changes. Package-owned changes that can invalidate reuse: none at runtime — a reinstall/upgrade of the bundle changes the schemas, which is a normal dependency-change invalidation.

## Known Limitations and Deferred Work

- **`docker_ps`/`docker_compose_ps` need the docker CLI to support `--format json`** (Docker ≥ 25 for `ps`, compose v2 for compose `ps`). Older CLIs surface a clear error rather than scraped text; the `docker inspect` batch is the adapter where the ps `Labels` field is absent.
- **Failed tool calls render no status table** — `presentationMeta` is computed from successful canonical values only, so a failed `docker_ps` shows the standard error card, not a table. The durable log carries no canonical value by design.
- **`docker_prune` cannot report what the engine reclaimed** without scraping human prose; the canonical output carries the request and success, and the engine's reclaimed-space line lives in the rendered text only.
- **`docker_exec --interactive` output may carry TTY framing** (CRLF/ANSI); the canonical value returns it verbatim rather than laundering it.
