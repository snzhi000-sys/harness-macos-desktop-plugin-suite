# Agent Note: Verify desktop product plugins at runtime

Status: implemented

English | [中文](2026-09-01-desktop-profile-runtime-verification.zh.md)

## Problem

A desktop Profile can contain an npm package without mounting its Cordis patch or publishing its Client bundle. Archive membership and backend readiness therefore do not prove that the product plugins required by the customized desktop application are available.

## Decision

`distribution/profile-manifest.json` names every required product plugin with its package name, Cordis entry id, and Client requirement. The desktop packaging commands run `verify:profile-runtime` after preparing the [clean product Profile](../feature/2026-08-27-desktop-clean-plugin-distribution.md) and Runtime and before invoking Electron Builder.

The verifier extracts both archives into a newly created temporary directory, checks the Profile bundle order and package identities, composes the effective Cordis configuration with the packaged Runtime, and starts an isolated Web backend. It rejects the build when a required Cordis entry or required Client bundle is absent. The temporary backend and files are removed after verification.

The required set is Workspace Lineage, Better Sidebar, Cowork, Message Edit, and File Edit. Cowork is Host-only; the other four must also appear in the Web boot manifest.

## Alternatives considered

**Check only `node_modules`.** This proves package installation but misses failed or omitted Cordis composition and Client discovery.

**Use the developer's Stable Profile as the release template.** This would hide missing product declarations and could copy personal plugins, paths, state, or credentials into the application.

**Rely on manual UI testing.** Manual testing remains useful for product behavior, but it is too late and too easy to skip as the only packaging safeguard.

## Consequences

Desktop packaging performs one additional isolated backend startup and archive extraction. A Dev or Stable candidate cannot be produced when any required customized plugin is missing from its actual runtime composition. User data and the installed Stable application remain outside the verification input.
