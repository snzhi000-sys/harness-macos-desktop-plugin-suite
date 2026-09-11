# Agent Note: 本地 Stable 构建包含桌宠

Status: implemented

[English](2026-09-09-stable-desktop-pet.md) | 中文

## Problem

用户希望已安装的 Stable App 包含测试过的桌面伙伴。仅复制插件包不能在保留的旧 Stable 组成中挂载它。

## Decision

两个产品通道均包含桌宠、原生窗口文件和麦克风用途声明。Stable Profile 升级在暂存用户清单中追加包内桌宠依赖和 bundle，保留原清单备份及无关配置，不重复添加已有桌宠条目。合并沿用现有原子提交和回滚路径。测试使用隔离数据，不调用真实供应商接口。

## Alternatives considered

**继续仅在 Dev 发行：** 不再符合用户明确要求。

**替换整个 Stable Profile：** 会覆盖无关用户配置和额外插件。

## Consequences

本地 Stable 提供与 Dev 相同的桌宠界面和受限 IPC。不在通道间复制设置和凭据。实际使用麦克风仍需要 macOS 授权。本地安装不意味着授权公开分发角色资源。回归覆盖通道选择、增量升级和包内原生窗口。
