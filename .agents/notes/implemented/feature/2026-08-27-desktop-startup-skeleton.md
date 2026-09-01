# Agent Note: Desktop startup suggests the three workspace regions

Status: implemented

English | [中文](2026-08-27-desktop-startup-skeleton.zh.md)

## Problem

The desktop shell must show a local document before the packaged runtime and loopback Web backend are ready. A centered status card made that wait look like a separate dialog, exposed a large blank surface, and produced an abrupt visual change when the three-column Harness workspace replaced it. The shell also lacked the Harness appearance preference until the Renderer loaded, so an operating-system theme mismatch could flash the wrong background.

## Decision

The Electron Main process owns a dependency-free startup document with three broad neutral regions representing the Session list, Explorer, and conversation area. It deliberately omits control and content placeholders so the startup view suggests only the overall structure. A low-contrast shimmer communicates progress, respects reduced-motion preferences, and leaves the exact startup status in a small live region at the bottom. The document uses light/dark CSS variables and the BrowserWindow background uses the same palette.

The preload appearance message remains the only Renderer-to-Main theme input. Main validates and atomically saves its `light` or `dark` value in `appearance-state.json`; the next launch applies that value before constructing the BrowserWindow, while a missing or invalid file falls back to the operating-system appearance. Once backend readiness is confirmed, Main fades the skeleton before navigating the existing window to the loopback URL. Startup failures continue to use the diagnostic status document and native error dialog because they must present actionable text rather than indefinite placeholders.

## Alternatives considered

**Restyle the centered card.** This would improve typography but preserve the dialog-like transition and blank window area that made startup feel detached from the product.

**Load the complete React application with mocked data.** That could reproduce the interface exactly, but it would add the Web runtime and plugin dependency graph to the phase that exists specifically because those dependencies are not ready.

**Use a second transparent splash window for a true cross-window dissolve.** It could overlap the first Web paint, but it adds window lifecycle, focus, accessibility, and multi-display complexity for a short local transition. A same-window fade keeps startup ownership and failure recovery simple.

## Consequences

The first visible frame suggests the application's three major regions and theme family without implying exact control placement, and later launches avoid an opposite-theme flash. The placeholder does not share production components; only major region proportions are approximated in `startup-document.mjs`. Unit coverage pins all three regions, the absence of detailed UI placeholders, theme and reduced-motion rules, status text, card removal, and validated appearance persistence.
