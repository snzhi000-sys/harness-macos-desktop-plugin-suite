# Agent Note: Durable partial hunk review settlement

Status: implemented

English | [中文](2026-09-03-partial-hunk-review-settlement.zh.md)

## Problem

File Edit stored partial accept and reject choices under positional hunk identifiers such as `h0` and `h1`. Accepting a hunk did not advance the baseline, and rejecting a hunk changed the diff topology without invalidating the meaning of later identifiers. A later agent edit to the same file could therefore resurrect accepted content or hide an unrelated pending hunk.

## Decision

The durable review model uses two content images: `base` contains the original content plus every accepted hunk, while `cur` contains current disk content. `diff(base, cur)` is the only source of pending review.

Accepting one hunk applies only that hunk to `base`. Rejecting one hunk restores only that region in `cur` and writes the result to disk. Both actions then discard positional decisions and recompute the remaining diff. State format v6 persists the settled baseline instead of durable hunk decisions.

On v5 migration, an accept-only decision set is folded into the saved baseline when both text images are available. Reject-containing or mixed state is ambiguous because rejection may already have changed and reindexed `cur`; migration preserves disk content and exposes the complete remaining `base` to `cur` delta instead of silently accepting or overwriting content.

## Alternatives considered

**Keep decisions and generate stable hunk hashes.** Rejected because edits near a hunk can still split or merge topology, requiring complex identity and conflict semantics while leaving accepted content outside the baseline.

**Clear decisions whenever the file changes.** Rejected because this directly causes accepted content to reappear against the old baseline.

**Treat ambiguous legacy mixed state as accepted.** Rejected because that could silently approve content the user never accepted. Conservative re-review preserves bytes and user control.

## Verification

Host tests cover accept followed by another agent edit, reject-induced hunk reindexing, accept-then-reject-file, reject-then-accept-file, re-editing an accepted region, CRLF preservation, stale revisions, restart persistence, and v5 migration. Product verification extracts the packaged File Edit Host from the Profile archive and rejects candidates without v6 settlement logic or with the former `decisions.set(hunkId, action)` path.

## Consequences

Previously reviewed content remains settled across later edits and restarts, and bulk actions operate only on the true remaining delta. Ambiguous legacy mixed states may ask the user to review a delta again, but never mutate or silently approve it during migration.
