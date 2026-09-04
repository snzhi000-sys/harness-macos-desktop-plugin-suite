/**
 * Serialize harness messages into DeepSeek chat completions. User text is joined; assistant text
 * becomes `content`, tool calls become `tool_calls`, and tool results become separate tool messages.
 * Thinking-mode requests replay `reasoning_content` on every assistant history message, including
 * an empty string when that message recorded no reasoning. Image-aware serialization resolves durable user and tool-result
 * attachments into either Files API references or inline data URLs; unsupported roles fail instead of losing content.
 * Unknown declaration-merged block types retain the adapter's documented extension fallback.
 * @module dsh-llm-deepseek/serialize
 */

import { contentHasImage, LlmError, offloadRequestImages } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { WireImageContentPart, WireMessage, WireRequest, WireTool, WireUserContentPart } from './types.ts'

/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  thinking?: 'enabled' | 'disabled' | undefined
  reasoningEffort?: 'off' | 'high' | 'max' | undefined
}

interface ResolvedThinking {
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: 'high' | 'max'
}

export type ImageRepresentation =
  | { kind: 'base64' }
  | { kind: 'file'; resolveFileId: (stored: StoredImageAttachment) => Promise<string> }

export interface ImageSerializationOptions {
  attachments: AttachmentStore
  representation: ImageRepresentation
  maxRequestImageBytes: number
  signal: AbortSignal
}

const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:'

/** Validate the adapter-owned effort before resolving its DeepSeek wire fields. */
function reasoningEffort(effort: NonNullable<GenerateOptions['reasoningEffort']>): 'off' | 'high' | 'max' {
  if (effort === 'off' || effort === 'high' || effort === 'max') {
    return effort as 'off' | 'high' | 'max'
  }
  throw new LlmError(
    `DeepSeek does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/** Resolve one legal thinking/effort pair without exposing `off` as a wire effort. */
function resolveThinking(options: GenerateOptions, defaults: RequestDefaults): ResolvedThinking {
  if (options.purpose === 'session-title') return { thinking: 'disabled' }
  const effort = options.reasoningEffort === undefined
    ? defaults.reasoningEffort
    : reasoningEffort(options.reasoningEffort)
  if (defaults.thinking === 'disabled' && effort !== undefined && effort !== 'off') {
    throw new LlmError(
      `DeepSeek deployment does not support reasoning effort "${effort}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  if (effort === 'off') return { thinking: 'disabled' }
  if (effort === 'high' || effort === 'max') {
    return { thinking: 'enabled', reasoningEffort: effort }
  }
  return defaults.thinking === undefined ? {} : { thinking: defaults.thinking }
}

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('The DeepSeek chat-completions adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

function assertSupportedImageRoles(messages: readonly Message[]): void {
  for (const message of messages) {
    if (message.role !== 'user' && contentHasImage(message.content)) {
      throw new LlmError(
        `The DeepSeek chat-completions adapter cannot represent image content in a ${message.role} message.`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

async function imagePart(
  block: Extract<ContentBlock, { type: 'image' }>,
  images: ImageSerializationOptions,
): Promise<WireImageContentPart | { type: 'file'; file_id: string }> {
  try {
    const stored = await images.attachments.readImage(block.attachment, images.signal)
    if (images.representation.kind === 'file') {
      return { type: 'file', file_id: await images.representation.resolveFileId(stored) }
    }
    return {
      type: 'image_url',
      image_url: { url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}` },
    }
  } catch (error: unknown) {
    if (error instanceof AttachmentError) throw new LlmError(error.message, error.code, { cause: error })
    throw error
  }
}

async function contentParts(
  blocks: readonly ContentBlock[],
  images: ImageSerializationOptions,
): Promise<WireUserContentPart[]> {
  const parts: WireUserContentPart[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      parts.push(await imagePart(block, images))
    } else if (block.type === 'tool-result') {
      parts.push(...await contentParts(block.content, images))
    }
  }
  return parts
}

function userContent(parts: readonly WireUserContentPart[]): string | WireUserContentPart[] {
  if (parts.every(part => part.type === 'text')) return parts.map(part => part.text).join('')
  return [...parts]
}

/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message: Message, thinkingEnabled: boolean): WireMessage {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
    // Text-less turns send "" — NEVER null. Pure tool-call turns: the
    // official samples replay message.content verbatim (which is "") and
    // some gateways reject null outright. Reasoning-ONLY turns (the model
    // can answer entirely in the reasoning channel, e.g. a v4-flash
    // greeting): the live API rejects null-content/no-tool_calls assistant
    // messages with a 400 ("content or tool_calls must be set"), and since
    // the message sits durably in the session log, a null here bricks every
    // later turn of that session.
    content: text,
    // DeepSeek validates every assistant history entry in a thinking-mode
    // request, not only the entry that initiated a tool call. The empty value
    // is required when a recorded assistant message carried no reasoning.
    ...thinkingEnabled ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; the harness puts each tool result in its own
 * user-role message, so a mixed user message contributes its text first and
 * its tool results as separate wire messages after.
 * @param messages - the harness conversation, in order.
 * @param thinkingEnabled - whether every assistant history message must include reasoning passback.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
export function serializeMessages(messages: Message[], thinkingEnabled = false): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message, thinkingEnabled))
      continue
    }
    // user role: tool results ride in user messages in the harness
    // vocabulary, but DeepSeek wants them as role:'tool' messages.
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

export async function serializeMessagesWithImages(
  messages: readonly Message[],
  images: ImageSerializationOptions,
  thinkingEnabled = false,
): Promise<WireMessage[]> {
  assertSupportedImageRoles(messages)
  const wire: WireMessage[] = []
  let pendingToolImages: Array<Exclude<WireUserContentPart, { type: 'text' }>> = []
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    wire.push({ role: 'user', content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages] })
    pendingToolImages = []
  }
  for (const message of messages) {
    if (message.role === 'system') {
      flushToolImages()
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      flushToolImages()
      wire.push(serializeAssistant(message, thinkingEnabled))
      continue
    }
    const regular = message.content.filter(block => block.type !== 'tool-result')
    const toolResults = message.content.filter((block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result')
    const regularParts = await contentParts(regular, images)
    if (regularParts.length > 0 || toolResults.length === 0) {
      flushToolImages()
      wire.push({ role: 'user', content: userContent(regularParts) })
    }
    for (const result of toolResults) {
      const parts = await contentParts(result.content, images)
      const attached = parts.filter((part): part is Exclude<WireUserContentPart, { type: 'text' }> => part.type !== 'text')
      const text = parts.filter((part): part is Extract<WireUserContentPart, { type: 'text' }> => part.type === 'text').map(part => part.text).join('')
      wire.push({ role: 'tool', tool_call_id: result.toolCallId, content: text || (attached.length > 0 ? '(see attached image)' : '(no output)') })
      pendingToolImages.push(...attached)
    }
  }
  flushToolImages()
  return wire
}

/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null, so
 * provider defaults apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level thinking defaults; undefined fields put nothing on the wire.
 * @returns the chat-completions request body.
 */
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
): WireRequest {
  // A short title budget must produce visible text; conversation and
  // compaction calls continue to inherit the adapter's thinking defaults.
  const resolvedThinking = resolveThinking(options, defaults)
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages, resolvedThinking.thinking === 'enabled'))

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...resolvedThinking.thinking !== undefined ? { thinking: { type: resolvedThinking.thinking } } : {},
    ...resolvedThinking.reasoningEffort !== undefined
      ? { reasoning_effort: resolvedThinking.reasoningEffort }
      : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
  }
}

export async function serializeRequestWithImages(
  options: GenerateOptions,
  images: ImageSerializationOptions,
  defaults: RequestDefaults = {},
): Promise<WireRequest> {
  assertSupportedImageRoles(options.messages)
  const requestMessages = offloadRequestImages(options.messages, images.maxRequestImageBytes)
  const resolvedThinking = resolveThinking(options, defaults)
  const messages: WireMessage[] = []
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system })
  messages.push(...await serializeMessagesWithImages(
    requestMessages,
    images,
    resolvedThinking.thinking === 'enabled',
  ))
  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...resolvedThinking.thinking !== undefined ? { thinking: { type: resolvedThinking.thinking } } : {},
    ...resolvedThinking.reasoningEffort !== undefined ? { reasoning_effort: resolvedThinking.reasoningEffort } : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
  }
}
