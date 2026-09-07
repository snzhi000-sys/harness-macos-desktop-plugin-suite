# Agent Note: Enable recoverable workspace-write shell review

Status: implemented

English | [中文](2026-09-05-recoverable-workspace-shell-review.zh.md)

## Problem

The stage-3 shell snapshot lifecycle classified changes but did not transfer deleted bytes into the durable File Edit ledger. Enabling it at that point would have allowed a foreground `rm -rf` to remove data while leaving only an internal transaction, without normal batch review, restart recovery, or user-facing restore.

## Decision

File Edit now settles every changed `workspace-write` foreground shell transaction before returning its result. The workspace transaction lease remains held through durable ledger settlement, so another session or child agent cannot start a transaction over the same or an enclosing root between disk comparison and ledger commit. Added and modified regular files enter the existing per-session baseline ledger. Deleted files and top-level deleted directories are copied from the verified pre-command snapshot into the session quarantine and receive the same `deletionBatchId` metadata used by `file_delete`. Directory payloads preserve nested layout, empty directories, file modes, binary bytes, and symbolic links without following them. File contents are verified by SHA-256 before the temporary shell transaction can be discarded.

State format v7 writes the compact review ledger through an fsynced temporary file and atomic rename. It continues to read older ledgers inside File Edit. A directory containing no regular files receives one private anchor record so its quarantine remains visible and can be accepted or restored. Partial file decisions retain the batch until its final record is resolved, then remove the quarantine. Whole-batch reject verifies and restores the complete payload before clearing tombstones.

The snapshot manager can recover transactions left in `running` or `captured` after a Host crash. File Edit performs this recovery before a new writable shell and when the review snapshot is requested. A failed process-tree transaction remains as evidence and is marked after its ledger changes are committed so restart cannot duplicate the batch.

The product composition enables `shellTransactionLifecycle`. The shell gate therefore permits managed foreground `bash`, `shell`, and `pwsh` when the resolved policy is `workspace-write` with one absolute workspace root. Read-only behavior is unchanged. A one-shot escalation to `workspace-write` remains owned by the approval service and executes inside the same snapshot transaction only after approval. Background jobs, persistent terminals, unmanaged compatibility shells, and `danger-full-access` remain denied because their writable lifetime or root set is not covered by this transaction.

## Alternatives considered

**Move deleted paths into quarantine after the command.** Rejected because the paths no longer exist after destructive commands; only the pre-command snapshot is a recovery authority.

**Keep captured shell snapshots indefinitely and teach the UI a second review model.** Rejected because it would duplicate deletion semantics and make structured tools and shell actions behave differently. Snapshot payloads are transferred into the existing quarantine format instead.

**Enable unbounded full-access shell.** Rejected because a workspace snapshot cannot claim to cover writes outside that root. Permission-mode messaging and broader policy selection remain a separate stage.

## Consequences

This product configuration allows writable foreground shell while retaining strict, restart-safe file review. A command can still complete at the process layer and then report an audit failure if settlement cannot be proven; in that case its snapshot is retained and the system does not claim success. Snapshot cost scales with the full declared writable root and is bounded at 51,000 entries, 8 GiB logical content, and depth 64. Same-root agents trade concurrency for a deterministic ledger boundary; agents in disjoint workspaces can proceed concurrently.
