# @deepseek-ai/dsh-deepseek-llm-api-extensions

English | [中文](README.zh.md)

Lifecycle-owned registry for additive top-level fields on official DeepSeek requests.

Each field has one owner. Providers prepare a JSON value from the exact serialized request before network I/O; the registry returns a detached, deeply frozen snapshot. A provider may return an `accept` callback, which runs at most once after the adapter receives HTTP 2xx. Duplicate or blank field names fail registration, preparation observes cancellation, and all acceptance callbacks settle before failures are reported.

This package carries no fields itself. Product features register independent providers, and the DeepSeek adapter rejects any extension field that collides with a native request field.

## Model Experience

### Request extensions

#### What the model sees

The registry itself adds no prompt or message content. A registered field may affect provider-side request handling, but its owner must document that behavior.

#### Token effect

The registry does not alter model-visible tokens.

#### KV Cache effect

The registry does not alter the model-visible prefix; provider-specific cache partitioning by extension fields is outside the Harness contract.

## Known Limitations and Deferred Work

- Extension fields are supported only by the official DeepSeek adapter; other adapters need their own typed registry.
- Acceptance is an in-process post-2xx transaction and is not durable across Host termination.
