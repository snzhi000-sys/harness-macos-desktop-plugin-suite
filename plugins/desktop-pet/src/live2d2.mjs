/** Cubism 2 uses its own Core and adapter; never pass a .moc to Cubism 4. */
import { Live2DModel, config } from 'pixi-live2d-display/cubism2'
import { createModelRenderer } from './model-renderer.mjs'
config.sound = false
export const createLive2DRenderer = (stage, settings, onError, info) => createModelRenderer(Live2DModel, stage, settings, onError, info)
