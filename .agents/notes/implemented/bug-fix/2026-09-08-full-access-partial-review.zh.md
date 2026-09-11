# Agent Note: Full Access 与明确的非完整文件审核

Status: implemented

[English](2026-09-08-full-access-partial-review.md) | 中文

## Problem

以快照决定权限会让 Full Access 命令在审计目录之外或目录快照超限时失败。取消限制也不能使普通文件快照具备完整恢复和准确进程归因能力。

## Decision

工具结果提示及面板展示已由[移除提示](../simplification/2026-09-08-remove-repeated-audit-notice.zh.md)替代；下述权限和持久范围决策继续有效。

本决策替代[单次审计根](2026-09-07-full-access-shell-audit-root.md)的权限范围规则，保留外部删除恢复。

用户明确接受观察不完整及部分修改不可恢复。Bash 与 Pwsh 保留解析后的 Full Access 权限。File Edit 尝试已有受限快照，但不以成功为执行前提。命令最多执行一次，审核结算错误不替代命令结果。会话持久保存审核不完整事实，并附加到可用的工具结果内容；可关闭的面板展示遵循[手动编辑与审核提示](2026-09-08-manual-edit-and-review-dismissal.md)。结构化审核与 Workspace Write 保留已有恢复规则，Read Only 保持只读。

## Alternatives considered

**系统级采集：** Endpoint Security 缺少系统前置条件，且接口本身不证明能恢复修改前内容。本次不引入专项授权、特权服务或磁盘访问授权。

**扩大强制审计目录：** 提高快照上限仍保留权限偏差，也不能捕捉瞬时动作或可靠区分其他进程并发写入。

## Consequences

Full Access 可以写入快照之外，并在快照失败时执行。不承诺完整观察、防篡改审核证据或恢复每次修改。快照范围内保留已有审核和过期版本检查，外部并发修改仍存在归因限制。后台任务与持久终端不在本次范围。Dev 验证覆盖包内 Host，Stable 需要另行授权。
