/** Shared model-space interaction and authored action playback for both Cubism generations. */
import * as PIXI from 'pixi.js'

export async function createModelRenderer(Model, stage, settings, onError, descriptor) {
  const info = descriptor ?? await (await fetch('/desktop-pet/api/model')).json()
  if (info.error) throw new Error(info.error)
  const profile = info.profile
  if (info.kind === 'cubism2') PIXI.settings.PREFER_ENV = PIXI.ENV.WEBGL
  const resolution = Math.min(devicePixelRatio || 1, 2)
  const app = new PIXI.Application({ width: stage.clientWidth, height: stage.clientHeight, backgroundAlpha: 0, antialias: true, autoStart: false, resolution, autoDensity: true, preserveDrawingBuffer: true })
  let model
  try { model = await Model.from(`/desktop-pet/models/${encodeURIComponent(info.id)}/${info.kind === 'cubism2' ? 'entry.model.json' : 'entry.model3.json'}`, { autoInteract: false, autoUpdate: false, motionPreload: 'NONE', idleMotionGroup: '__pet_scheduled_idle__' }) }
  catch (error) { app.destroy(true, { children: true, texture: true, baseTexture: true }); throw error }
  app.stage.addChild(model); stage.append(app.view)
  const internal = model.internalModel, manager = internal.motionManager, core = internal.coreModel
  const legacy = info.kind === 'cubism2'
  const legacyIds = [...new Set([...info.parameterIds,...Object.values(profile.parameters)])]
  const baseParameters = Array.from({length: legacy ? legacyIds.length : core.getParameterCount()}, (_, i) => legacy ? core.getParamFloat(legacyIds[i]) : core.getParameterValueByIndex(i))
  const baseParts = legacy ? [] : Array.from({length:core.getPartCount()},(_,i)=>core.getPartOpacityByIndex(i))
  const resetPose = () => {
    manager.stopAllMotions()
    manager.playing = false
    manager.expressionManager?.stopAllExpressions()
    baseParameters.forEach((value,i)=>legacy ? core.setParamFloat(legacyIds[i],value) : core.setParameterValueByIndex(i,value))
    baseParts.forEach((value,i)=>core.setPartOpacityByIndex(i,value))
    if (legacy) core.saveParam()
    else { internal.pose?.reset(core); core.saveParameters() }
  }
  let disposed = false, initialized = false, sequence = 0, previous = performance.now(), until = 0, nextIdle = 0
  let active = 'idle', lastMotion = null, activeExpression = null, pending = false, gazeWeight = 1
  let speaking = false, inputFocused = false
  let lastPixelKey = '', pixelAt = 0, opaque = false, fitFrames = 3, visibleBounds
  const pixel = new Uint8Array(4)
  // Focus remains additive, at reduced weight when an authored reaction owns head and body parameters.
  internal.updateFocus = () => {
    const focus = internal.focusController, x = focus.x * gazeWeight, y = focus.y * gazeWeight
    const add = (id, value) => { if (!id) return; if (info.kind === 'cubism2') core.addToParamFloat(id, value); else core.addParameterValueById(id, value) }
    add(profile.parameters.eyeX, x); add(profile.parameters.eyeY, y)
    add(profile.parameters.angleX, x * 20); add(profile.parameters.angleY, y * 15)
  }
  const failure = error => { if (!disposed) onError(error instanceof Error ? error : new Error(String(error))) }
  manager.on('motionLoadError', (group, index, error) => failure(new Error(`动作 ${group}[${index}]：${error.message}`)))
  manager.expressionManager?.on('expressionLoadError', (index, error) => failure(new Error(`表情 ${index}：${error.message}`)))
  const interval = () => profile.idleMinMs + Math.random() * (profile.idleMaxMs - profile.idleMinMs)
  const expression = async name => {
    activeExpression = name
    if (name !== null) {
      const expressions = manager.expressionManager
      const index = expressions.getExpressionIndex(name)
      if (index >= 0 && expressions.expressions[index] === expressions.currentExpression) expressions.restoreExpression()
      else if (!await model.expression(name)) throw new Error(`表情无法播放：${name}`)
    }
    else manager.expressionManager?.resetExpression()
  }
  const play = async (actionName, override) => {
    if (disposed || !settings.animated) return false
    const token = ++sequence, action = override ?? profile.actions[actionName]
    if (!action) return false
    active = actionName; pending = true
    const choices = action.motions.filter(ref => !lastMotion || ref.group !== lastMotion.group || ref.index !== lastMotion.index)
    const pool = choices.length ? choices : action.motions
    const ref = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null
    try {
      const motion = ref ? await manager.loadMotion(ref.group, ref.index) : null
      if (disposed || token !== sequence) return false
      if (ref && !motion) throw new Error('模型动作加载失败')
      resetPose()
      if (motion) {
        if ('_isLoop' in motion) motion._isLoop = false
        if (manager.state.currentGroup === ref.group && manager.state.currentIndex === ref.index) manager.stopAllMotions()
        const started = await model.motion(ref.group, ref.index, 3)
        if (disposed || token !== sequence) return false
        if (!started) throw new Error(`动作未启动：${ref.group}[${ref.index}]`)
        lastMotion = ref
      }
      await expression(action.expression ?? (actionName === 'idle' ? profile.defaultExpression : null))
      if (disposed || token !== sequence) return false
      const detail = ref ? info.motions.find(item => item.group === ref.group && item.index === ref.index) : null
      until = ['drag','speaking'].includes(actionName) ? Infinity : performance.now() + Math.min(detail?.durationMs ?? 1800, action.maxMs)
      nextIdle = until + interval()
      return true
    } finally { if (token === sequence) pending = false }
  }
  const restore = () => { ++sequence; pending = false; resetPose(); active = 'idle'; until = 0; nextIdle = performance.now() + interval(); void play('idle').catch(failure) }
  manager.on('motionFinish', () => { if (!pending && !['idle', 'drag', 'debug', 'speaking'].includes(active)) restore() })
  const fit = () => {
    const scale = Math.min(app.screen.width / internal.width, app.screen.height / internal.height) * 0.3
    model.scale.set(scale); model.anchor.set(0.5, 0.5)
    model.position.set(app.screen.width * 0.5, app.screen.height * 0.35)
    fitFrames = 3
  }
  const fitVisible = () => {
    // Exported canvas/layout bounds can include large empty margins; fit visible artwork once, not every frame.
    const width = app.view.width, height = app.view.height
    const pixels = new Uint8Array(width * height * 4)
    app.renderer.renderTexture.bind(null)
    const gl = app.renderer.gl
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    let left = width, right = 0, top = height, bottom = 0
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (pixels[(y * width + x) * 4 + 3] > 24) {
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, height - 1 - y); bottom = Math.max(bottom, height - 1 - y)
    }
    if (right > left && bottom > top) {
      const centerX = (left + right) / (2 * resolution), centerY = (top + bottom) / (2 * resolution)
      const factor = Math.min(app.screen.width * 0.82 / ((right - left) / resolution), (app.screen.height - 80) / ((bottom - top) / resolution)) * profile.scale
      model.position.set(app.screen.width * (0.5 + profile.offsetX) - (centerX - model.x) * factor, (app.screen.height + 48) / 2 + profile.offsetY * app.screen.height - (centerY - model.y) * factor)
      model.scale.set(model.scale.x * factor)
      visibleBounds = { x: app.screen.width * (0.5 + profile.offsetX) - (right - left) / resolution * factor / 2, y: (app.screen.height + 48) / 2 + profile.offsetY * app.screen.height - (bottom - top) / resolution * factor / 2, width: (right - left) / resolution * factor, height: (bottom - top) / resolution * factor }
    }
  }
  fit()
  if (settings.animated) void play('idle').catch(failure)
  const hit = (x, y) => {
    if (disposed || x < 0 || y < 0 || x >= app.screen.width || y >= app.screen.height) return false
    const key = `${Math.floor(x)},${Math.floor(y)}`, now = performance.now()
    if (key !== lastPixelKey || now - pixelAt > 100) {
      // One screen pixel instead of a full framebuffer download on every pointer tick.
      const gl = app.renderer.gl
      gl.readPixels(Math.floor(x * resolution), app.view.height - 1 - Math.floor(y * resolution), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
      opaque = pixel[3] > 24; lastPixelKey = key; pixelAt = now
    }
    return opaque
  }
  return {
    profile, info,
    setSpeaking(value) { speaking = value },
    setInputFocused(value) { inputFocused = value },
    playSpeaking(selection) { return play('speaking', { motions: selection.motion ? [selection.motion] : [], expression: selection.expression ?? null, maxMs: Infinity }).catch(failure) },
    cancelSpeaking() { if (active === 'speaking') restore() },
    playAutomatic(selection) { return play('automatic', { motions: selection.motion ? [selection.motion] : [], expression: selection.expression ?? null, maxMs: 60000 }).catch(failure) },
    cancelAutomatic() { if (active === 'automatic') restore() },
    async startDebug(selection) {
      if (disposed || !settings.animated) return
      await play('debug', { motions: selection.motion ? [selection.motion] : [], expression: selection.expression ?? null, maxMs: Infinity })
      if (active === 'debug') until = Infinity
    },
    stopDebug() {
      if (disposed || active !== 'debug') return
      ++sequence; pending = false; manager.stopAllMotions(); restore()
    },
    get contentBottom() { const b = visibleBounds ?? model.getBounds(); return b.y + b.height },
    react(name) { return play(name).catch(failure) },
    preview(ref, name = null) { return play('click', { motions: ref ? [ref] : [], expression: name, maxMs: 12000 }).catch(failure) },
    get state() { return active },
    hit,
    region(x, y) {
      if (!hit(x, y)) return null
      const areas = model.hitTest(x, y)
      if (areas.some(name => /head|face/i.test(name))) return 'head'
      if (areas.some(name => /body/i.test(name))) return 'body'
      const bounds = visibleBounds ?? model.getBounds(), h = profile.headRegion
      const nx = (x - bounds.x) / bounds.width, ny = (y - bounds.y) / bounds.height
      return nx >= h.x && nx <= h.x + h.width && ny >= h.y && ny <= h.y + h.height ? 'head' : 'body'
    },
    update(now, pointer) {
      if (disposed) return
      if (app.screen.width !== stage.clientWidth || app.screen.height !== stage.clientHeight) { app.renderer.resize(stage.clientWidth, stage.clientHeight); fit() }
      if (settings.animated) {
        gazeWeight += ((active === 'idle' ? 1 : active === 'drag' ? 0.6 : 0.12) - gazeWeight) * 0.08
        const bounds = visibleBounds ?? model.getBounds()
        const inside = !speaking && !inputFocused && pointer.x >= 0 && pointer.x <= app.screen.width && pointer.y >= 0 && pointer.y <= app.screen.height
        const clamp = value => Math.max(-1, Math.min(1, value))
        internal.focusController.focus(inside ? clamp((pointer.x - bounds.x - bounds.width / 2) / (bounds.width * 0.9)) : 0, inside ? clamp((bounds.y + bounds.height * 0.2 - pointer.y) / (bounds.height * 0.6)) : 0)
        if (!pending && !['idle', 'drag', 'debug'].includes(active) && now >= until) restore()
        if (!pending && active === 'idle' && now >= nextIdle && manager.isFinished()) void play('idle').catch(failure)
        model.update(Math.max(0, Math.min(now - previous, 50)))
      } else if (!initialized) {
        // Pixi skips internal-model evaluation for zero delta; Cubism 2 needs one evaluation to populate its drawable vertices.
        model.update(1)
      }
      initialized = true
      previous = now; app.renderer.render(app.stage)
      if (fitFrames > 0 && --fitFrames === 0) fitVisible()
    },
    inspect() {
      const ids = info.kind === 'cubism2' ? ['PARAM_ANGLE_X', 'PARAM_ANGLE_Y', 'PARAM_EYE_L_OPEN', 'PARAM_EYE_R_OPEN', 'PARAM_BODY_ANGLE_X', 'PARAM_MOUTH_OPEN_Y'] : ['ParamAngleX', 'ParamAngleY', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamBodyAngleX', 'ParamMouthOpenY']
      return { state: active, motion: lastMotion, expression: activeExpression, poseParameters: baseParameters.map((_,i)=>legacy ? core.getParamFloat(legacyIds[i]) : core.getParameterValueByIndex(i)), partOpacities: baseParts.map((_,i)=>core.getPartOpacityByIndex(i)), parameters: Object.fromEntries(ids.map(id => [id, info.kind === 'cubism2' ? core.getParamFloat(id) : core.getParameterValueById(id)])), bounds: model.getBounds(), hitAreas: Object.keys(internal.hitAreas), physics: Boolean(internal.physics), pending }
    },
    inspectParts() { return legacy ? {} : Object.fromEntries(core.getModel().parts.ids.map((id,i)=>[id,core.getPartOpacityByIndex(i)])) },
    dispose() { if (disposed) return; disposed = true; ++sequence; app.destroy(true, { children: true, texture: true, baseTexture: true }) },
  }
}
