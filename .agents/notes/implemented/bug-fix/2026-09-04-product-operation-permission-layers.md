# Agent Note: Layer product operation permissions instead of disabling writable work

Status: implemented

The raw-shell portion of this decision is superseded by [Block unrecoverable writable shell until pre-delete snapshots exist](2026-09-05-block-unrecoverable-shell-until-snapshots.md). The constrained `lark_cli` permission decision remains current.

English | [中文](2026-09-04-product-operation-permission-layers.zh.md)

## Problem

The product file-review plugin denied every raw shell-family tool before dispatch because arbitrary commands can write or delete files without the exact before-image and quarantine guarantees of the structured file tools. A separate constrained `lark_cli` tool restored Feishu operations, but its first implementation asked for approval before every remote write. A session configured with approval policy `never` deterministically rejects every ask, so ordinary document updates and uploads still could not run. The combination preserved a stronger review claim by removing common agent productivity: build scripts, generators, package managers, and ordinary remote document writes were unavailable.

## Decision

Foreground `bash`, `shell`, and `pwsh` calls are allowed through the normal Harness session sandbox. `dsh-file-edit` wraps their bounded execution with a workspace watcher and before/after metadata reconciliation, then stages detected workspace changes in the owning session's review ledger. Explicitly named external file targets retain the existing narrow capture path. Background shell calls, persistent terminal operations, and unmanaged compatibility shell entries remain denied by both pre-execute policy and the final monotonic guard because they do not have one completion point at which the review transaction can close.

Structured `write`, `edit`, `file_move`, and `file_delete` remain preferred when exact before-images or recoverable deletion are required. The shell review layer is visibility after execution, while the session sandbox is the write boundary. In particular, `danger-full-access` may modify unnamed external paths that workspace observation cannot discover.

The constrained `lark_cli` tool executes ordinary document creation, update, import, upload, and other non-destructive writes without an additional approval ask. Commands that delete, revert, log out, or remove access still require `allowed-once`; approval policy `never` therefore continues to fail those high-risk operations closed. The tool retains its argv allowlist, trusted executable, full sandbox-enforcement requirement, workspace input containment, narrow writable state root, and credential redaction.

## Alternatives considered

**Keep the unconditional raw-shell denial and add one structured tool per external program.** Rejected because it fixes known commands one at a time while package scripts, generators, and future authenticated CLIs remain unusable. Structured tools are still preferred for high-value integrations, but they are not a substitute for the general foreground execution capability expected from an IDE agent.

**Allow every shell and terminal lifetime.** Rejected because an immediate background acknowledgement or persistent terminal send does not identify when filesystem effects have finished. Closing review at the acknowledgement would falsely claim that later writes were captured.

**Ask before every ordinary Feishu write.** Rejected because `never` means approval-requiring actions cannot run, and creation or update then becomes unavailable despite the constrained tool's independent filesystem and command boundaries. Approval remains attached to destructive and access-removing operations where a one-shot human decision materially reduces risk.

**Parse command text to allow only apparently safe shell operations.** Rejected because expansion, scripts, interpreters, subprocesses, and symlinks make command-string classification neither complete nor enforceable. The OS sandbox controls write scope; observation supplies review visibility.

## Consequences

Foreground build and automation commands work according to the selected session sandbox, and their detected workspace changes appear in File Edit review. Dynamic file creation no longer depends solely on one filesystem-watcher delivery because bounded metadata reconciliation supplies a fallback. Very deep, ignored, or extremely broad trees rely on watcher delivery outside the bounded reconciliation set, so this mechanism does not claim transactional completeness.

Ordinary Feishu document writes now work in `never` sessions, while destructive and access-removing commands remain unavailable there. Users who need a recoverable delete use `file_delete`; users who select `danger-full-access` accept that unnamed external shell effects are outside complete File Edit discovery.
