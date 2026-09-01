# Agent Note: Desktop share builds seed a clean plugin profile

Status: implemented

English | [中文](2026-08-27-desktop-clean-plugin-distribution.zh.md)

## Problem

The packaged desktop runtime contains Harness itself, while locally installed customization plugins live in the user's Web profile. Copying only the application omits those plugins, but copying the live profile would expose sessions, settings, state, credentials, workspace references, machine paths, and development symlinks.

## Decision

The desktop build creates a separate clean profile archive from the product allowlist in `distribution/profile-manifest.json`, the product plugins maintained under `plugins/`, and fixed Harness workspace packages. The build never reads the installed Stable Profile. Local development links are converted through npm package contents, machine paths in generated source annotations are removed, and the generated Profile uses an empty root configuration plus the declared product composition. The archive build rejects personal path remnants and absolute symlinks.

On packaged first launch, Electron extracts the archive into `profiles/web` only when that directory does not exist. Existing profiles are never replaced. Runtime extraction and profile extraction remain separate so plugin composition does not acquire ownership of sessions or other durable Harness state.

## Alternatives considered

**Zip the currently installed application only.** The recipient would receive the desktop shell and core runtime but not the customization plugins resolved from the local profile.

**Copy the complete application-support directory.** This would preserve the exact local state but would disclose user records and bind the recipient to machine-specific paths.

**Require recipients to install every plugin manually.** This keeps the App small but does not deliver the configured Harness experience the share build is intended to reproduce.

## Consequences

The share archive is larger because it contains plugin code and required production dependencies. A recipient starts with the selected plugin composition but with empty sessions, workspace state, settings, credentials, and logs. A clean-room boot with an empty environment verifies that the Profile loads without relying on the source workstation, while the [runtime plugin verification decision](../process/2026-09-01-desktop-profile-runtime-verification.md) rejects a candidate whose required Host or Client composition is absent.
