/** Pure client-visible types for the whole-log turn outline projection. */

export {}

/** One started turn's bounded navigation facts. */
export interface TurnOutlineEntry {
  /** Host-assigned turn number. */
  readonly turn: number
  /** `turn/start` event sequence used as the history paging target. */
  readonly seq: number
  /** Bounded first human prompt preview. */
  readonly prompt: string
  /** Bounded settled assistant response preview. */
  readonly response: string
  /** Whether a matching `turn/end` has been committed. */
  readonly status: 'open' | 'closed'
}

/** Every started turn in ascending turn order. */
export interface TurnOutlineProjection {
  readonly turns: readonly TurnOutlineEntry[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Whole-log bounded navigation index; it never carries tool output or attachments. */
    turnOutline: TurnOutlineProjection
  }
}
