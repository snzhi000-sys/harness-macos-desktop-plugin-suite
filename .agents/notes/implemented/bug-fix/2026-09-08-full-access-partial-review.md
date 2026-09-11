# Agent Note: Full Access with explicit partial file review

Status: implemented

English | [中文](2026-09-08-full-access-partial-review.zh.md)

## Problem

Snapshot-driven confinement makes Full Access commands fail outside one audit directory or when a large directory exceeds snapshot limits. Removing that confinement cannot also guarantee complete recovery or accurate process attribution with ordinary filesystem snapshots.

## Decision

The tool-result notice and dock presentation are superseded by [notice removal](../simplification/2026-09-08-remove-repeated-audit-notice.md); the permission and durable coverage decisions below remain in effect.

This supersedes the permission scope of [per-call audit roots](2026-09-07-full-access-shell-audit-root.md), retaining its external deletion recovery.

The user explicitly accepts incomplete observation and potentially unrecoverable changes. Bash and Pwsh retain the resolved Full Access policy. File Edit attempts its existing bounded snapshot without making success a dispatch prerequisite. A command runs at most once; audit settlement errors do not replace its execution outcome. Persistent per-session partial coverage is appended to available tool-result content; its dismissible dock presentation follows [manual editing and review dismissal](2026-09-08-manual-edit-and-review-dismissal.md). Structured review and Workspace Write retain their existing recovery rules. Read Only remains read-only.

## Alternatives considered

**System-level collection:** Endpoint Security requires unavailable system prerequisites and does not by itself prove pre-image recovery. No special entitlement, privileged service or disk-access authorization is introduced.

**Larger mandatory audit roots:** Increasing snapshot limits retains the permission mismatch and cannot capture transient actions or reliably attribute concurrent external writers.

## Consequences

Full Access can write beyond the snapshot and run when snapshots fail. It does not promise complete observation, immutable audit evidence or recovery of every mutation. Snapshot-covered changes keep existing review and stale checks; external concurrent writes remain an attribution limitation. Background jobs and persistent terminals remain outside this change. Dev verification exercises the packaged Host; Stable requires separate authorization.
