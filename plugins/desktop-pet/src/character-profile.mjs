/** Model-specific action pools use explicit indices, including valid empty group names. */
export const actionNames = ['idle', 'touch', 'click', 'annoyed', 'drag', 'release', 'thinking', 'working', 'replying', 'waiting', 'complete', 'error']

/** Derive conservative defaults from actual authored filenames; unknown models only use known idle/tap groups. */
export function suggestedProfile(info) {
  const find = regex => info.motions.filter(item => regex.test(item.file)).map(({ group, index }) => ({ group, index }))
  const expression = name => info.expressions.some(item => item.name === name) ? name : null
  const katou = Boolean(expression('F_FUN'))
  const senko = info.motions.some(item => /Singing\.motion3/.test(item.file))
  const idle = find(katou ? /IDLING_0[123]\.mtn$/ : /idl(?:e|ing)/i)
  const unique = pool => pool.filter((item, index) => pool.findIndex(other => other.group === item.group && other.index === item.index) === index)
  const first = group => info.motions.filter(item => item.group.toLowerCase() === group).slice(0, 3).map(({ group, index }) => ({ group, index }))
  const happy = katou ? find(/I_FUN(?:_S)?\.mtn$/) : senko ? first('tap') : first('flick_head')
  const surprise = katou ? find(/I_SURPRISE_S\.mtn$/) : first('tap_body').length ? first('tap_body') : first('tapbody')
  const gentle = katou ? find(/I_ANGRY_S\.mtn$/) : surprise
  const action = (motions, expression = null, maxMs = 8000) => ({ motions: unique(motions), expression, maxMs })
  const profile = {
    version: 1, scale: 1, offsetX: 0, offsetY: 0, idleMinMs: 9000, idleMaxMs: 18000,
    cooldownMs: 650, dragThreshold: 28, strokeThreshold: 7, strokeMs: 220, headRegion: { x: 0.12, y: 0.03, width: 0.76, height: 0.32 },
    defaultExpression: expression('F_NOMAL'),
    parameters: info.kind === 'cubism2' ? { angleX: 'PARAM_ANGLE_X', angleY: 'PARAM_ANGLE_Y', eyeX: 'PARAM_EYE_BALL_X', eyeY: 'PARAM_EYE_BALL_Y' } : { angleX: 'ParamAngleX', angleY: 'ParamAngleY', eyeX: 'ParamEyeBallX', eyeY: 'ParamEyeBallY' },
    actions: { idle: action(idle), touch: action(happy, expression('F_FUN')), click: action(surprise, expression('F_SURPRISE')), annoyed: action(gentle, expression('F_ANGRY'), 4000), drag: action([], expression('F_SURPRISE')), release: action(happy, expression('F_FUN'), 3500), thinking: action(idle), working: action(idle), replying: action(happy), waiting: action([], expression('F_DOWN')), complete: action(happy, expression('F_FUN')), error: action(gentle, expression('F_SAD')) },
  }
  return profile
}

/** Validate editable profiles against the selected model before saving. */
export function validateProfile(value, info) {
  if (!value || value.version !== 1 || !value.actions) throw new Error('角色配置无效')
  const result = structuredClone(value)
  const range = (key, min, max) => { if (!Number.isFinite(result[key]) || result[key] < min || result[key] > max) throw new Error(`角色设置无效：${key}`) }
  range('scale', 0.4, 2); range('offsetX', -0.5, 0.5); range('offsetY', -0.5, 0.5)
  range('idleMinMs', 1000, 120000); range('idleMaxMs', result.idleMinMs, 180000)
  range('cooldownMs', 100, 5000); range('dragThreshold', 10, 80); range('strokeThreshold', 2, 20); range('strokeMs', 100, 2000)
  const region = result.headRegion
  if (!region || ['x', 'y', 'width', 'height'].some(key => !Number.isFinite(region[key]) || region[key] < 0 || region[key] > 1) || region.width <= 0 || region.height <= 0 || region.x + region.width > 1 || region.y + region.height > 1) throw new Error('头部区域须位于模型边界内')
  const checkExpression = name => { if (name !== null && !info.expressions.some(item => item.name === name)) throw new Error(`表情不存在：${name}`) }
  checkExpression(result.defaultExpression)
  for (const key of ['angleX', 'angleY', 'eyeX', 'eyeY']) if (typeof result.parameters?.[key] !== 'string' || result.parameters[key].length > 120) throw new Error(`参数映射无效：${key}`)
  for (const name of actionNames) {
    const action = result.actions[name]
    if (!action || !Array.isArray(action.motions) || action.motions.length > 100 || !Number.isFinite(action.maxMs) || action.maxMs < 300 || action.maxMs > 60000) throw new Error(`动作配置无效：${name}`)
    for (const ref of action.motions) if (!info.motions.some(item => item.group === ref.group && item.index === ref.index)) throw new Error(`动作不存在：${ref.group}[${ref.index}]`)
    checkExpression(action.expression)
  }
  return result
}
