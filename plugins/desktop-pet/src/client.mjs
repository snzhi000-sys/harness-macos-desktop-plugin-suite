/** Built-in companion picker with persistent basic preferences and scoped preview lifetime. */
import { mountModelManager } from './model-manager.mjs'
import { mountConversationSettings } from './conversation-settings.mjs'
import { mountActionDebug } from './action-debug.mjs'
export const name = 'desktop-pet-client'
export function apply(ctx) {
  ctx.effect(() => {
    const lease = crypto.randomUUID(), desktop = window.harnessDesktop
    const command = value => desktop?.petCommand({ ...value, lease }) ?? Promise.reject(new Error('请在 Harness 桌面 App 中使用桌宠窗口'))
    const host = document.createElement('div'); host.dataset.plugin = 'desktop-pet'
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = `<style>
      :host{font:14px -apple-system,BlinkMacSystemFont,sans-serif;color:#2e3440}*{box-sizing:border-box}button,input{font:inherit;color:inherit}button{cursor:pointer;border:1px solid #e0e3e9;border-radius:10px;background:#fff;padding:9px 16px}button:hover{background:#f1f4fa}button:focus-visible,input:focus-visible{outline:3px solid #9db4e8;outline-offset:2px}button:disabled{opacity:.5;cursor:wait}
      #entry{position:fixed;bottom:16px;right:18px;z-index:900;box-shadow:0 3px 18px #17203320}
      dialog{padding:0;border:1px solid #e3e6ec;border-radius:22px;width:min(1180px,96vw);height:min(860px,94vh);max-height:94vh;color:inherit;box-shadow:0 24px 100px #0003;overflow:hidden}dialog::backdrop{background:#16233b50}
      .shell{height:100%;display:flex;flex-direction:column}.heading{display:flex;align-items:center;justify-content:space-between;padding:22px 26px;border-bottom:1px solid #edf0f4}h2{font-size:22px;margin:0 0 5px}.heading p{margin:0;color:#7a8290;font-size:13px}#close{border:0;font-size:25px;line-height:1;width:36px;height:36px;padding:0;background:transparent}
      .body{flex:1;min-height:0;display:grid;grid-template-columns:300px minmax(0,1fr)}#library{min-height:0;display:flex;flex-direction:column;background:#f7f8fb;padding:20px 14px 0;border-right:1px solid #edf0f4}.search-label{font-weight:600;margin:0 8px 12px}#model-search{width:100%;border:1px solid #e0e4ec;border-radius:10px;background:#fff;padding:10px 12px}#library-count{font-size:12px;color:#7a8290;margin:12px 6px}#models{min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:0 3px 16px}
      .character-row{display:flex;align-items:center;gap:12px;width:100%;padding:8px;margin-bottom:7px;text-align:left;border-color:transparent;background:transparent;min-height:80px}.character-row:hover{background:#eceff6}.character-row[aria-pressed=true]{border-color:#98afe0;background:#eaf0fc}.character-row img{width:48px;height:64px;object-fit:contain;border-radius:8px;background:#eee9e2;flex:none}.character-row>span:nth-child(2){min-width:0;flex:1}.character-row strong{display:block;font-size:14px;overflow-wrap:anywhere}.character-row small{display:block;color:#7a8290;font-size:11px;margin-top:5px}.selection-mark{color:#4b6faf;font-weight:700}.empty{padding:20px 8px;color:#7a8290;line-height:1.6}
      .detail{min-width:0;min-height:0;overflow:auto;padding:18px 28px;display:flex;flex-direction:column}.portrait{position:relative;min-height:150px;flex:1;background:radial-gradient(ellipse at 50% 80%,#e4dfd4 0,transparent 65%),#f6f3ed;border-radius:16px;overflow:hidden}.portrait:after{content:"";position:absolute;bottom:12px;left:35%;right:35%;height:7px;background:#776b5820;filter:blur(5px);border-radius:50%;pointer-events:none}#model-preview{display:block;width:100%;height:100%;border:0;position:absolute;inset:0}#character-name{font-size:18px;margin:14px 0 4px}#character-subtitle{font-size:12px;color:#7a8290;margin:0 0 13px}.size-label{display:flex;justify-content:space-between;align-items:center;font-size:13px}.size-label output{color:#7a8290;font-variant-numeric:tabular-nums}#height{width:100%;accent-color:#6281bd;margin:12px 0 14px}.toggle{display:flex;align-items:center;justify-content:space-between;padding:9px 0;font-size:13px}.toggle input{width:18px;height:18px;accent-color:#6281bd}.hint{font-size:12px;color:#7a8290;line-height:1.5;margin:12px 0 0}
      footer{flex:none;border-top:1px solid #edf0f4;padding:12px 24px 16px;background:white}#status{font-size:12px;min-height:18px;margin:0 0 8px;color:#68758a}.actions{display:flex;gap:10px;align-items:center}.actions .primary{margin-left:auto;background:#526fa5;color:#fff;border-color:#526fa5}.actions .primary:hover{background:#435f92}
      @media(max-width:650px){.body{grid-template-columns:42% minmax(0,1fr)}#library{padding:12px 6px 0}.detail{padding:12px}.character-row{gap:6px;padding:5px}.character-row img{width:34px;height:50px}.character-row strong{font-size:12px}.character-row small{font-size:10px}.heading{padding:16px}.heading p{max-width:240px;font-size:12px}.selection-mark{display:none}footer{padding:10px 14px}.hint{display:none}}
      </style><button id="entry" title="桌宠设置">🐾 桌宠</button><dialog aria-labelledby="pet-title">
      <div class="shell"><header class="heading"><div><h2 id="pet-title">桌面伙伴</h2><p>挑一位喜欢的伙伴，陪你一起工作。</p></div><button id="close" aria-label="关闭" title="关闭">×</button></header>
      <div class="body"><aside id="library"></aside><section class="detail" aria-label="当前角色与设置"><div class="portrait"><iframe id="model-preview" title="角色立绘" src="about:blank"></iframe></div><h3 id="character-name">正在加载伙伴…</h3><p id="character-subtitle"></p>
      <label class="size-label" for="height"><span>角色显示大小</span><output id="height-value"></output></label><input id="height" type="range" min="180" max="1000" step="10">
      <label class="toggle" for="animated">开启动画<input id="animated" type="checkbox"></label><label class="toggle" for="alwaysOnTop">保持在窗口上方<input id="alwaysOnTop" type="checkbox"></label><p class="hint">轻轻摸头、点击互动，按住角色即可拖动。</p></section></div>
      <footer><p id="status" role="status"></p><div class="actions"><button id="show">显示</button><button id="hide">隐藏</button><button id="save" class="primary">保存</button></div></footer></div></dialog>`
    const layoutStyle = document.createElement('style')
    layoutStyle.textContent = 'dialog{width:min(1180px,96vw)!important;height:min(860px,94vh)!important;max-height:94vh!important}.body{grid-template-columns:320px minmax(0,1fr)!important}.detail{padding:22px 32px!important}'
    shadow.append(layoutStyle)
    document.body.append(host)
    const find = id => shadow.getElementById(id), dialog = shadow.querySelector('dialog')
    const tabs = document.createElement('nav'); tabs.style.cssText = 'display:flex;gap:8px;padding:10px 24px;border-bottom:1px solid #edf0f4;overflow-x:auto;flex-shrink:0;white-space:nowrap'
    tabs.innerHTML = '<button data-tab="partner">伙伴</button><button data-tab="conversation">对话</button><button data-tab="prompts">Prompt 管理</button><button data-tab="intimacy">亲密度</button><button data-tab="actions">动作与关键词</button><button data-tab="voice">声音</button><button data-tab="history">聊天记录</button>'
    tabs.setAttribute('aria-label','桌宠设置分类')
    const selectTab = tab => { for (const button of tabs.querySelectorAll('button')) { button.setAttribute('aria-pressed',String(button.dataset.tab===tab)); button.style.background = button.dataset.tab===tab ? '#eaf0fc' : '' } }
    selectTab('partner')
    shadow.querySelector('.heading').after(tabs)
    const voiceRoot = document.createElement('section'); voiceRoot.className = 'voice-form'; voiceRoot.style.display = 'none'; shadow.querySelector('.body').after(voiceRoot)
    const history = document.createElement('iframe'); history.title = '聊天记录与高级对话'; history.allow = 'microphone'; history.src = 'about:blank'; history.style.cssText = 'display:none;flex:1;min-height:0;width:100%;border:0'; voiceRoot.after(history)
    let selectedTab = 'partner'
    let disposed = false, attached = false, settings, opening = 0, saving = false
    const status = text => { if (!disposed) find('status').textContent = text }
    const voiceSettings = mountConversationSettings(voiceRoot, status, async () => { await command({ action: 'show' }); await new Promise(resolve => setTimeout(resolve, 600)) })
    tabs.onclick = async event => {
      try {
        const tab = event.target.closest('[data-tab]')?.dataset.tab; if (!tab) return
        selectTab(tab)
        actionDebug.suspend(); selectedTab = tab; shadow.querySelector('.body').style.display = tab === 'partner' ? '' : 'none'; voiceRoot.style.display = ['partner', 'history'].includes(tab) ? 'none' : 'block'; history.style.display = tab === 'history' ? 'block' : 'none'; history.src = tab === 'history' ? '/desktop-pet/chat' : 'about:blank'; find('save').hidden = tab === 'history'
        voiceSettings.show(tab)
        if (tab !== 'partner') { find('model-preview').src = 'about:blank'; if (tab !== 'history') { await voiceSettings.load() } }
        else preview(await library.refresh())
      } catch (error) { status(error.message) }
    }
    const api = async (path, body) => {
      const response = await fetch(`/desktop-pet/api/${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      const value = await response.json(); if (!response.ok) throw new Error(value.error); return value
    }
    const debugRoot = document.createElement('section'); shadow.querySelector('.detail').append(debugRoot)
    const actionDebug = mountActionDebug(debugRoot, { api, status, animated: () => settings?.animated })
    const preview = model => {
      if (disposed || !dialog.open || !model || selectedTab !== 'partner') return
      find('character-name').textContent = model.name; find('character-subtitle').textContent = model.subtitle
      find('model-preview').src = `/desktop-pet/view?preview=1&model=${encodeURIComponent(model.id)}`
      void actionDebug.load(model.id)
    }
    let updates = Promise.resolve()
    const updateSettings = patch => {
      const result = updates.then(async () => { settings = await api('settings', { ...settings, ...patch }) })
      updates = result.catch(() => {})
      return result
    }
    const configure = async () => { if (attached) await command({ action: 'configure', height: settings.height, alwaysOnTop: settings.alwaysOnTop }) }
    const wardrobe = document.createElement('div'); find('character-subtitle').after(wardrobe)
    const library = mountModelManager(find('library'), { wardrobe, api, selected: () => settings?.modelId, status, select: async model => {
      actionDebug.suspend()
      // Save only the character here; unconfirmed size and toggle edits stay in their controls.
      await updateSettings({ modelId: model.id })
      if (disposed) return
      preview(model)
      await configure()
      if (attached) await command({ action: 'show' })
    } })
    const ready = (async () => {
      settings = await api('settings')
      if (disposed) return
      if (desktop?.petCommand) {
        await command({ action: 'attach', height: settings.height, alwaysOnTop: settings.alwaysOnTop }); attached = true
        if (disposed) { await command({ action: 'detach' }); attached = false }
      }
    })()
    ready.catch(error => status(error.message))
    const run = action => async () => { try { await ready; if (!disposed) await action() } catch (error) { status(error.message) } }
    find('entry').onclick = run(async () => {
      if (dialog.open) return
      const token = ++opening
      dialog.showModal(); library.resume(); status('')
      if (selectedTab === 'history') history.src = '/desktop-pet/chat'; else if (selectedTab !== 'partner') { voiceSettings.show(selectedTab); await voiceSettings.load() }
      settings = await api('settings')
      if (disposed || !dialog.open || token !== opening) return
      find('height').value = settings.height; find('height-value').value = `${settings.height} px`
      for (const key of ['animated', 'alwaysOnTop']) find(key).checked = settings[key]
      preview(await library.refresh())
    })
    find('height').oninput = () => { find('height-value').value = `${find('height').value} px` }
    const releasePreview = () => { actionDebug.suspend(); history.src = 'about:blank'; ++opening; library.suspend(); voiceSettings.suspend(); find('model-preview').src = 'about:blank' }
    find('close').onclick = () => { releasePreview(); dialog.close() }
    dialog.addEventListener('cancel', releasePreview)
    dialog.addEventListener('close', releasePreview)
    find('save').onclick = run(async () => {
      if (saving) return
      saving = true; find('save').disabled = true
      try {
        if (selectedTab === 'history') return
        if (selectedTab !== 'partner') { await voiceSettings.save(); return }
        await updateSettings({ height: Number(find('height').value), animated: find('animated').checked, alwaysOnTop: find('alwaysOnTop').checked })
        if (disposed) return
        await configure()
        const current = await library.refresh(); preview(current)
        status('设置已保存。')
      } finally { saving = false; if (!disposed) find('save').disabled = false }
    })
    find('show').onclick = run(async () => { await command({ action: 'show' }); status('伙伴已显示。') })
    find('hide').onclick = run(async () => { await command({ action: 'hide' }); status('伙伴已隐藏，点击「显示」即可回来。') })
    const unsubscribeSettings = desktop?.onPetSettings?.(() => { if (!disposed) find('entry').click() })
    const unload = () => { actionDebug.dispose(); if (attached) { attached = false; void command({ action: 'detach' }).catch(() => { /* Native ownership also releases the window on navigation. */ }) } }
    const react = event => { if (['touch', 'click'].includes(event.detail?.action)) void ready.then(() => { if (!disposed && attached) return command({ action: 'react', reaction: event.detail.action }) }).catch(error => status(error.message)) }
    window.addEventListener('dsh-desktop-pet:react', react); window.addEventListener('pagehide', unload)
    return () => { disposed = true; ++opening; unload(); unsubscribeSettings?.(); library.dispose(); voiceSettings.dispose(); find('model-preview').src = 'about:blank'; window.removeEventListener('pagehide', unload); window.removeEventListener('dsh-desktop-pet:react', react); history.src = 'about:blank'; host.remove() }
  }, 'desktop-pet: picker and desktop lifetime')
}
