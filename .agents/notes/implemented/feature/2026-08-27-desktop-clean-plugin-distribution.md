# Agent Note: Desktop share builds seed a clean plugin profile

Status: implemented

English | [中文](2026-08-27-desktop-clean-plugin-distribution.zh.md)

## Problem

The packaged desktop runtime contains Harness itself, while locally installed customization plugins live in the user's Web profile. Copying only the application omits those plugins, but copying the live profile would expose sessions, settings, state, credentials, workspace references, machine paths, and development symlinks.

## Decision

The desktop build creates a separate clean profile archive from the product allowlist in `distribution/profile-manifest.json`, the product plugins maintained under `plugins/`, and fixed Harness workspace packages. The build never reads the installed Stable Profile. Local development links are converted through npm package contents, machine paths in generated source annotations are removed, and the generated Profile uses an empty root configuration plus the declared product composition. Runtime installation consumes local package tarballs but rewrites its archived manifest to version-only dependencies. Source privacy checks include tracked files and untracked non-ignored files; the final release check extracts the Runtime, Profile, and Electron application archive and rejects personal state, build-machine paths, private-key files, and absolute symlinks.

On packaged first launch, Electron extracts the archive into `profiles/web` when that directory does not exist and records the bundled Profile identifier beside it. A Dev build whose identifier differs stages and validates the new archive, moves the old Profile to a recoverable backup, commits the replacement and identifier atomically, and restores the backup if the commit fails. Stable applies the [product-module merge decision](../bug-fix/2026-09-01-stable-product-profile-merge.md) so user composition and additional plugins remain present. Runtime and Profile extraction remain separate, and Profile replacement does not touch credentials, sessions, workspaces, settings, review state, Explorer state, or other durable Harness data.

## Alternatives considered

**Zip the currently installed application only.** The recipient would receive the desktop shell and core runtime but not the customization plugins resolved from the local profile.

**Copy the complete application-support directory.** This would preserve the exact local state but would disclose user records and bind the recipient to machine-specific paths.

**Require recipients to install every plugin manually.** This keeps the App small but does not deliver the configured Harness experience the share build is intended to reproduce.

**Never replace an existing Dev Profile.** This preserves arbitrary Dev Profile edits but causes replacement builds to keep running stale product plugins, so newly packaged settings and UI remain absent. Dev therefore treats the bundled Profile as product-owned; Stable retains user composition through a product-module merge.

## Consequences

The share archive is larger because it contains plugin code and required production dependencies. A recipient starts with the selected plugin composition but with empty sessions, workspace state, settings, credentials, and logs. Replacing a Dev build updates product plugins while retaining Dev user data; manual changes inside its generated Profile are intentionally replaced. Stable replaces packaged product modules while retaining its user-authored composition and extra modules. A clean-room boot with an empty environment verifies that the Profile loads without relying on the source workstation, while the [runtime plugin verification decision](../process/2026-09-01-desktop-profile-runtime-verification.md) rejects a candidate whose required Host or Client composition is absent.
