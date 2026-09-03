# Agent Note: Projection cache cross-version salvage

Status: implemented

English | [中文](2026-09-03-projection-cache-cross-version-salvage.zh.md)

## Problem

The local product stored all Session projection checkpoints in the v3 `session_projcache.json` unit, while later Harness releases stored v4 and v5 per-Session documents. An exact-version single-unit reader either rejected an upgraded home or discarded every useful title cache. One schema-invalid derived checkpoint could also reject the complete domain during boot even though the Session log could reconstruct it.

## Decision

The storage descriptor supports an optional `per-record` layout and explicit older versions whose records the current owner schema accepts. Single-unit domains keep exact-version behavior. The JSON backend stores each per-record value independently, imports an accepted legacy single-unit file without deleting it, stamps every new write with the current version, and treats malformed or unaccepted documents as absent.

The domain layer retains fail-loud validation by default. A disposable domain may opt into `invalidRecords: 'backup-and-skip'` only when the backend can move the invalid record document aside. Backup failure still rejects opening, so recovery never destroys the only diagnostic copy.

The Session projection cache uses v5 per-record storage, accepts v3 and v4 documents, and binds current writes to `createdAt`, `cwd`, seeded status, and inherited-event count. Missing lineage fields mean an unseeded old record; a Fork rejects that record and refolds from the authoritative Session JSONL.

## Alternatives considered

**Replace the complete Session persistence stack with the upstream handle-based design.** Rejected because projection compatibility does not require changing Session event storage, query APIs, plugin-visible interfaces, or the local validated history-tail cache.

**Discard every cache on a version change.** Rejected because valid older titles and list projections can be read safely, while forcing every Session through a cold fold increases startup cost without protecting more data.

**Repair invalid records in place.** Rejected because the cache is derived and the intended value cannot be inferred from a failed schema. Moving the bytes aside and rebuilding from the Session log preserves diagnosis and correctness.

**Skip invalid authoritative domain records globally.** Rejected because only explicitly disposable derived domains may lose one record safely. Workspace and other authoritative state must continue to fail loudly.

## Consequences

Existing v3 local homes and v4/v5 upstream cache media open under one Runtime, and subsequent writes converge on v5 per-Session documents. One schema-invalid checkpoint no longer blocks the Web backend when it can be backed up. Unknown versions remain untouched, read-only backup failures remain explicit, and the main Session JSONL format and all plugin Session interfaces are unchanged.
