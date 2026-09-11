# Agent Note: Desktop Pet in local Stable builds

Status: implemented

English | [中文](2026-09-09-stable-desktop-pet.zh.md)

## Problem

The user now wants the tested desktop companion in the installed Stable App. Copying its package alone cannot mount it in an older preserved Stable composition.

## Decision

Both product channels include Desktop Pet, native window files and microphone usage metadata. Stable profile upgrades append the bundled pet dependency and bundle to the staged user manifest, retaining the original manifest backup and unrelated configuration. Existing pet entries are not duplicated. The merged profile uses the existing atomic commit and rollback path. Tests run with isolated data and no real provider requests.

## Alternatives considered

**Keep Dev-only distribution:** This no longer matches the user's explicit request.

**Replace the entire Stable profile:** This would overwrite unrelated user configuration and additional plugins.

## Consequences

Local Stable can expose the same companion UI and restricted IPC as Dev. Existing channel-specific settings and credentials are not copied between channels. Microphone access still requires macOS consent when used. Local installation does not authorize public redistribution of character assets. Regression covers product selection, additive upgrade and native packaged windows.
