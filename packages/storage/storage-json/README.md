# @deepseek-ai/dsh-storage-json

English | [中文](README.zh.md)

JSON backend for the [storage hub](../storage/README.md), registered as backend `json`. A unit uses either one human-readable `<unit>.json` document or independent `<unit>/<table>/<key>.json` record documents under the configured root. Design: [domain KV storage Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md).

## Model

- In the default `single` layout, in-memory unit state is authoritative and every write republishes the whole file through temp-write, fsync, and atomic `rename()`. A missing file opens empty; malformed media and version mismatch reject.
- In the `per-record` layout, the directory is authoritative and each write touches one record document. Malformed, unreadable, unsafe-name, and unaccepted-version documents read as absent without affecting siblings. Record keys must match `[a-zA-Z0-9_-]+`.
- An empty per-record tree imports an accepted legacy single-unit file once, writes current-version documents, and retains the source unchanged. `backupRecord` moves an invalid schema record to `<key>.json.bak.<YYYYMMDDHHmm>`; the domain layer decides whether that salvage policy is allowed.
- Write ordering across calls belongs to the caller (the domain layer's write chain); each single call is atomic and durable once resolved.

## Config

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `root` | string | required — no default (a cwd fallback would scatter files) | Directory holding unit files; created `0o700` on demand |

## Model Experience

### Stored domain records

#### What the model sees

Nothing. This backend contributes no prompt, tool, or schema; it persists non-session domain data behind `ctx.storage` for host-side consumers only.

#### Token effect

Zero live-request tokens.

#### KV Cache effect

None — the backend never touches live request prefixes.

## Known Limitations and Deferred Work

- Windows durability relies on libuv's `rename()` (`MoveFileExW` with replacement) without an explicit write-through flag; the session-log backend's stricter Win32 write-through publish helper is planned to move down here when the append-log facet lands (see the Agent Note's migration section).
- No cross-process write locking: two processes writing the same root can interleave whole-file replacements (last write wins). Single-host-process deployments are the current consumer; the multi-process story is deferred per the Agent Note's out-of-scope table.
