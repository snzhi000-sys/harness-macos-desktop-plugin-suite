# Agent Note: Merge packaged product modules into the Stable user Profile

Status: implemented

English | [中文](2026-09-01-stable-product-profile-merge.zh.md)

## Problem

Stable users keep credentials, sessions, custom patches, and additional plugins in a long-lived application environment. Leaving its Web Profile untouched preserves customization but also keeps stale product modules after the App is replaced, so packaged fixes and settings can remain absent.

## Decision

The desktop bootstrap records the packaged Profile identifier beside `profiles/web`. When a Stable package carries a different identifier, it extracts and validates the clean product Profile, copies the existing Stable Profile to staging, and recursively overlays only the packaged `node_modules` entries. The existing `package.json`, `cordis.yml`, `cordis.patch.yml`, additional modules, and all data outside the Profile remain unchanged. It atomically swaps the merged staging copy into place through a recoverable backup and restores the old Profile on failure. A matching identifier skips extraction and merging.

## Alternatives considered

**Replace the complete Stable Profile.** Rejected because it removes the user's bundle list, patches, and third-party plugins.

**Never update Stable Profile contents.** Rejected because replacing the App would continue to run stale product modules and omit packaged product behavior.

**Load product plugins directly from the source workspace.** Rejected because an installed App must remain self-contained and must not depend on a developer checkout.

## Verification

Desktop tests prove that the merge replaces a product module while preserving user composition, patches, a personal plugin, credentials, and sessions. The Profile Runtime verifier continues to prove the clean packaged composition before Electron packaging.

## Consequences

Stable App replacement updates packaged product plugins without resetting Keys, sessions, state, or the user's plugin composition. A packaged dependency name that collides with an extra plugin is product-owned and is replaced. Package-manager operations performed manually inside the Stable Profile can still rewrite installed modules and require the next packaged identifier to repair them.
