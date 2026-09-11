/** Official Spine WebGL 4.2 adapter. The page owns its clock, GPU resources and audio cues. */
import { MouthCues } from './mouth-cues.mjs'

export async function createSpineRenderer(stage, settings, onError, info) {
  const spine = globalThis.spine, profile = info.profile, canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: true })
  if (!gl) throw new Error('Spine 需要 WebGL')
  const context = new spine.ManagedWebGLRenderingContext(gl), images = []
  let atlas
  let renderer, skeleton, animation, mouth, disposed = false, active = 'idle', elapsed = 0, until = 0, previous = performance.now(), wasAnimated = settings.animated
  let bounds, fitWidth = 0, fitHeight = 0, resolution = 1
  let debugRestore
  const aborted = new AbortController()
  const dispose = () => {
    if (disposed) return
    disposed = true; aborted.abort(); mouth?.dispose(); animation?.clearTracks(); renderer?.dispose(); atlas?.dispose(); images.forEach(image => image.close()); context.dispose(); canvas.remove()
    canvas.removeEventListener('webglcontextlost', lost)
    window.removeEventListener('pagehide', dispose)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
  const lost = event => { event.preventDefault(); if (!disposed) { dispose(); onError(new Error('Spine 绘图上下文已丢失，请重新选择角色')) } }
  canvas.addEventListener('webglcontextlost', lost)
  window.addEventListener('pagehide', dispose, { once: true })
  const play = (name, track, loop = false) => {
    if (!info.animations.some(a => a.name === name && a.timelines)) throw new Error(`Spine 动作缺少关键帧：${name}`)
    return animation.setAnimation(track, name, loop)
  }
  const advance = dt => { skeleton.update(dt); animation.update(dt); animation.apply(skeleton); skeleton.updateWorldTransform(spine.Physics.update) }
  const fit = () => {
    fitWidth = Math.max(1, stage.clientWidth); fitHeight = Math.max(1, stage.clientHeight); resolution = Math.min(devicePixelRatio || 1, 2)
    canvas.width = Math.round(fitWidth * resolution); canvas.height = Math.round(fitHeight * resolution)
    canvas.style.width = `${fitWidth}px`; canvas.style.height = `${fitHeight}px`
    renderer.camera.position.set(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, 0)
    renderer.camera.setViewport(fitWidth, fitHeight)
    renderer.camera.zoom = Math.max(bounds.width / (fitWidth * .86), bounds.height / (fitHeight * .86)); renderer.camera.update()
  }
  const draw = () => { gl.viewport(0, 0, canvas.width, canvas.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); renderer.begin(); renderer.drawSkeleton(skeleton, info.premultipliedAlpha ?? false); renderer.end() }
  try {
    const signal = AbortSignal.any([aborted.signal, AbortSignal.timeout(30000)])
    const resource = async child => {
      const response = await fetch(`/desktop-pet/models/${encodeURIComponent(info.id)}/${child.split('/').map(encodeURIComponent).join('/')}`, { signal })
      if (!response.ok) throw new Error('Spine 资源加载失败')
      return response
    }
    const [json, text] = await Promise.all([resource(info.skeleton).then(r => r.json()), resource(info.atlas).then(r => r.text())])
    signal.throwIfAborted()
    atlas = new spine.TextureAtlas(text)
    for (const page of atlas.pages) {
      const blob = await (await resource(page.name)).blob(), bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
      if (signal.aborted) { bitmap.close(); signal.throwIfAborted() }
      images.push(bitmap); page.setTexture(new spine.GLTexture(context, bitmap))
    }
    const parser = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas))
    const data = parser.readSkeletonData(json)
    skeleton = new spine.Skeleton(data); animation = new spine.AnimationState(new spine.AnimationStateData(data)); animation.data.defaultMix = .15
    skeleton.setToSetupPose(); skeleton.updateWorldTransform(spine.Physics.reset)
    play(profile.idle, 0, true)
    if (profile.mouths?.length) {
      mouth = new MouthCues(shape => { if (!disposed) play(shape, 3) }, profile.mouths, profile.neutralMouth)
      mouth.set(profile.neutralMouth)
    }
    advance(1 / 60)
    const offset = new spine.Vector2(), size = new spine.Vector2(); skeleton.getBounds(offset, size, [])
    bounds = { x: offset.x, y: offset.y, width: size.x, height: size.y }
    if (!(size.x > 0 && size.y > 0 && Number.isFinite(size.x + size.y))) throw new Error('Spine 角色边界无效')
    renderer = new spine.SceneRenderer(canvas, context); fit(); stage.append(canvas); draw()
  } catch (error) { dispose(); throw error }
  const pixel = new Uint8Array(4)
  const hit = (x, y) => {
    if (disposed || x < 0 || y < 0 || x >= fitWidth || y >= fitHeight) return false
    gl.readPixels(Math.floor(x * canvas.width / fitWidth), canvas.height - 1 - Math.floor(y * canvas.height / fitHeight), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    return pixel[3] > 24
  }
  const feedback = (motion, expression) => {
    if (motion) play(motion, 1); else animation.setEmptyAnimation(1, .15)
    if (expression) play(expression, 2); else animation.setEmptyAnimation(2, .15)
  }
  return {
    profile, info, hit, get state() { return active },
    setSpeaking() { /* This unregistered experimental renderer has no pointer-follow layer. */ },
    setInputFocused() { /* This unregistered experimental renderer has no pointer-follow layer. */ },
    playSpeaking(selection) { if (disposed || !settings.animated) return; play(selection.animation,1);active='speaking';until=Infinity },
    cancelSpeaking() { if (active !== 'speaking') return;animation.setEmptyAnimation(1,.2);active='idle';until=0 },
    playAutomatic(selection) { if (disposed || !settings.animated || active !== 'idle') return; play(selection.animation,1);active='automatic';until=elapsed+Math.max(1.2,selection.durationMs/1000) },
    cancelAutomatic() { if (active !== 'automatic') return;animation.setEmptyAnimation(1,.15);active='idle';until=0 },
    startDebug(selection) { if (disposed || !settings.animated) return; debugRestore ??= { active, until }; play(selection.animation, 4); active = 'debug'; until = Infinity },
    stopDebug() { if (disposed || !debugRestore) return; animation.setEmptyAnimation(4, .2); active = debugRestore.active; until = debugRestore.until; debugRestore = null },
    speech: { start(timeline, clock) { if (disposed || !settings.animated || !mouth) return false; mouth.start(timeline, clock); return true }, cancel() { if (!disposed) mouth?.cancel() } },
    react(name) {
      if (disposed || !settings.animated || !profile.actions[name]) return false
      const action = profile.actions[name]; feedback(action.motion, action.expression); active = name
      until = name === 'drag' ? Infinity : elapsed + Math.max(1.2, (info.animations.find(a => a.name === action.motion)?.durationMs ?? 1400) / 1000)
      return true
    },
    preview(motion, expression) { if (disposed || !settings.animated) return; feedback(typeof motion === 'string' ? motion : motion?.name, expression); active = 'preview'; until = elapsed + 6 },
    region(x, y) {
      if (!hit(x, y)) return null
      const world = renderer.camera.screenToWorld(new spine.Vector3(x, y, 0), fitWidth, fitHeight), h = profile.headRegion
      const nx = (world.x - bounds.x) / bounds.width, ny = 1 - (world.y - bounds.y) / bounds.height
      return nx >= h.x && nx <= h.x + h.width && ny >= h.y && ny <= h.y + h.height ? 'head' : 'body'
    },
    update(now) {
      if (disposed) return
      if (fitWidth !== stage.clientWidth || fitHeight !== stage.clientHeight || resolution !== Math.min(devicePixelRatio || 1, 2)) fit()
      if (wasAnimated && !settings.animated) { mouth?.cancel(); animation.apply(skeleton); skeleton.updateWorldTransform(spine.Physics.pose) }
      if (!wasAnimated && settings.animated) skeleton.updateWorldTransform(spine.Physics.reset)
      wasAnimated = settings.animated
      if (settings.animated) {
        const dt = Math.max(0, Math.min((now - previous) / 1000, .05)); elapsed += dt; mouth?.update()
        if (active !== 'idle' && elapsed >= until) { animation.setEmptyAnimation(1, .2); animation.setEmptyAnimation(2, .2); active = 'idle' }
        advance(dt)
      }
      previous = now; draw()
    },
    get contentBottom() { return fitHeight / 2 + bounds.height / (2 * renderer.camera.zoom) },
    inspect() { return { state: active, disposed, bodyTime: animation.getCurrent(0)?.trackTime, mouth: mouth?.current ?? null, speaking: mouth?.active ?? false, bounds, bones: skeleton.bones.length, physics: skeleton.physicsConstraints.length } },
    dispose,
  }
}
