# `@deepseek-ai/dsh-session-turn-outline`

[English](README.md) | 中文

本函数插件将完整、持久化的 Session 日志折叠为有界 `turnOutline` 导航投影。每项只包含回合号、`turn/start` 序号、受限长度的用户问题与已结算回答预览，以及回合状态。工具输出、附件正文和文件内容不会进入该投影。

## 模型体验

无，因为本插件只从已经记录的 Session 事件计算客户端只读数据，不接触提示词、消息、schema、stream 或工具结果。

#### KV Cache 影响

无；本插件不会组装或发送模型请求。

## 已知限制与延期工作

- **投影大小随回合数增长** — 每项长度有界，但包含大量短回合的 Session 仍会为每个回合携带一条小记录。
- **深度跳转会加载真实历史页** — 导航不保留完整正文，因此到达未加载回合时可能发起多次只读分页请求。
- **Packed journal transport 仍延期** — 本包使用现有 projection carrier，不改变 JSONL 历史安全链路。
