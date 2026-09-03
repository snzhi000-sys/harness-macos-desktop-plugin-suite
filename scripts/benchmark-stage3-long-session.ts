/** Reproducible data-plane baseline for phase-3 long-session work. */
import { performance } from 'node:perf_hooks'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { turnOutlineProjectionDefinition } from '../packages/session/session-turn-outline/src/projection.ts'

interface Report {
  readonly scenario: string
  readonly records: number
  readonly turns: number
  readonly sourceBytes: number
  readonly outlineBytes: number
  readonly encodeMs: number
  readonly parseMs: number
  readonly foldMs: number
  readonly heapDeltaMb: number
}

function event(seq: number, type: string, data: unknown): SessionEvent {
  return { seq, time: 1_700_000_000_000 + seq, type, data } as SessionEvent
}

function fixture(records: number, largeToolBytes = 0): SessionEvent[] {
  const events: SessionEvent[] = []
  let turn = 0
  while (events.length < records) {
    const remaining = records - events.length
    const start = events.length
    turn += 1
    events.push(event(start, 'turn/start', { turn, trigger: { kind: 'user' } }))
    if (remaining > 1) events.push(event(start + 1, 'user/message', {
      id: `m-${String(turn)}`,
      content: [{ type: 'text', text: `Question ${String(turn)} ${'context '.repeat(24)}` }],
      source: { kind: 'user' },
    }))
    if (remaining > 2) events.push(event(start + 2, 'step/start', { turn, step: 1 }))
    if (remaining > 3) events.push(event(start + 3, 'assistant/message', {
      turn,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `Answer ${String(turn)} ${'result '.repeat(24)}` }],
        source: { provider: 'benchmark', model: 'benchmark' },
      },
    }))
    if (remaining > 4) events.push(event(start + 4, 'tool/result', {
      turn,
      step: 1,
      message: { content: [{ type: 'text', text: largeToolBytes === 0 ? 'ok' : 'x'.repeat(largeToolBytes) }] },
    }))
    if (remaining > 5) events.push(event(start + 5, 'turn/end', { turn, reason: { kind: 'completed' } }))
  }
  return events.slice(0, records).map((value, seq) => ({ ...value, seq }))
}

function measure(scenario: string, events: SessionEvent[]): Report {
  const heapBefore = process.memoryUsage().heapUsed
  const encodeStarted = performance.now()
  const encoded = JSON.stringify(events)
  const encodeMs = performance.now() - encodeStarted
  const parseStarted = performance.now()
  JSON.parse(encoded) as unknown
  const parseMs = performance.now() - parseStarted
  const foldStarted = performance.now()
  const outline = events.reduce(
    (state, current) => turnOutlineProjectionDefinition.apply(state, current),
    turnOutlineProjectionDefinition.init(),
  )
  const foldMs = performance.now() - foldStarted
  return {
    scenario,
    records: events.length,
    turns: outline.turns.length,
    sourceBytes: Buffer.byteLength(encoded),
    outlineBytes: Buffer.byteLength(JSON.stringify(outline)),
    encodeMs: Number(encodeMs.toFixed(3)),
    parseMs: Number(parseMs.toFixed(3)),
    foldMs: Number(foldMs.toFixed(3)),
    heapDeltaMb: Number(((process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024).toFixed(3)),
  }
}

const reports = [
  measure('1k-records', fixture(1_000)),
  measure('10k-records', fixture(10_000)),
  measure('large-tool-output', fixture(1_000, 256 * 1024)),
]

console.info(`STAGE3_PERF_BASELINE ${JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2)}`)
