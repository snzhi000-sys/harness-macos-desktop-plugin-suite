# Agent Note: External Views in Blank Sessions

Status: implemented

English | [中文](2026-08-17-blank-session-external-conversation-views.zh.md)

## Problem

The blank-session Hero hid the session header and returned no strict session body. A plugin could open its own conversation view only by finding and clicking its rendered tab button, but that button did not exist in a new blank session. Explorer file opens therefore updated plugin-local state yet showed no file. The file plugin's global state could also retain the prior session's active file.

## Decision

`ConversationController` now exposes scope-addressed `activateView(viewId)`. A per-session activation coordinator mirrors the active id for the resident shell, binds it to the framework-owned chat store, and queues requests made before that store mounts. External views do not change the Host's blank flag or synthesize conversation content.

The resident shell uses the mirrored view when choosing its layout. Blank Chat retains the centered Hero and hidden header/body. A blank session with an external view uses the active layout, shows the ordinary header and requested view, and keeps the same composer in its docked posture. Returning to Chat restores the Hero.

Explorer opens carry the target session id, resolved cwd, absolute path, and workspace-relative path. The file plugin switches its in-memory tab set to that session before opening and activates its view through the controller; tabs and the active file are cached separately per session.

## Verification

Focused UI tests cover unchanged blank Chat behavior and rendering an external view in a blank session. Coordinator tests cover pre-mount requests, persisted selections, and session isolation. The conversation client typecheck and focused test suites pass. Better Sidebar typecheck and build pass, and the file plugin client bundle builds.

## Consequences

Conversation view plugins no longer depend on localized labels or rendered DOM to activate themselves. A blank session can host non-Chat tools without becoming a non-blank conversation, and file tabs cannot leak between tasks during the browser lifetime.
