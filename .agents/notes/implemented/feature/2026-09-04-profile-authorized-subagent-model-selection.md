# Agent Note: Profile-authorized subagent model selection

Status: implemented

English | [中文](2026-09-04-profile-authorized-subagent-model-selection.zh.md)

## Problem

The subagent tool could apply one fixed child route from plugin configuration, but the parent model could not select a different authorized Provider, model, reasoning effort, or output-token limit for one delegation. Exposing the global LLM directory would disclose routes outside the parent's deployment authority, while replacing the established subagent lifecycle would risk control-tool, persistence, Job, and plugin compatibility.

## Decision

`tool-subagent` treats `selectableModels` as an exact Profile-owned Provider/model allowlist and adds the parent's current route for that Session. A configured instance exposes per-call `provider`, `model`, `reasoning_effort`, and `max_tokens` fields plus `list_subagent_models`. Discovery filters providers and models against the effective allowlist before returning them. Execution authorizes the effective route before resolving its model options through the live LLM adapter, and aborts if the subagent provider registration changes during that asynchronous preflight.

Calls that omit all four fields follow the existing path without LLM preflight. A changed route without an explicit reasoning effort clears inherited or configured effort so the selected adapter owns its default. `AgentOptions.reasoningEffort` seeds the first request. Continuable descriptor v3 persists the resolved Provider, model, reasoning effort, and maximum tokens; the reader accepts v2 descriptors and restores their previously persisted fields.

The existing one-shot, Task-backed, and continuable lifecycles remain unchanged. Spawn and fork providers declare that their one-shot start path applies `agentOptions`; the product spawn tool enables selection, while the fork tool retains inherited routing for its prefix-reuse purpose. File Edit ownership and Job projection remain on their existing services.

## Alternatives considered

**Expose every registered LLM Provider.** Rejected because registration proves technical availability, not Profile or parent authorization, and discovery itself would reveal globally configured routes.

**Import the upstream subagent and Settings architecture wholesale.** Rejected because it depends on newer Session projection, Remote/API, and client-settings structures and would couple a bounded capability to unrelated migrations.

**Create one fixed tool instance per model.** Rejected because it multiplies schemas and configuration while still lacking per-call reasoning and token controls.

**Enable route selection for the fork tool.** Rejected because changing its route undermines the inherited-prefix KV Cache purpose; a fresh spawn is the supported route-selection path.

## Consequences

The model can delegate to authorized routes with explicit inference controls without seeing unrelated Providers. Invalid authorization, unavailable routes, unsupported provider capabilities, cancellation, and provider replacement fail before child creation. Continuable children reconstruct the same selected values after refresh or process restart, and existing v2 children remain readable.

Profiles must maintain exact route ids, and a newly desired route requires an explicit Profile update. Provider/model selection is available only on configured tool instances, while persona, tool filtering, and depth policy remain instance-level choices. Focused tests cover schema exposure, authorization, preflight, capability rejection, descriptor compatibility, cold recovery, request-header reconstruction, Job projection, and Better Sidebar Job rendering; product assembly is verified through the Dev package pipeline.
