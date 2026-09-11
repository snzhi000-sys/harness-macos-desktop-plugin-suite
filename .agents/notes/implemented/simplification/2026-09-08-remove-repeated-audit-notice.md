# Agent Note: Remove repeated partial audit notices

Status: implemented

English | [中文](2026-09-08-remove-repeated-audit-notice.zh.md)

## Problem

The user accepts partial Full Access observation but does not want repeated generic warnings or a coverage badge after reviewing files.

## Decision

Remove the generic Full Access warning, coverage badge and Shell-result notice injection. This supersedes the presentation decision in [manual editing and review dismissal](../bug-fix/2026-09-08-manual-edit-and-review-dismissal.md) and the result annotation in [partial review](../bug-fix/2026-09-08-full-access-partial-review.md). Keep durable `auditCoverage.kind: partial`, permissions, snapshots, recovery and concrete operation errors. Legacy coverage messages do not render. Empty coverage alone cannot open the review dock.

## Alternatives considered

**Keep a dismissible warning:** The user explicitly requests removal, not repeated dismissal after refresh.

**Delete coverage metadata:** Hiding a warning does not establish complete observation; durable coverage must retain its meaning.

## Consequences

The generic reminder is no longer available in the dock or appended to Shell output. Full Access still does not guarantee complete attribution or recovery. Host tests check unmodified tool results with retained coverage; client checks require warning absence. The packaged UI regression checks legacy coverage, acceptance and reload, and must run against a rebuilt Dev before package acceptance. Reintroducing this presentation needs a new user decision.
