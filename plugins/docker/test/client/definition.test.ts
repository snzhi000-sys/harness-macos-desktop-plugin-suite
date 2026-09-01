import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ConversationMatch, ConversationNodeContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { dockerStatusDefinition, DOCKER_STATUS_KIND } from '../../src/client/definition.ts'
import { DockerStatusView, LogPane, Table } from '../../src/client/view.ts'
import type { DockerStatusChatData, DockerStatusState } from '../../src/client/definition.ts'

/** The engine-owned context key format (stable per kind + business id). */
function contextKey(kind: string, id: string): string {
  return `${kind}:${id}`
}

/** Build one session event with the fields the Definition reads. */
function event(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, data, seq, time: 1_000 + seq } as SessionEvent
}

function toolCall(callId: string, name: string, args: Record<string, unknown>, seq: number): SessionEvent {
  return event('tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) }, seq)
}

function toolResult(callId: string, meta: unknown, seq: number): SessionEvent {
  return event('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] }],
      source: { kind: 'tool', name: 'docker_ps' },
    },
    meta,
  }, seq)
}

const PS_META = {
  tool: 'docker_ps',
  rows: [{ id: 'abc', name: 'web', image: 'alpine', state: 'running', status: 'Up 1 hour', ports: [] }],
}

function startContext(startEvent: SessionEvent, matches: ConversationMatch[] = []): ConversationNodeContext<DockerStatusState> {
  return {
    key: contextKey(DOCKER_STATUS_KIND, String(startEvent.data.callId)),
    kind: DOCKER_STATUS_KIND,
    id: String(startEvent.data.callId),
    matches,
    start: undefined,
    state: undefined,
    current: new Map(),
  }
}

/** Run the Definition over one event window, start → updates in ascending seq. */
function replay(events: SessionEvent[]): { state: DockerStatusState | undefined; node: ReturnType<NonNullable<typeof dockerStatusDefinition.buildViewNode>> } {
  let context: ConversationNodeContext<DockerStatusState> | undefined
  let state: DockerStatusState | undefined
  const matches: ConversationMatch[] = []
  for (const ev of events) {
    const matched = dockerStatusDefinition.match(ev)
    if (matched === null) continue
    if (context === undefined) {
      context = startContext(ev, matches)
    }
    matches.push({ event: ev, role: matched.role, location: { kind: 'unresolved' } })
    if (matched.role === 'start') {
      state = dockerStatusDefinition.start({ ...context, matches }, matches[matches.length - 1]!, {
        previous: () => undefined,
      })
      context = { ...context, matches, start: matches[matches.length - 1], state }
    } else if (state !== undefined) {
      state = dockerStatusDefinition.update({ ...context, matches, state }, matches[matches.length - 1]!)
      context = { ...context, matches, state }
    }
  }
  if (context === undefined) return { state: undefined, node: null }
  const node = dockerStatusDefinition.buildViewNode?.({ ...context, state })
  return { state, node }
}

test('client definition: match extracts stable ids per tool call', () => {
  const call = toolCall('call-1', 'docker_ps', {}, 10)
  const matched = dockerStatusDefinition.match(call)
  assert.deepEqual(matched, { id: 'call-1', role: 'start' })
  const result = toolResult('call-1', PS_META, 11)
  assert.deepEqual(dockerStatusDefinition.match(result), { id: 'call-1', role: 'update' })
})

test('client definition: unrelated events and tools are not matched', () => {
  assert.equal(dockerStatusDefinition.match(toolCall('c1', 'docker_start', { container: 'x' }, 10)), null)
  assert.equal(dockerStatusDefinition.match(event('user/message', { turn: 1, step: 1, message: { role: 'user', content: [] } }, 10)), null)
  assert.equal(dockerStatusDefinition.match(toolResult('c2', { tool: 'other', x: 1 }, 11)), null)
  // A tool/result without a recognizable meta never matches (no pending junk).
  assert.equal(dockerStatusDefinition.match(event('tool/result', { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c3', content: [] }] } }, 11)), null)
})

test('client definition: complete window produces the expected state, node payload, and anchorSeq', () => {
  const { state, node } = replay([toolCall('call-1', 'docker_ps', { all: true }, 10), toolResult('call-1', PS_META, 11)])
  assert.equal(state?.settled, true)
  assert.ok(state?.meta)
  assert.ok(node)
  assert.equal(node!.key, contextKey(DOCKER_STATUS_KIND, 'call-1'))
  assert.equal(node!.kind, DOCKER_STATUS_KIND)
  assert.equal(node!.anchorSeq, 10)
  const data = node!.data as DockerStatusChatData
  assert.equal(data.tool, 'docker_ps')
  assert.equal(data.settled, true)
  assert.equal(data.rows?.length, 1)
  assert.equal(data.title, 'All containers')
})

test('client definition: an update-only tail stays pending with no node', () => {
  const { state, node } = replay([toolResult('call-1', PS_META, 11)])
  assert.equal(state, undefined)
  assert.equal(node, null)
})

test('client definition: replaying the combined window equals live start-then-append', () => {
  const call = toolCall('call-1', 'docker_ps', {}, 10)
  const result = toolResult('call-1', PS_META, 11)
  const combined = replay([call, result])
  assert.ok(combined.node)

  // "Live" path: the start already materialized, then the result is appended.
  const startOnly = replay([call])
  assert.ok(startOnly.state)
  const ctx = startContext(call, [])
  const updateMatch: ConversationMatch = { event: result, role: 'update', location: { kind: 'unresolved' } }
  const appendedState = dockerStatusDefinition.update({ ...ctx, state: startOnly.state! }, updateMatch)
  const appendedNode = dockerStatusDefinition.buildViewNode!({
    ...ctx,
    matches: [updateMatch],
    start: { event: call, role: 'start', location: { kind: 'unresolved' } },
    state: appendedState,
  })
  assert.deepEqual(appendedNode, combined.node)
})

test('client definition: log calls render lines plus the truncation flag', () => {
  const call = toolCall('call-2', 'docker_logs', { container: 'web', tail: 50 }, 20)
  const result = toolResult('call-2', { tool: 'docker_logs', lines: ['a', 'b'], truncated: true }, 21)
  const { node } = replay([call, result])
  assert.ok(node)
  const data = node!.data as DockerStatusChatData
  assert.deepEqual(data.lines, ['a', 'b'])
  assert.equal(data.truncated, true)
})

test('client definition: compose ps rows carry the project', () => {
  const call = toolCall('call-3', 'docker_compose_ps', {}, 30)
  const result = toolResult('call-3', { tool: 'docker_compose_ps', project: 'stack', rows: [{ name: 'sleeper', state: 'running' }] }, 31)
  const { node } = replay([call, result])
  assert.ok(node)
  const data = node!.data as DockerStatusChatData
  assert.equal(data.project, 'stack')
  assert.equal(data.rows?.length, 1)
})

test('client renderer: collapsed by default and consumes node.data only', () => {
  const { node } = replay([toolCall('call-1', 'docker_ps', {}, 10), toolResult('call-1', PS_META, 11)])
  assert.ok(node)
  const html = renderToStaticMarkup(createElement(DockerStatusView, {
    node: node as never,
    owner: { selectedCallId: undefined, cwd: '/tmp', openFile: () => {}, inspectCall: () => {}, forkAt: () => {}, loadImage: async () => '', fileMentions: () => undefined },
    t: (() => '') as never,
  }))
  // The header title and summary render; the expanded table body does not.
  assert.match(html, /Containers/)
  assert.match(html, /1 service/)
  assert.ok(!html.includes('web'), 'collapsed view must not render the row body')
})

test('client renderer: table and log pane render their data when expanded', () => {
  const tableHtml = renderToStaticMarkup(createElement(Table, { rows: PS_META.rows }))
  assert.match(tableHtml, /web/)
  assert.match(tableHtml, /running/)
  const logHtml = renderToStaticMarkup(createElement(LogPane, { lines: ['boot ok', 'warn x'], truncated: true }))
  assert.match(logHtml, /boot ok/)
  assert.match(logHtml, /truncated/)
  const cleanLog = renderToStaticMarkup(createElement(LogPane, { lines: ['done'], truncated: false }))
  assert.ok(!cleanLog.includes('truncated'))
})
