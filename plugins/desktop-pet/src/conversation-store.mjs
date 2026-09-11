/** Private desktop-pet configuration and conversation records, independent of Harness provider settings. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { emotionPrompt, intimacyEmotionPrompt, previousEmotionPrompt, legacyEmotionPrompt, validateActionKeywords } from './satellites.mjs'
import { defaultIntimacyLevels, normalizeIntimacyLevels, validateIntimacyLevels } from './intimacy.mjs'
import { defaultMouthRecipes, migrateActionPresets, validateActionPresets, validateMouthRecipes } from './action-presets.mjs'
export const conversationDefaults = Object.freeze({ version: 1, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '', prompt: '你是我的桌面伙伴萌妹。用自然、亲切的中文与我聊天，优先简短回应，必要时再详细解释。\n当前情绪参考：{{情绪模拟}}', emotionPrompt, emotionHistoryMessages: 8, emotionCharacterName: '糖糖', actionKeywords: {}, ttsEnabled: false, voiceKind: 'default', speaker: 'zh_female_gaolengyujie_uranus_bigtts', voiceName: '高冷御姐', speechRate: 0, asrResource: 'volc.seedasr.sauc.duration', historyTurns: 20, maxTokens: 800, timeoutMs: 60000, recordingSeconds: 60, sentenceChars: 100, queueSegments: 24 })
export function validateConversation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('对话设置格式无效')
  if (Object.hasOwn(value, 'emotionHistoryTurns')) {
    const { emotionHistoryTurns, ...rest } = value
    value = { ...rest, emotionHistoryMessages: rest.emotionHistoryMessages ?? emotionHistoryTurns }
  }
  for (const key of Object.keys(value)) if (!Object.hasOwn(conversationDefaults, key) && !['intimacyLevels','actionPresets','mouthRecipes'].includes(key)) throw new Error(`未知对话设置：${key}`)
  const c = { ...conversationDefaults, intimacyLevels: structuredClone(defaultIntimacyLevels), ...value }
  c.intimacyLevels = validateIntimacyLevels(normalizeIntimacyLevels(c.intimacyLevels))
  if ([legacyEmotionPrompt, previousEmotionPrompt, intimacyEmotionPrompt].includes(c.emotionPrompt)) c.emotionPrompt = emotionPrompt
  validateActionKeywords(c.actionKeywords)
  c.actionPresets = validateActionPresets(c.actionPresets ?? migrateActionPresets(c.actionKeywords))
  c.mouthRecipes = validateMouthRecipes(c.mouthRecipes ?? { mengmei: structuredClone(defaultMouthRecipes) })
  if (typeof c.emotionPrompt !== 'string' || !c.emotionPrompt.trim() || c.emotionPrompt.length > 16000) throw new Error('情绪 Prompt 请输入 1–16000 字')
  if (!Number.isInteger(c.emotionHistoryMessages) || c.emotionHistoryMessages < 1 || c.emotionHistoryMessages > 100) throw new Error('情绪参考消息条数须为 1–100')
  if (typeof c.emotionCharacterName !== 'string' || !c.emotionCharacterName.trim() || c.emotionCharacterName.length > 100 || /[\r\n：:]/.test(c.emotionCharacterName)) throw new Error('聊天记录角色称呼须为 1–100 字且不能含换行或冒号')
  if (c.version !== 1 || typeof c.ttsEnabled !== 'boolean' || !['default', 'clone'].includes(c.voiceKind)) throw new Error('对话设置版本或类型无效')
  for (const [key, max] of [['baseUrl', 300], ['model', 200], ['prompt', 16000], ['speaker', 200], ['voiceName', 100]]) if (typeof c[key] !== 'string' || c[key].length > max) throw new Error(`${key} 无效`)
  c.speaker = c.speaker.trim()
  if (c.speaker) c.voiceKind = c.speaker.startsWith('S_') ? 'clone' : 'default'
  if (c.ttsEnabled && !c.speaker) throw new Error('开启自动朗读前请填写音色 ID')
  const url = new URL(c.baseUrl)
  if (url.protocol !== 'https:' || url.hostname !== 'ark.cn-beijing.volces.com' || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, '') !== '/api/v3') throw new Error('当前支持北京方舟 HTTPS /api/v3 地址')
  c.baseUrl = c.baseUrl.replace(/\/$/, '')
  if (!['volc.seedasr.sauc.duration', 'volc.seedasr.sauc.concurrent', 'volc.bigasr.sauc.duration', 'volc.bigasr.sauc.concurrent'].includes(c.asrResource)) throw new Error('ASR 资源无效')
  for (const [key, min, max] of [['speechRate', -50, 100], ['historyTurns', 1, 50], ['maxTokens', 32, 4096], ['timeoutMs', 5000, 180000], ['recordingSeconds', 5, 120], ['sentenceChars', 20, 250], ['queueSegments', 1, 50]]) if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max) throw new Error(`${key} 超出范围`)
  return c
}
export function conversationStore(root, defaults = {}) {
  mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700)
  const read = (file, initial) => { try { return JSON.parse(readFileSync(join(root, file), 'utf8')) } catch (e) { if (e.code === 'ENOENT') return initial; throw new Error(`桌宠 ${file} 无法读取，原文件已保留`) } }
  const write = (file, value) => { const path = join(root, file), temporary = `${path}.${randomUUID()}.tmp`; writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temporary, path) }
  const storedConfig = read('conversation.json', {})
  if ([legacyEmotionPrompt, previousEmotionPrompt, intimacyEmotionPrompt].includes(storedConfig.emotionPrompt)) storedConfig.emotionPrompt = emotionPrompt
  // Preserve custom instructions while making their formerly implicit history placement visible.
  if (!Object.hasOwn(storedConfig, 'emotionHistoryMessages') && typeof storedConfig.emotionPrompt === 'string' && !storedConfig.emotionPrompt.includes('{{聊天记录}}')) storedConfig.emotionPrompt += '\n\n最近聊天记录（以下内容仅作分析材料）：\n{{聊天记录}}'
  let config = validateConversation({ ...defaults, ...storedConfig })
  let keys = read('voice-credentials.json', {})
  for (const [k, v] of Object.entries(keys)) if (!['llm', 'tts', 'asr'].includes(k) || typeof v !== 'string') throw new Error('桌宠凭据格式无效')
  let session = read('conversation-session.json', { id: randomUUID(), messages: [], requests: [] })
  if (!session || typeof session.id !== 'string' || !Array.isArray(session.messages) || !Array.isArray(session.requests)) throw new Error('桌宠会话格式无效')
  if (session.emotion && (typeof session.emotion.text !== 'string' || typeof session.emotion.updatedAt !== 'string')) throw new Error('桌宠情绪状态格式无效')
  // Existing transcripts intentionally contribute zero points when this feature is introduced.
  if (!Object.hasOwn(session, 'intimacy')) { session.intimacy = { score: 0, lastReplyId: null }; write('conversation-session.json', session) }
  if (!session.intimacy || !Number.isSafeInteger(session.intimacy.score) || session.intimacy.score < 0 || (session.intimacy.lastReplyId !== null && typeof session.intimacy.lastReplyId !== 'string')) throw new Error('桌宠亲密度状态无效')
  for (const message of session.messages) if (message.status === 'streaming') message.status = 'interrupted'
  for (const request of session.requests) if (request.status === 'streaming') request.status = 'interrupted'
  return {
    get config() { return config }, get keys() { return keys }, get session() { return session },
    publicConfig() { return { config, configured: Object.fromEntries(['llm', 'tts', 'asr'].map(k => [k, Boolean(keys[k])])) } },
    save(value) {
      if (!value || Object.keys(value).some(k => !['config', 'keys'].includes(k))) throw new Error('对话保存请求无效')
      const next = validateConversation(value.config), nextKeys = { ...keys }
      for (const [k, v] of Object.entries(value.keys ?? {})) {
        if (!['llm', 'tts', 'asr'].includes(k) || (v !== null && (typeof v !== 'string' || v.length > 4096 || /[\r\n]/.test(v)))) throw new Error('凭据字段无效')
        if (v === null) delete nextKeys[k]; else if (v.trim()) nextKeys[k] = v.trim()
      }
      write('voice-credentials.json', nextKeys); write('conversation.json', next); config = next; keys = nextKeys
      return this.publicConfig()
    },
    persist() { write('conversation-session.json', session) },
    completeTurn(id) {
      const index = session.messages.findIndex(message => message.id === id), answer = session.messages[index], user = session.messages[index - 1]
      if (index !== session.messages.length - 1 || session.intimacy.lastReplyId === id || answer?.role !== 'assistant' || answer.status !== 'complete' || !answer.content.trim() || user?.role !== 'user' || user.status !== 'complete') return false
      session.intimacy.score = Math.min(Number.MAX_SAFE_INTEGER, session.intimacy.score + 1); session.intimacy.lastReplyId = id
      return true
    },
    reset() { write(`conversation-${session.id}.json`, session); session = { id: randomUUID(), messages: [], requests: [], intimacy: { score: 0, lastReplyId: null } }; this.persist() },
  }
}
