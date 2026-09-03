# Agent Note：长会话使用有界全日志回合导航

Status: implemented

[English](2026-09-03-long-session-turn-navigation.md) | 中文

## Problem

对话页有意只加载经过安全校验且序号连续的历史尾页。这个机制能控制长 Session 的启动成本，但读者必须反复加载旧页后才能发现早期回合。若每个流式增量都重建所有行，大型已加载窗口还会产生不必要的开销。

## Decision

Host 在完整的权威 Session 日志上注册 `turnOutline` 投影。每个回合只保留回合号、`turn/start` 序号、打开或结束状态，以及最长 160 字的用户问题和已结算回答预览。工具输出、附件和文件内容不会进入该投影。投影通过现有 projection carrier 到达 Client，因此不改变 `ctx.sessions`、Conversation slot 或 Session 事件格式。

Chat 使用该投影渲染 memoized 回合导航条。已加载回合指向稳定的 Conversation 节点 key，未加载回合指向其 `turn/start` 序号。选择未加载回合时，现有 Session 分页器按每页最多 250 条消息向前加载，直到连续窗口覆盖目标；分页插入期间保持读者的语义滚动锚点，并只在真实目标行出现后定位。普通分页持有读取权时，目标保持等待，并在分页释放后只启动一次深度读取；读取失败或无进展不会循环重试。导航不估算行高，也不重试任何写操作。

流式事件继续使用现有动画帧 notifier、增量 Markdown parser 和 keyed node store。真实行几何持续挂载，因为基于 intrinsic size 的绘制隔离会在浏览器尚未测量离屏行时让已恢复的阅读锚点漂移。

## Alternatives considered

**用上游 `ui-chat` 整体替换本地对话 UI。** 本地包仍承载产品 slot、权威用户消息即时显示、Better Sidebar turn-tail 集成和 File Edit hook。整体替换会把兼容性风险扩大到回合导航之外。

**将 packed journal transport 与导航一起引入。** 上游传输依赖本产品在阶段 1 明确没有采用的 handle-based journal persistence。单独引入会绕过 JSONL 完整冷检查，并破坏本地 salvage 保证。

**把完整 Session 日志加载到 Client。** 这种方式实现导航简单，但会传输并持有大型工具输出、附件和文件内容。有界 Host 投影无需复制日志即可提供索引。

**使用估算高度的行虚拟化。** Markdown、代码块、图片、审核面板和插件卡片的高度不稳定，估算会让分页和跳转定位漂移。保持真实行挂载能够保留精确布局与语义锚点，行为风险更低。

**为每个 Chat 行使用固定 intrinsic height 的 `content-visibility`。** 重新挂载的离屏行没有可复用的实测高度，真实布局替换占位高度时会移动已恢复的会话位置。在行高具备 Session 所有的精确缓存之前，稳定几何优先于这项绘制优化。

## Consequences

长 Session 无需改变插件事件契约即可立即发现回合并一键导航。投影大小随回合数增长，但每回合固定有界，并且不受工具输出大小影响。深度跳转可能产生多个只读历史请求，并暂时扩大已加载窗口，但不会重放任何操作。当前传输仍序列化原始历史页；packed journal transport 继续作为独立的后续迁移，实施时必须保留 JSONL 安全检查。
