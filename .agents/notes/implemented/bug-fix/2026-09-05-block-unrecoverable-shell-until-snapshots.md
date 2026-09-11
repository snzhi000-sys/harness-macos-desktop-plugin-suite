# Agent Note: Block unrecoverable writable shell until pre-delete snapshots exist

Status: implemented

English | [中文](2026-09-05-block-unrecoverable-shell-until-snapshots.zh.md)

## Problem

Foreground raw shell had been reopened under the session sandbox and File Edit observed changes after execution. Testing proved that `bash rm -rf`, Python deletion, Node deletion, and equivalent subprocesses could remove files before the plugin obtained a recoverable before-image. A pending created-file entry could then converge from absent to absent and disappear from persisted review state. This violated the product invariant that permission to act does not remove the requirement to retain an audit record, and it could misrepresent an irreversible deletion as no change.

## Decision

Until the filesystem sandbox provides a deletion-before-image transaction, `dsh-file-edit` permits raw foreground `bash`, `shell`, and `pwsh` only when `sandboxPolicy.resolve({ session })` returns exactly `read-only`. It denies `workspace-write`, `danger-full-access`, missing or failed policy resolution, every explicit `sandbox_permissions` request, background shell, persistent terminal operations, and unmanaged compatibility shell entries before dispatch. The early `tools/pre-execute` listener and final monotonic tool guard use the same policy function. Command text is not parsed.

Structured `write`, `edit`, `file_move`, and `file_delete` remain available, as does `shell_readonly`. Product operations such as Feishu document updates continue through the constrained `lark_cli` tool and are not coupled to raw shell permission.

The retained foreground-shell capture path remains a compatibility and incident-recording defense for calls that were already running or bypass normal dispatch. If it observes a previously pending created file become absent without quarantine, it persists `shell-delete-unrecoverable`, stores the last known content only as a preview, disables automatic reject, and requires either manual recovery or explicit acceptance. Acceptance advances the absent baseline and removes the incident. It does not claim that the preview is an isolation backup.

## Alternatives considered

**Continue allowing writable shell and rely on post-execution watchers.** Rejected because observation occurs after destructive syscalls and cannot recover deleted bytes or guarantee complete delivery.

**Parse command strings and block only apparent deletion.** Rejected because interpreters, scripts, subprocesses, expansion, aliases, and dynamically computed paths make text classification bypassable.

**Restore a missing pending created file from the last observed content.** Rejected because that content was not captured by a verified pre-delete transaction and may be partial, stale, binary, or broader than one file. The record is evidence for manual handling, not recovery authority.

**Disable structured external operations together with shell.** Rejected because filesystem review and remote product permissions are separate boundaries. A constrained structured tool can perform its declared remote operation without gaining arbitrary local shell write access.

## Consequences

Writable build scripts, generators, package managers, and arbitrary raw-shell mutations are temporarily unavailable in strict File Edit sessions even when the user selects full filesystem access. Read-only diagnostics and all audited structured file operations continue to work. This is an explicit emergency safety boundary, not the final usability design.

The next implementation stage must move deletion interception below individual tools into the filesystem sandbox, create and verify quarantine content before allowing unlink or recursive removal, and route every writer through the same ledger transaction. Writable raw shell may be reopened only after Bash, Python, Node, subprocess, directory-recursive, external-path, crash, and rollback tests prove that no deletion can execute without a recoverable pre-image.

The standalone snapshot foundation for that work is recorded in [Build a pre-change shell snapshot transaction foundation](../feature/2026-09-05-shell-prechange-snapshot-foundation.md). Its presence does not supersede this denial: lifecycle settlement and review-ledger integration remain incomplete.
