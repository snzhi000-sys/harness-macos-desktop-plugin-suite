# Agent Note: Client connection recovery generation

Status: implemented

English | [中文](2026-09-03-client-connection-recovery-generation.zh.md)

## Problem

The browser used two independently opened WebSocket downlinks and a coarse reconnect loop. Idle proxies could retire healthy sockets, a slow readiness handshake was treated as connected after a timeout, recovery state was not observable outside the Runtime callback, and an older Session or Workspace list response could publish after a newer connection had already established. Rebuilding an opened Session also cleared its committed conversation before replacement history arrived.

## Decision

The Host sends WebSocket Ping control frames on one configurable interval and terminates a socket only after two consecutive missed Pong responses. The existing mux and Host downlinks remain separate; transport consolidation is not required for heartbeat or recovery ownership.

`ConnectionController` owns readiness, generation identity, stall reporting, retry backoff, and immediate reconnect. It publishes `connecting`, `connected`, `stalled`, and `reconnecting` through the shared `ctx.connection.state` source. `ctx.connection.reconnect()` aborts only the current generation or retry delay. Stream sinks receive frames only while their owning generation remains active.

Every established generation triggers the existing Runtime reconciliation path. Session and Workspace list refreshes replace any older generation refresh and publish only from the latest request token. Opened Session history remains visible while resync loads and is replaced atomically when the current generation's history arrives. Existing model-directory and plugin-state consumers continue to refresh through `connection/reset`, whose stores already use latest-load generation guards.

Recovery retries only subscriptions and authoritative reads. Forks, renames, file operations, review decisions, Browser layout writes, and other non-idempotent commands remain caller-owned and are never replayed by the connection layer.

If the packaged Desktop backend exits unexpectedly, the shell restarts it a bounded number of times on the same loopback port. The existing Renderer and origin stay intact so the Connection Controller can recover the loaded page; a static error page appears only after repeated recovery failure.

## Alternatives considered

**Cherry-pick the upstream single Remote-stream transport.** Rejected because the local product still exposes API Proxy mux and Host downlinks, and replacing that carrier would expand the migration into generated Remote APIs and every transport consumer.

**Treat the readiness timeout as successful connection.** Rejected because a missing stream subscription can make reconciliation outrun its incremental baseline. A slow Host remains stalled until the actual handshake completes or the transport ends.

**Reload the browser page after disconnection.** Rejected because reload discards in-memory optimistic and viewing state, broadens recovery into plugin reactivation, and cannot distinguish idempotent reads from writes whose result is unknown.

**Clear Session state before fetching replacement history.** Rejected because the existing committed window remains valid display state during an outage. Atomic replacement preserves visible user messages without accepting stale responses.

## Consequences

Idle connections survive intermediary timeouts, brief Host stalls remain distinguishable from transport loss, and users can restart recovery without restarting the Desktop backend. New generations reconcile Session, Workspace, model, and plugin-derived state without accepting older baselines. The Host owns one heartbeat timer per downlink acceptor, and the client retains its last committed conversation during recovery. Non-idempotent actions may still report an unknown outcome after transport loss and require snapshot reconciliation rather than automatic retry.

Desktop crash recovery now depends on rebinding the previous port. If the port cannot be reclaimed, the shell retries five times with bounded backoff and then fails explicitly. Recovery never navigates or refreshes the Renderer.
