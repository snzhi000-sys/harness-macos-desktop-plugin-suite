# Agent Note: 手动编辑与可关闭的审核提示

Status: implemented

[English](2026-09-08-manual-edit-and-review-dismissal.md) | 中文

## Problem

持久审核范围提示会撑开空审核栏。浏览器保存使用 agent（智能体）策略会在 Read Only 下阻止人工编辑。原生结构化删除也需要在模式检查之外落实路径限制。

## Decision

下述可关闭提示展示已由[移除提示](../simplification/2026-09-08-remove-repeated-audit-notice.zh.md)替代。手动保存、路径限制及空审核栏行为继续有效。

[非完整审核](2026-09-08-full-access-partial-review.md)的显示规则被替代：持久范围记录不意味着空审核栏必须显示。提示正文放在可折叠内容区，用户可以在当前组件关闭正文和标签。有待审核文件时刷新可再次提示；工具提示及持久范围记录保留。

浏览器整文及逐行保存使用限定工作区的用户写策略，并校验真实路径。不修改会话的 agent 权限，也不向工具暴露绕过参数。已有外部只读、版本及待审核检查保留。Workspace Write 下原生 file_delete 在枚举前及隔离前校验执行会话的真实工作区；Full Access 保留区外删除。

## Alternatives considered

**接受后删除范围记录：** 这会混淆已知文件获批和未知修改已被完整观测。

**手动保存时将会话切到 Full Access：** 这会意外扩大 agent 权限。

## Consequences

用户可以在 agent 只读时保存，并收起已处理完的审核界面。这只是区分既有用户 API 操作与工具，不提供人类意图的密码学证明或新认证传输。手动拒绝及撤销链路不在本轮重构。测试覆盖区外删除拒绝、Full Access 外部删除保留、手动保存、版本冲突、符号链接逃逸及待审核内容。包内界面回归覆盖折叠、关闭提示、接受及刷新。
