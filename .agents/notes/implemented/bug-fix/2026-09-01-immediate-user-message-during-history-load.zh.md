# Agent Note: 长历史加载期间立即投影已写入日志的用户消息

Status: implemented

[English](2026-09-01-immediate-user-message-during-history-load.md) | 中文

## Problem

当对话历史很多时，Host 已经接受并写入新发送的用户消息后，尾页历史请求仍可能处于 pending。Runtime 过去只把对应的实时 `session/event` 放入缓冲区，不发布 conversation snapshot，因此消息要等历史完成，或等模型后续事件触发更新后才显示。

## Decision

初次历史请求处于 loading 时，每个权威实时事件既保留在原有序号缓冲区，也立即投影到 conversation assembler。历史响应仍会原子替换临时投影，再按既有 event 序号规则拼接缓冲事件。Client 不会在 Host 写入日志前制造乐观消息。

Gap repair 保持原有行为。已经打开的窗口出现序号缺口，意味着中间存在未知事件，因此必须等修复页恢复连续性后再投影缓冲事件。

## Alternatives considered

**按下 Enter 时插入只存在于 Client 的乐观用户消息。** 否决，因为 prompt 拒绝、重连、附件和跨客户端事件都需要第二套身份及回滚协议，并可能显示从未进入模型可见历史的内容。

**等待 prompt RPC 返回后再由 Client 本地追加。** 否决，因为这会复制权威 mux 链路并与同一日志事件发生竞态，而且 RPC 响应时机不应成为对话发布契约。

**Gap repair 期间也立即投影。** 否决，因为 Definitions 要求加载事件窗口连续；跨越未知序号区间投影可能派生错误的对话上下文。

## Verification

Runtime session 测试会保持历史请求未完成，注入 `turn/start` 和 `user/message`，并证明请求解决前用户节点已经可见；随后返回旧历史页，证明最终顺序正确且新用户消息只出现一次。

## Consequences

即使大型对话仍在加载，已写入日志的用户消息也会立即显示。模型运行继续异步进行，历史仍是权威来源，发送失败仍通过既有输入链路恢复草稿，历史拼接不会制造重复消息。
