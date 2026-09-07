# Agent Note: Build a pre-change shell snapshot transaction foundation

Status: implemented

English | [中文](2026-09-05-shell-prechange-snapshot-foundation.zh.md)

## Problem

File Edit cannot safely reopen writable raw shell by observing the filesystem after execution. Destructive syscalls can remove data before a watcher reports a path, and a directory tree is not a recoverable before-image merely because its later metadata was enumerated. The product therefore needs an independently testable transaction that either establishes a complete, verified snapshot of every declared writable root before command dispatch or fails without starting the command.

## Decision

`plugins/file-edit/host/shell-snapshot-transaction.mjs` owns the stage-2 snapshot foundation. A transaction uses an opaque ID and a session-ID hash beneath `dsh-file-edit-state/shell-transactions`, writes a versioned manifest through `preparing`, `ready`, `running`, `captured`, `failed`, and `discarded` states, and stores payloads separately from manifest metadata.

The manager requires explicit, absolute, non-overlapping writable roots. It completely and deterministically enumerates ordinary files, directories, and symbolic links without following links. It rejects special files, hard-linked files, unreadable entries, excessive depth, excessive entry count, and excessive logical bytes. macOS clones each complete root with one parameterized `/bin/cp -cR` process because Node reports `ENOSYS` for `COPYFILE_FICLONE_FORCE` on this platform; injected and non-macOS adapters retain the per-file clone contract. Only known unsupported or cross-volume errors may fall back to physical copy, and fallback checks aggregate logical size against free space plus the reserve before copying any file. Every payload file remains checked by size and SHA-256.

Snapshot preparation failures remove the entire hidden staging directory. A compact version-2 manifest records ctime metadata together with the existing content hashes. Preparation verification and post-command stability passes reuse a hash only while kind, size, mode, mtime, ctime, owner, and group remain identical; changed and new files are hashed before classification. A ready transaction is atomically renamed into place before entering `running`. Finalization compares the complete manifest with current roots without a watcher and classifies added, modified, and deleted entries. It samples the roots twice after command completion; continued mutation fails as `snapshot-finalize-stale` and retains the transaction. Metadata-only timestamp changes are discarded, while content, kind, mode, ownership, and symbolic-link target changes remain. Watcher paths are stored only as diagnostic candidates and never determine the change set.

The File Edit Host routes shell-family `tools/execute` through this lifecycle when its private `shellTransactionLifecycle` composition config is `true`; the product Profile enables it for bounded `workspace-write` foreground shell. The manager serializes transactions whose canonical roots are equal or overlap, including calls from different sessions and parent/child agents, and keeps ownership until File Edit commits the ledger. Disjoint roots can run concurrently. This path settles successful, nonzero, thrown, timed-out, and cancelled calls through the same finalizer. A foreground shell executor also waits for the managed subprocess tree after the direct process closes; a surviving helper is terminated, reported as `SHELL_PROCESS_TREE_SURVIVED`, and causes File Edit to retain a failed transaction even when no file change is visible.

Expired staging and ready transactions are reclaimed only when a writable transaction or explicit review recovery invokes the manager, never during the desktop first-screen startup path. Hidden `preparing` and unused `ready` state expire after one hour. A transaction marked as committed to the durable ledger remains for seven days for diagnostics and is then removed. Uncommitted `running`, `captured`, and `failed` evidence has no time-based deletion rule.

## Alternatives considered

**Treat APFS clone success as sufficient verification.** Rejected because a source can change while a multi-file snapshot is being assembled, and clone availability does not establish a coherent directory-wide point in time.

**Follow symbolic links and preserve hard-link topology.** Rejected for this stage because links can escape declared roots and hard-link restoration has aliasing semantics that the current ledger cannot represent safely. Symbolic links are recorded as links; hard links fail closed.

**Run one clone process per file.** Rejected because process startup dominates large trees. Root-level recursive COW keeps one process per declared root while the independently built inventory and full payload hash verification retain the security boundary.

**Enable the lifecycle in the product as soon as change classification works.** Rejected because deletion batches, crash recovery, and ledger ownership remain incomplete. A captured change set alone is not enough to claim recoverable shell review.

## Consequences

The project has a bounded, deterministic pre-change snapshot and a single internal lifecycle that produces replayable change metadata for every command ending. Failures can prove that the command callback was never invoked, stale post-command roots cannot be silently settled, and foreground helpers cannot outlive a successful result unnoticed.

The product can review bounded writable foreground shell without trading away complete enumeration or payload verification. The default 51,000-entry and 8 GiB logical limits bound peak work; a 50,000-file sharded benchmark remains within that entry allowance. Serialization can delay a second agent working in the same tree, while unrelated workspaces retain concurrency. Diagnostic retention consumes state storage for up to seven days after a failed transaction reaches the ledger, and uncommitted evidence intentionally requires explicit recovery rather than age-based deletion.
