# Agent Note：区分 Shell 权限与可恢复审核范围

状态：已实现

[English](2026-09-06-shell-permission-and-audit-modes.md) | 中文

## 问题

File Edit 曾把所有显式 Shell 提权和所有非只读模式统一视为审核拒绝。这会阻止 Shell 工具自己的审批流程处理有边界的 `workspace-write` 提权，无法说明失败来自权限、审批、快照准备、容量还是结算，也会让 Full access 标签看起来像是严格审核能够覆盖所有可写路径的保证。

## 决策

File Edit 对每次原始 Shell 调用都从实时调用 Session 解析 `sandboxPolicy`。`read-only` 调用不建立文件快照即可执行。常驻或一次性的 `workspace-write` 调用必须启用修改前事务并取得一个绝对工作区根目录；符号链接根目录会在快照和观察前解析为真实路径。一次性请求仍会进入 Shell 工具的审批服务，因此用户拒绝或 `never` 策略仍表现为审批结果，而不是由 File Edit 代替审批。

`danger-full-access` 原始 Shell 会在派发前拒绝，因为它的可写路径集合没有边界。对于自身执行和审核模型能够覆盖的操作，Full access 仍是有效的执行权限 preset。产品权限描述和确认框会说明执行权限与可恢复文件审核是相互独立的控制项。

面向用户的 Shell 失败分为权限拒绝、审核不可用或范围不足、快照准备失败、审计超限和命令后结算冲突。准备失败会说明命令未执行；结算失败会说明文件可能已经改变，并保留事务证据。来自 Shell 或 Lark 工具的审批失败保持原样。

子代理解析自己的有效 sandbox policy，File Edit 则把产生的变更归入最近可见父 Session。独立 Lark 操作继续使用自己的规则：普通远程写直接执行，高风险远程写逐次审批，不经过原始 Shell 审核。

## 考虑过的替代方案

**把 Full access 视为绕过 File Edit 的许可。** 未采用，因为执行权限 preset 无法证明声明工作区外的破坏性修改具有可恢复的修改前映像。

**在 File Edit 内拒绝所有显式提权。** 未采用，因为有边界的 `workspace-write` 提权已经由 Shell 审批服务控制，并且可以在同一个完整快照事务中执行。

**在 File Edit 中复制 sandbox preset 状态。** 未采用，因为副本可能在 Session 期间漂移。File Edit 会为每次调用重新解析所属策略。

## 结果

切换 Session 权限模式会直接影响下一次调用，无需重启插件。有边界且审批通过的提权可以使用可写 Shell，同时不绕过审核。Full access 不能把严格审核降级为尽力观察；无界命令开始前，用户会收到具体替代路径。
