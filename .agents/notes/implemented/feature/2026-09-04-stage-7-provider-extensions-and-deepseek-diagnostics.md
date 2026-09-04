# Stage 7 provider extensions and DeepSeek diagnostics

English | [中文](2026-09-04-stage-7-provider-extensions-and-deepseek-diagnostics.zh.md)

## Status

Implemented on `migration/unified-suite` on 2026-09-04. Stable packaging and installation are out of scope.

## Decisions

- The Models section remains the owner. It exposes `settings.models.provider-card`, keyed by `settingsNs`, and `settings.models.footer`; authentication plugins extend these seats through the existing slot lifecycle.
- Provider-card owner facts are limited to the provider directory entry plus `configured` and `keyConfigured` booleans.
- Model discovery search matches id and display name without case sensitivity. Bulk toggles affect only visible results.
- Host-side pi-ai discovery reuses configured Profile headers. Typed credentials override stored credentials; Harness-controlled `Accept` and attribution headers win after merging. Browser discovery receives no Profile headers.
- DeepSeek request metadata uses a generic one-owner-per-field registry. Preparation is abortable and precedes fetch; HTTP 2xx triggers an idempotent joint acceptance transaction.
- Base composition reports active package-backed plugins through `dsh_plugin_packages`. The payload contains only package name and version, is sorted and deduplicated, and can be disabled.

## Compatibility boundaries

- Existing `settings.section`, LLM discovery, Session, attachment, retry, and plugin-visible interfaces remain unchanged.
- DeepSeek reasoning history and multimodal/Files retry behavior remain in the existing adapter; extension fields are merged only after serialization and are reused unchanged for the bounded stale-file-id retry.
- No local path, user plugin configuration, workspace information, Profile content, or manifest extras enter the diagnostic payload.
- Better Sidebar does not own the new settings extension points.

## Verification

- Affected TypeScript project references build successfully.
- Network-independent focused tests pass: 184 tests across five files, plus four fetch-stub discovery tests.
- The standard Dev build rebuilt Host/Client, both new packages, and all product plugins. It stopped at the unchanged sandbox restriction where four Better Sidebar media-range tests receive `listen EPERM`; the other 543 plugin tests passed. No Electron candidate was generated or published.
