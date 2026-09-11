# Agent Note: 在具备删除前快照前禁止不可恢复的可写 Shell

Status: implemented

[英文](2026-09-05-block-unrecoverable-shell-until-snapshots.md) | 中文

## Problem

上一版在会话沙箱下重新开放前台原始 Shell，File Edit 在执行后观测变更。测试证明，`bash rm -rf`、Python 删除、Node 删除和等价子进程可在插件获得可恢复的修改前快照之前删除文件。已记账的新建文件随后可从不存在收敛为不存在，并从持久审核状态中消失。这违反了“允许执行不等于免除审计”的产品不变量，也可能把不可逆删除误表达为无变化。

## Decision

在文件系统沙箱提供删除前快照事务之前，`dsh-file-edit` 只在 `sandboxPolicy.resolve({ session })` 精确返回 `read-only` 时放行原始前台 `bash`、`shell` 和 `pwsh`。`workspace-write`、`danger-full-access`、会话缺失或策略解析失败、任何显式 `sandbox_permissions` 请求、后台 Shell、持久终端操作和未受托管的兼容 Shell 入口都在派发前拒绝。前置 `tools/pre-execute` 监听器和最终单调工具 guard 共用同一策略函数。不解析命令文本。

结构化 `write`、`edit`、`file_move` 和 `file_delete` 继续可用，`shell_readonly` 也继续可用。飞书文档更新等产品操作继续通过受控 `lark_cli` 工具执行，不与原始 Shell 权限绑定。

保留的前台 Shell 捕获路径继续作为已开始调用或绕过正常派发时的兼容和事故记录防线。如果它观测到之前待审的新建文件在无隔离区的情况下变为不存在，则持久化 `shell-delete-unrecoverable`，仅把最后已知内容作为预览，禁用自动拒绝，并要求手动恢复或明确接受。接受后推进不存在基线并移除事故记录。该预览不会被声称为隔离备份。

## Alternatives considered

**继续放行可写 Shell，依赖执行后监听。** 未采用，因为观测发生在破坏性系统调用之后，既无法恢复已删字节，也无法保证事件完整交付。

**解析命令字符串，只拦截表面上的删除。** 未采用，因为解释器、脚本、子进程、展开、别名和动态路径都能绕过文本分类。

**使用最后观测内容自动恢复缺失的待审新建文件。** 未采用，因为该内容并非由经验证的删除前事务捕获，可能不完整、过时、属于二进制文件或无法表达整个目录。它是供手动处理的证据，不是恢复权威。

**与 Shell 一起禁用结构化外部操作。** 未采用，因为文件系统审核和远程产品权限是两个独立边界。受约束的结构化工具可执行已声明的远程操作，而不获得任意本地 Shell 写权限。

## Consequences

在严格 File Edit 会话中，即使用户选择全部文件系统权限，可写构建脚本、生成器、包管理器和任意原始 Shell 变更也会暂时不可用。只读诊断和所有受审结构化文件操作继续可用。这是明确的紧急安全边界，不是最终的易用性设计。

下一实施阶段必须把删除拦截下沉到单个工具之下的文件系统沙箱层，在允许 unlink 或递归删除之前创建并验证隔离内容，并让每个写入方都通过同一账本事务。只有 Bash、Python、Node、子进程、目录递归、外部路径、崩溃和回滚测试都证明不存在无可恢复修改前映像即执行的删除后，才可重新开放可写原始 Shell。

该工作的独立快照基础设施记录在[Build a pre-change shell snapshot transaction foundation](../feature/2026-09-05-shell-prechange-snapshot-foundation.md)。该模块的存在不会取代本拒绝决策：Shell 生命周期结算和审核账本集成仍未完成。
