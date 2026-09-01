# Agent Note: Keep Dev settings isolated and reuse Explorer workspace listings

Status: implemented

English | [中文](2026-09-01-dev-data-and-workspace-explorer-cache.zh.md)

## Problem

The packaged Dev application previously derived Electron user data from an unintended package name, so its model credentials and preferences appeared to disappear after channel-correct builds. Explorer also treated a conversation switch as a directory-data identity change even when both conversations belonged to the same workspace, causing avoidable tree reloads.

## Decision

The desktop main process selects `DeepSeek Harness Dev` before reading `userData`; packaged Dev builds therefore consistently use `~/Library/Application Support/DeepSeek Harness Dev`, independently of Stable. `migrateLegacyDevData()` performs a one-time, non-overwriting migration from the historical `@deepseek-ai/dsh-desktop-builder` Dev location. It copies only credentials, settings, workspace preferences, and Explorer marks/visibility records. Profiles, Runtime files, sessions, logs, and review data remain excluded.

Better Sidebar owns a renderer-lifetime `Map` of loaded Explorer levels keyed by workspace root. A conversation switch under that root restores the existing snapshot and uses the new session only as request authority. The visible-directory poll remains active for external changes. Rename, move, and delete update the same root snapshot, and a response for an old root cannot repaint the current tree.

## Alternatives considered

**Reuse Stable user data for Dev.** Rejected because a Dev package could modify live credentials, sessions, preferences, or Profiles.

**Copy the complete legacy Dev directory.** Rejected because it can reintroduce a broken Profile or Runtime and carries private session and review data into the new environment.

**Persist Explorer listings to disk.** Rejected because listings are a short-lived UI cache; stale disk state creates an invalid view after filesystem changes and offers no benefit over the existing poll.

**Cache by session id.** Rejected because directory contents belong to a workspace root rather than one conversation.

## Verification

Desktop tests prove the allowlisted migration excludes legacy Profile and sessions and never overwrites existing Dev credentials. Better Sidebar tests prove same-root reuse and root isolation. Type checking covers Explorer cache integration.

## Consequences

Dev users configure credentials once per Dev channel and retain them across replacement builds without exposing Stable data. A legacy Dev configuration is imported at most once; later manual changes in either directory are intentionally independent. Explorer changes conversations within a workspace without an initial duplicate listing fetch, while its periodic refresh continues to surface real filesystem changes.
