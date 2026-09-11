/** Cubism 3/4 adapter; load official Core before importing this module. */
import { Live2DModel, config, CubismConfig, Cubism4MotionManager } from 'pixi-live2d-display/cubism4'
import { createModelRenderer } from './model-renderer.mjs'
config.sound = false
// PartOpacity curves switch alternate limb artwork; treating them as parameters leaves both visible.
CubismConfig.setOpacityFromMotion = true
const createMotion = Cubism4MotionManager.prototype.createMotion
Cubism4MotionManager.prototype.createMotion = function(data, group, definition) {
  // The pinned evaluator visits Model, Parameter, then PartOpacity in separate contiguous loops.
  const order = { Model: 0, Parameter: 1, PartOpacity: 2 }
  const normalized = {...data, Curves: [...data.Curves].sort((a,b)=>(order[a.Target] ?? 3)-(order[b.Target] ?? 3))}
  return createMotion.call(this, normalized, group, definition)
}
export const createLive2DRenderer = (stage, settings, onError, info) => createModelRenderer(Live2DModel, stage, settings, onError, info)
