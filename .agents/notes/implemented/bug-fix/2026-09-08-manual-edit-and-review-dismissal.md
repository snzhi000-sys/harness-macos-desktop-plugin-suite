# Agent Note: Manual editing and dismissible review coverage

Status: implemented

English | [中文](2026-09-08-manual-edit-and-review-dismissal.zh.md)

## Problem

A persistent coverage warning keeps an empty review dock open. Applying the agent policy to browser document saves blocks human editing in Read Only. Native structured deletion also needs path enforcement beyond a mode check.

## Decision

The dismissible warning presentation below is superseded by [notice removal](../simplification/2026-09-08-remove-repeated-audit-notice.md). Manual saves, path restrictions and empty-dock behavior remain in effect.

The display rule in [partial review](2026-09-08-full-access-partial-review.md) is superseded: persisted coverage does not imply a visible empty dock. Warning text belongs inside the collapsible body, and users can dismiss its text and chip in the current component. Reload may show it again when pending files exist; tool notices and durable coverage remain intact.

Browser document and line saves use a workspace-bounded user write policy with realpath validation. They do not modify the session's agent policy or expose a bypass flag on tools. Existing external-read-only, revision and pending-review checks remain. Native file_delete checks the executing session's real workspace before inventory and before quarantine in Workspace Write; Full Access retains external deletion.

## Alternatives considered

**Delete coverage on acceptance:** This confuses approval of known files with complete observation of unknown changes.

**Change the session to Full Access for manual saves:** This unexpectedly grants the agent more permission.

## Consequences

Users can save while their agent is read-only and clear finished review UI. These changes separate existing user API operations from tools, not provide cryptographic proof of human intent or a new authenticated transport. Manual rejection/undo paths are not redesigned. Tests cover denied external deletion, retained Full Access deletion, manual save, stale revisions, symlink escape and pending work. Packaged UI regression covers collapse, dismissal, acceptance and reload.
