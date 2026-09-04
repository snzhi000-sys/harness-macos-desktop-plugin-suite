# @deepseek-ai/dsh-plugin-package-inventory-deepseek

English | [中文](README.zh.md)

Optional DeepSeek request diagnostic that reports active Loader-backed plugin packages through the request-extension registry.

The wire field is `dsh_plugin_packages` version 1. It contains a stable, deduplicated list of `{name, version}` pairs from active package-backed Host and standing Agent-preset entries. Disabled, pending, failed, grouped, loose, URL, and Cordis builtin entries are omitted.

Only package name and version leave the Host. Local module paths, user plugin configuration, workspace information, Profile content, and package-manifest extras are never included. Reporting is enabled by default and can be disabled with `enabled: false`.

## Model Experience

### Plugin package inventory

#### What the model sees

Nothing is added to prompts, messages, tools, or tool results. The inventory is provider-facing diagnostic metadata.

#### Token effect

No model-visible tokens are added.

#### KV Cache effect

The model-visible prefix is unchanged. Any provider-side accounting or cache partitioning by this diagnostic field is provider-defined.

## Known Limitations and Deferred Work

- Identity resolution reads package manifests during request preparation and caches identities for the plugin lifetime; it does not maintain a separate Loader epoch cache.
- Entries without a valid package identity are omitted or fail preparation according to whether they are loose modules or malformed package manifests.
