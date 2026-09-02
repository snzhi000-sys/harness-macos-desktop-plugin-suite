# Agent Note: Thinking history replay and recovered failure status

Status: implemented

English | [中文](2026-09-02-thinking-history-replay-and-error-recovery.zh.md)

## Problem

DeepSeek thinking requests could accept one assistant response and then reject the next tool step because earlier assistant history omitted `reasoning_content`. Separately, a structurally valid pi-ai replay record could contain a terminal partial block absent from the finalized Harness message, causing every later request in that session to fail before reaching a provider. A durable turn failure also continued to look current after a later answer succeeded.

## Decision

The DeepSeek adapter resolves thinking mode before serializing history. Every assistant message in a thinking-enabled request carries `reasoning_content`: recorded reasoning is replayed verbatim and an assistant message without reasoning carries an empty string. Thinking-disabled requests omit the field.

The pi-ai adapter keeps strict validation for replay format and source provider/model identity. When finalized Harness blocks are an ordered subset of the native terminal response, replay keeps the matching private metadata and ignores unfinished surplus blocks. When they cannot align, the adapter converts the durable message to foreign provider-neutral history instead of rejecting every later request.

Terminal turn failures remain durable historical facts. A later finalized text answer changes an earlier failure row to a recovered status, while a new Agent run clears the prior unpositioned live error. Repeated identical live notifications do not republish unchanged state.

## Alternatives considered

**Replay reasoning only for assistant messages containing tool calls.** Rejected because DeepSeek validates every assistant history entry in a thinking-mode request, including ordinary answers from earlier steps or turns.

**Reject every replay/content mismatch.** Rejected because a native terminal response can contain an unfinished block that never became durable Harness content; preserving strict failure here turns one partial response into a permanently unusable session.

**Delete or hide historical failures after success.** Rejected because `turn/end(error)` is an authoritative session fact. The recovered presentation preserves that fact while distinguishing it from the current run.

## Verification

Serializer tests cover thinking-enabled and disabled history, reasoning-bearing and reasoning-free assistant messages, tool calls, and reasoning-only responses. pi-ai conversion tests cover ordered-subset metadata recovery, safe foreign fallback, malformed metadata, and provider/model identity checks. Client tests cover recovered failure rendering and live-error invalidation on a new run. Product App verification inspects the packaged Runtime and Client bundles for these behaviors before publishing the fixed Dev output.

## Consequences

Thinking-enabled follow-up requests carry more input because prior reasoning is replayed as required by the provider. Sessions with stale but structurally valid pi-ai replay metadata remain usable, at the cost of dropping provider-private reuse metadata when alignment is impossible. Historical failures remain visible but no longer present themselves as the latest outcome after recovery.
