# Agent Note: Post-paint startup I/O scheduling

Status: implemented

English | [中文](2026-08-31-post-paint-startup-io-scheduling.zh.md)

## Problem

The Web runtime starts the current Session history and Workspace baselines as soon as the connection is ready. Local plugins previously launched layout restoration, Explorer marker validation, and review-target reconciliation during the same first render. Those independent disk reads and filesystem checks competed with the content required to show the current conversation and Explorer root.

## Decision

The Client Runtime provides `ctx.startupTasks`, one serial lane that opens after two animation frames. A 200 ms timer opens it when a backgrounded page does not receive animation frames. Every queued operation is isolated: failure rejects only its own completion and draining continues. A caller-owned `AbortSignal` skips work made obsolete by a Session or Workspace change, while the feature's existing generation or revision token still prevents a task already in progress from publishing stale data. Runtime disposal resolves queued operations without starting them.

The current Session history, Workspace/Session lists, Explorer root listing, and persisted review snapshot remain on the critical path. Better Sidebar defers Host layout restoration and Emoji-marker reconciliation. Explorer visibility is split: a lightweight persisted-intent snapshot gates root rendering so hidden rows never flash, while filesystem existence reconciliation runs later. File Edit paints its durable pending ledger first and submits only target-by-target reconciliation to the deferred lane.

## Alternatives considered

**Independent timeouts in each plugin.** Rejected because timers provide no cross-plugin serialization, share no disposal owner, and still allow disk-heavy operations to start together.

**Delay the complete Explorer visibility restore.** Rejected because rows marked hidden would render briefly before the delayed state arrived. Persisted intent is therefore critical while only filesystem reconciliation is deferred.

**Delay the review snapshot with its calibration.** Rejected because pending review is user-visible authority and must appear immediately after restart. Only target validation belongs in the post-paint lane.

## Consequences

Critical first-screen reads no longer start alongside every local restoration task, and post-paint disk work cannot fan out concurrently. The queue does not weaken persistence or review authority. It changes scheduling only: pending reviews still appear before reconciliation, hidden intent still applies before root rows render, and every late response remains guarded by the owning feature.

## Verification

Scheduler tests cover two-frame gating, strict serialization, cancellation, failure isolation, and disposal. Better Sidebar tests cover deferred layout restoration, late-response rejection, persisted visibility before filesystem reconciliation, and the full existing Explorer/Preview suite. File Edit retains the full ledger and deletion suite while its Client source contract pins snapshot-first deferred reconciliation.
