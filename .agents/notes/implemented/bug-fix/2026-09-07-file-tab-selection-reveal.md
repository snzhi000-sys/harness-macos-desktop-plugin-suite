# Agent Note: Reveal selected file tabs inside their scrollport

Status: implemented

English | [中文](2026-09-07-file-tab-selection-reveal.zh.md)

## Problem

Selecting a file outside the visible portion of the File Edit tab strip displays its contents without revealing its tab.

## Decision

FileView reveals the active DOM tab after selection commits. An explicit open counter also covers reopening the same file. Only the horizontal tab scrollport moves, by the minimum distance needed; an oversized tab aligns its beginning. Ordinary review updates and drag reordering do not trigger reveal. Remounting the view and changing sessions reveal the current selection.

## Alternatives considered

**Scroll on every store update.** Rejected because polling and editing would override manual tab browsing.

**Use scrollIntoView.** Rejected because it can also scroll ancestor containers and disturb document reading.

## Consequences

Subsequent selections use a 180–250ms cubic ease-out animation. A new selection cancels the prior frame and starts from the current position; wheel, pointer, touch, drag and keyboard input cancel motion without blocking the event. First mount, session restoration and reduced-motion preference use immediate positioning. Effect cleanup cancels frames and removes input/media listeners. Native smooth scrolling is not used because its timing and cancellation vary by browser.

The change is client-only and does not alter file permissions, audit state or tab ordering. Geometry tests cover both edges, no-op, oversized and hidden tabs; integration checks pin the open signal and committed refs. Resizing the window alone does not force a reveal; the next file activation does.
