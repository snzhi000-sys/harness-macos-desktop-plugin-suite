# Agent Note: Weighted pet actions and phoneme recipes

Status: implemented

English | [中文](2026-09-10-pet-weighted-presets.zh.md)

## Problem

One authored expression needs multiple keyword-triggered intensities. Four mouth meshes also need configurable derived visual poses for additional pinyin symbols; a mouth preview alone does not improve speech playback.

## Decision

Action variants store authored references, weight, enabled state and independent keywords per outfit. Legacy keyword entries migrate at full weight. Mouth recipes separately map logical pinyin symbols to authored a/o/i/m meshes and weight. The audio timeline retains symbols until the visible character resolves its saved recipes. Same-mesh weight changes are observable cue transitions; speech completion clears all weights.

The preview lease updates weight on its existing animation state rather than restarting it. Manual mouth previews suppress automatic mouth influence while preserving audio time. UI drafts survive tab switches and only Save changes subsequent replies. Direct interaction and teardown retain existing ownership rules.

## Alternatives considered

Creating new animation files for each weight duplicates identical resources. Treating e/w/y as keyword-only poses never affects speech. Normalizing every cue to total weight one discards the intended partial influence. Applying DragonBones weights to Live2D without verifying discrete part visibility can expose alternate limbs; those engines retain full-weight variants.

## Consequences

Derived mouths are adjustable visual approximations, not new supplier artwork. DragonBones uses official animation weights; zero, partial and full deformations require actual runtime verification. Keyless assembled browser playback verifies stored recipes reaching audio-clock playback and selected body weights, in addition to storage migration and pure mapping tests. Default e/w/y recipes remain subject to user visual tuning.
