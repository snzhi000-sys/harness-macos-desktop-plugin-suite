# Agent Note: macOS Electron desktop wrapper

Status: implemented

English | [中文](2026-08-14-macos-electron-desktop-wrapper.zh.md)

## Problem

The shipped Web profile requires a Node process and a browser, so a static Web bundle cannot provide terminal, filesystem, session, or model capabilities. A Finder-launched application must also work without the checkout, system Node or pnpm, survive a read-only signed application bundle, and stop its backend without leaving an orphan process.

## Decision

The root-level `desktop` builder produces an Apple Silicon Electron application around the existing `dsh web` profile. Its BrowserWindow enables context isolation and renderer sandboxing, accepts navigation only to the loopback backend origin, and opens every other URL through macOS.

The build packs the current checkout's transitive runtime workspace packages, installs their production closure, copies the build machine's Node executable, and stores that runtime as a signed gzip archive. The application extracts each archive into a content-addressed directory below its Application Support directory and publishes a completion marker only after extraction succeeds. Harness profiles and sessions use a separate `harness` child directory so Electron lock files never enter the Harness file watcher.

The main process starts `dsh web` on an OS-assigned loopback port and treats its settled URL line as readiness. Application quit sends SIGTERM and awaits backend exit before completing; an eight-second fallback sends SIGKILL. Finder-safe executable paths include the embedded runtime and standard Homebrew and system locations.

The macOS window uses `hiddenInset` native chrome and a renderer-owned 32-pixel drag region. The renderer keeps the stable `Harness` label at 50% of the complete window width, independently of the traffic-light controls. A sandboxed preload bridge accepts only the resolved light/dark scheme and computed surface colors from the Harness UI. The main process applies that scheme through Electron's native theme and updates the window background, so changing Appearance in Harness updates both renderer and desktop chrome without exposing Node APIs to the page. Page title updates are prevented from replacing the stable application title.

Local builds use Electron Builder's Hardened Runtime entitlements and an ad-hoc signature. The installer preserves an existing application before copying and retains framework-relative symbolic links so copying does not invalidate the signature.

## Alternatives considered

**A Finder launcher over the checkout.** Rejected because moving the repository or changing its Node and pnpm installation would break the application.

**A static WebView or installed PWA.** Rejected because the Web frontend is not a standalone application and cannot replace the Node Host capabilities.

**SwiftUI, WKWebView, or Tauri with a Node sidecar.** Rejected because Harness still requires Node, while Electron already owns a compatible Web window and process distribution model. A second native runtime would add packaging work without removing the Node runtime.

## Consequences

The installed application launches independently from `/Applications`, keeps runtime and user writes outside its signed bundle, and reuses an extracted runtime after first launch. Its title remains horizontally centered and its chrome follows the Harness appearance setting at runtime. The application is currently an arm64 local build, and its runtime archive increases application and first-launch disk use. Ad-hoc signing supports local installation without disabling Gatekeeper, but Internet distribution still requires a Developer ID Application certificate, Apple notarization, and a stapled ticket.
