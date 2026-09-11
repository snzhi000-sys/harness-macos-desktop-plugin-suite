# Agent Note：Full Access Shell 使用逐调用任意审计根

[English](2026-09-07-full-access-shell-audit-root.md) | 中文

下文权限收窄决策已由[明确的非完整审核](2026-09-08-full-access-partial-review.md)替代；外部删除批次恢复机制继续使用。

## 背景

产品 File Edit 门禁曾在派发前拒绝全部 `danger-full-access` `bash`/`shell`/`pwsh` 调用。这把执行范围与审核实现上限耦合在一起：选择更宽权限反而失去 Shell 能力，连只读命令也被拒绝。

## 决策

系统 Agent preset 启用 `auditFullAccessWrites`。Full Access 前台 Shell 可用 `audit_root` 指定磁盘上任意现有绝对目录；省略时依次使用 `workdir` 和 Session 工作区。Shell consumer 保留全盘读取，但通过以该目录为根的既有 `workspace-write` 内核策略执行写入。File Edit 独立解析同一个根，建立完整修改前事务快照，再把新增、修改和删除结算到 Session 审核账本。

这是逐调用写入范围，不是固定工作区权限。命令需要修改多个位置时，应指定能够包含这些目标的最窄现有共同目录。如果该根无法在既有上限内完成快照，只在派发前拒绝该次调用；实现不允许降级为仅依赖 watcher 的审核。

工作区外目录删除批次持久化规范化绝对根路径，因此拒绝批次时可以从隔离区完整恢复外部目录，不会再把根错误地解析到 Session 工作区。

后台 Shell、持久终端和未纳入管理的兼容 Shell 工具仍不在事务生命周期内，继续由 File Edit 阻止。

## 验证

包测试覆盖 Bash/Pwsh 的 Full Access schema 与策略投影。File Edit 测试覆盖 Full Access 放行、工作区外文件新增，以及外部目录递归删除后的整批完整恢复。
