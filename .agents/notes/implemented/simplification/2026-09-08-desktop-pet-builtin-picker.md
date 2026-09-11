# Agent Note: Built-in companion picker

Status: implemented

English | [中文](2026-09-08-desktop-pet-builtin-picker.zh.md)

## Problem

The expanding character library pushes controls below the viewport. Retained searches and technical filters can make the library look limited to three entries. Import paths, Core settings, PNG mode, and editable action bindings impose setup work on a user who only wants to choose a companion.

## Decision

Use a independently scrolling, searchable character list beside one live portrait and basic settings. A row click saves and switches the character immediately. Save commits size, animation, and always-on-top without changing visibility. Show and Hide control visibility; the modal close icon and Escape release the preview. The footer remains visible at compact window sizes.

The local Dev plugin contains 22 Live2D versions and Mengmei, profiles, thumbnails, and Cubism runtimes. A relative catalogue with stable IDs is the resource authority. Developers extend this catalogue and rebuild the plugin; user data stores basic preferences, not required model files. This supersedes the external-asset and PNG-mode choices in the [native ownership note](../feature/2026-09-07-desktop-pet.md).

Remove PNG rendering, direct-path and Core fields, technical filters, directory import, profile editing, and session binding from the product. Version 1 disk migration retains size, toggles, and the selected character by matching the old private index name; it leaves private files intact and writes only version 2 fields. Current HTTP writes reject removed fields.

## Alternatives considered

**Hide technical fields behind an advanced panel** retains the configuration burden and unused renderer paths. The user explicitly requested their removal.

**A larger card grid** still competes with the portrait and settings for vertical space. A dedicated list makes every entry reachable while retaining visible controls.

**Copy the existing user library into the package** risks private paths and preferences entering product artifacts. The resource preparation script instead uses the fixed research sources and curated playback profiles. Public distribution remains separate from this local Dev packaging.

## Verification

A clean-data assembled Client snapshot and browser smoke cover all 19 character rows and 23 outfit resources, the last row, search and empty results, both window sizes, basic settings, Escape, explicit close, delayed switch completion, and disposal. Host tests reject removed fields and endpoints, preserve migrated preferences, and constrain resource paths. The native smoke covers transparency, dragging, resize, paused frames, restart, hide/show, and unloading. The packaged smoke starts with empty user data, hashes the shipped source and catalogue, and exercises built-in models.

## Consequences

Character variants are not distinct people. Explicitly verified Mori and Kasumi identities group bundled outfit models under one row. Outfit switching uses the same serialized model selection and persists its stable ID without new preference fields. Unknown identities remain separate; cloth physics parameters alone do not prove an authored costume switch. Authored action availability still varies by model; no missing rig or expression is synthesized. The source remains reusable, but the ignored local asset payload must be supplied before building and is not a public redistribution grant. Resource changes require a new Dev build. A single preview exists per modal; closed or disposed views reject late updates. Settings mutations are serialized so saving controls does not overwrite an overlapping character selection.
