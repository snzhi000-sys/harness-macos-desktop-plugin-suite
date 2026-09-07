# Agent Note: Controlled lark-cli Host tool

Status: implemented

English | [中文](2026-09-04-controlled-lark-cli.zh.md)

## Problem

The strict File Edit guard correctly blocks writable raw shells, but `lark-cli` must refresh OAuth state beneath the user's macOS Application Support directory before it can upload documents. Running it through `shell_readonly` therefore fails, while relaxing the shell guard would let arbitrary processes bypass the file-review ledger.

## Decision

The product ships a separate Host-only `dsh-lark-cli` plugin. Its single `lark_cli` tool accepts an argv array and executes a fixed trusted binary through `ctx.subprocess` and a full `ctx.sandbox` confinement. The writable root is the lark-cli state directory; system temp remains available by the sandbox contract, and the current workspace remains read-only to the child.

Only an explicit matrix of `auth`, `docs`, `drive`, `wiki`, and `markdown` shortcuts is accepted. Raw API/resource commands, profile/config mutation, self-update, skill reads, directory sync, clipboard or URL ingestion, caller-selected output paths, background execution, and terminals are rejected. Upload paths and `@file` payloads are realpath-checked and normalized beneath the calling session workspace. Shell metacharacters remain ordinary argv data.

Remote writes require `ctx.approval.request()` and proceed only on `allowed-once`. Output is bounded and credential tokens are redacted; the short-lived OAuth device code is preserved only for the documented two-step login flow. The subprocess receives a minimal environment and has a bounded lifetime with managed tree termination.

## Alternatives considered

**Allow `bash` only for lark-cli-shaped command text.** Rejected because command parsing cannot constrain dynamic programs, environment behavior, helpers, redirects, or later CLI escape hatches.

**Add a generic writable shell rooted at the credential directory.** Rejected because arbitrary executables would still gain network and state side effects unrelated to Lark, with no command-specific approval or path validation.

**Put an exception inside dsh-file-edit.** Rejected because external-service authorization is not file-review ownership and would couple two independent security boundaries.

## Verification

Plugin tests cover the command matrix, exact argv transport, path and symlink containment, approval outcomes, dry-run behavior, full-sandbox enforcement, timeout cancellation, output redaction, and registration. Product Profile verification checks the packed module's schema and prompt registration in addition to package identity and Cordis composition. Existing File Edit tests retain the monotonic raw-shell guard.

## Consequences

Harness agents can perform approved Feishu/Lark writes and OAuth refreshes without obtaining a writable raw shell. Workspace mutations still flow through the File Edit review tools. The first version intentionally does not download artifacts into the workspace or expose every lark-cli domain; those need separate structured delivery and policy work.
