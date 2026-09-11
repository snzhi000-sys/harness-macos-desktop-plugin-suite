# Agent Note: 保持 Dev 设置隔离并复用 Explorer 工作区目录列表

Status: implemented

[English](2026-09-01-dev-data-and-workspace-explorer-cache.md) | 中文

## Problem

此前打包后的 Dev App 会从错误的包名推导 Electron 用户数据目录，导致在通道正确的构建中，模型凭据和偏好看起来像是丢失了。Explorer 也会把同一工作区中的会话切换视为目录数据身份变化，造成不必要的树目录重复加载。

## Decision

桌面主进程会在读取 `userData` 前选择 `DeepSeek Harness Dev`，因此打包的 Dev 始终使用 `~/Library/Application Support/DeepSeek Harness Dev`，并与 Stable 独立。`migrateLegacyDevData()` 从历史 `@deepseek-ai/dsh-desktop-builder` Dev 目录执行一次性、不覆盖的迁移；只复制凭据、设置、工作区偏好以及 Explorer 标记/可见性记录。Profile、Runtime、会话、日志和审核数据均不迁移。

Better Sidebar 在 Renderer 生命周期内维护按工作区根路径索引的已加载 Explorer 层级 `Map`。同一根路径下的会话切换恢复已有快照，只将新会话用于请求授权。可见目录轮询继续用于发现外部变更。重命名、移动和删除都会更新同一个根路径快照，旧根路径的异步响应不能重绘当前树。

## Alternatives considered

**让 Dev 复用 Stable 用户数据。** 否决，因为 Dev 包可能修改真实的凭据、会话、偏好或 Profile。

**复制完整的旧 Dev 目录。** 否决，因为这会重新引入故障 Profile 或 Runtime，并将私有会话和审核数据带入新环境。

**将 Explorer 目录列表持久化到磁盘。** 否决，因为目录列表只是短生命周期的 UI 缓存；文件系统变化后磁盘缓存会制造错误视图，且相比已有轮询没有收益。

**按 session id 缓存。** 否决，因为目录内容属于工作区根路径，而不是某一次对话。

## Verification

Desktop 测试证明允许列表迁移不会带入旧 Profile 和会话，也绝不覆盖现有 Dev 凭据。Better Sidebar 测试证明同根路径复用和不同根路径隔离。类型检查覆盖 Explorer 缓存接入。

## Consequences

Dev 用户每个 Dev 通道只需配置一次凭据，替换构建后仍会保留，且不会暴露 Stable 数据。历史 Dev 配置最多导入一次，之后两个目录的手动修改有意保持独立。同一工作区内切换会话不再触发首次重复目录加载，同时周期性刷新仍会展示真实文件系统变化。
