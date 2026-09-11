# Agent Note: Separate Shell permission from recoverable audit coverage

Status: implemented

English | [中文](2026-09-06-shell-permission-and-audit-modes.zh.md)

## Problem

File Edit treated every explicit Shell escalation and every non-read-only mode as one generic audit denial. That prevented the Shell tool's own approval flow from handling a bounded escalation to `workspace-write`, obscured whether permission, approval, snapshot preparation, capacity, or settlement caused a failure, and made the Full access label sound like a guarantee that strict review covered every writable path.

## Decision

File Edit resolves `sandboxPolicy` from the live calling Session for every raw Shell call. A `read-only` call runs without a file snapshot. A standing or one-shot `workspace-write` call requires the enabled pre-change transaction and one absolute workspace root; a symlink root is canonicalized before snapshot and observation. The one-shot request still reaches the Shell tool's approval service, so rejection or the `never` policy remains an approval result rather than a File Edit substitute.

`danger-full-access` raw Shell is rejected before dispatch because its writable path set is unbounded. Full access remains a valid execution-permission preset for operations whose own enforcement and audit model can cover them. Product permission descriptions and confirmations state that execution permission and recoverable file review are independent controls.

User-facing Shell failures are classified as permission denial, unavailable or insufficient audit coverage, snapshot preparation failure, audit limit, or post-command settlement conflict. A preparation failure states that the command did not run. A settlement failure states that files may already have changed and retains transaction evidence. An approval failure from the Shell or Lark tool remains unchanged.

Subagents resolve their own effective sandbox policy while File Edit attributes resulting changes to the nearest visible parent Session. Dedicated Lark operations keep their separate rule: ordinary remote writes run directly, and high-risk remote writes use one-time approval without passing through raw Shell review.

## Alternatives considered

**Treat Full access as permission to bypass File Edit.** Rejected because an execution preset cannot prove that destructive changes outside the declared workspace have a recoverable before-image.

**Reject every explicit escalation inside File Edit.** Rejected because bounded `workspace-write` escalation is already mediated by the Shell approval service and can execute inside the same complete snapshot transaction.

**Duplicate sandbox preset state in File Edit.** Rejected because copied state can drift during a Session. File Edit resolves the owning policy for every call instead.

## Consequences

Changing a Session's permission mode affects the next call without restarting the plugin. A bounded approved escalation can use writable Shell without bypassing review. Full access cannot be used to turn strict review into best-effort disk observation; users receive a concrete alternative before an unbounded command starts.
