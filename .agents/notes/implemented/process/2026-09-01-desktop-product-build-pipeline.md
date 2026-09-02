# Agent Note: Make desktop product packaging fail closed

Status: implemented

English | [中文](2026-09-01-desktop-product-build-pipeline.zh.md)

## Problem

The Dev and Stable commands were long shell chains that did not rebuild product plugins or verify the final application's channel metadata and packaged UI behavior. A previous application could therefore remain visible while a new build was incomplete, and an old Client bundle could survive a source change. Temporary launch verification also used an argument form that Electron helpers did not honor and triggered legacy Dev credential migration.

## Decision

`desktop/scripts/build-product-app.mjs` owns both channels. It rebuilds the Harness Host and Client libraries before preparing Runtime, rebuilds and tests product plugins, runs desktop and privacy checks, prepares Runtime and Profile, verifies actual Cordis and Client composition, writes release metadata, uses a validated local Electron distribution, and builds into one fixed per-channel staging directory. `verify-product-app.mjs` checks Bundle ID, product name, packaged channel, version, build time, signing, current Better Sidebar feature markers, and selected Harness Client Runtime behavior markers. `verify-product-launch.mjs` starts the candidate with `--user-data-dir=<absolute-path>`, requires packaged Runtime and Profile startup, rejects credential migration, then terminates only its own process and removes its temporary data.

Publishing replaces only the fixed `dist/dev` or `dist/stable` directory after every check passes. A running target application blocks replacement and leaves the one fixed staging candidate for inspection. After that application is closed, `product:publish:candidate:dev` or `product:publish:candidate:stable` repeats candidate privacy, identity/feature, and isolated-launch verification before publishing the retained bundle, without rebuilding unrelated dependencies. Stable construction remains separate from explicit installation.

## Alternatives considered

**Keep the package.json shell chain.** It cannot express final-candidate assertions or safely publish only after isolated startup.

**Trust source diffs or built package presence.** Neither proves that the packaged Profile contains the rebuilt Client bundle.

**Reuse normal Dev userData for startup verification.** This hides first-install defects and can mistake existing credentials or Profile state for packaged behavior.

## Consequences

Desktop packaging takes longer because it rebuilds Harness libraries and product plugins and performs a real isolated launch, but source changes cannot silently reuse stale Runtime libraries and every delivered path identifies a completed candidate. Dev and Stable outputs remain separate and overwrite only their own previous candidate. Release metadata and selected product behavior are now machine-checked before publication.
