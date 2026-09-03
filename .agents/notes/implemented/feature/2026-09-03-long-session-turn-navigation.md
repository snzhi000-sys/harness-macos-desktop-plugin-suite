# Agent Note: Long sessions keep a bounded whole-log turn navigator

Status: implemented

English | [中文](2026-09-03-long-session-turn-navigation.zh.md)

## Problem

The Chat window intentionally loads only a safe, contiguous history tail. In a long Session this keeps startup bounded, but it leaves old turns undiscoverable until the reader repeatedly requests earlier pages. Rebuilding every row for each streamed delta also makes a large loaded window needlessly expensive.

## Decision

The Host registers a `turnOutline` projection over the complete authoritative Session log. Each turn retains only its number, `turn/start` sequence, open or closed status, and 160-character prompt and settled-response previews. Tool output, attachments, and file content are excluded. The projection reaches the Client through the existing projection carrier, so `ctx.sessions`, the Conversation slots, and the Session event format stay unchanged.

Chat renders a memoized rail from that projection. A loaded turn points at a stable Conversation node key; an unloaded turn points at its `turn/start` sequence. Selecting an unloaded turn asks the existing Session pager to load backwards in bounded 250-message pages until the contiguous window covers the target, holds the reader's semantic scroll anchor while pages prepend, and lands only after a real target row exists. A reader-owned ordinary page keeps the target pending and starts one deep read only after releasing the pager; a failed or progress-free read does not loop. Navigation never estimates row height or retries writes.

Streaming events continue through the existing animation-frame notifier, incremental Markdown parser, and keyed node store. Stable real row geometry remains mounted because intrinsic-size paint containment makes restored reader anchors drift before the browser has measured an off-screen row.

## Alternatives considered

**Replace the local conversation UI with upstream `ui-chat`.** The local package still owns product-specific slots, immediate authoritative message display, Better Sidebar turn-tail integration, and File Edit hooks. A wholesale replacement would widen compatibility risk beyond turn navigation.

**Import packed journal transport together with navigation.** The upstream transport depends on handle-based journal persistence that this product intentionally did not adopt in phase 1. Importing it alone would bypass the JSONL full cold inspection and invalidate the local salvage guarantees.

**Load the complete Session log into the Client.** This makes navigation trivial but transfers and retains large tool output, attachments, and file content. The bounded Host projection provides the needed index without duplicating the log.

**Virtualize rows by estimated height.** Markdown, code blocks, images, review panels, and plugin cards have unstable heights. Estimation would make prepend and jump landings drift. Keeping real rows mounted retains exact layout and semantic anchors with less behavioral risk.

**Apply `content-visibility` with a fixed intrinsic height to every Chat row.** A remounted off-screen row has no remembered measured height, so restored session positions move when its real layout replaces the placeholder. Stable geometry wins over that paint optimization until row heights have a session-owned exact cache.

## Consequences

Long Sessions gain immediate turn discovery and one-action navigation without changing plugin event contracts. Projection size grows with turn count but remains bounded per turn and independent of tool-output size. A deep jump may issue several read-only history requests and temporarily grow the loaded window; it does not replay any operation. The current transport still serializes raw history pages, so packed journal transport remains a separate future migration that must preserve the JSONL safety checks.
