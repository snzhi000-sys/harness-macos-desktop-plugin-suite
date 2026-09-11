# Agent Note: Authored DragonBones desktop companion

Status: implemented

English | [中文](2026-09-08-desktop-pet-dragonbones.zh.md)

## Problem

Mengmei is a DragonBones 6.0 export with mesh mouth poses, expressions, hand gestures and physics. Cubism renderers cannot interpret its skeleton. The default DragonBonesJS branch also rejects its format, while constraint names reused across types cause the compatible branch to skip three physics constraints.

## Decision

The desktop-pet plugin dispatches internally by catalogue kind and includes Mengmei alongside the 10 Live2D versions. DragonBonesJS branch 6.0.2 is pinned to `7b2d9f700d1719db2c5d89a6fa36c85d7f092501`, paired with PixiJS 8.9.2. Character preparation namespaces physics identifiers and their physics timeline references without changing bones or IK names. All 117 constraints remain available.

Each pet or preview document loads only its selected runtime. Live2D retains PixiJS 6; DragonBones uses PixiJS 8 and removes the pinned adapter's implicit shared ticker. Its renderer owns time advancement and destruction. Independent animation groups preserve body motion and expression transforms while the mouth group's FFD controls speech poses.

The mouth controller consumes timestamped authored cues and a caller-owned audio clock. It holds cues during audio pause, follows seek, closes on end or cancellation, and is disabled with animation. It does not infer phonemes or subscribe to Harness sessions. The character picker and settings schema remain independent of animation technology.

## Alternatives considered

**Use master or lower the export version.** Master lacks the required format and constraints; changing a version label does not reproduce those capabilities.

**Upgrade all characters to PixiJS 8.** Existing Cubism drivers use PixiJS 6. Isolated documents avoid coupling their compatibility to the new character.

**Reset the entire animation for each mouth cue.** That discards simultaneous authored body and expression behavior. Non-resetting grouped poses preserve those layers without converting the resource to frame images.

## Consequences

Pointer following uses the supplied directional control bone plus a small pupil-bone offset, driven before the official clock advances. The authored eye constraint alone produces little horizontal gaze, so the bounded pupil offset supplies visible eye motion without replacing mesh weights or constraints. A neutral face anchor prevents feedback drift; radial limits keep diagonal input inside the tested range. Drag and action preview recenter smoothly, animation-off resets both offsets, and no new native IPC or persisted setting is needed. The resource preparer appends missing horizontal/vertical zhuan tracks without changing supplier keys. The September 9 export supplies wuxiong in place of shou1/shou2; the approved click and release mappings use wuxiong, while other profile fields remain unchanged. Settings debug poses use a separate high-priority group and fade out on release, preserving the underlying speech clock and ordinary layers. Pointer input writes the official runtime’s additive zhuan offset directly; horizontal/vertical animations remain available as resource data but are not active follow layers. The supplier recommends a smaller excursion than the reference screenshot. The user-selected ellipse limits horizontal displacement to 350 and vertical displacement to 300 skeleton units, with body sensitivity 2 and unchanged pupil range. Bone-local X corresponds to screen vertical travel and bone-local Y to horizontal travel. Speech and compact-input focus independently suppress following until both end. Equal-offset comparison gives essentially the same bone output as scrubbing the two direction tracks; the larger response comes from the range and sensitivity, not a demonstrated track conflict.

The plugin carries an additional runtime and an approximately 32 MiB uncompressed texture per active Mengmei renderer. The settings preview can coexist with a native pet, so teardown and bounded memory are part of the renderer smoke. Official adapter internals used to detach its ticker require review on runtime updates. The user-provided artwork and runtime have separate distribution terms.

## Verification

The supplier's revised 4096×2048 atlas and PNG provide separate body and hair regions, with 13 supplier animations plus two app pointer-control tracks. Their hashes are recorded in the bundled SOURCE file. Independent playback with the existing renderer shows continuous body artwork and hair without clothing pixels; mouth poses and blinking are distinguishable. This source resource revision requires a new standard Dev build before it reaches an installed app.

The Host tests resolve every built-in model. The assembled browser snapshot includes Mengmei and checks cross-engine switching. DragonBones playback covers reactions, expressions, four mouth cues, a local audio clock, nonempty paused frames and repeated creation/disposal; the native fixture checks hit-through, dragging, resize, persistence and unload. The packaged Dev smoke verifies exact bundles and resources plus real Cordis loading and native reactions. Calibration audio verifies transport timing, not arbitrary speech alignment; no author-editor reference recording is supplied for frame-identical comparison.
