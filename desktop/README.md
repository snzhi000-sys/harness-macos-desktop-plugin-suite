# DeepSeek Harness desktop builder

English | [中文](README.zh.md)

This directory builds the current checkout into a self-contained Apple Silicon macOS application. The application starts the packaged `dsh web` backend on an OS-assigned loopback port, waits for its readiness line, and displays that URL in a hardened Electron window. Closing the application stops and awaits the backend process.

The build packages the current workspace's runtime dependency closure and a copy of the Node executable used for the build. On first launch, the signed runtime archive is extracted into a content-addressed directory under `~/Library/Application Support/DeepSeek Harness`; the installed application does not write into its signed bundle. Later launches reuse that completed extraction. Harness profiles and sessions live in the separate `harness` child directory so Electron's own lock files never enter the Harness file watcher.

Share builds also contain a clean snapshot of the installed Web plugins. On a first launch with no `profiles/web` directory, the desktop shell installs that snapshot before starting Harness. It never replaces an existing profile. The snapshot contains plugin packages and a sanitized composition manifest only; session logs, workspaces, credentials, settings, application logs, state stores, and machine-specific paths are excluded.

The renderer sends its resolved light/dark scheme and computed surface colors through a sandboxed preload bridge. Electron applies the native appearance and window background, while the renderer-owned drag region draws the stable, horizontally centered `Harness` title. Session and workspace changes therefore never alter the macOS window title.

While the packaged runtime and Web backend start, the desktop window renders three broad placeholder regions for the Session list, Explorer, and conversation area. The placeholders intentionally avoid depicting controls or content details. They follow the last light/dark appearance reported by Harness, fall back to the operating-system appearance before any preference exists, and fade before the live Web interface loads. The saved appearance is limited to the validated `light` or `dark` value in `~/Library/Application Support/DeepSeek Harness/appearance-state.json`.

The application stores the last normal window position and size in `~/Library/Application Support/DeepSeek Harness/window-state.json`. Later launches restore that state and use the `1380 × 900` default only when no valid record exists. Restored bounds are constrained when a display is disconnected or its resolution changes, keeping the window on a currently visible screen.

## Build and install

Run from this directory on an Apple Silicon Mac:

```sh
npm install
npm run install:mac
```

The command creates an ad-hoc-signed application and copies it to `/Applications/DeepSeek Harness.app`. An existing installation is preserved once as `/Applications/DeepSeek Harness.previous.app`; the installer refuses to overwrite that backup.

The local build does not require an Apple Developer certificate. Internet distribution still requires a Developer ID Application certificate, Hardened Runtime, Apple notarization, and a stapled ticket.

Desktop startup logs are stored at `~/Library/Application Support/DeepSeek Harness/logs/desktop.log`.
