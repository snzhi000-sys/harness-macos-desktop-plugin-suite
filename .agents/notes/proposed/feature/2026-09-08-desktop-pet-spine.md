# Agent Note: Spine desktop companion admission

Status: proposed

English | [中文](2026-09-08-desktop-pet-spine.zh.md)

## Problem

The supplied Spine 4.2 export contains empty mouth timelines, inconsistent texture regions and duplicate constraint orders. Successful parsing does not establish correct assembly. The supplier's editable project is unavailable.

## Proposal

Keep DragonBones unchanged and add an isolated official Spine WebGL adapter. Admit a companion only after the source or a traceable derived copy passes visual playback. Existing settings and the 25-entry catalogue remain unchanged while asset repair is pending. The adapter source exists, but no Spine companion is admitted or packaged for delivery.

## Alternatives considered

Replacing DragonBones would remove a useful independent reference. Registering the broken export would repeat the assembly defect. Deformation recovered from matching DragonBones bind poses is preferable to inventing mouth shapes, while texture cropping that removes hair is not an authentic repair.

## Acceptance criteria

Require complete body and hair assembly, distinguishable authored mouth poses, correctly scheduled constraints, animation mixing and native lifecycle verification before normal Dev delivery. Descriptor checks reject empty configured tracks and duplicate constraint orders. Browser playback and renderer lifecycle tests do not substitute for visual acceptance.

## Risks

Missing constraint order does not identify the author's intended order. Bind-pose and setup-pose differences can be intentional. Runtime licensing and character licensing apply independently. The [plugin README](../../../../plugins/desktop-pet/README.md) owns preparation and renderer behavior; the existing [DragonBones decision](../../implemented/feature/2026-09-08-desktop-pet-dragonbones.md) remains in force.
