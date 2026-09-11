/** Scoped settings form for the pet's private model and speech services. */
import { conversationApi as api } from './conversation-api.mjs'
import { mountActionPresetSettings } from './action-preset-settings.mjs'
import { mountIntimacySettings } from './intimacy-settings.mjs'
export function mountConversationSettings(root, status, showPet) {
  root.innerHTML = `<style>.voice-form{padding:22px 28px;overflow:auto;flex:1;min-height:0}.voice-form label{display:flex;flex-direction:column;gap:7px;margin-bottom:16px;font-size:13px}.voice-form input,.voice-form textarea,.voice-form select{font:inherit;width:100%;padding:10px;border:1px solid #dfe3ea;border-radius:9px;background:white}.voice-form textarea{min-height:150px;resize:vertical}.voice-form p{color:#788393;font-size:12px;line-height:1.6}.voice-form .keyrow{display:flex;gap:8px}.voice-form .keyrow button{white-space:nowrap}.voice-form .switch{flex-direction:row;align-items:center;justify-content:space-between}.voice-form .switch input{width:18px;height:18px}</style>
  <div data-page="conversation"><p>桌宠对话和情绪模拟共用这里的独立模型配置，不影响 Harness 主对话。</p><label>方舟 API Key<span class="keyrow"><input data-key="llm" type="password" autocomplete="off" placeholder="填写后保存"><button data-clear="llm">清除</button></span></label><label>Base URL<input data-field="baseUrl"></label><label>模型接入点<input data-field="model" placeholder="ep-…"></label><button data-test>测试对话连接</button></div>
  <div data-page="prompts" hidden><label>对话 Prompt<textarea data-field="prompt"></textarea></label><p>在需要的位置写入 {{情绪模拟}}，回复时替换为最新已完成的情绪文本。旧 Prompt 原样保留；未填写变量时不会自动注入。</p><button data-insert-emotion>插入 {{情绪模拟}}</button><label>情绪模拟 Prompt<textarea data-field="emotionPrompt"></textarea></label><button data-insert-history>插入 {{聊天记录}}</button><p>{{聊天记录}} 按时间顺序包含双方消息，8 条就是双方消息合计 8 条。未填写变量时不会注入聊天记录。</p><label>聊天记录中的角色称呼<input data-field="emotionCharacterName"></label><label>情绪参考最近几条消息<input data-field="emotionHistoryMessages" type="number" min="1" max="100"></label><p>首次无记录时先根据用户消息生成情绪；之后每次回复完成在后台更新，供下一轮使用。情绪文本不进入聊天记录，也不朗读。</p><h3>当前情绪</h3><p data-emotion-status role="status"></p><div data-emotion-text style="white-space:pre-wrap;overflow-wrap:anywhere"></div></div>
  <div data-page="actions" hidden></div>
  <div data-page="voice" hidden><label class="switch">自动朗读回复<input data-field="ttsEnabled" type="checkbox"></label><p>关闭后立即停止朗读；开启后从下一次回复自动发声。</p><label>TTS API Key<span class="keyrow"><input data-key="tts" type="password" autocomplete="off"><button data-clear="tts">清除</button></span></label><label>ASR API Key<span class="keyrow"><input data-key="asr" type="password" autocomplete="off"><button data-clear="asr">清除</button></span></label><p>语音 Key 可共用，也可分别填写；新版接口无需 App ID。</p><label>音色类型<select data-field="voiceKind"><option value="default">默认音色</option><option value="clone">克隆音色</option></select></label><label>默认音色<select data-default-voice><option value="zh_female_gaolengyujie_uranus_bigtts">高冷御姐</option><option value="custom">其他官方音色</option></select></label><label>音色 ID<input data-field="speaker" placeholder="官方 speaker 或 S_…"></label><label>音色名称<input data-field="voiceName"></label><label>语速<input data-field="speechRate" type="number" min="-50" max="100"></label><label>ASR 资源<select data-field="asrResource"><option value="volc.seedasr.sauc.duration">豆包 2.0 · 小时版</option><option value="volc.seedasr.sauc.concurrent">豆包 2.0 · 并发版</option><option value="volc.bigasr.sauc.duration">豆包 1.0 · 小时版</option><option value="volc.bigasr.sauc.concurrent">豆包 1.0 · 并发版</option></select></label><button data-sample>试听已保存音色</button><p>识别测试：打开聊天，点击录音，结束后检查转写文字。</p></div>`
  let stored, disposed = false, generation = 0, events; const cleared = new Set()
  const intimacyRoot = document.createElement('div'); intimacyRoot.dataset.page = 'intimacy'; intimacyRoot.hidden = true; root.append(intimacyRoot)
  const intimacy = mountIntimacySettings(intimacyRoot)
  const insertIntimacy = document.createElement('button'); insertIntimacy.textContent = '插入 {{亲密情况}}'; insertIntimacy.dataset.insertIntimacy = ''
  root.querySelector('[data-field="emotionPrompt"]').parentElement.after(insertIntimacy)
  insertIntimacy.onclick = e => { e.preventDefault(); const input = field('emotionPrompt'); input.setRangeText('{{亲密情况}}', input.selectionStart, input.selectionEnd, 'end'); input.focus() }
  const keywords = mountActionPresetSettings(root.querySelector('[data-page="actions"]'), status)
  const showEmotion = value => {
    root.querySelector('[data-emotion-text]').textContent = value?.text || '尚未生成情绪。'
    root.querySelector('[data-emotion-status]').textContent = value?.generating ? '正在生成下一轮的情绪，期间沿用上一份。' : value?.error || (value?.updatedAt ? '更新于 '+new Date(value.updatedAt).toLocaleString() : '')
  }
  const voiceStatus = document.createElement('p'); voiceStatus.setAttribute('role','status'); root.querySelector('[data-page="voice"]').prepend(voiceStatus)
  const renderVoiceStatus = enabled => { voiceStatus.textContent = enabled ? '自动朗读已开启：保存的新音色用于下一轮回复。' : '自动朗读已关闭：聊天只显示文字；如需发声，请开启自动朗读开关。' }
  const field = key => root.querySelector(`[data-field="${key}"]`)
  const guarded = fn => async e => { e.preventDefault(); try { await fn() } catch (error) { if (!disposed) status(error.message) } }
  const load = async (force = false) => {
    if (stored && !force) return
    const token = ++generation; stored = undefined
    for (const input of root.querySelectorAll('input,textarea,select,button')) input.disabled = true
    let result
    try { result = await api('/config'); if (!disposed && token === generation) await keywords.load(result.config) }
    finally { if (!disposed && token === generation) for (const input of root.querySelectorAll('input,textarea,select,button')) if (!input.closest('[data-page="actions"]')) input.disabled = false }
    if (disposed || token !== generation) return
    stored = result.config; cleared.clear()
    intimacy.load(stored.intimacyLevels)
    events?.close(); events = new EventSource('/desktop-pet/api/conversation/events')
    events.addEventListener('state', e => { const value = JSON.parse(e.data); showEmotion(value.emotion); intimacy.state(value.intimacy) })
    events.addEventListener('emotion', e => showEmotion(JSON.parse(e.data)))
    renderVoiceStatus(stored.ttsEnabled)
    for (const input of root.querySelectorAll('[data-field]')) { const value = stored[input.dataset.field]; if (input.type === 'checkbox') input.checked = value; else input.value = value }
    root.querySelector('[data-default-voice]').value = stored.speaker === 'zh_female_gaolengyujie_uranus_bigtts' ? stored.speaker : 'custom'
    root.querySelector('[data-default-voice]').parentElement.hidden = stored.voiceKind === 'clone'
    for (const input of root.querySelectorAll('[data-key]')) { input.value = ''; input.placeholder = result.configured[input.dataset.key] ? '已保存，留空保持不变' : '尚未配置' }
  }
  root.querySelector('[data-insert-emotion]').onclick = e => { e.preventDefault(); const input = field('prompt'); input.setRangeText('{{情绪模拟}}',input.selectionStart,input.selectionEnd,'end'); input.focus() }
  root.querySelector('[data-insert-history]').onclick = e => { e.preventDefault(); const input = field('emotionPrompt'); input.setRangeText('{{聊天记录}}',input.selectionStart,input.selectionEnd,'end'); input.focus() }
  for (const button of root.querySelectorAll('[data-clear]')) button.onclick = e => { e.preventDefault(); cleared.add(button.dataset.clear); const input = root.querySelector(`[data-key="${button.dataset.clear}"]`); input.value = ''; input.placeholder = '保存后清除' }
  root.querySelector('[data-default-voice]').onchange = e => { if (e.target.value !== 'custom') { field('speaker').value = e.target.value; field('voiceName').value = '高冷御姐' } }
  field('voiceKind').onchange = () => { root.querySelector('[data-default-voice]').parentElement.hidden = field('voiceKind').value === 'clone'; if (field('voiceKind').value === 'default') { field('speaker').value = 'zh_female_gaolengyujie_uranus_bigtts'; field('voiceName').value = '高冷御姐' } else { field('speaker').value = stored.voiceKind === 'clone' ? stored.speaker : ''; field('voiceName').value = stored.voiceKind === 'clone' ? stored.voiceName : '我的克隆音色' } }
  field('speaker').oninput = () => {
    const speaker = field('speaker').value.trim()
    if (!speaker) return
    field('voiceKind').value = speaker.startsWith('S_') ? 'clone' : 'default'
    root.querySelector('[data-default-voice]').parentElement.hidden = field('voiceKind').value === 'clone'
    root.querySelector('[data-default-voice]').value = speaker === 'zh_female_gaolengyujie_uranus_bigtts' ? speaker : 'custom'
    status('音色类型已按 ID 匹配，请保存；新音色从下一轮回复生效。')
  }
  field('ttsEnabled').onchange = guarded(async () => { const enabled = field('ttsEnabled').checked, current = await api('/config'); await api('/config', { config: { ...current.config, ttsEnabled: enabled } }); stored.ttsEnabled = enabled; renderVoiceStatus(enabled); status(enabled ? '已开启自动朗读，从下一次回复生效。' : '已关闭自动朗读。') })
  root.querySelector('[data-test]').onclick = guarded(async () => { status('正在测试已保存配置…'); const result = await api('/test', {}); if (!disposed) status(`连接正常：${result.text}`) })
  const save = async () => { if (!stored) throw new Error('设置尚未加载'); const config = { ...stored, ...keywords.value() , intimacyLevels: intimacy.value() }, keys = {}; for (const input of root.querySelectorAll('[data-field]')) config[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value; for (const input of root.querySelectorAll('[data-key]')) { if (input.value.trim()) keys[input.dataset.key] = input.value.trim(); else if (cleared.has(input.dataset.key)) keys[input.dataset.key] = null } await api('/config', { config, keys }); await load(true); status('设置已保存。') }
  root.querySelector('[data-sample]').textContent = '保存并试听音色'
  root.querySelector('[data-sample]').onclick = guarded(async () => { await save(); await showPet(); status('正在合成试听…'); await api('/sample', {}); if (!disposed) status('音色已送至桌宠播放。') })
  return {
    load,
    show(page) { keywords.show(page === 'actions'); for (const div of root.querySelectorAll('[data-page]')) div.hidden = div.dataset.page !== page; root.scrollTop = 0 },
    save,
    suspend() { generation++; stored = undefined; events?.close(); keywords.suspend(); for (const input of root.querySelectorAll('[data-key]')) input.value = '' },
    dispose() { disposed = true; this.suspend(); keywords.dispose(); root.replaceChildren() },
  }
}
