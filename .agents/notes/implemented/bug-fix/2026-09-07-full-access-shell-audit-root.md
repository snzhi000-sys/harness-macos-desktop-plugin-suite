# Agent Note: Full Access Shell uses an arbitrary per-call audit root

English | [中文](2026-09-07-full-access-shell-audit-root.zh.md)

The permission-confinement decision below is superseded by [explicit partial review](2026-09-08-full-access-partial-review.md). The external deletion-batch recovery mechanism remains in use.

## Context

The product File Edit gate rejected every `danger-full-access` `bash`/`shell`/`pwsh` call before dispatch. This coupled execution scope to review implementation limits: selecting a wider permission mode removed Shell capability, including read-only commands.

## Decision

The system Agent presets enable `auditFullAccessWrites`. A Full Access foreground Shell call may name any existing absolute directory with `audit_root`; omission uses `workdir`, then the Session workspace. The Shell consumer preserves unrestricted reads but executes writes through the existing `workspace-write` kernel profile rooted at that directory. File Edit independently resolves the same root, takes a complete pre-change transaction snapshot, and settles additions, modifications, and deletions into the Session review ledger.

This is a per-call write scope, not a fixed workspace permission. A command that needs several writable locations names their narrowest existing common directory. If that root cannot be snapshotted within the existing limits, only that call fails before dispatch. The implementation never falls back to watcher-only review.

External directory deletion batches persist their canonical absolute root. Rejecting the batch therefore restores the complete external directory from quarantine instead of resolving its root relative to the Session workspace.

Background Shell, persistent terminals, and unmanaged compatibility Shell tools remain outside the transaction lifecycle and stay blocked by File Edit.

## Verification

Package tests cover Full Access schema/policy projection for Bash and Pwsh. File Edit tests cover Full Access admission, an added file outside the workspace, and an external recursive directory deletion with complete batch restoration.
