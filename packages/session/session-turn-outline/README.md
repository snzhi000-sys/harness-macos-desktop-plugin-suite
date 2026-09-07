# `@deepseek-ai/dsh-session-turn-outline`

English | [中文](README.zh.md)

Function plugin folding the complete durable Session log into a bounded `turnOutline` navigation projection. Each entry contains only the turn number, its `turn/start` sequence, short prompt and settled-response previews, and status. Tool output, attachment bodies, and file contents never enter the projection.

## Model Experience

None, as the plugin only computes a client-facing read model of already-logged Session events and touches no prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; the plugin never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **Projection size grows with turn count** — each entry is bounded, but a Session with many short turns still carries one small record per turn.
- **Deep jumps load real history pages** — navigation does not retain full content, so reaching an unloaded turn may require several read-only page requests.
- **Packed journal transport remains deferred** — this package uses the existing projection carrier and does not change the JSONL history safety path.
