# Agent Note: Desktop pet plugin and native window ownership

Status: implemented

English | [中文](2026-09-07-desktop-pet.zh.md)

## Problem

A character displayed in a Harness view cannot remain above other applications or pass pointer input through transparent areas. The supplied single-layer PNG also lacks the mesh and parameters required for Live2D facial animation.

## Decision

The Stable exclusion below is superseded by [Stable desktop pets](2026-09-09-stable-desktop-pet.md); window ownership remains unchanged.

Keep assets, settings, interaction states, and browser rendering in an independent product plugin. Add a dedicated Electron window controller with a narrow preload interface. Cubism adapters consume touch, click, drag, release, and idle states. The original external-asset, PNG, editable-profile, and session-binding choices are superseded by the [built-in picker](../simplification/2026-09-08-desktop-pet-builtin-picker.md). Left-button gestures do not open the context menu; right-click owns menu access. Each renderer exposes a stable fitted artwork bottom so the chat field stays close without following per-frame motion.

## Alternatives considered

**A renderer-only overlay** cannot provide native desktop placement outside Harness, so it remains a browser preview rather than the desktop implementation.

**Automatic PNG-to-Live2D conversion** would conflate illustration segmentation, missing-area painting, and Cubism rigging with runtime playback. The plugin uses existing rigs; the later built-in picker removes illustration mode.

**Bundling personal artwork and sample assets** would couple the reusable plugin to local files and their licenses. The later built-in picker explicitly scopes bundled assets to a local Dev collection.

## Verification

The seven-plugin Dev Profile loads both Host and Client; Stable excludes the pet package and native window. Plugin tests, browser and native Electron smoke tests, and the packaged Dev smoke test pass. Coverage includes actual Cubism playback, authored motions and expressions, physics, pointer transparency, dragging, preference restoration, and window disposal. The packaged smoke checks execution-file hashes against current source and bundles before testing. The isolated Dev build passes product composition and upgrade verification. Repository-wide lint and doc-sync still report unrelated baseline failures.

Live2D alternate limbs depend on authored PartOpacity curves while a motion is running. The pinned Cubism adapter enables actual part opacity writes and sorts a copied curve array into the evaluator's required target order. This handles interleaved exports without changing keyframes or adding per-character arm guesses. Post-action baseline restoration alone cannot establish correct mid-motion visibility; the Atago playback fixture asserts mutually exclusive parts across debug, automatic and ordinary preview paths.

## Consequences

Speech playback owns the matched action's hold and pointer-follow suppression. The renderer retains the authored pose beyond its ordinary timeout, then releases it when the audio segment ends, fails or is cancelled; direct interaction has priority. A fixed longer timer was rejected because different speech durations and pauses would still restore poses at the wrong time. Real DragonBones and both Cubism adapters exercise hold/release, and preview overlap cannot resurrect a completed speech action. Parenthetical bubble text uses a subdued readable color without altering stored replies or interpreting markup.

Intimacy is a persisted completed-turn counter in the private pet session, with globally editable inclusive score ranges and descriptions. It is injected only where the emotion prompt contains `{{亲密情况}}`; expanded inputs are recorded in auxiliary requests. Historical backfill was rejected because introduction must start at zero even in an existing chat. A global counter was rejected because New Conversation must reset the relationship. A successful nonempty reply increments once before post-reply emotion, while tests, failed and interrupted replies do not. Named ranges expose both endpoints and reject overlaps or gaps so configuration cannot silently select the wrong description. Start-only settings migrate to equivalent explicit ranges. Host persistence tests and the assembled settings snapshot cover the migration, editing and injection behavior.

Ellipses form explicit speech boundaries so a following question enters its own synthesis item rather than depending on provider sentence splitting. Their streamed punctuation run remains intact, and an intervening aside attaches to the following item. The reported multi-aside example retains all text through filtering; live synthesis plus ASR preserved the suffix. The change isolates segments and adds full playback regression evidence, without claiming the intermittent report was reproduced.

The emotion satellite supplies five first-person fields describing internal feelings rather than reply strategy. Output rules accompany custom prompts; only the exact legacy default is replaced. Structural validation rejects incomplete updates and normalizes field separators without inventing missing feelings. Invalid output remains in auxiliary request evidence and never replaces the last valid emotion. The user reference's persona and intimacy score are not product defaults.

Emotion generation is persisted as an auxiliary request outside chat messages. A first-turn dependency seeds emotion before the reply; later updates follow completed turns, with cancellation and session identity rejecting stale writes. Emotion history counts individual messages from both speakers, defaults to eight, and expands through `{{聊天记录}}` inside the recorded system prompt with chronological speaker labels. This replaces implicit JSON history in a separate message; legacy numeric limits become message counts and old custom templates gain a visible placeholder. Dialogue snapshots completed emotion at send time. Per-outfit literal keywords consume bracketed asides and reuse interruptible playback without an extra model call. Prompt and keyword tabs separate these controls from provider configuration. Keyless Host concurrency tests and the assembled conversation snapshot cover these decisions; fixture output does not certify subjective emotion quality.

Cubism actions are exclusive at transition boundaries: cancellation clears the queued motion and stale completion flag, resets the initial parameter baseline and Cubism 3/4 part opacities, then applies the next action. This is required even when the model has no idle motion, because partial motions leave unauthored parameters unchanged. A pose reset trades inter-action crossfades for consistent exclusive limb artwork. Authored deformation within each action is preserved. Body/mouth metadata drives both settings grouping and automatic selection; only Mengmei a/i/o/m are mouths. A visible pet waits one idle minute before a non-mouth action, while previews, menus, dragging and hidden/paused views cannot schedule one. Input interrupts, completion restores idle, and the next interval never accumulates missed actions.

The plugin owns a private conversation service shared by the compact input below the character and the full chat page embedded in settings. Both surfaces resume the latest session, preserving bounded short-term context rather than creating a session on open. Ark text generation and V3 TTS/ASR use separate pet credentials and an editable Prompt; main Harness providers and sessions remain independent. Actual model requests are recorded privately, and browsers never receive stored keys. A single pet page owns playback and the mouth clock. Playback acknowledgements keep the reply bubble visible through queued and paused audio; unvoiced text uses a bounded reading interval. Closing compact input preserves the turn; leaving the history tab releases capture. The native audio permission is restricted to the owned embedded page, and no extra chat BrowserWindow is created. Appearance settings remain version 2, separate from conversation settings.

Default and cloned voices select different speech resources. Word timestamps and pinyin provide four-pose approximations because tested voices return empty phoneme arrays. Text remains available if speech fails or is disabled. Complete sentences are buffered before playback to keep audio and subtitle timing together, trading some first-sound latency for reliable alignment. Tests distinguish keyless provider fixtures, real service requests and virtual microphone capture; virtual input does not certify the user's physical microphone. Continuous normalized state weights use the official deform blender instead of repeatedly starting short mouth fades. Authored direction timelines own torso movement; speech aliases exclude nested direction tracks to keep these two controls independent. This preserves mesh artwork and avoids a second animation engine. Speech poses use normalized weights while speaking. All four speech weights are zero at rest and fade to zero over 0.2 seconds when a sentence ends, restoring the idle mouth. The m pose is only a speaking closure. A pinned-runtime fix keeps completed single-frame FFD poses participating in blending; a zero-deform base resets inner-mouth slots absent from idle.

Speech text projection strips nested parenthetical asides without modifying visible or logged answers. Punctuation consumes no vowel time. Partial subtitles fill available gaps; incompatible timing falls back explicitly. Short cues shorten the nominal 200 ms blend so the pose can open before the next cue. Speaker IDs determine default/clone resource selection, and Save and Preview commits current fields before synthesis. Form loading prevents delayed configuration from overwriting edits.

The current built-in catalogue and removal of end-user import are owned by the built-in picker note. Research downloads pin repository commits and verify blob hashes even when using a delivery mirror.

Cubism Core and model licenses are separate from plugin source. The renderer has separate Cubism 2 and Cubism 3/4 adapters; newer model features are not guaranteed. Native transparent input must be checked in the full desktop product as well as the deterministic Electron fixture. Existing worktree changes in the desktop and product manifests must be preserved during integration.

The Client bundle registers a lazy CommonJS factory through `globalThis.__ModuleLoader__.load`; emitting ordinary ESM breaks Harness loading. A build-contract guard pins this requirement. Host configuration uses Schemastery defaults, while saved local preferences take precedence. The local `dsh-desktop-pet:react` event accepts touch and click actions without model requests.

The native controller owns window bounds, transparency, and lifetime. Hiding destroys the renderer; plugin unload and application exit release resources. Live2D alpha hit testing flips the WebGL pixel Y coordinate. The built-in picker owns the resource catalogue and migration of legacy asset settings.

Session permission handlers affect the main window as well as the pet. A media-only allowlist rejects ordinary Explorer copy operations, so clipboard writes explicitly allow the main window's backend origin while reads remain denied. The real Electron fixture snapshots file and folder path writes through the shared UI helper and compares native clipboard contents; it does not substitute for Explorer menu interaction.

Actions use explicit group and index references, including empty groups. Looping actions have a playback limit; repeated actions and expressions can be triggered again. Authored animation retains primary parameter control, with reduced additive gaze. A calibrated head region covers missing standard hit areas. Each built-in model has a curated profile; missing dependencies reject the build without modifying original assets.

Closing settings releases previews; suspension releases native windows and resume requires visibility plus a valid lease. Retina alpha calibration reads WebGL buffers at physical dimensions to avoid the Pixi extractor applying pixel resolution twice.
