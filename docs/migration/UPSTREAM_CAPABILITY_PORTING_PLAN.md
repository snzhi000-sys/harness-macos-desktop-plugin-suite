# Harness Upstream Capability Porting Plan

English | [中文](UPSTREAM_CAPABILITY_PORTING_PLAN.zh.md)

Updated: 2026-09-03

## 1. Purpose

This document plans how to port key capabilities from the official DeepSeek Harness `dsh-v0.1.2-alpha.5` release and its predecessors into the local macOS desktop and plugin suite. It is not an in-place version upgrade plan and does not authorize merging, rebasing, building a Stable App, or overwriting user data.

The plan uses the local `migration/unified-suite` branch, Harness `0.1.0-rc.5` core, and Desktop `0.1.0-rc.5-local.5` as its baseline. See the [migration status](STATUS.zh-CN.md) and [unified repository migration plan](../MIGRATION_PLAN.zh-CN.md) for current facts and repository boundaries.

## 2. Decision and priorities

Porting proceeds in this order: preserve correct local behavior, add data safety and runtime reliability, improve long-conversation behavior, and then add new capabilities.

| Order | Capability | Priority | Reason | Porting approach |
| --- | --- | --- | --- | --- |
| 0 | Stabilize immediate local message display and reasoning-history fixes | Prerequisite | Both capabilities exist in the worktree but do not yet form a stable baseline; later changes could easily overwrite them | Split local commits and complete tests; do not overwrite them from upstream |
| 1 | Cross-version Session storage reads and corrupt-data salvage | P0 | Directly affects startup, session titles, and recoverability of user data; user-data loss is unacceptable | Port storage and projection-cache read compatibility without migrating the whole Session architecture |
| 2 | WebSocket heartbeat, automatic reconnection, and recovery status | P0 | Affects every session and plugin Host call; can reduce recovery faults such as stale errors shown after a successful response | Port the state machine and heartbeat into the existing connection package while retaining Client Runtime interfaces |
| 3 | Incremental long-conversation rendering, stable paging, and Turn navigation | P1 | Highest daily value and the largest user-facing gap from upstream | Port data and rendering optimizations first, then implement navigation on the existing `ui-conversation`; do not import all of `ui-chat` |
| 4 | WebFetch SSRF protection | P1 security prerequisite | The local provider has no private-network protection; Fetch is disabled, but protection must precede any re-enablement | Port DNS validation, NAT64 checks, and address-pinned connections; keep Fetch disabled until security acceptance passes |
| 5 | Native DeepSeek multimodal input and Files API | P2 | Adds valuable image understanding but crosses attachments, logs, model requests, and history replay | Port the complete attachment path; do not expose image selection or change only the serializer |
| 6 | Subagent model selection and parent-child communication enhancements | P2 | Local code already has foundations such as `send_message`; most added value comes from model and reasoning parameter selection | Fill behavioral gaps in the existing subagent interfaces instead of replacing the whole package |
| 7 | Provider sign-in, model discovery, and plugin-version reporting | P3 | Improves configuration and diagnostics but ranks below session reliability and long-conversation performance | Port settings extensions, request metadata, and model-directory behavior independently |
| Deferred | Full `ui-chat` migration, indexed Session APIs, handle-based persistence, Remote gateway, and SQLite removal | Architecture project | Would affect multiple core packages and product plugins at once and cannot be safely ported as one capability | Create a separate architecture migration plan after the preceding stages stabilize |

## 3. Porting rules

1. **Do not perform an in-place version upgrade.** Do not merge official `master`, `dsh-v0.1.2-alpha.5`, or large merge commits into the local branch.
2. **Replay one capability at a time.** Identify the upstream commits and tests, then manually adapt the required mechanisms to local code without unrelated refactors, package moves, or API removals.
3. **Preserve local public interfaces.** Initial ports put upstream behavior behind the existing Session, Client Runtime, Cordis slot, and plugin interfaces so five product plugins do not require simultaneous rewrites.
4. **Do not dual-write Session logs.** Readers may support old and new formats, but one stage has exactly one authoritative durable-log write format so one Session cannot contain an unreconstructable mixture.
5. **Keep model-visible content reconstructable.** Images, references, reasoning content, and tool results must have replayable Session records before entering a model request.
6. **Preserve product capabilities.** Explorer, unified file routing, file review, transactional deletion, message forks, session lineage, Browser/Preview, and the Desktop/Profile packaging pipeline must not regress.
7. **Make every capability independently reversible.** One capability has its own commit sequence, test record, and Dev candidate; multiple high-risk changes must not share one inseparable commit.
8. **Use synthetic migration data only.** Storage and upgrade tests use constructed or de-identified fixtures and never commit real Stable sessions, credentials, review ledgers, or user Profiles.

## 4. Compatibility baseline

The local product plugins are coupled to Harness core. Better Sidebar depends on Client Runtime, Conversation, Settings, and tool interfaces; Workspace Lineage directly uses Session and Workspace Client Runtime; Message Edit directly operates on Session, Session Query, Workspace, and fork behavior; File Edit depends on tool events, Session headers, and session ownership; Cowork depends on Session, LLM, Tools, FS, and Approval.

| Component | Storage port | Connection port | Long-conversation/UI port | Multimodal port | Session architecture migration |
| --- | --- | --- | --- | --- | --- |
| Better Sidebar | Low | Medium: layout and Explorer requests must recover after Host API loss | High: depends on `ui-conversation`, turn-tail, deliverables, and unified file opening | Medium: image deliverables must continue through Preview routing | High |
| File Edit | Medium: review state must not be overwritten by Session recovery | Medium: review requests must remain fail-closed | High: review panels, references, and deliverable projections depend on conversation UI | Medium: images must not enter text review or code editing | High |
| Message Edit | High: forks, flushes, parent chains, and version events depend on durable Sessions | Medium: reconnect must not create duplicate forks | High: edit, reroll, and retry controls depend on conversation nodes | Medium: forks of historical image messages must preserve all content | Highest |
| Workspace Lineage | Medium: titles and parent chains must remain stable after recovery | High: Workspace and Session lists require reconciliation after reconnect | High: directly depends on Client Runtime Session and Workspace state | Low | Highest |
| Cowork | Medium: tool and deliverable events must replay | Medium: long-running jobs must not settle twice after disconnect | Medium: tool cards and deliverables depend on conversation projections | High: Office/Notebook deliverables may intersect with image attachments | High |
| Desktop/Profile | Medium: upgrade startup and Profile replacement must retain data | Medium: backend readiness must remain distinct from Renderer disconnection | Low | Medium: the Runtime must include every attachment dependency | Medium |

The highest-risk dependency path is `Session/Workspace Client Runtime → Workspace Lineage/Message Edit`, followed by `Conversation projection/slot → Better Sidebar/File Edit`. P0 and P1 therefore preserve these interfaces and replace only their internal implementations.

## 5. Stage 0: Preserve the local baseline

### 5.1 Goal

Before importing upstream code, turn the locally implemented and directionally validated fixes into an independently testable and reversible baseline.

### 5.2 Work

1. Split `reasoning_content` history replay, pi-ai replay degradation, and error recovery into one independent commit sequence.
2. Split immediate user-message display during long-history loading into another independent commit sequence.
3. Separate unrelated Better Sidebar, About App, and Explorer cache changes so they do not share commits with core ports.
4. Establish regression tests for these behaviors: every thinking-mode history turn replays; non-thinking mode omits unnecessary fields; a failed turn does not reappear as a stale error after the next turn; a submitted user message appears without waiting for the model or history load; refresh retains exactly one durable message.
5. Record the typecheck, build, test, and Profile Runtime assembly baseline for all five product plugins.

### 5.3 Compatibility requirements

- Do not change the Session event format.
- Do not change plugin-visible `ctx.sessions`, `ctx.workspaces`, Conversation slots, or tool-event interfaces.
- Do not change Profile composition or build a Stable package.

### 5.4 Completion criteria

- Each of the two fix groups can be reverted independently.
- Focused tests cover failure, retry, refresh, and long-history-loading paths.
- All 95 current worktree entries have a known feature owner, with no mixed diff of uncertain origin.

### 5.5 Stage 0 execution record

Stage 0 was preserved on 2026-09-03 without importing any upstream capability or building or installing a Stable package.

| Baseline group | Independent commit | Preserved scope |
| --- | --- | --- |
| Reasoning history and error recovery | `856f7bc4d3` | Complete DeepSeek `reasoning_content` history passback, pi-ai ordered-subset replay recovery and safe degradation, recovered historical failures, and live-error invalidation |
| Immediate messages during long history | `11b9f7ba81` | Immediate projection of Host-durable events while the initial history request is pending, sequence-based stitching and deduplication after history lands, and unchanged contiguous-window behavior during gap repair |

After preservation, all 76 remaining uncommitted worktree entries have known owners and are outside these two core commits: 46 belong to the Desktop/Profile/product packaging pipeline, 16 to Better Sidebar About App and Explorer cache work, 7 to File Edit partial-hunk settlement, 3 to the project README showcase, and 4 to migration planning and status documentation. Later stages must not include these groups as incidental upstream-port changes.

The automated baseline is:

- Focused core tests: 5 test files and 256 tests passed.
- Five product plugins: builds passed; Better Sidebar passed 547 tests, File Edit 77, and Workspace Lineage 139; all Cowork workspace tests passed; Message Edit Host and Client snapshot checks passed.
- Desktop: 26 tests passed; source privacy passed; Profile Runtime assembly confirmed all 5 required plugins.
- Dev candidate: the standard `npm run product:dist:dev` path passed product identity, release privacy, and isolated empty-userData launch checks; the fixed output is `desktop/dist/dev/mac-arm64/DeepSeek Harness Dev.app`.

Dependency installation still reports deprecation warnings for packages including `node-domexception`, `inflight`, `rimraf@2`, `glob@7`, `fstream`, `uuid@8`, and `xterm@5`. These are recorded baseline risks in the current dependency graph and are not opportunistically upgraded in Stage 0 because doing so would change the Runtime or plugin compatibility surface.

## 6. Stage 1: Session storage compatibility and salvage

### 6.1 Upstream reference scope

- `fcd109d29a`: version-compatible reads and backup-and-skip salvage for Storage per-record units.
- `49df707c86`: cross-domain-version reads and safe startup for the Session projection cache.
- `dsh-v0.1.2-alpha.5`: fixes startup failures and lost session titles after upgrades.

### 6.2 Porting method

1. Compare local storage, JSON backend, and projection-cache format versions, filenames, locking, and write timing; record a field-level difference table.
2. Port only the mechanisms for reading old versions, validating them, backing up corrupt units, and skipping and rebuilding unreadable caches; do not import upstream handle-based persistence.
3. Keep the primary Session JSONL as the sole source of truth. Projection-cache failure may only discard and rebuild cache data; it must not delete or rewrite the primary log.
4. Preserve the local `readHistoryTail()` rule that permits cache generation only after a complete cold inspection; upstream salvage must not broaden “skip a bad cache” into “skip an unverified log.”
5. Write backups under the same state owner with atomic rename or copy verification; diagnostics record only Session ID, version, and error category, never message content.
6. Build matrix tests for local old formats, upstream v3/v4/v5 fixtures, truncated files, unknown future versions, a single corrupt record, and read-only directories.

### 6.3 Plugin impact

- Message Edit: verify that parent chains, `message-edit/version`, and flushes survive forks.
- Workspace Lineage: verify that titles, parent-child relationships, manual ordering, and archive state remain unchanged after cache rebuilds.
- File Edit: its review ledger is independent of Session storage; migration must not clear or rebuild `$DSH_HOME/dsh-file-edit-state`.
- Better Sidebar: Browser/Preview layouts are independent plugin state and do not participate in Session cache salvage.
- Cowork: tool and deliverable events must reconstruct completely from the primary log.

### 6.4 Completion criteria

- Every supported old fixture starts while preserving titles, parent chains, and event counts.
- A corrupt cache is backed up and rebuilt; a corrupt primary log still fails explicitly instead of silently losing messages.
- A copied temporary Dev userData completes one upgrade rehearsal from old package data to the new Runtime.

### 6.5 Stage 1 execution record

Stage 1 completed Dev-candidate verification on 2026-09-03 without building or installing a Stable package.

| Difference | Previous local baseline | Upstream v4/v5 | Ported decision |
| --- | --- | --- | --- |
| Medium layout | One v3 `session_projcache.json` file | Per-Session documents | v5 writes `<root>/session_projcache/sessions/<id>.json` |
| Version reads | Exact version only | Cross-version v4/v5 reads | Explicitly accept v3/v4; preserve and ignore unknown newer versions |
| Record identity | `createdAt`/`cwd` | Includes lineage binding | v5 writes seeded status and inherited-event count; old records never seed a fork |
| Corruption handling | One schema error can reject the domain | Independent-record salvage | Only disposable derived domains back up uniquely before skipping; backup failure remains loud |
| Primary data | Session JSONL | Upstream also has handle-based persistence | Do not port the handle architecture; JSONL remains the sole source of truth |

The implementation adds an optional Storage `per-record` layout, explicit `compatibleVersions`, and `backup-and-skip` for disposable domains. The first v3 single-file import retains its source. New backup names combine a millisecond timestamp with a UUID so repeated corruption of the same record cannot replace an earlier diagnostic copy within one minute. Salvage logs omit underlying schema errors and message content.

Verification evidence:

- The storage and projection-cache matrix passed 75 tests across 4 files, covering v3/v4/v5, unknown versions, truncated documents, schema-invalid backup, read-only backup failure, and fork-lineage rejection.
- Repository typecheck, Stage 1 scoped lint, all five product-plugin builds, 26 Desktop tests, source/release privacy checks, and five-plugin Profile Runtime assembly passed.
- The standard `npm run product:dist:dev` chain passed its complete plugin suite and empty-userData launch, produced `v1.00.21 (dev)`, and replaced the fixed Dev output path.
- A separate packaged-App launch used temporary userData seeded with a synthetic v3 cache. After the Web backend became ready, the v5 per-Session document existed and the v3 source bytes were unchanged.

`product:test:plugins` initially encountered timing failures in the Better Sidebar PTY-exit wait and the Cowork WeChat message-order assertion. Neither depends on this Stage 1 code, and the complete plugin suite passed inside the final standard Dev packaging chain. The corpus-wide Agent Note format gate remains blocked by the pre-existing `2026-08-17-blank-session-external-conversation-views.md`, which lacks `Alternatives considered`; the new Stage 1 Agent Note has the complete required structure.

## 7. Stage 2: Connection recovery and heartbeat

### 7.1 Upstream reference scope

- `af562d3649`: idle WebSocket heartbeat.
- `ccfbbb443a`: centralized connection recovery in Connection Controller.
- `19b4d7f26c`: connection recovery status and explicit reconnect action.
- `49bf26a794`: tolerance for briefly stalled Hosts without false disconnects.

### 7.2 Porting method

1. Preserve the public interface of local `packages/client/connection`; centralize heartbeat, generation, backoff, and reconnect ownership inside its existing controller.
2. Distinguish four states: initial connection, connected, briefly stalled, and reconnecting. A short event gap must not immediately clear Session or Workspace state.
3. After each new generation connects, reconcile Session, Workspace, model-directory, and plugin Host state. Reconnection restores state and never replays confirmed writes.
4. Never automatically retry operations without idempotency keys, including fork creation, file moves, deletion, review acceptance/rejection, and Browser layout writes.
5. Expose a common Client connection state for the UI indicator instead of letting each plugin listen to WebSocket events.
6. “Reconnect now” restarts only the connection loop; it does not refresh the page, exit the Desktop backend, or clear userData.

### 7.3 Plugin impact

- Workspace Lineage reloads authoritative Session and Workspace snapshots and prevents late responses from an old generation from replacing the new snapshot.
- Better Sidebar reloads Host state only within the current workspace authorization. Existing Explorer cache may display first but must accept authoritative reconciliation from the new generation.
- File Edit remains fail-closed while connection state is uncertain; after recovery it reloads the pending snapshot without resubmitting acceptance or rejection.
- Message Edit does not automatically resend fork, rename, or retry actions. On interruption it reports an unknown result and then reconciles the Session list to determine whether a child Session exists.
- Cowork determines long-job state from durable events and does not mark a job failed solely because the connection closed.

### 7.4 Completion criteria

- Automation covers idle heartbeat, a brief stall, backend restart, repeated disconnects, page unload, and an old response arriving during reconnection.
- User messages already shown during a disconnect remain visible; recovery does not duplicate messages, forks, review actions, or file operations.
- A Dev App with temporary userData completes a real backend interruption and recovery test.

## 8. Stage 3: Long-conversation performance and Turn navigation

### 8.1 Substage order

This stage has three independently accepted substages and does not directly migrate official `packages/client/ui-chat`.

#### 3A: Data transfer and projections

1. Compare upstream packed assistant history, paged journal, and incremental projection publication.
2. Preserve the safety validation of local `readHistoryTail()` and reduce only transfer, parsing, and repeated projection of already validated records.
3. Give Conversation snapshots stable identity so streaming updates do not rebuild the entire node array.
4. Preserve existing `ctx.sessions` and `ui-conversation` consumer interfaces by introducing an internal adapter first.

#### 3B: Rendering and scrolling

1. Coalesce streaming updates to animation-frame cadence and limit repeated Markdown, syntax-highlighting, and scroll-geometry work.
2. Preserve user scroll ownership: leaving the bottom disables automatic pullback, and paging and jump navigation cannot own the scroll position simultaneously.
3. Keep Better Sidebar review panels, deliverable tails, and file navigation on stable slots instead of importing upstream internal components.

#### 3C: Turn navigation

1. Add a separate whole-log Turn outline projection to existing `ui-conversation`, exposing only Turn sequence, status, and bounded previews.
2. A navigation jump asks the paging controller to load the target sequence before the existing scroll container locates it.
3. Previews do not read or cache complete tool output, attachment bodies, or file content.
4. Implement text Turns first; images, tool cards, and question cards initially use type summaries.

### 8.2 Plugin impact

- Better Sidebar's turn-tail deliverable interception continues to read `Turn.data` and never falls back to `owner.nodes`.
- File Edit review panels and reference navigation retain the active Session across paging, file-tab changes, and Turn jumps.
- Message Edit edit, reroll, and retry actions use stable MessageId/sequence identity and do not depend on whether a node is loaded in the current page.
- Workspace Lineage must not destroy same-workspace Explorer cache when switching Sessions, and a stale Session paging response must not overwrite the newly selected Session.
- Cowork renders tool cards only in the visible window while deriving job status and deliverable statistics from whole-log projections.

### 8.3 Performance baseline

Create synthetic Sessions with 1,000 records, 10,000 records, and large tool outputs. Record cold first paint, second startup, backward paging, jumping to an old Turn, sustained streaming, Session switching, main-thread long tasks, and peak memory.

The minimum acceptance threshold is no significant regression from the Stage 0 baseline in any scenario. A 10,000-record Session must open, send, stream a response, page backward, and jump between Turns; offscreen code blocks must not be repeatedly highlighted; immediate local message display must remain intact.

## 9. Stage 4: WebFetch SSRF protection

### 9.1 Current boundary

Local `web-fetch-http` limits protocol, credentials, length, and cross-origin redirects but does not protect private networks, DNS rebinding, or NAT64. The product Profile currently uses `fetch: false` and mounts no Fetch Provider, so this code must remain disabled until protection is complete.

### 9.2 Porting method

1. Port upstream `network.ts` public-IP classification, complete DNS-answer validation, NAT64 private-address detection, and address-pinned connections.
2. Revalidate URL and public destination for every request and redirect; cross-origin redirects continue to require a new tool call.
3. Preserve the original hostname for TLS SNI and HTTP Host while the underlying connection uses only validated addresses.
4. Reject loopback, link-local, private, documentation-reserved, Unix-socket, embedded-credential, and mixed public/non-public DNS destinations.
5. Test with controlled local DNS and HTTP fixtures without contacting real internal services.
6. Even after security tests pass, enable the provider explicitly in a Dev Profile first; decide Stable Profile enablement separately.

### 9.3 Plugin impact

This capability primarily affects the Web tool Host and does not change the right-side Browser iframe. Better Sidebar's Browser may visit a user-entered address, while model-callable WebFetch follows a separate security policy; the two must not share authorization decisions.

### 9.4 Completion criteria

- Every upstream SSRF test category passes after local adaptation.
- Profile Runtime verification confirms that Fetch Provider assembly and tool flags match the target channel configuration.
- Dev can read a public URL and rejects private, rebinding, and cross-origin-redirect destinations.

## 10. Stage 5: Native DeepSeek multimodal input and Files API

### 10.1 Porting scope

1. Core image content blocks and model input-modality declarations.
2. Local attachment persistence, canonical encoding, dimension limits, and pixel budgets.
3. Native DeepSeek image serialization and the vision-model directory.
4. Files API-preferred upload, file-ID reuse, and controlled fallback after failure.
5. Immediate image echo, background compression/upload, and history replay after refresh.
6. Image handling in compaction, forks, reroll, retry, subagents, and Trajectory.

### 10.2 Porting method

1. Complete attachment storage and Session events before exposing UI; never create Blob-only temporary messages that cannot replay.
2. Preserve Stage 0 `reasoning_content` rules in `llm-deepseek` and cover reasoning history in multimodal serialization tests.
3. Scope Files API upload records by stable content digest and Provider so file IDs are never reused across accounts or base URLs.
4. Attachment failures retain an intelligible error and do not cause every retry to resend an attachment that the model cannot service.
5. Better Sidebar image Preview and model attachments serve different purposes: Preview reads workspace files and model attachments read durable Session references; a Preview URL cannot replace a model attachment record.

### 10.3 Plugin impact

- Message Edit preserves image messages and their durable references when forking instead of copying text alone.
- File Edit provides line references and review only for text files; image attachments never enter text editing or rejection recovery.
- Better Sidebar remains the owner of local image Preview. A chat attachment may reuse unified file routing only when it has a safe local path.
- Cowork explicitly classifies an image or document thumbnail as a deliverable or a model attachment and never inserts it into model context implicitly.
- Workspace Lineage search indexes only visible descriptions of image messages, never binary content.

### 10.4 Completion criteria

- Text-only models reject images with a clear error; vision models accept one image, multiple images, and very tall screenshots.
- Files API uploads are reused, expired file IDs trigger re-upload, and switching Provider does not reuse an invalid ID.
- Images survive refresh, restart, fork, reroll, retry, and long-history paging without disappearing, duplicating, or blocking immediate text-message display.

## 11. Stage 6: Subagent and model-configuration enhancements

### 11.1 Porting method

1. Compare local `send_message`, `interrupt_agent`, `list_agents`, and Job Panel behavior with upstream and establish gap tests.
2. Incrementally add Provider, model, reasoning effort, and max tokens to existing subagent creation arguments without replacing the current job lifecycle.
3. The parent agent and Profile own authorization; a subagent selects only from the allowed directory and cannot inspect globally configured unauthorized Providers.
4. Preserve File Edit's `origin: "subagent"` ownership rule so nested-subagent file changes continue to aggregate into the nearest visible parent Session's review ledger.
5. Better Sidebar's Job Panel reads state through a stable subagent service and never accesses internal Session arrays directly.

### 11.2 Completion criteria

- Default arguments preserve current behavior.
- An unavailable Provider/model, insufficient permission, disconnected parent Session, and exited subagent each produce a deterministic state.
- Subagent file changes, deliverables, token/duration metrics, and parent-child messages reconstruct after refresh.

## 12. Stage 7: Configuration and diagnostic enhancements

This stage can be split into three independent items: plugin-provided Provider sign-in controls in model settings, model discovery using Profile headers with search, and optional reporting of enabled plugin package names and versions in DeepSeek requests.

Plugin-version reporting sends only package names and versions by default, never local paths, user plugin configuration, workspace information, or Profile content. Settings extensions continue through the existing `settings.section` lifecycle and do not make Better Sidebar the owner of all settings capabilities.

## 13. Explicitly deferred architecture migrations

### 13.1 `Session.events` to indexed APIs

About 257 local core files still use the old event-access pattern, and product plugins also have direct dependencies. This migration requires a compatibility adapter, a generated call-site inventory, and complete event-order tests before implementation; it must not be hidden inside long-conversation optimization.

### 13.2 `ui-conversation` to `ui-chat`

Better Sidebar, File Edit, Message Edit, and Workspace Lineage depend on the current Conversation, Runtime, and slot system. A full UI package split first needs a slot mapping that proves new owners exist for review panels, references, deliverables, message editing, and external conversation views for blank Sessions.

### 13.3 Handle-based persistence and SQLite removal

Migrating storage lifecycle and deleting a backend are separate decisions. Stage 1 read compatibility neither authorizes SQLite removal nor changes Session write ownership.

### 13.4 Full Remote gateway migration

Local plugin Host routes, Client Runtime, and Desktop loopback startup require joint review. Connection recovery can be completed behind current interfaces without removing ApiProxy or rewriting every remote call.

## 14. Standard implementation workflow for each capability

1. Create a dedicated branch or worktree from the preserved local baseline, naming it after the capability rather than the official version.
2. Record the upstream tag, commit range, affected packages, and upstream tests, and identify actual dependencies between commits.
3. State the local product behavior and plugin interfaces that must remain, then add gap tests first.
4. Manually port the smallest mechanism. When upstream depends on new architecture, place an adapter behind existing local interfaces without importing unrelated architecture.
5. Run unit tests, typecheck, build, and key snapshots for affected core packages.
6. Run tests for every product plugin marked Medium or High in the compatibility matrix.
7. Generate the release Profile and verify required plugin Host composition and Client bundle assembly.
8. Build the fixed-path Dev candidate, verify first startup with fresh temporary userData, then verify upgrade startup with a copied synthetic old-data set.
9. Record performance, data migration, and UI regression results. On failure, revert that capability's commits without reverting other accepted capabilities.
10. Only after the user accepts the Dev candidate, decide whether to begin the next capability or build a Stable candidate.

## 15. Verification matrix

| Verification layer | Minimum requirement for every stage |
| --- | --- |
| Static checks | Affected-package typecheck and lint, plus `git diff --check` |
| Unit tests | Old and new behavior, failure, cancellation, retry, dispose/HMR, and late responses |
| Session snapshots | Model-visible content, history replay, refresh, and fork results remain equivalent |
| Storage fixtures | Current format, supported old formats, truncation, corruption, unknown future versions, and read-only failure |
| Plugin tests | Build and focused tests for Medium/High-impact plugins; core-only testing is insufficient |
| Profile Runtime | All five product plugins are mounted and enabled; four Client bundles appear in the startup manifest |
| Dev first install | Independent temporary userData, Runtime extraction, Profile install, backend startup, and main UI load |
| Dev upgrade | Synthetic old userData, data retention, cache rebuild, plugin upgrade, and connection recovery |
| Manual regression | Explorer, Browser/Preview, file review, transactional deletion, references, message editing, and session lineage |
| Package metadata | Dev/Stable channel, version, build time, Runtime/Profile IDs, and About App agree |

## 16. Stop and rollback conditions

Stop the current capability and do not stack the next stage if any of these conditions occurs:

- The primary Session log is modified, lost, silently skipped, or unrecoverable from backup.
- Message Edit creates a duplicate fork, a Workspace Lineage parent chain changes, or a session title disappears.
- A File Edit review ledger is cleared, assigned to the wrong Session, or fails open while connection state is uncertain.
- Explorer marks, infrequent-item visibility, Preview tabs, or plugin state migrate incorrectly into dynamic-localhost localStorage.
- Immediate user-message display or the `reasoning_content` fix regresses.
- A Profile contains package files but does not mount the Host or execute the Client bundle.
- Dev and Stable outputs, userData, Bundle ID, or About App channel metadata are confused.

Code rollback reverts only the current capability's commits. Data tests always use temporary copies; never recover a test environment by deleting real `DSH_HOME`, Session, Profile, review-ledger, or Explorer state.

## 17. Recommended delivery batches

| Batch | Content | Expected delivery |
| --- | --- | --- |
| A | Stage 0: local fixes and worktree classification | Clean, testable product baseline; no Stable package |
| B | Stage 1: storage compatibility and salvage | Data-migration test report and Dev candidate |
| C | Stage 2: connection recovery and heartbeat | Disconnect-recovery test report and Dev candidate |
| D | Stages 3A/3B: long-conversation data and rendering optimization | Performance comparison and Dev candidate |
| E | Stage 3C: Turn navigation | Long-conversation UI acceptance package |
| F | Stage 4: WebFetch SSRF protection | Security test report; Fetch remains disabled by default |
| G | Stage 5: multimodal input and Files API | Multimodal conversation acceptance package |
| H | Stages 6/7: subagent, model, and diagnostic enhancements | Separate Dev candidates |

The first approval should cover only batches A, B, and C. After all three are stable, use measured long-conversation performance to choose the implementation depth of batches D and E. Multimodal input is an independent product capability and must not be developed in the same batch as long-conversation or Session architecture migration.

## 18. Official update inventory

This section records the major official releases after the local `0.1.0-rc.5` baseline through `dsh-v0.1.2-alpha.5`. It identifies capability origins and dependency scope; it does not mean that every update fits this product or replace commit-level review before implementation.

### 18.1 By official release

| Official release | Major updates | Key areas | Local assessment |
| --- | --- | --- | --- |
| [`dsh-v0.1.0-rc.7`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.7) | Plugin settings cards; Codex/Claude Code subagents in Job Panel; durable MCP/ACP images; fixes for large-history paging stack overflow and continuation after max-token truncation; DeepSeek `low` reasoning effort | Settings, Subagent, Attachment, Session paging, LLM | Local code already has settings cards and some subagent metrics; paging and truncation fixes need focused comparison; the image path is incomplete |
| [`dsh-v0.1.0-rc.8`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.8) | Native DeepSeek images; multimodal `/goal` and `/plan`; file and Session references in `@`; subagent Profile Bundles; reasoning replay fix; oversized-image controls; large-history fork optimization; incompatible SQLite format change | Attachment, LLM, Composer, Subagent, Session fork, SQLite | The local reasoning fix is stricter and must not be overwritten; references are deeply customized; images and SQLite cannot be ported as isolated commits |
| [`dsh-v0.1.1-rc.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.1-rc.1) | Published vision model; fixes for editing before `@`; Bubblewrap `/proc/<pid>/root` escape fix; multiline `ask_user_question` input | LLM catalog, Composer, Linux sandbox, User Questions | The macOS product does not directly use Bubblewrap, but a future Linux release needs the security fix; composer changes collide with the local reference protocol |
| [`dsh-v0.1.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.1-rc.2) | Files API-preferred DeepSeek uploads and file reuse; model-specific image resizing and format conversion | Attachment, Attachment Local, LLM DeepSeek | This is part of the complete multimodal path; adding it alone creates a partial state where images can be selected but cannot reliably send or replay |
| [`dsh-v0.1.2-alpha.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.1) | Process and system-prompt folding; width, font size, token details, and Turn navigation; queued sends; immediate image echo; stable references; startup and loading optimization; subagent model selection; ACP completion; plugin-version reporting; incremental Session-log upload; Web token authentication; Remote gateway replacing ApiProxy; major conversation-UI split; public WebFetch with SSRF protection | Client UI, Session, Attachment, Subagent, ACP, LLM, API, Web security, Profile | This is the largest architecture boundary; independent capabilities can be ported, but the whole release cannot be treated as an upgrade patch |
| [`dsh-v0.1.2-alpha.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.2) | Connection-error status, automatic retry, and reconnect-now; plugin grouping by Session/global scope; Preset browsing and search; long-history and live-message optimization; per-Turn token and duration details; Node 24 fix; unified RemoteError | Connection, Settings, Preset, Conversation, Remote gateway | Connection work is suitable for early porting; local code already has statistics and should not duplicate UI; RemoteError depends on the deferred gateway migration |
| [`dsh-v0.1.2-alpha.3`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.3) | Preview and jump across all paged Turns; long-conversation memory and highlighting optimization; reliable queued-image delivery; extensionless-image detection; stalled-Host disconnect fix; SQLite Session backend removal | Turn outline, Paging, Rendering, Attachment, Connection, Persistence | Long-conversation work should be split into ports; SQLite removal affects existing data access and is explicitly deferred |
| [`dsh-v0.1.2-alpha.4`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.4) | Parent-child Agent communication through `send_message`; model discovery with Profile headers and search; very-long-conversation optimization; replacement of `Session.events` with indexed reads; strong Session seq/log-offset types; `web_fetch` enabled in more Profiles | Subagent, Model directory, Session API, WebFetch | Local code has part of `send_message`; Session API replacement affects about 257 core files and several plugins; WebFetch must not follow new defaults before security acceptance |
| [`dsh-v0.1.2-alpha.5`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.5) | Cross-version Storage and Session projection-cache reads; backup-and-skip for corrupt units; fixes for failed upgrade startup and missing session titles | Storage, Projection cache, Upgrade recovery | Highest data-safety value and appropriate for the first focused port; it still must not bring handle-based persistence with it |

### 18.2 By capability domain

| Capability domain | Official progress | Local capability | Local gap | Main conflict from a direct import |
| --- | --- | --- | --- | --- |
| Session storage | Cross-version reads, per-record salvage, projection-cache rebuild, and log-tail repair warnings | JSONL, SQLite, local `readHistoryTail()`, and validated tail cache | Official-format fixtures and complete cross-version recovery | Mixing new readers/writers with local cache rules can lose titles, prevent startup, or silently omit events |
| Client Session architecture | Session Controller, deep paging, indexed reads, strong seq/offset types, and on-demand snapshots | Legacy Client Runtime, Conversation assembler, and plugin-visible Session/Workspace interfaces | New indexed APIs and controller | Removing `.events` directly produces broad compilation failures; incomplete compatibility creates ordering and paging faults |
| Conversation UI | `ui-chat` package split, process folding, width and font settings, Turn navigation, and detailed metrics dialogs | Deeply customized `ui-conversation`, statistics line, references, review, and deliverable slots | Whole-log navigation and some rendering optimizations | Replacing the directory makes review panels, message editing, unified file opening, and reference controls disappear or duplicate |
| Message submission | Optimistic echo, running-turn queue, background image work, and unified steering | Local immediate text-message display and failure recovery | Official queue and image paths | Two optimistic-echo owners create duplicate messages, broken deduplication, or position changes after refresh |
| LLM reasoning history | Official reasoning replay and OpenAI-compatible fixes | Stricter DeepSeek empty-reasoning rules, pi-ai private-block alignment, and stale-error recovery | Joint verification with new multimodal serialization | Overwriting local serialization can restore the 400 error and carry failed-turn errors into the next Turn |
| Multimodal input | Durable attachments, Files API, image reuse, conversion, Vision catalog, Trajectory, and compaction | pi-ai modality declarations and right-side local image Preview | End-to-end DeepSeek image path | Copying only UI or adapter code leaves unreplayable attachments, cross-Provider reuse, and retry loops |
| Connection | Heartbeat, generation tracking, centralized reconnect, stalled-Host tolerance, and recovery status | Basic automatic reconnect and partial reconnect baselines | Complete state machine, heartbeat, and common UI | Two reconnect owners create duplicate subscriptions, duplicate baselines, and stale responses overwriting new state |
| Subagent | Job Panel, model/Provider/reasoning parameters, bidirectional parent-child messages, and image follow-ups | Customized Job Panel, `send_message`, `interrupt_agent`, and file-review ownership | Parameter authorization and behavioral equivalence | Replacing the lifecycle breaks Better Sidebar job views and File Edit aggregation into parent-session review |
| Web tools | Public WebFetch enabled by default, SSRF protection, and broader Profile assembly | `web_search` assembled; WebFetch Provider present but disabled in product configuration | Secure network layer | Syncing only defaults exposes the unprotected Provider to the model and creates an internal-network access risk |
| Settings and model directory | Plugin sign-in controls, plugin grouping, Preset search, and model discovery with Profile headers | `settings.section` and customized About App | Provider sign-in and model search | Replacing Settings UI loses About App; copying UI without Host services creates empty controls |
| API and Profile | Remote gateway, unified RemoteError, one-time Web token, and unified Profile startup | ApiProxy, Desktop loopback backend, and product Profile generation/merge policy | New Remote interfaces and network-Web authentication | Removing ApiProxy breaks Client and plugin calls; replacing Profile omits product plugins or overwrites user configuration |
| Sandbox and terminals | Bubblewrap PID namespace and security fix, plus PTY/PowerShell/Bash reliability | macOS Seatbelt, Linux bwrap/Landlock, and read-only Shell enforcement | Linux Bubblewrap fix and selected terminal fixes | Limited macOS impact, but a Linux package retains a known escape; wholesale replacement may weaken File Edit's strict Shell guard |

## 19. Definition and direct consequences of a “rough upgrade”

A “rough upgrade” is not merely a large change. It means placing an official version into source or runtime without preserving the local behavioral baseline, splitting capability dependencies, introducing plugin compatibility, and rehearsing data upgrades.

### 19.1 Merge official `master` or a release tag directly

- **What happens:** Git encounters widespread text conflicts in Client Runtime, Session, Persistence, LLM, Settings, and Profile; automatically merged files may still contain semantic conflicts.
- **Why it is dangerous:** The 153 local divergent commits and extensive uncommitted product work have no matching upstream patch identities, so Git cannot decide whether a local rule must remain or yield to new upstream architecture.
- **Possible result:** Compilation failure is only the easiest outcome to detect; a more dangerous build passes while message behavior, parent chains, review ownership, or plugin lifecycle silently changes.
- **Affected components:** All five product plugins, Harness core, Desktop Runtime, and the complete Profile build path.

### 19.2 Replace `packages/client` wholesale or import all of `ui-chat`

- **What happens:** Existing exports for `ui-conversation`, Client Runtime, Session/Workspace state, and slots move or disappear.
- **Why it is dangerous:** Better Sidebar, File Edit, Message Edit, and Workspace Lineage directly depend on those interfaces, and some custom behavior attaches to specific Conversation projections and turn-tail lifecycles.
- **Possible result:** Explorer may still render while file opening fails; review panels disappear; message-edit controls vanish; deliverables return to upstream opening behavior; session lineage can no longer rename, order, or open branches.
- **Affected components:** Better Sidebar, File Edit, Message Edit, and Workspace Lineage; Cowork tool-card and deliverable rendering may also degrade.

### 19.3 Cherry-pick only a feature's leaf commit

- **What happens:** The leaf commit references types, Services, events, config keys, generated catalogs, or earlier data formats that have not been ported.
- **Why it is dangerous:** Official `0.1.2` features often build on Session Controller, Remote gateway, attachment persistence, or the UI package split; commit subjects do not express every dependency.
- **Possible result:** Explicit type errors, missing runtime injection, empty settings controls, events written but unreadable by the old reader, or tests that pass only in the complete upstream composition.
- **Affected components:** Depends on the capability; multimodal input, connection recovery, and long-conversation behavior are especially unsuitable for taking only the final UI commit.

### 19.4 Replace `package.json`, the lockfile, or the entire package set

- **What happens:** Workspace resolution, peer dependencies, Client bundle discovery, and native Node dependency versions all change together.
- **Why it is dangerous:** Product plugins depend on a single Harness core instance inside the Runtime, while the fixed Profile manifest and fallback resolution prevent Cordis scope from splitting across two instances.
- **Possible result:** A package exists under `node_modules` while its Host is not mounted or Client never executes; alternatively, duplicate Cordis/Core instances make a registered service unavailable from plugin context.
- **Affected components:** Every product plugin, Profile Runtime verification, and Desktop first-install and upgrade behavior.

### 19.5 Replace local artifacts with an official Profile, Runtime, or App

- **What happens:** The official composition does not automatically include the five product plugins, release patches, About App metadata, or Desktop Profile merge behavior.
- **Why it is dangerous:** Runtime, Profile, and `.app` belong to the artifact plane and cannot express product allowlists, Client bundles, or user-Profile retention policy from local source.
- **Possible result:** The App starts but Explorer, file review, message editing, or Cowork is absent; replacing the Stable Profile can also lose user-added plugins and configuration.
- **Affected components:** Desktop, all five product plugins, user Profile, Dev/Stable channels, and About App build metadata.

### 19.6 Open real Stable data directly with the new Runtime

- **What happens:** New storage readers, projection cache, supported Session-event set, and SQLite policy act on irreplaceable real data for the first time.
- **Why it is dangerous:** `rc.8` introduced an incompatible SQLite format, `alpha.3` removed SQLite, and `alpha.5` specifically fixed cross-version startup and title loss, so this path is not inherently compatible.
- **Possible result:** Startup failure, missing list titles, invisible old branches, cache mistaken for primary data, inaccessible SQLite Sessions, or inability to safely return to the old version after upgrade.
- **Affected components:** Session, Message Edit, Workspace Lineage, Cowork history, and every user workflow based on old conversations.

## 20. Failure propagation from a rough full upgrade

A rough full upgrade usually causes more than one UI defect and propagates in this order:

1. Package and API changes first prevent some plugins from resolving, injecting, or registering.
2. Plugins that load consume new Session/Workspace state while still assuming old event order and lifecycle.
3. Client and Host disagree about messages, forks, reviews, or queues, producing duplicate, missing, or stale UI state.
4. New Persistence or projection cache preserves that disagreement across restarts, turning a temporary display error into a data-recovery error.
5. If Profile or Runtime is replaced at the same time, source, build output, user Profile, and running process report different versions during diagnosis.
6. If a Stable package is built and installed immediately, reverting code cannot automatically restore data already read, migrated, or omitted by the new format.

| Plugin or system | Most likely visible symptom | Deeper consequence |
| --- | --- | --- |
| Better Sidebar | Explorer, Browser/Preview, or settings controls disappear | Unified file opening is bypassed, deliverables and external files use the wrong route, and stale responses overwrite layout state |
| File Edit | Review panel, deletion tombstone, or reference control disappears | Change ownership is wrong, rejection recovery overwrites newer content, or the strict Shell guard is not mounted, creating data and security regressions |
| Message Edit | Edit, reroll, or retry fails or its controls disappear | Duplicate forks, broken parent chains, unreadable version events, and old branches disappearing from the Session tree |
| Workspace Lineage | Session ordering, rename, or two-level tree behaves incorrectly | Title and parent-chain recovery fails, late snapshots overwrite the current selection, and users believe Sessions were lost |
| Cowork | Tool cards or deliverables disappear and long jobs remain stuck | Tool events do not replay, jobs settle twice, or Office/Notebook deliverables cannot open through unified file routing |
| Desktop/Profile | The App starts with missing features or confused Dev/Stable metadata | The wrong channel uses the wrong userData, product plugins are omitted, or user Profile and extra plugins are overwritten |
| LLM/Session | Duplicate messages, stale history errors, or failed image sending | The `reasoning_content` 400 returns, model context differs from UI, or message counts change after refresh |
| Storage | Slow startup, missing titles, or inaccessible Sessions | Data is skipped incorrectly, downgrade becomes unsafe, or a missing cache is mistaken for primary-log corruption |

## 21. Prerequisites for considering a broader upgrade

Only after all of these conditions hold may the project evaluate expanding from capability ports to an architecture upgrade; satisfying them still does not authorize overwriting the Stable App:

1. Stages 0, 1, and 2 are complete, with stable tests for immediate message display, reasoning history, storage salvage, and connection recovery.
2. The current worktree is split by capability and contains no unknown-origin or cross-capability mixed changes.
3. A machine-readable old-to-new interface call-site inventory covers core and all five product plugins.
4. Compatibility designs exist for `Session.events`, Session/Workspace Client Runtime, Conversation slots, and ApiProxy/Remote.
5. Synthetic old data starts, reads, and downgrades under the new Runtime while preserving titles, parent chains, event counts, and review state.
6. All five product plugins pass Host composition, Client bundle, focused tests, and real Dev UI regression.
7. The new Profile is generated from the repository release manifest and upgrades while preserving user configuration and extra plugins.
8. Only an independent Dev candidate is built; after user validation, Stable candidate creation and installation are separate decisions.
