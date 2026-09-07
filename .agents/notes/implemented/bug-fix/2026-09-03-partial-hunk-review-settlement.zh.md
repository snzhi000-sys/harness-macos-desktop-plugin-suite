# Agent Note: 局部 hunk 审核的持久结算

Status: implemented

[English](2026-09-03-partial-hunk-review-settlement.md) | 中文

## Problem

File Edit 曾以 `h0`、`h1` 等位置型 hunk 标识保存局部接受和拒绝决定。接受 hunk 时基线不前移，拒绝 hunk 后 diff 结构改变，但后续标识的含义没有同步失效。因此，agent 后续再次修改同一文件时，已接受内容可能重新出现，其他未审核 hunk 也可能被错误隐藏。

## Decision

持久审核模型只使用两份内容：`base` 包含原始内容与所有已接受 hunk，`cur` 包含当前磁盘内容。`diff(base, cur)` 是待审核内容的唯一来源。

接受单个 hunk 时，只把该 hunk 应用到 `base`。拒绝单个 hunk 时，只在 `cur` 中恢复该区域并写回磁盘。两种操作完成后都会丢弃位置型 decision，重新计算剩余 diff。v6 状态持久化已结算基线，不再持久化 hunk decision。

迁移 v5 状态时，如果 decision 全部为接受且两份文本快照都可用，就把接受内容折叠进已保存基线。包含拒绝或接受拒绝混合的状态存在歧义，因为拒绝可能已改写 `cur` 并导致 hunk 重排；迁移会保留磁盘内容，并重新暴露完整的 `base` 到 `cur` 剩余差异，不会静默接受或覆盖内容。

## Alternatives considered

**保留 decision 并为 hunk 生成稳定哈希。** 不采用，因为 hunk 附近的编辑仍可能拆分或合并 diff 结构，需要复杂的身份与冲突语义，同时已接受内容仍未进入基线。

**文件变化时直接清空 decision。** 不采用，因为这正会让已接受内容基于旧基线重新出现。

**把有歧义的旧版混合状态视为已接受。** 不采用，因为这可能静默批准用户从未接受的内容。保守地重新审核可以保留原始字节和用户控制权。

## Verification

Host 测试覆盖接受后 agent 再次修改、拒绝导致 hunk 重排、接受后拒绝整文件、拒绝后接受整文件、再次修改已接受区域、CRLF 保留、过期 revision、重启持久化和 v5 迁移。产品验证会从 Profile 归档中提取最终 File Edit Host；如果缺少 v6 结算逻辑，或仍包含旧 `decisions.set(hunkId, action)` 路径，候选包会被拒绝。

## Consequences

已审核内容会在后续修改和重启之间保持结算状态，批量操作也只处理真实剩余差异。旧版有歧义的混合状态可能要求用户重新审核一段差异，但迁移期间绝不会修改或静默批准它。
