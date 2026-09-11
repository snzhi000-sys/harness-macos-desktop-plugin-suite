/** Authored modules share one category across settings previews and automatic playback. */
export function describeActionModules(info) {
  const modules = info.animations
    ? info.animations.map(a=>({id:a.name,label:a.name,animation:a.name,durationMs:a.durationMs}))
    : [...info.motions.map(m=>({id:`motion:${m.group}:${m.index}`,label:m.file.split('/').at(-1).replace(/\.(motion3\.json|mtn)$/,''),motion:{group:m.group,index:m.index},durationMs:m.durationMs})), ...info.expressions.map(e=>({id:`expression:${e.name}`,label:e.name,expression:e.name,durationMs:1800}))]
  return modules.map(module=>{
    const category = info.id === 'mengmei' && ['a','i','o','m'].includes(module.animation) ? 'mouth' : 'body'
    const control = ['左右','上下',info.profile.idle].includes(module.animation) && Boolean(module.animation)
    const idle = module.motion && info.profile.actions.idle.motions.some(m=>m.group===module.motion.group&&m.index===module.motion.index)
    const defaultExpression = module.expression && module.expression === info.profile.defaultExpression
    return {...module,category,automaticEligible:category==='body'&&!control&&!idle&&!defaultExpression}
  })
}
