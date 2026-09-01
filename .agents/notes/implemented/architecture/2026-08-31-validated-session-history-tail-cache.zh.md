# Agent Note: 已验证的会话历史尾页缓存

Status: implemented

[English](2026-08-31-validated-session-history-tail-cache.md) | 中文

## 问题

Web 客户端只请求冷会话最近 50 条消息，但 Host 此前会先完整解码、验证、冻结并折叠整个 JSONL 会话，再执行分页。因此，大型仅追加历史在每次进程重启后都要承担完整重建成本，即使首屏只使用尾页。

## 决策

持久化 seam 暴露 `readHistoryTail(id, maxMessages, signal?)`。默认实现执行既有的完整 `inspect()`，因此后端不会隐式获得更弱的行为。JSONL 后端在一次完整冷 inspection 后保存可重建的 50 条消息尾页缓存，并且只有主日志完整的 stat 派生 revision 与当前构建支持的事件类型集合均匹配时才复用。缓存携带连续的可见尾页、作为重建上下文的最近一条更早 `agent-preset/selected` 事件、最终 seq 和 `hasMore` 事实。

Host 仅在 `session.history` 尾页请求中使用冷尾页缓存。挂载 projection 注册表时，持久化 projection cache 必须描述同一个最终 seq；projection 切点缺失或更早都会强制执行完整 inspection。恢复、fork、subagent continuation、模型重建、崩溃修复、旧页读取以及其他所有完整日志消费方继续使用 `inspect()`、`prepare()`、`load()` 或 `readFrom()`。

主会话日志仍是唯一真源。尾页缓存缺失、格式错误、陈旧或与当前构建不兼容时，系统会回退完整 inspection，并以快速失败不影响主流程的方式重建缓存。缓存文件绝不修复或修改日志。

## 考虑过的替代方案

**在没有既有验证记录时解码最后几个 Zstandard frame。**不采用，因为结构 frame 扫描和局部连续的后缀无法证明更早必需事件的类型、seq 连续性，也无法证明页面必须展示的 preset 与 projection 状态。

**先使用未验证的快速页面，再在后台验证完整日志。**不采用，因为 UI 可能短暂展示随后被持久化约定拒绝的 transcript，而 fork 或恢复也可能与验证结果竞争。

**把强制字节偏移索引加入权威会话格式。**本次不采用，因为它会扩大 append、修复、截断和兼容行为。可丢弃且绑定精确 revision 的缓存无需改变会话格式即可获得重启收益。

## 后果

现有会话必须先承担一次完整冷 inspection，之后缓存才可使用；后续日志未变化的进程重启可以在不解码完整 JSONL 产物的情况下渲染前 50 条消息页。任何 append、修复、缓存损坏、事件支持变化或 projection 落后都会有意让一次读取恢复原有成本。新增文件的大小由渲染尾页限制，而不是随会话总大小增长，并且可以随时删除或重新生成而不丢失会话数据。

## 验证

纯分页测试覆盖追加来源配额、替换事件排除、preset 上下文和无效限制。JSONL 集成覆盖缓存创建、精确 revision 复用和损坏缓存回退。Host 覆盖固定冷尾页不执行完整 inspection 的路径。既有持久化、冷历史恢复、展示转换、分页和 projection 测试套件继续负责未改变的完整日志路径回归。
