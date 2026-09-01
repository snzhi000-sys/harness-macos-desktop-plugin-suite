# Agent Note: Validated session history tail cache

Status: implemented

English | [中文](2026-08-31-validated-session-history-tail-cache.zh.md)

## Problem

The Web client requests only the latest 50 messages for a cold conversation, but the Host previously obtained that page by fully decoding, validating, freezing, and folding the complete JSONL session before pagination. Large append-only histories therefore paid full reconstruction cost on every process restart even though first paint used only the tail.

## Decision

The persistence seam exposes `readHistoryTail(id, maxMessages, signal?)`. Its default implementation performs the established full `inspect()`, so backends gain no weaker implicit behavior. The JSONL backend stores a rebuildable 50-message tail cache after a full cold inspection and reuses it only when the main log's complete stat-derived revision and the current build's supported-event-type set match. The cache carries a contiguous visible tail, the latest earlier `agent-preset/selected` event as reconstruction context, the final seq, and the `hasMore` fact.

The Host uses a cached cold tail only for a `session.history` tail-page request. When a projection registry is mounted, the persisted projection cache must describe the same final seq; a missing or older projection cut forces full inspection. Resume, fork, subagent continuation, model reconstruction, crash repair, older-page reads, and every other complete-log consumer continue to use `inspect()`, `prepare()`, `load()`, or `readFrom()`.

The main session log remains the only authority. Missing, malformed, stale, or build-incompatible tail caches fall back to full inspection and are rebuilt fail-soft. Cache files never repair or mutate the log.

## Alternatives considered

**Decode the final Zstandard frames without a prior validation record.** Rejected because structural frame scanning and a locally contiguous suffix cannot prove earlier required event types, seq continuity, or the preset and projection state that the page must present.

**Use an unvalidated fast page and verify the complete log in the background.** Rejected because the UI could briefly present a transcript that the persistence contract later refuses, while fork or resume might race the verification result.

**Build a mandatory byte-offset index into the authoritative session format.** Rejected for this iteration because it expands append, repair, truncation, and compatibility behavior. A disposable exact-revision cache provides the restart benefit without changing the session format.

## Consequences

An existing session pays one full cold inspection before its first cache is available; later unchanged process restarts can render its first 50-message page without decoding the complete JSONL artifact. Any append, repair, cache damage, event-support change, or projection lag deliberately restores the old cost for one read. The additional file is bounded by the rendered tail rather than total session size and can always be deleted or regenerated without losing session data.

## Verification

Pure pagination tests cover append-origin quotas, replacement exclusion, preset context, and invalid limits. JSONL integration coverage exercises cache creation, exact-revision reuse, and corrupt-cache fallback. Host coverage pins the no-full-inspection cold-tail path. Existing persistence, cold-history recovery, presenter, pagination, and projection suites remain the regression owners for the unchanged full-log paths.
