# Agent Note: Project logged user messages before long history finished loading

Status: implemented

English | [中文](2026-09-01-immediate-user-message-during-history-load.zh.md)

## Problem

When a conversation had a large history window, its tail-page request could still be pending after the Host had accepted and logged a newly sent user message. The Runtime buffered the corresponding live `session/event` without publishing a conversation snapshot, so the message could remain invisible until history completed or a later model event caused another update.

## Decision

While the initial history request is loading, each authoritative live event is retained in the existing sequence buffer and also projected immediately into the conversation assembler. The history response still replaces the temporary projection atomically, then stitches buffered events under the normal event-sequence guard. The client does not manufacture an optimistic message before Host log admission.

Gap repair keeps its previous behavior. Because a sequence gap represents an unknown range in an already-open window, its events remain buffered until the repair page restores continuity.

## Alternatives considered

**Insert a client-only optimistic user message when Enter is pressed.** Rejected because prompt rejection, reconnects, attachments, and cross-client events would require a second identity and rollback protocol and could display content that never entered model-visible history.

**Wait for the prompt RPC response and then append locally.** Rejected because it duplicates the authoritative mux path and can race the same logged event, while the response timing is not the conversation publication contract.

**Project gap-repair events immediately too.** Rejected because Definitions require a contiguous loaded event window; projecting across an unknown sequence range could derive invalid conversation contexts.

## Verification

The Runtime session test holds a history request open, delivers `turn/start` and `user/message`, and proves the user node is visible before the request resolves. It then resolves the older page and proves the final sequence is ordered and contains the new user message exactly once.

## Consequences

Logged user messages appear immediately even while a large conversation is loading. Model execution remains asynchronous, history remains authoritative, failed sends still restore the draft through the existing input path, and history stitching cannot duplicate the message.
