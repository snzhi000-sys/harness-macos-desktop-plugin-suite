# dsh-lark-cli

English | [中文](README.zh.md)

`dsh-lark-cli` exposes a single structured `lark_cli` Host tool. It executes a fixed, trusted `lark-cli` binary with an argv array, never through a shell.

The first release allows selected `auth`, `docs`, `drive`, `wiki`, and `markdown` shortcuts. Raw `api`, configuration/profile changes, self-update, embedded skill reads, directory sync, clipboard/URL ingestion, caller-selected output paths, background processes, and persistent terminals are unavailable. Ordinary document creation, updates, imports, uploads, and other non-destructive writes run directly. Destructive, rollback, logout, and access-removal operations require one-time Harness approval and fail closed without a grant. Upload paths are realpath-checked and normalized beneath the current workspace, while the child can write only the lark-cli credential/state directory and a private temporary directory.

Output is bounded and credential-shaped access and refresh tokens are redacted. OAuth `auth login --no-wait` preserves the short-lived device code because the documented second-step `auth login --device-code` flow needs it.

This plugin does not use a shell and cannot modify workspace files.
