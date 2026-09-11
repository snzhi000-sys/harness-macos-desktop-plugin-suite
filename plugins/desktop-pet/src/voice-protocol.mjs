/** Volcengine V3 binary framing; field order follows the official TTS/ASR protocol examples. */
import { gzipSync, gunzipSync } from 'node:zlib'
const int = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b }
const sized = b => Buffer.concat([int(b.length), b])
export function ttsPacket(event, session = '', payload = {}) {
  return Buffer.concat([Buffer.from([0x11, 0x14, 0x10, 0]), int(event), ...([1, 2].includes(event) ? [] : [sized(Buffer.from(session))]), sized(Buffer.from(JSON.stringify(payload)))])
}
export function asrPacket(sequence, payload, audio = false, last = false) {
  const data = gzipSync(audio ? payload : Buffer.from(JSON.stringify(payload)))
  return Buffer.concat([Buffer.from([0x11, (audio ? 0x20 : 0x10) | (last ? 3 : 1), audio ? 1 : 0x11, 0]), int(last ? -sequence : sequence), sized(data)])
}
export function decodeVoicePacket(bytes, tts = false) {
  const b = Buffer.from(bytes)
  if (b.length < 4 || b[0] >> 4 !== 1) throw new Error('语音协议头无效')
  let offset = (b[0] & 15) * 4
  const type = b[1] >> 4, flags = b[1] & 15, compression = b[2] & 15, serialization = b[2] >> 4
  const readInt = () => { if (offset + 4 > b.length) throw new Error('语音数据不完整'); const n = b.readInt32BE(offset); offset += 4; return n }
  const readSized = () => { const size = readInt(); if (size < 0 || offset + size > b.length) throw new Error('语音数据长度无效'); const data = b.subarray(offset, offset + size); offset += size; return data }
  if (offset < 4) throw new Error('语音协议头长度无效')
  const sequence = flags & 1 ? readInt() : null
  const code = type === 15 ? readInt() : 0
  const event = flags & 4 ? readInt() : null
  let session = ''
  if (tts && event !== null) session = readSized().toString('utf8')
  let payload = readSized()
  if (offset !== b.length || ![0, 1].includes(compression)) throw new Error('语音协议格式无效')
  if (compression === 1) payload = gunzipSync(payload, { maxOutputLength: 8 * 1024 * 1024 })
  if (serialization === 1) payload = JSON.parse(payload.toString('utf8'))
  return { type, event, sequence, last: Boolean(flags & 2), code, session, payload }
}
