# Browser / File Viewer shared panel — Stage 0 baseline

Recorded on 2026-08-28 (Asia/Shanghai), before implementation of the shared
Browser / file-preview panel.

## Scope

This baseline is read-only with respect to plugin source, Harness settings,
user files, sessions, and installed application contents. No source build,
deployment, App restart, reset, checkout, clean, or user-data deletion was
performed.

The only additions made for Stage 0 are this report and the screenshots in
this directory.

## Versions and running composition

- Source repository: `<legacy-root>/dsh-better-sidebar-fork`
- Git branch: `main`
- Git HEAD: `717df775b2414322a22f6a43017dc01e8784db8d`
- Plugin version: `0.10.25`
- Desktop App: `/Applications/DeepSeek Harness.app`
- Desktop version/build: `0.1.0-rc.5-local.4`
- Active DSH runtime: `<stable-user-data>/runtimes/<runtime-id>`
- Active profile: `<stable-user-data>/harness/profiles/web`
- Profile plugin entry: `link:<legacy-root>/dsh-better-sidebar-fork`
- Resolved profile plugin path: `<legacy-root>/dsh-better-sidebar-fork`
- Running process confirmed from `/Applications/DeepSeek Harness.app`.
- App code signature verification passed.

The active profile therefore consumes this fork through a symlink; it is not
an unrelated copied plugin directory.

## Protected pre-existing worktree

Before this baseline directory was added, `git status --short` contained 49
pre-existing entries. The tracked diff summary was:

```text
33 files changed, 3129 insertions(+), 442 deletions(-)
```

These changes include the current Explorer, Browser-only rail, file routing,
settings, state, host routes, tests, documentation, and newly added source
files. They are treated as user-owned work and were not modified or reverted
by Stage 0.

## Current sidebar settings

The active `dsh-better-sidebar` settings resolve to:

```yaml
tabsEnabled:
  editor: false
  git: false
  subagent: false
  terminal: false
  browser: true
  diff: false
interceptOpenPath: true
browserInterceptLinks: false
bottomPanelAutoTerminal: false
autoOpenSubagent: false
autoOpenJobs: false
```

`explorer` is absent from `tabsEnabled`, which means enabled. No viewer is
explicitly disabled in `viewersEnabled`.

## Automated baseline

Commands were run from the source repository:

```text
pnpm test
  PASS — 37 test files, 449 tests

pnpm typecheck
  PASS — tsc --noEmit
```

No build was run because the package build begins by replacing `lib/`; Stage
0 is intended to preserve the current artifact plane unchanged.

Existing artifacts observed without modification:

```text
lib/client.js  441098 bytes  2026-08-27 18:30:38 +0800
lib/index.js   115191 bytes  2026-08-27 18:30:37 +0800
```

## UI baseline

All screenshots are 1389 × 769 pixels and were captured from the installed
DeepSeek Harness App.

1. `01-explorer-and-conversation.png`
   - Explorer is visible between the session list and conversation.
   - Explorer quick marks, uncommon-file visibility toggle, collapse action,
     folders, and files are visible.
   - Browser rail is closed.
2. `02-browser-panel.png`
   - Browser rail opens on the right.
   - A Browser tab, close button, new-tab button, navigation controls, address
     field, and content area are visible.
3. `03-files-workspace-with-browser.png`
   - The top-level `文件` workspace renders an existing text/code file.
   - The right Browser rail remains open at the same time.
   - This confirms the two surfaces currently coexist spatially, although
     file viewers do not yet share the Browser tab strip.

Screenshot SHA-256 values:

```text
a63043622a0f5bb633fa9375c8d1e5890762a3e7a19e67a6e52e4a867c0d73a7  01-explorer-and-conversation.png
4f17385be986c3cbd7f3c8aea68f8a44a99446d732bfbfae514cc1512e47939a  02-browser-panel.png
f102ab80de94071481e5899d43637f918d2cfad9f50d15b0d15d8f31268be399  03-files-workspace-with-browser.png
```

After capture, the UI was restored to the conversation workspace with the
Browser rail closed. No message was sent and no file content was edited.

## Stage 0 result

- Runtime/source ownership is confirmed.
- The active plugin is the requested fork.
- Explorer, Browser, and the top-level File workspace render successfully.
- Browser and the File workspace can be visible concurrently.
- The pre-development automated baseline is green.
- Existing user changes remain intact.
