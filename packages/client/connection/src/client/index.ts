/**
 * Browser wire client. The plugin selects fixture or HTTP transport, provides
 * the shared API client, and lets the runtime object layer start the stream
 * controller with its sinks.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HostDescription, IApiClient } from './api.ts'
import { ConnectionController, type ConnectionConfig, type ConnectionSinks, type ConnectionState } from './connection.ts'
import { FixtureApiClient } from './fixture.ts'
import { WebApiClient } from './web-api-client.ts'
import { createWebConnectionRpc } from './rpc.ts'
import { isLoopbackHostname } from '../loopback-hostname.ts'
import type { ClientConnectionRpc } from '../rpc.ts'

// ---- Contract re-exports (browser-safe apiproxy channels + core types) ----
export type {
  ApiProxy, SessionsApi, SessionSearchItem, SessionSummary, PromptContentPart, HostApi, EventsApi, MuxFrame, HostFrame,
  ApprovalResponsePayload, QuestionResponsePayload, HistoryEntry, ToolEventView,
  DirectoryEntry, DirectoryListing,
  ToolCallView, ToolResultView, WorkspaceApi, WorkspaceId, WorkspaceView,
  SkillsApi, SkillEntry,
  ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  MessageId, ModelReasoningEffort, ModelSelection, QueueAction, QueuedInboxItem, SessionModels,
  SubagentsApi, SubagentAddress, SubagentCatalog, SubagentListEntry, SubagentPromptReceipt,
  JobView,
  RpcRequest, RpcResponse, RpcResult, RpcError, RpcErrorCode,
  ClientRequest, ServerResponse, ServerRequest, ClientResponse, RpcMessage, RpcReceipt,
  HostDescription, IApiClient, SessionId, SessionEvent, ContentBlock, StreamChunk,
  GoalsApi, GoalRef,
  SettingsApi, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
  CredentialsApi, CredentialView, ConfigurableProviderView, DiscoveredModelView, LlmApi,
} from './api.ts'
export {
  RpcId,
  AbstractApiClient,
  transportError,
} from './api.ts'

// Connection loop types are public through ConnectionHandle.start; the
// controller remains package-internal.
export type { ConnectionConfig, ConnectionSinks, ConnectionState }
export type { ClientConnectionRpc } from '../rpc.ts'

/** Observable Host description published by each completed connection handshake. */
export interface HostDescriptionSource {
  /** Latest connected-generation description; absent before connect and while reconnecting. */
  getSnapshot(): HostDescription | undefined
  /** Subscribe to description replacement and connection loss. */
  subscribe(listener: () => void): () => void
}

/** Identity and Host facts for one established connection generation. */
export interface ConnectionGeneration {
  /** Monotone identifier within this page runtime. */
  readonly id: number
  /** Host description captured by this generation's readiness handshake. */
  readonly description: HostDescription
}

/** Observable active generation; absent while no generation is ready. */
export interface ConnectionGenerationSource {
  /** @returns The ready generation, or undefined while connecting. */
  getSnapshot(): ConnectionGeneration | undefined
  /**
   * @param listener - Called whenever the ready generation changes.
   * @returns An unsubscribe callback.
   */
  subscribe(listener: () => void): () => void
}

/** Observable shared connection lifecycle. */
export interface ConnectionStateSource {
  /** @returns The current lifecycle state, or undefined before start and after stop. */
  getSnapshot(): ConnectionState | undefined
  /**
   * @param listener - Called whenever the lifecycle state changes.
   * @returns An unsubscribe callback.
   */
  subscribe(listener: () => void): () => void
}

/** Required services (none — this is the wire root). */
export const inject: string[] = []

/**
 * The ctx.connection service API: the API client plus a one-shot
 * controller starter (the runtime plugin supplies sinks when its object layer
 * is ready — connection stays consumer-agnostic).
 */
export interface ConnectionHandle {
  /** Shared api client (fixture or real, decided at boot from the page URL). */
  readonly api: IApiClient
  /** Whether the current page authority is loopback; non-browser contexts default to true. */
  readonly isLoopback: boolean
  /** Generation-scoped Host facts, including native path-open capability. */
  readonly hostDescription: HostDescriptionSource
  /** Active connection generation and its monotone identity. */
  readonly generation: ConnectionGenerationSource
  /** Shared lifecycle state for UI and plugin consumers. */
  readonly state: ConnectionStateSource
  /** Generic logical RPC channels over the same Connection transport. */
  readonly rpc: ClientConnectionRpc
  /** Replace the current generation or retry delay immediately. */
  reconnect(): void
  /**
   * Start the connect/pump/reconnect loop with the consumer's frame sinks.
   * One consumer owns the streams (the runtime object layer); a second call
   * throws.
   * @param sinks - frame/state callbacks.
   * @param config - reconnect/backoff tunables.
   * @returns stop handle for the loop.
   */
  start(sinks: ConnectionSinks, config?: ConnectionConfig): { stop(): void }
}

/**
 * Client plugin body: pick the api by page mode and provide ctx.connection.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
  const fixtureClient = fixture ? new FixtureApiClient() : undefined
  const api: IApiClient = fixtureClient ?? new WebApiClient()
  const rpc = fixtureClient?.rpc ?? createWebConnectionRpc()
  let started = false
  let controller: ConnectionController | undefined
  let description: HostDescription | undefined
  let generation: ConnectionGeneration | undefined
  let generationId = 0
  let state: ConnectionState | undefined
  const descriptionListeners = new Set<() => void>()
  const generationListeners = new Set<() => void>()
  const stateListeners = new Set<() => void>()
  const publish = (listeners: Set<() => void>, label: string): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error(`[web-runtime] ${label} listener threw:`, error)
      }
    }
  }
  const publishDescription = (next: HostDescription | undefined): void => {
    if (Object.is(description, next)) return
    description = next
    publish(descriptionListeners, 'host-description')
  }
  const publishGeneration = (next: ConnectionGeneration | undefined): void => {
    if (Object.is(generation, next)) return
    generation = next
    publish(generationListeners, 'generation')
  }
  const publishState = (next: ConnectionState | undefined): void => {
    if (state === next) return
    state = next
    publish(stateListeners, 'connection-state')
  }
  const handle: ConnectionHandle = {
    api,
    isLoopback: pageLocation === undefined || isLoopbackHostname(pageLocation.hostname),
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => { descriptionListeners.delete(listener) }
      },
    },
    generation: {
      getSnapshot: () => generation,
      subscribe: (listener) => {
        generationListeners.add(listener)
        return () => { generationListeners.delete(listener) }
      },
    },
    state: {
      getSnapshot: () => state,
      subscribe: (listener) => {
        stateListeners.add(listener)
        return () => { stateListeners.delete(listener) }
      },
    },
    rpc,
    reconnect() {
      controller?.reconnect()
    },
    start(sinks, config) {
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      const current = new ConnectionController(api, {
        ...sinks,
        onConnected: (next) => {
          const nextGeneration = { id: ++generationId, description: next }
          publishDescription(next)
          publishGeneration(nextGeneration)
          // A description subscriber may synchronously stop the loop. In that
          // case publishDescription(undefined) has already retracted this
          // generation, so do not leak its stale connected notification to
          // the consumer sink afterward.
          if (!Object.is(description, next) || !Object.is(generation, nextGeneration)) return
          sinks.onConnected?.(next, nextGeneration.id)
        },
        onStateChange: (state) => {
          if (state !== 'connected') {
            publishDescription(undefined)
            publishGeneration(undefined)
          }
          publishState(state)
          sinks.onStateChange?.(state)
        },
      }, config ?? {})
      controller = current
      current.start()
      return {
        stop: () => {
          current.stop()
          if (controller === current) controller = undefined
          publishDescription(undefined)
          publishGeneration(undefined)
          publishState(undefined)
        },
      }
    },
  }
  ctx.provide('connection', handle)
}
