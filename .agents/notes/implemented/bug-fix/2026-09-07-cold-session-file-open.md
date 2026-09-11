# Agent Note: Browse cold session files without loading history

Status: implemented

English | [中文](2026-09-07-cold-session-file-open.zh.md)

## Problem

Explorer can display a session's files before its live Host session is attached. File Edit rejects that session and the file router treats the rejection as a download request. Review hydration can also delay browsing unrelated files.

## Decision

Read-only target resolution and diff browsing bind their root to the live session header or the persistence service's header-only listing. They do not load conversation logs, wait for review hydration, or trust renderer-supplied cwd. This does not mark the audit baseline ready or grant a write policy. The router distinguishes read errors from confirmed binary formats, and late client opens cannot activate a different session.

## Alternatives considered

**Wait for history attachment.** Rejected because file reading does not require model history.

**Trust the Explorer cwd.** Rejected because a client path cannot replace Host authority.

**Download on any failure.** Rejected because transport and startup failures do not identify a file format.

## Consequences

Cold browsing uses metadata I/O and target-only reads. Missing sessions remain rejected and mutations keep their existing checks. Tests exercise a detached session with a persistence loader that must never execute, untrusted cwd, and failed opens/probes without downloads.
