# Agent Note: Profile 授权的 subagent 模型选择

Status: implemented

[English](2026-09-04-profile-authorized-subagent-model-selection.md) | 中文

## Problem

subagent 工具可以从插件配置中应用一个固定子级路由，但父模型无法为单次委派选择其他已授权的提供方、模型、推理强度或输出 token 上限。公开全局 LLM 目录会泄露父级部署权限之外的路由，而替换既有 subagent 生命周期又会给控制工具、持久化、Job 和插件兼容性带来风险。

## Decision

`tool-subagent` 将 `selectableModels` 视为归 Profile 所有的确切提供方／模型允许列表，并为当前 Session 加入父 agent 的当前路由。配置后的实例会公开逐次调用的 `provider`、`model`、`reasoning_effort` 和 `max_tokens` 字段，以及 `list_subagent_models`。发现操作先按生效允许列表过滤提供方和模型，再返回结果。执行操作先授权生效路由，再通过实时 LLM 适配器解析模型选项；如果 subagent 提供方注册在异步预检期间发生变化，则中止调用。

四个字段全部省略时，调用沿用既有路径，不执行 LLM 预检。路由发生变化但未显式提供推理强度时，系统会清除继承值或配置值，由所选适配器决定默认值。`AgentOptions.reasoningEffort` 为首次请求提供初始值。可继续描述符 v3 持久化已解析的提供方、模型、推理强度和最大 token 数；读取方接受 v2 描述符并恢复其中原本持久化的字段。

既有一次性、Task 支撑和可继续生命周期保持不变。spawn 与 fork 提供方声明其一次性启动路径会应用 `agentOptions`；产品 spawn 工具启用选择，而 fork 工具为了复用前缀继续继承路由。File Edit 归属和 Job 投影继续由其既有服务负责。

## Alternatives considered

**公开全部已注册 LLM 提供方。** 未采用，因为注册只证明技术上可用，不代表获得 Profile 或父级授权，而且发现操作本身就会泄露全局配置路由。

**整体导入上游 subagent 与 Settings 架构。** 未采用，因为它依赖新版 Session 投影、Remote/API 和客户端设置结构，会把一个范围明确的能力与无关迁移绑定。

**为每个模型创建一个固定工具实例。** 未采用，因为这会增加 schema 和配置数量，而且仍然缺少逐次调用的推理与 token 控制。

**为 fork 工具启用路由选择。** 未采用，因为改变路由会削弱继承前缀的 KV Cache 价值；需要选择路由时应使用全新 spawn。

## Consequences

模型可以携带明确推理控制向已授权路由进行委派，并且看不到无关提供方。授权无效、路由不可用、提供方能力不支持、取消以及提供方替换都会在创建子 agent 前失败。可继续子 agent 在刷新或进程重启后重建相同选择值，既有 v2 子级仍可读取。

Profile 必须维护确切路由 id，新增所需路由需要显式更新 Profile。提供方／模型选择只在已配置的工具实例中可用，而 persona、工具过滤和深度策略仍是实例级选择。定向测试覆盖 schema 公开、授权、预检、能力拒绝、描述符兼容、冷恢复、请求 header 重建、Job 投影和 Better Sidebar Job 渲染；产品组装通过 Dev 打包流水线验证。
