# DeepSeek Harness desktop builder

English | [中文](README.zh.md)

Desktop Pet is included in both Dev and Stable through `product-channel.cjs`, including assets, bundle registration, native windows and gated IPC. Stable upgrades append the missing pet bundle and dependency in the staged user manifest, backing up its original as `package.json.before-desktop-pet`; unrelated configuration and state remain intact. Dev and Stable builds must run serially because they share build intermediates.

This directory builds the current checkout into a self-contained Apple Silicon macOS application. The application starts the packaged `dsh web` backend on an OS-assigned loopback port, waits for its readiness line, and displays that URL in a hardened Electron window. Closing the application stops and awaits the backend process.

The build packages the current workspace's runtime dependency closure and a copy of the Node executable used for the build. On first launch, the signed runtime archive is extracted into a content-addressed directory under `~/Library/Application Support/DeepSeek Harness`; the installed application does not write into its signed bundle. Later launches reuse that completed extraction. Harness profiles and sessions live in the separate `harness` child directory so Electron's own lock files never enter the Harness file watcher.

Share builds also contain a clean snapshot of the installed Web plugins. On a first launch with no `profiles/web` directory, the desktop shell installs that snapshot before starting Harness. Dev builds record the bundled Profile identifier and atomically replace that product-owned Profile when a replacement build carries a new identifier. Stable builds copy the existing user Profile, overlay the packaged product modules, then atomically switch to the merged copy; user composition files and additional plugins remain intact. Both paths preserve credentials, sessions, workspaces, settings, application logs, and state stores outside the Profile. The snapshot contains plugin packages and a sanitized composition manifest only; user data and machine-specific paths are excluded.

Dev and Stable distribution commands run privacy checks before and after packaging. The source check covers tracked files and untracked files that are not ignored by Git. The release check extracts the packaged Runtime, Profile, and Electron application archive, then rejects personal state files, absolute symlinks, private-key files, and build-machine home paths. Runtime installation may use local package tarballs, but the archived manifest retains only package versions.

The renderer sends its resolved light/dark scheme and computed surface colors through a sandboxed preload bridge. Electron applies the native appearance and window background, while the renderer-owned drag region draws the stable, horizontally centered `Harness` title. Session and workspace changes therefore never alter the macOS window title.

While the packaged runtime and Web backend start, the desktop window renders three broad placeholder regions for the Session list, Explorer, and conversation area. The placeholders intentionally avoid depicting controls or content details. They follow the last light/dark appearance reported by Harness, fall back to the operating-system appearance before any preference exists, and fade before the live Web interface loads. The saved appearance is limited to the validated `light` or `dark` value in `~/Library/Application Support/DeepSeek Harness/appearance-state.json`.

The application stores the last normal window position and size in `~/Library/Application Support/DeepSeek Harness/window-state.json`. Later launches restore that state and use the `1380 × 900` default only when no valid record exists. Restored bounds are constrained when a display is disconnected or its resolution changes, keeping the window on a currently visible screen.

Stable repairs a missing `shellTransactionLifecycle` setting on enabled literal `dsh-file-edit` entries in `cordis.patch.yml`, even when the Profile identifier matches. Explicit values and disabled entries remain authoritative. Migration preserves unrelated YAML values and comments, saves the original patch as `.before-shell-transactions`, and atomically replaces the patch; invalid YAML aborts startup. The packaged upgrade verifier exercises this migration with real Bash writing, deletion, audit records, and rejection recovery in temporary data.

## Build and install

The shared Electron Session allows clipboard writes from the main window's backend origin, including Explorer path copying. Clipboard reads remain denied; microphone access is limited to the owned pet chat page. The assembled clipboard regression runs with `node scripts/clipboard-electron-smoke.mjs` from the Desktop Pet plugin directory.

The [Desktop Pet plugin](../plugins/desktop-pet/README.md) owns companion assets, interaction, and settings. The desktop shell provides its sandboxed transparent window and stores placement separately from the main window. Closing or unloading the owning client releases that window; no language-model request is needed for local interaction.

Build Dev or Stable from the unified repository root:

```sh
npm run product:dist:dev
npm run product:dist:stable
```

Both commands run `scripts/build-product-app.mjs`: rebuild product plugins, create a candidate in the fixed channel staging directory, use the verified local Electron cache, verify application identity, version, build time, packaged feature markers, signing, and privacy, then launch with `--user-data-dir=<absolute-temporary-path>` without credential migration. Only a fully verified candidate replaces `dist/dev` or `dist/stable`; publishing refuses to replace a running channel application and retains the single staging candidate.

A Stable candidate is not installed automatically. Only an explicit `npm run install:stable` copies it to `/Applications/DeepSeek Harness.app`. An existing installation is preserved as `/Applications/DeepSeek Harness.previous.app` when that path is free; later installations use a timestamped `DeepSeek Harness.backup-*.app` path and never overwrite an earlier backup. A failed copy restores the installation it just moved.

The local build does not require an Apple Developer certificate. Internet distribution still requires a Developer ID Application certificate, Hardened Runtime, Apple notarization, and a stapled ticket.

Desktop startup logs are stored at `~/Library/Application Support/DeepSeek Harness/logs/desktop.log`.
