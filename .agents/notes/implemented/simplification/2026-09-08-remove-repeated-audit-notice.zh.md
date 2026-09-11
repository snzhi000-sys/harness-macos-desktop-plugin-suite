# Agent Note: 移除重复的非完整审核提示

Status: implemented

[English](2026-09-08-remove-repeated-audit-notice.md) | 中文

## Problem

用户接受 Full Access 的非完整观察，但不希望审核文件后仍重复显示通用警告或范围标签。

## Decision

移除通用 Full Access 警告、范围标签以及 Shell 结果提示注入。本决策替代[手动编辑与审核提示](../bug-fix/2026-09-08-manual-edit-and-review-dismissal.zh.md)的展示决策和[非完整审核](../bug-fix/2026-09-08-full-access-partial-review.zh.md)的结果附注。保留持久 `auditCoverage.kind: partial`、权限、快照、恢复及具体操作错误。旧范围记录的提示正文不渲染。仅有范围记录不能撑开空审核栏。

## Alternatives considered

**保留可关闭警告：** 用户明确要求移除，而不是刷新后反复关闭。

**删除范围元数据：** 隐藏警告不代表观察完整，持久范围记录必须保留其含义。

## Consequences

审核栏和 Shell 输出不再提供通用提醒。Full Access 仍不保证完整归因及恢复。Host 测试检查工具结果不被修改且范围记录保留；客户端检查要求提示不存在。包内界面回归检查旧范围记录、接受及刷新，需要在重新构建的 Dev 上执行后才能验收包。重新引入此展示需要新的用户决策。
