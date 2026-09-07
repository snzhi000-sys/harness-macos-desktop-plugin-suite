# Harness 上游能力移植实施计划

[English](UPSTREAM_CAPABILITY_PORTING_PLAN.md) | 中文

更新日期：2026-09-03

## 1. 文档目的

本文规划将 DeepSeek Harness 官方 `dsh-v0.1.2-alpha.5` 及其前置版本中的关键能力，按功能边界移植到本地 macOS 桌面端与插件套件。本文不是整体版本升级方案，也不授权直接合并、变基、打包 Stable App 或覆盖用户数据。

本计划以本地 `migration/unified-suite` 分支、Harness `0.1.0-rc.5` 核心和 Desktop `0.1.0-rc.5-local.5` 为基线。当前事实和统一工程边界见[迁移状态](STATUS.zh-CN.md)与[统一工程迁移执行计划](../MIGRATION_PLAN.zh-CN.md)。

## 2. 结论与优先级

能力移植采用“先封存本地正确行为，再移植数据安全与运行可靠性，随后改善长会话体验，最后增加新能力”的顺序。

| 顺序 | 能力 | 级别 | 选择原因 | 移植方式 |
| --- | --- | --- | --- | --- |
| 0 | 固化本地消息即时显示与思考历史修复 | 前置门禁 | 两项能力已在工作树实现，但尚未形成稳定基线；后续改动最容易覆盖它们 | 先拆分本地提交、补齐测试，不从上游覆盖 |
| 1 | Session 存储跨版本读取与损坏数据 salvage | P0 | 直接关系启动成功、会话标题和用户数据可恢复性；用户损失不可接受 | 定向移植 storage 与 projection cache 的读取兼容，不迁移整个 Session 架构 |
| 2 | WebSocket 心跳、自动重连与连接恢复提示 | P0 | 影响所有会话和插件 Host 调用；能够减少成功回答后仍出现陈旧错误等恢复异常 | 在现有 connection 包内移植状态机与心跳，保持现有 Client Runtime 接口 |
| 3 | 长会话增量渲染、分页稳定性与回合导航 | P1 | 对日常长对话价值最高，也是当前本地与官方差距最大的体验能力 | 先移植数据与渲染优化，再在旧 `ui-conversation` 上实现导航，不引入完整 `ui-chat` |
| 4 | WebFetch SSRF 防护基础 | P1 安全前置 | 本地 Provider 未实现私网防护；当前 Fetch 已关闭，但任何重新启用都必须先完成该能力 | 移植 DNS 校验、NAT64 检查和固定地址连接；保持 Fetch 关闭直到安全验收完成 |
| 5 | DeepSeek 原生多模态与 Files API | P2 | 新增图片理解能力，价值高但改动跨附件、日志、模型请求和历史回放 | 按完整附件链路移植，不能只开放图片选择或只修改序列化器 |
| 6 | 子代理模型选择与父子通信增强 | P2 | 本地已有 `send_message` 等基础能力，新增收益主要是模型和推理参数选择 | 对现有子代理接口做差异补齐，不替换整个子代理包 |
| 7 | Provider 登录、模型发现和插件版本上报 | P3 | 有助于配置和诊断，但不优先于会话可靠性与长会话性能 | 分别移植设置扩展、请求元数据和模型目录能力 |
| 暂缓 | `ui-chat` 全量迁移、Session 索引 API、handle-based persistence、Remote gateway、SQLite 移除 | 架构专项 | 会同时冲击多个核心包和产品插件，无法作为单一能力安全移植 | 等前述阶段稳定后另立架构迁移计划 |

## 3. 移植原则

1. **不直接升级版本。** 不把官方 `master`、`dsh-v0.1.2-alpha.5` 或大型合并提交直接 merge 到本地分支。
2. **按能力重放。** 每项能力先锁定官方提交和测试，再把必要机制人工适配到本地代码；不携带无关重构、目录迁移和 API 删除。
3. **保持本地公共接口。** 第一轮移植优先把官方能力放在现有 Session、Client Runtime、Cordis slot 和插件接口后面，避免五个产品插件同时改造。
4. **不双写 Session 日志。** 允许旧格式与新格式双读，但持久日志在一个阶段内只能有一个权威写入格式，防止同一会话产生不可重建的混合记录。
5. **模型可见内容可重建。** 图片、引用、思考内容和工具结果进入模型请求前，必须已经有可回放的 Session 记录。
6. **保留产品能力。** Explorer、统一文件路由、文件审核、事务删除、消息 Fork、会话谱系、Browser/Preview 和 Desktop/Profile 打包链均为不可回归项。
7. **每项能力可单独回滚。** 一个能力对应独立提交序列、测试记录和 Dev 候选；不得把多个高风险能力压进一个不可拆分提交。
8. **只用合成迁移数据。** 存储和升级测试使用人工构造或去标识化 fixture，不把真实 Stable 会话、凭据、审核账本或用户 Profile 提交到仓库。

## 4. 当前兼容性基线

本地产品插件与 Harness 核心并非松耦合。Better Sidebar 依赖 Client Runtime、Conversation、Settings 和工具接口；Workspace Lineage 直接使用 Session/Workspace Client Runtime；Message Edit 直接操作 Session、Session Query、Workspace 和 Fork；File Edit 依赖工具事件、Session 头信息和会话归属；Cowork 依赖 Session、LLM、Tools、FS 和 Approval。

| 组件 | 对存储移植 | 对连接移植 | 对长会话/UI 移植 | 对多模态移植 | 对 Session 架构迁移 |
| --- | --- | --- | --- | --- | --- |
| Better Sidebar | 低 | 中：Host API 断线后的布局与 Explorer 请求必须恢复 | 高：依赖 `ui-conversation`、turn-tail、产物和统一文件打开 | 中：图片产物必须继续进入 Preview 路由 | 高 |
| File Edit | 中：审核状态不能与 Session 恢复互相覆盖 | 中：审核请求失败必须保持 fail closed | 高：审核面板、引用和产物投影依赖会话 UI | 中：图片不能误进入文本审核和代码编辑 | 高 |
| Message Edit | 高：Fork、flush、父链和版本事件依赖持久 Session | 中：重连不得重复创建 Fork | 高：编辑、reroll、retry 的入口依赖对话节点 | 中：历史图片消息 Fork 必须完整复制 | 最高 |
| Workspace Lineage | 中：标题与父链必须在恢复后稳定 | 高：重连后 Workspace 与 Session 列表要重新对账 | 高：直接依赖 Client Runtime 的 Session/Workspace 状态 | 低 | 最高 |
| Cowork | 中：工具与产物事件必须可回放 | 中：长任务状态不能因断线重复结算 | 中：工具卡和产物展示依赖对话投影 | 高：Office/Notebook 产物和图片附件可能交汇 | 高 |
| Desktop/Profile | 中：升级启动与 Profile 替换必须保留数据 | 中：后端 ready 与 Renderer 断线要区分 | 低 | 中：Runtime 需要带齐附件依赖 | 中 |

兼容性风险最高的路径是 `Session/Workspace Client Runtime → Workspace Lineage/Message Edit`，其次是 `Conversation projection/slot → Better Sidebar/File Edit`。因此这些接口在 P0/P1 阶段保持稳定，只在内部替换实现。

## 5. 阶段 0：封存本地基线

### 5.1 目标

在吸收上游代码前，把当前工作树中已经验证方向正确的本地修复变成可独立测试、可回滚的基线。

### 5.2 实施内容

1. 将 `reasoning_content` 历史回传、pi-ai replay 降级和错误恢复拆成一个独立提交序列。
2. 将长历史加载期间用户消息即时显示拆成另一个独立提交序列。
3. 将 Better Sidebar、About App、Explorer 缓存等无关改动分别归档，避免与内核移植共享提交。
4. 为以下行为建立固定回归测试：思考模式每轮历史可重放；非思考模式不发送多余字段；失败轮次后的下一轮不重复显示旧错误；用户消息提交后不等待模型或历史加载即可显示；刷新后只保留一条持久消息。
5. 记录五个产品插件的 typecheck、build、test 和 Profile Runtime 装配基线。

### 5.3 兼容性要求

- 不改变 Session 事件格式。
- 不改变插件可见的 `ctx.sessions`、`ctx.workspaces`、Conversation slot 和工具事件接口。
- 不改 Profile 组成，不打 Stable 包。

### 5.4 完成门槛

- 两组修复均可单独回滚。
- 定向测试覆盖失败、重试、刷新和长历史加载路径。
- 当前 95 项工作树改动已按功能归属，不存在无法判断来源的混合 diff。

### 5.5 阶段 0 执行记录

阶段 0 已于 2026-09-03 完成封存，尚未吸收任何上游能力，也未构建或安装 Stable 包。

| 基线组 | 独立提交 | 固化范围 |
| --- | --- | --- |
| 思考历史与错误恢复 | `856f7bc4d3` | DeepSeek `reasoning_content` 全历史回传、pi-ai replay 有序子集恢复与安全降级、旧失败恢复状态和 live error 失效 |
| 长历史即时消息 | `11b9f7ba81` | 初始历史请求未完成时立即投影 Host 已持久化事件，历史落地后按 seq 拼接去重，gap repair 继续等待连续窗口 |

封存后剩余 76 项未提交工作树记录均已确定归属，不属于上述两个内核提交：Desktop/Profile/产品打包链 46 项，Better Sidebar 的 About App 与 Explorer 缓存 16 项，File Edit 分块审核结算 7 项，项目 README 展示 3 项，迁移计划与状态文档 4 项。后续阶段不得把这些组作为上游能力移植的附带修改提交。

自动化基线结果如下：

- 核心定向测试：5 个测试文件、256 项测试通过。
- 五个产品插件：构建通过；Better Sidebar 547 项、File Edit 77 项、Workspace Lineage 139 项测试通过；Cowork 各 workspace 测试通过；Message Edit 的 Host/Client snapshot 校验通过。
- Desktop：26 项测试通过；源码隐私检查通过；Profile Runtime 装配确认 5 个必需插件。
- Dev 候选：标准 `npm run product:dist:dev` 链路通过产品身份、发布隐私和空 userData 隔离启动校验；固定输出为 `desktop/dist/dev/mac-arm64/DeepSeek Harness Dev.app`。

依赖安装仍会报告 `node-domexception`、`inflight`、`rimraf@2`、`glob@7`、`fstream`、`uuid@8` 和 `xterm@5` 等弃用提示。它们是当前依赖图的已知基线风险，不在阶段 0 顺带升级，避免改变 Runtime 或插件兼容面。

## 6. 阶段 1：Session 存储兼容与 salvage

### 6.1 上游参考范围

- `fcd109d29a`：Storage per-record unit 的版本读取兼容、备份并跳过损坏单元。
- `49df707c86`：Session projection cache 跨 domain 版本读取与安全启动。
- `dsh-v0.1.2-alpha.5`：修复升级后启动失败和会话标题丢失。

### 6.2 移植方法

1. 先比较本地 storage、JSON 后端和 projection cache 的格式版本、文件命名、锁和写入时机，列出字段级差异。
2. 只移植“读取旧版本、验证、备份损坏单元、跳过不可读缓存并重建”的机制，不引入官方 handle-based persistence。
3. 保持主 Session JSONL 为唯一真源。Projection cache 失败只能丢弃缓存并重建，不能删除或重写主日志。
4. 本地 `readHistoryTail()` 继续要求完整冷检查后才能生成缓存；上游 salvage 不得把“跳过坏 cache”扩大成“跳过未验证日志”。
5. 备份文件写入同一状态所有者目录，使用原子改名或复制校验；诊断只记录会话 ID、版本和错误分类，不输出消息正文。
6. 为本地旧格式、官方 v3/v4/v5 fixture、截断文件、未知新版本、单条损坏和只读目录建立矩阵测试。

### 6.3 插件影响

- Message Edit：重点验证 Fork 后父链、`message-edit/version` 和 flush 不丢失。
- Workspace Lineage：重点验证标题、父子关系、手动排序和归档状态在 cache 重建后不变化。
- File Edit：审核账本独立于 Session 存储，迁移不得清理或重建 `$DSH_HOME/dsh-file-edit-state`。
- Better Sidebar：Browser/Preview 布局属于独立插件状态，不参与 Session cache salvage。
- Cowork：工具和产物事件必须从主日志完整重建。

### 6.4 完成门槛

- 每个受支持旧 fixture 都能启动并保留标题、父链和事件数量。
- 损坏 cache 会备份并重建，损坏主日志仍明确失败，不静默丢消息。
- 使用复制的临时 Dev userData 完成一次旧包数据到新 Runtime 的升级演练。

### 6.5 阶段 1 执行记录

阶段 1 已于 2026-09-03 完成 Dev 候选验证，未构建或安装 Stable 包。

| 差异项 | 本地旧基线 | 上游 v4/v5 | 移植后决策 |
| --- | --- | --- | --- |
| 介质布局 | v3 `session_projcache.json` 单文件 | 逐 Session 文档 | v5 写入 `<root>/session_projcache/sessions/<id>.json` |
| 版本读取 | 仅接受精确版本 | v4/v5 跨版本读取 | 显式接受 v3/v4，未知新版本保留并忽略 |
| 记录身份 | `createdAt`/`cwd` | 包含 lineage 绑定 | v5 写入 seed 状态和继承事件数；旧记录不用于 Fork |
| 损坏处理 | 一条 schema 错误可阻断整个 domain | 独立记录 salvage | 仅对可丢弃派生 domain 先唯一备份再跳过；备份失败仍明确失败 |
| 主数据 | Session JSONL | 上游已出现 handle-based persistence | 不移植 handle 架构，JSONL 仍是唯一真源 |

实现新增了 Storage 可选 `per-record` layout、显式 `compatibleVersions` 和可丢弃 domain 的 `backup-and-skip`。v3 单文件首次导入时保留源文件；新备份名使用毫秒时间戳与 UUID，避免同名记录在同一分钟内重复损坏时覆盖之前诊断副本。Salvage 日志不输出 schema 底层错误或消息正文。

验证证据如下：

- 存储与 projection cache 矩阵：4 个测试文件、75 项通过，覆盖 v3/v4/v5、未知版本、截断文档、schema 无效备份、只读备份失败和 Fork lineage 防误用。
- 全仓 typecheck、阶段 1 定向 lint、5 个产品插件构建、Desktop 26 项测试、源码/发布隐私检查和 Profile Runtime 5 插件装配通过。
- 标准 `npm run product:dist:dev` 链路通过完整插件测试与空 userData 启动，生成 `v1.00.21 (dev)` 并覆盖固定 Dev 路径。
- 对打包 App 另用合成 v3 cache 的临时 userData 启动；Web 后端就绪后已生成 v5 逐 Session 文档，v3 源文件字节不变。

`product:test:plugins` 曾分别命中 Better Sidebar PTY 退出等待和 Cowork 微信消息先后顺序的时序失败；它们与本阶段代码无依赖，最终 Dev 标准打包链中的完整插件套件已通过。全局 Agent Note 格式门禁仍被既有 `2026-08-17-blank-session-external-conversation-views.md` 缺少 `Alternatives considered` 阻断；阶段 1 新 Agent Note 已包含完整结构。

## 7. 阶段 2：连接恢复与心跳

### 7.1 上游参考范围

- `af562d3649`：空闲 WebSocket 心跳。
- `ccfbbb443a`：连接恢复集中到 Connection Controller。
- `19b4d7f26c`：连接恢复状态提示和主动重连入口。
- `49bf26a794`：容忍短时 stalled host，避免误判断开。

### 7.2 移植方法

1. 保留本地 `packages/client/connection` 的公开接口，把心跳、generation、退避和重连所有权集中到现有 controller 内部。
2. 区分四种状态：首次连接、已连接、短时卡顿、正在重连。短时没有事件不能立即清空 Session/Workspace 状态。
3. 每次成功建立新 generation 后，统一触发 Session、Workspace、模型目录和插件 Host 状态的重新对账；重连只恢复状态，不重放已确认的写操作。
4. 对没有幂等键的操作禁止自动重试，包括创建 Fork、文件移动、删除、审核接受/拒绝和 Browser 布局写入。
5. UI 指示器通过通用 Client 状态提供，不让每个插件自行监听 WebSocket。
6. “立即重连”只重启连接循环，不刷新页面、不退出 Desktop 后端、不清除 userData。

### 7.3 插件影响

- Workspace Lineage 需要重新拉取 Session/Workspace 完整快照，并防止旧 generation 的迟到响应覆盖新快照。
- Better Sidebar 只重读当前工作区授权范围内的 Host 状态；已有 Explorer 缓存可先显示，但必须接受新 generation 的权威校准。
- File Edit 在连接不确定时保持审核操作 fail closed；连接恢复后重新读取 pending 快照，不重复提交接受或拒绝。
- Message Edit 的 Fork/rename/retry 不自动重发；连接中断时返回“结果未知”，随后通过 Session 列表对账确认是否已创建子会话。
- Cowork 长任务通过持久事件确认状态，不能仅依据连接断开将任务判定失败。

### 7.4 完成门槛

- 自动化覆盖空闲心跳、短时卡顿、后端重启、连续断线、页面卸载和重连时旧响应迟到。
- 断线期间已显示的用户消息不消失；连接恢复后不重复消息、Fork、审核动作或文件操作。
- Dev App 在临时 userData 中完成真实后端中断与恢复测试。

### 7.5 阶段 2 执行记录

阶段 2 已于 2026-09-03 完成 Dev 候选验证，未构建或安装 Stable 包。

实现保留 mux 与 Host 双 WebSocket，Host 使用可配置空闲 Ping/Pong；Client Controller 统一发布 `connecting`、`connected`、`stalled` 和 `reconnecting`，并持有 generation、退避及立即重连。Session、Subagent catalog 和 Workspace 的权威读取用请求 token 拒绝旧 generation 的迟到响应；Session resync 在新历史到达前保留当前可见消息。设置侧栏显示共享连接状态，立即重连不刷新页面，也不自动重放任何非幂等写操作。

真实打包演练额外发现 Desktop 后端退出会导航到错误页，无法保持 Renderer。壳层现已在原 loopback 端口有限次重启后端，只有恢复耗尽才显示错误页。临时 userData 演练中，后端 PID 从 `98599` 变为 `98762`，端口保持 `56732`；Electron 主进程与 Renderer PID `98641` 未变化，恢复后重新建立三条连接，release-info 仍返回 `v1.00.23 (dev)`。

验证证据如下：

- 阶段 2 定向自动化 8 个文件、195 项通过；最终审查后复跑 6 个关键文件、178 项通过，并新增 Desktop 恢复策略 3 项测试。
- Client/Host typecheck、阶段文件 lint、Client/config catalog、双语配对和 Harness 维护 skill 校验通过。
- 全量 GUI：275 个文件、3781 项通过、1 项跳过；Web replay：75 个文件通过、1 个文件跳过，253 项通过、15 项跳过。
- 标准 `npm run product:dist:dev` 完整链路通过五个产品插件、Desktop 29 项测试、隐私检查、Profile Runtime 装配和空 userData 启动，生成 `v1.00.23 (dev)` 并覆盖固定 Dev 路径。

Web E2E 首次因本机 Playwright 1.61.1 缺少 revision 1228 而无法启动；官方 171 MiB 下载过慢后，测试缓存临时复用已安装的 revision 1223，完整 replay 随后通过。全局 lint 及导出 JSDoc 门禁仍报告 ui-conversation 工作树中的既有问题，不属于阶段 2 文件。

## 8. 阶段 3：长会话性能与回合导航

### 8.1 拆分顺序

本阶段必须分成三个可独立验收的子阶段，不直接迁移官方 `packages/client/ui-chat`。

#### 3A：数据传输与投影

1. 对比官方 packed assistant history、分页 journal 和 projection 增量发布机制。
2. 保留本地 `readHistoryTail()` 安全校验，只减少已经验证记录的传输、解析和重复投影。
3. 为 Conversation snapshot 增加稳定 identity，避免流式更新导致整个节点数组重建。
4. 保持现有 `ctx.sessions` 和 `ui-conversation` 消费接口，先在内部建立适配器。

#### 3B：渲染与滚动

1. 将流式更新合并到动画帧节奏，限制 Markdown、代码高亮和滚动几何重复计算。
2. 保留用户滚动所有权：用户离开底部时不自动拉回；分页加载和跳转期间不同时争夺滚动位置。
3. Better Sidebar 的审核面板、产物尾部和文件跳转必须继续挂在稳定 slot 上，不改为引用官方内部组件。

#### 3C：回合导航

1. 在现有 `ui-conversation` 上新增独立的全日志 turn outline 投影，只输出回合 seq、状态和受限长度预览。
2. 导航跳转通过分页控制器加载目标 seq，再交给现有滚动容器定位。
3. 预览不读取或缓存完整工具输出、附件正文和文件内容。
4. 先实现文本回合；图片、工具卡和问答卡只显示类型摘要，后续再增强。

### 8.2 插件影响

- Better Sidebar 的 turn-tail 产物拦截必须继续读取 `Turn.data`，不能退回 `owner.nodes`。
- File Edit 的审核面板和引用定位必须在分页、切换文件 Tab 和跳转回合后保持当前 session 归属。
- Message Edit 的 edit/reroll/retry 必须使用稳定 MessageId/seq，不依赖当前页面是否加载了目标节点。
- Workspace Lineage 切换会话时不能销毁同工作区 Explorer 缓存，也不能让旧会话分页响应覆盖新会话。
- Cowork 工具卡只渲染可见窗口，但任务状态和产物统计从全日志投影读取。

### 8.3 性能基线

建立 1,000、10,000 和包含大工具输出的合成 Session。记录冷启动首屏、第二次启动、向前翻页、跳转旧回合、持续流式输出和切换会话的耗时、主线程长任务和内存峰值。

移植后的最低门槛是：所有场景不得比阶段 0 基线显著退化；10,000 条记录会话可以打开、发送、流式回答、向前翻页和跳转；离屏代码块不得持续重复高亮；本地消息即时显示行为保持不变。

### 8.4 阶段 3 执行记录

阶段 3 于 2026-09-03 按 3A、3B、3C 的兼容边界完成实现，最终交付仍只构建 Dev 包。

3A 没有直接移植上游 packed journal。官方实现依赖本地尚未采用的 handle-based journal persistence、ranged journal 和新的 Session Controller；若只搬传输层，会绕过阶段 1 要求的 JSONL 完整冷检查，并改变既有 `session.history` 与插件消费接口。本地继续使用 `HistoryEntry` 内部适配、50 条消息安全尾页、按 `seq` 连续分页和 keyed Conversation snapshot。现有 `ChatSnapshot.order` 只在节点进入、离开或移动时变更，每个 `ChatNodeSeat` 只订阅自己的稳定 key；流式内容不会重建整个节点数组。

3B 沿用现有动画帧发布、流式 Markdown 增量解析、keyed Chat 节点订阅与滚动所有权：用户离开底部后不会因流式增量重新吸附，分页使用语义节点 key 保持锚点。组装浏览器滚动契约测得固定 intrinsic height 的 `content-visibility` 实验会让恢复锚点偏移 834 px，因此没有保留该方案；重新挂载的离屏行没有精确历史高度。在具备 Session 所有的精确行高缓存前，Better Sidebar turn-tail、File Edit 审核、文件跳转和 Cowork 工具卡所需的真实 DOM 行与稳定 slot 继续保持挂载。

3C 新增 Host `turnOutline` 全日志投影。每个回合只保存回合号、`turn/start` 序号、open/closed 状态和最长 160 字的用户问题、已结算回答预览；工具输出、附件正文和文件内容不进入投影。Chat 回合导航将已加载回合映射到稳定节点 key，未加载回合映射到 `turn/start seq`。点击旧回合后，Session 使用每页最多 250 条消息的只读循环向前分页，保持当前阅读锚点，在真实目标行提交后再定位；普通“加载更早”正在执行时不会启动竞争分页，重连 generation 变化会终止旧跳转。

可重复数据面基线由 `npm run benchmark:stage3` 生成。本机最终复跑记录如下：1,000 条记录序列化 0.553 ms、解析 1.183 ms、outline fold 1.991 ms；10,000 条记录序列化 5.424 ms、解析 8.170 ms、fold 23.052 ms。含约 41.7 MiB 大工具输出的 1,000 条记录，源数据序列化和解析分别为 52.716 ms 与 32.012 ms，而 outline 仍为 64,511 bytes、fold 0.525 ms，证明导航投影不随工具正文膨胀。堆增量受同进程垃圾回收时机影响，只作为诊断样本，不设机器无关阈值。浏览器侧继续由 `apps/web/tests/complex-history.perf.ts` 记录冷启动、首屏、分页、持续流式输出、切换会话、主线程任务与内存；它是无固定耗时阈值的人工性能 lane，结构断言防止 fixture 被意外缩小。

验证覆盖 projection schema、非用户消息、重复边界、大工具正文不泄露、10,000 条记录 benchmark、连续多页 `loadThrough`、普通分页互斥、现有即时消息显示、动画帧合并和滚动锚点。阶段 3 定向测试 8 个文件、133 项通过；全量 GUI 277 个文件、3,788 项通过、1 项跳过；Web replay 75 个文件通过、1 个文件跳过，253 项通过、15 项跳过。Client typecheck、阶段文件 lint、包路径、包不变量、Cordis 配置、README 和配置目录门禁均通过。全目录 lint 仍只报告 `ui-conversation` 中本阶段未修改的旧行。

标准 `npm run product:dist:dev` 链路重新构建 Host/Client、五个产品插件、Runtime 与 Profile，并通过 Desktop 29 项测试、源码和包内隐私检查、Profile Runtime 五插件装配、产品身份/功能标记、ad-hoc 签名及空临时 userData 隔离启动。最终 Dev 为 `v1.00.25 (dev)`，构建时间 `2026-09-03T12:39:49.051Z`，Runtime ID `9d1639b0be921c11`，Profile ID `8810735fb59c0bc6`，固定路径为 `desktop/dist/dev/mac-arm64/DeepSeek Harness Dev.app`。包内 Runtime 已确认包含 `@deepseek-ai/dsh-session-turn-outline`。本阶段没有构建或安装 Stable；用户可见的回合导航点击仍待人工 UI 验收。

## 9. 阶段 4：WebFetch SSRF 防护

### 9.1 当前边界

本地 `web-fetch-http` 仅限制协议、凭据、长度和同源重定向，没有私网地址、DNS rebinding 或 NAT64 防护。产品 Profile 当前设置 `fetch: false` 且未挂载 Fetch Provider，因此该代码不得在防护完成前启用。

### 9.2 移植方法

1. 移植官方 `network.ts` 的公网 IP 分类、完整 DNS 答案校验、NAT64 私网检测和固定地址连接。
2. 每次请求和每次重定向都重新执行 URL 与公网目标验证；跨源重定向继续要求新的工具调用。
3. TLS SNI 和 HTTP Host 保持原始主机名，底层连接只使用已验证地址。
4. 拒绝 loopback、link-local、私网、文档保留地址、Unix socket、嵌入凭据和 DNS 答案中混入的非公网地址。
5. 通过受控本地 DNS/HTTP fixture 测试，不访问真实内网服务。
6. 安全测试通过后仍先以 Dev Profile 显式开启；Stable Profile 是否开启另行决策。

### 9.3 插件影响

该能力主要影响 Web 工具 Host，不改变右侧 Browser iframe。Better Sidebar 的 Browser 可以访问用户主动输入的地址，而模型可调用的 WebFetch 继续遵守独立安全策略，二者不能复用权限判断。

### 9.4 完成门槛

- 官方 SSRF 测试类别全部在本地适配后通过。
- Profile Runtime 验证确认 Fetch Provider 和工具开关符合目标通道配置。
- Dev 中公网 URL 可读，私网、重绑定和跨源重定向均被拒绝。

### 9.5 阶段 4 执行记录

阶段 4 已于 2026-09-03 完成安全传输层，但没有打开共享产品 Profile。`web-fetch-http` 现在会验证完整 IPv4／IPv6 答案集，拒绝任何混合或非公网目标，发现 RFC 6052／RFC 7050 DNS64 前缀，拒绝映射到私网 IPv4 的 NAT64 地址，并使用请求私有的 Undici dispatcher，只把已验证地址交给 lookup。每个同源重定向都会重新验证并固定地址；跨源重定向会在解析或连接第二个来源前被拒绝。现有 URL 长度、超时、正文大小、解码与错误约定保持不变。

上游代理路径有意没有移植：代理侧 DNS 会让本机无法证明最终目标仍属于公网。Better Sidebar Browser 没有改动，继续代表用户主动浏览，与模型选择的 WebFetch 权限保持隔离。

受控 resolver 与 loopback HTTP fixture 的 87 项安全和集成测试通过；Web 子系统全量 11 个文件、285 项通过。Host／Client typecheck、定向 lint、包路径、包不变量、README、Cordis、配置目录和阶段 4 双语文档检查通过。全语料 doc-sync 仍报告阶段 4 范围外已有的 Agent Note 与双语配对问题。

标准 `npm run product:dist:dev` 链路通过产品插件测试、Desktop 29 项测试、隐私检查、Profile／Runtime 装配、身份验证、ad-hoc 签名和空临时 userData 隔离启动，并覆盖固定 Dev 路径。最终版本为 `v1.00.26 (dev)`，构建时间 `2026-09-03T13:55:22.404Z`，Runtime ID `d43d5c585f31cee4`，Profile ID `c0d7117aaa9608be`。包内 Profile 仍保持 `fetch: false` 且没有挂载 Fetch Provider，因为 Dev 与 Stable 当前共用同一份 Profile 源码；打包 Dev 启用需要等待通道专属组成机制，不能冒险让 Stable 隐式继承。本阶段没有构建或安装 Stable。

## 10. 阶段 5：DeepSeek 原生多模态与 Files API

### 10.1 移植范围

1. Core image content block 与模型输入模态声明。
2. 本地附件持久化、规范化编码、尺寸和像素预算。
3. DeepSeek 原生图片序列化与视觉模型目录。
4. Files API 优先上传、文件 ID 复用、失败后受控降级。
5. 图片发送即时回显、后台压缩上传和刷新后的历史重放。
6. Compaction、Fork、reroll、retry、子代理和 Trajectory 中的图片处理。

### 10.2 移植方法

1. 先完成附件存储和 Session 事件，再开放 UI；禁止生成无法重放的临时 Blob-only 消息。
2. `llm-deepseek` 保留阶段 0 的 `reasoning_content` 规则，在图文序列化测试中同时覆盖思考历史。
3. Files API 上传记录使用稳定内容摘要和 Provider 范围，避免跨账号或跨 base URL 复用文件 ID。
4. 图片处理失败必须保留可理解错误，不让会话在每次重试时重复发送同一个无法服务的附件。
5. Better Sidebar 的图片 Preview 与模型附件是两个用途：Preview 读取工作区文件，模型附件读取 Session 持久引用，不能以 Preview URL 代替模型附件记录。

### 10.3 插件影响

- Message Edit 必须完整复制图片消息及其持久引用，不能只复制文本。
- File Edit 只对文本文件提供行引用和修改审核；图片附件不得进入文本编辑与拒绝恢复逻辑。
- Better Sidebar 继续负责本地图片 Preview；聊天附件点击是否复用统一文件路由要按附件是否有安全本地路径决定。
- Cowork 产生的图片或文档缩略图必须明确属于产物还是模型附件，不能隐式进入模型上下文。
- Workspace Lineage 的搜索结果只索引图片消息的可见说明，不索引二进制内容。

### 10.4 完成门槛

- 文本模型拒绝图片时给出明确错误，视觉模型可以发送单图、多图和超长截图。
- Files API 上传可复用，失效文件 ID 能重新上传；切换 Provider 不复用错误 ID。
- 刷新、重启、Fork、reroll、retry 和长历史分页后图片不丢失、不重复、不阻塞文本消息即时显示。

### 10.5 阶段 5 执行记录

阶段 5 于 2026-09-04 在现有持久附件与 Session 事件链上完成，没有导入上游新版 Session Controller 或整体替换 `ui-conversation`。DeepSeek 目录现在显式区分文本模型与视觉模型；未收录的透传模型仍按仅文本处理。图片在用户消息写入前已经由 Host 校验并保存为内容寻址附件，Queue、Steer、Fork、retry、reroll、刷新与分页继续只携带持久引用，不持久化 Blob URL 或 base64。

`llm-deepseek` 在保留阶段 0 `reasoning_content` 规则的同时，将用户和工具结果图片序列化为 DeepSeek 图文消息。它优先使用 Files API，并按附件摘要、规范化端点和单向凭据作用域复用文件 id；临近过期会主动刷新。受控上传失败会在请求图片预算内降级为内联数据。chat completion 明确拒绝过期 id 时，只使匹配映射失效，重新上传一次并重传一次；重新上传仍失败时可受控降级，但不会形成重试循环。同一图片的并发上传会合并，单个等待者取消不会中止仍被其他请求需要的上传。

子代理浏览器图片先经父 Host 的附件服务校验和保存，再以持久引用进入子会话；纯文本子模型在写入部分消息前拒绝图片。Trajectory 保留助手与工具结果中的图片引用，并通过 Conversation 的 Session 授权加载器展示，不复用 Better Sidebar Preview 权限。超过请求图片预算时只在临时模型请求中从最旧图片开始替换为明确省略标记，不改写 Session 历史。

定向验证覆盖 DeepSeek 图文序列化、Files API、上传索引、并发取消、思考历史、Queue、Steer、Fork、子代理准入与持久化，以及 Trajectory 授权图片渲染。当前补充复跑结果为 7 个测试文件、243 项通过，相关 LLM、Host、Subagent、Client Runtime、Conversation 与 Trajectory TypeScript 工程构建通过。最终 Dev 打包与隔离启动记录在本阶段完成后补入；本阶段不构建或安装 Stable。

## 11. 阶段 6：子代理与模型配置增强

### 11.1 移植方法

1. 先对比本地 `send_message`、`interrupt_agent`、`list_agents` 和 Job Panel 与官方行为，形成缺口测试。
2. 在现有子代理创建参数上增量加入 Provider、模型、reasoning effort 和 max tokens，不更换现有任务生命周期。
3. 授权范围由父 Agent/Profile 决定，子代理只能在允许目录中选择，不能读取全局未授权 Provider。
4. 保持 File Edit 的 `origin: "subagent"` 归属规则，嵌套子代理修改继续汇总到最近可见父会话审核账本。
5. Better Sidebar 的 Job Panel 通过稳定子代理服务读取状态，不直接读取 Session 内部数组。

### 11.2 完成门槛

- 默认参数下行为与当前版本一致。
- Provider/模型不可用、权限不足、父会话断线和子代理退出均有确定状态。
- 子代理文件修改、产物、token/耗时和父子消息在刷新后可重建。

### 11.3 阶段 6 执行记录

阶段 6 保留现有 subagent 服务、继续执行生命周期、控制工具和 Job 投影。配置的 spawn 工具现在允许使用 Profile 中的确切模型目录以及父 agent 当前路由，并公开逐次调用的提供方、模型、推理强度与输出 token 字段，同时提供 `list_subagent_models`；该发现工具会在任何全局提供方详情到达模型前过滤结果。系统先授权显式选择，再通过实时 LLM 适配器解析，并且在异步校验期间发生提供方替换时拒绝调用，避免混用不同代际。未携带这些字段的调用继续采用原有创建路径，也不会增加 LLM 预检。

`AgentOptions.reasoningEffort` 会为子 agent 的首次请求设定初始值，请求重建不变量会将其与持久请求 header 比对。可继续描述符 v3 保存提供方、模型、推理强度和最大 token 数以供冷恢复；读取方仍接受 v2 描述符，并为其中缺少的字段采用路由默认值。spawn 与 fork 提供方显式声明一次性 `agentOptions` 支持，但产品 fork 工具不公开路由选择，因此继续保留继承路由的 KV Cache 行为。

File Edit 的归属仍为 `origin: "subagent"`，嵌套修改继续通过现有父级账本结算。Better Sidebar 的 Job Panel 仍读取 `jobsBySession`，其 subagent 拓扑使用稳定的 history/catalog API，而不是根据 Session 数组推导 Job 状态。定向 TypeScript 构建通过；扩展回归覆盖继续执行恢复、提供方能力拒绝、授权过滤、Job 投影和 Better Sidebar Job 渲染，共 25 个文件、503 项测试通过。2026-09-04 的标准 Dev 产品构建完成了 Harness Host/Client 与五个产品插件的重建，但当前执行沙箱禁止 Better Sidebar 媒体 Range 集成测试监听 `127.0.0.1`，4 项测试以 `listen EPERM` 终止，另外 543 项通过；流水线在 Electron 候选生成前按预期停止，因此没有产生或发布新的 Dev App，也没有执行隔离启动。本阶段不绕过门禁，不构建或安装 Stable；需在允许本地回环监听的环境中重新运行 `npm run product:dist:dev`。

## 12. 阶段 7：配置与诊断增强

本阶段可以拆成三个独立小项：插件在模型设置页注册 Provider 登录控件；模型发现复用 Profile headers 并提供搜索；DeepSeek 请求可选附带已启用插件的包名和版本。

插件版本上报默认只发送包名和版本，不发送本机路径、用户插件配置、工作区信息或 Profile 内容。设置扩展继续使用现有 `settings.section` 生命周期，不把 Better Sidebar 变成所有设置能力的所有者。

### 12.1 阶段 7 执行记录

阶段 7 保留现有模型设置区的所有权，并开放两个 root 作用域子槽位：按设置命名空间 keyed 的 provider-card seat，以及列表型 footer。Keyed owner share 只包含提供方目录中的配置事实，因此认证插件可以增加路由专属控件，无需读取模型页 store，也不把所有权转移给 Better Sidebar。模型发现现在支持按 id／显示名称进行不区分大小写的搜索；批量选择只影响可见结果，并保留隐藏项目的选择状态。

`llm-pi-ai` 在 Host 端询问模型端点时会复用已配置路由的 Profile header。表单 key 优先于已保存凭据；没有 key 时仍可保留 Profile authorization；JSON `Accept` 与 Harness 归因信息在 Profile 合并后应用。浏览器侧发现仍与 Profile header 隔离。

DeepSeek 适配器现在使用可叠加的请求扩展 Registry。扩展在 fetch 前准备，与原生字段冲突时 fail closed，快照会分离并冻结，取消信号可停止等待，确认事务只在 HTTP 2xx 后执行一次。基础 composition 注册可选的插件包清单，在 `dsh_plugin_packages` 下包含活跃且具有 package 身份的 Host 与常驻 preset entry，经稳定排序和去重后的名称／版本对。它排除本地路径、配置、工作区／Profile 数据、非活跃 entry、松散模块、URL entry 与 Cordis builtin。可以通过 inventory 插件的 `enabled` 选项关闭上报。

定向 TypeScript 构建通过；首轮不依赖网络监听的回归共 5 个文件、184 项通过，覆盖槽位分发、搜索语义、Registry 事务、取消、生命周期撤回、排序、去重和隐私边界；另有 4 项使用 fetch stub、不需要监听端口的发现测试通过。标准 Dev 产品构建已经重建完整 Harness Host／Client（包含两个新包）和五个产品插件，随后在产品测试门禁处因既有 Better Sidebar 媒体 Range 集成测试限制停止：沙箱拒绝 4 项测试监听 `127.0.0.1`，错误为 `EPERM`，其余 543 项通过。流水线在 Electron 候选生成前按预期停止，因此没有生成或发布新的 Dev App。同一监听限制也使当前环境无法完整运行 pi-ai 与 DeepSeek adapter 的 mock-server 测试。没有绕过任何门禁，本阶段不构建或安装 Stable。

## 13. 明确暂缓的架构迁移

### 13.1 `Session.events` 到索引 API

本地核心约 257 个文件仍引用旧事件访问方式，产品插件也存在直接依赖。该迁移需要先提供兼容适配器、自动化调用点清单和完整事件顺序测试，不能夹带在长会话优化中。

### 13.2 `ui-conversation` 到 `ui-chat`

Better Sidebar、File Edit、Message Edit 和 Workspace Lineage 都依赖当前 Conversation/Runtime/slot 体系。全量 UI 拆包必须先形成 slot 对照表，证明审核面板、引用、产物、消息编辑和空白会话外部视图都有新归属。

### 13.3 handle-based persistence 与 SQLite 移除

存储生命周期迁移和删除后端属于两项不同决策。完成阶段 1 的读取兼容不代表可以移除 SQLite，也不代表可以改变 Session 写入所有权。

### 13.4 Remote gateway 全迁移

本地插件 Host 路由、Client Runtime 和 Desktop loopback 启动均需联合审查。连接恢复可以在现有接口内完成，不以移除 ApiProxy 或改写全部远程调用为前提。

## 14. 每个能力的标准实施流程

1. 从已封存的本地基线创建独立分支或 worktree，命名包含能力而不是官方版本号。
2. 记录上游标签、提交范围、涉及包和上游测试，确认提交之间的真实依赖。
3. 写出本地必须保持的产品行为和插件接口，并先增加缺口测试。
4. 人工移植最小机制；遇到官方新架构依赖时，在本地现有接口后建立适配器，不顺带迁移无关架构。
5. 运行受影响核心包的 unit、typecheck、build 和关键 snapshot。
6. 运行所有被兼容矩阵标为中或高影响的产品插件测试。
7. 生成发行 Profile，执行必需插件 Host composition 与 Client bundle 装配验证。
8. 构建固定路径 Dev 候选，用全新临时 userData 验证首次启动，再用复制的合成旧数据验证升级启动。
9. 记录性能、数据迁移和 UI 回归结果；失败时回滚该能力提交，不回滚其他已通过能力。
10. 用户验证 Dev 候选后，才决定是否进入下一能力或构建 Stable 候选。

## 15. 验证矩阵

| 验证层 | 每阶段最低要求 |
| --- | --- |
| 静态检查 | 受影响 package typecheck、lint、`git diff --check` |
| 单元测试 | 新旧行为、失败、取消、重试、dispose/HMR 和迟到响应 |
| Session snapshot | 模型可见内容、历史重放、刷新与 Fork 结果一致 |
| 存储 fixture | 当前格式、受支持旧格式、截断、损坏、未知新版本、只读失败 |
| 插件测试 | 中/高影响插件的 build 与定向测试；禁止只测核心 |
| Profile Runtime | 五个产品插件真实 mounted/enabled，四个 Client bundle 进入启动清单 |
| Dev 首装 | 独立临时 userData，Runtime 解压、Profile 安装、后端启动和主界面加载 |
| Dev 升级 | 合成旧 userData，数据保留、缓存重建、插件升级和连接恢复 |
| 人工回归 | Explorer、Browser/Preview、文件审核、事务删除、引用、消息编辑、会话谱系 |
| 打包信息 | Dev/Stable 通道、版本、构建时间、Runtime/Profile ID 与 About App 一致 |

## 16. 停止与回滚条件

出现以下任一情况时停止当前能力，不继续叠加下一阶段：

- 主 Session 日志被修改、丢失、静默跳过或无法从备份恢复。
- Message Edit 创建重复 Fork、Workspace Lineage 父链变化或会话标题丢失。
- File Edit 审核账本被清空、归属到错误会话或在连接不确定时错误放行。
- Explorer 标记、非常用隐藏、Preview 标签或插件持久状态被错误迁移到动态 localhost localStorage。
- 用户消息即时显示或 `reasoning_content` 修复回归。
- Profile 只有包文件但 Host 未挂载或 Client bundle 未执行。
- Dev 与 Stable 输出、userData、Bundle ID 或 About App 通道信息混淆。

代码回滚只撤销当前能力的提交。数据测试始终在临时副本进行；不得通过删除真实 `DSH_HOME`、Session、Profile、审核账本或 Explorer 状态恢复测试环境。

## 17. 建议执行批次

| 批次 | 内容 | 预期交付 |
| --- | --- | --- |
| A | 阶段 0：本地修复与工作树归档 | 干净、可测试的产品基线，不打包 Stable |
| B | 阶段 1：存储兼容与 salvage | 数据迁移测试报告、Dev 候选 |
| C | 阶段 2：连接恢复与心跳 | 断线恢复测试报告、Dev 候选 |
| D | 阶段 3A/3B：长会话数据与渲染优化 | 性能对比、Dev 候选 |
| E | 阶段 3C：回合导航 | 长会话 UI 验收包 |
| F | 阶段 4：WebFetch SSRF 防护 | 安全测试报告；默认继续关闭 Fetch |
| G | 阶段 5：多模态与 Files API | 图文会话验收包 |
| H | 阶段 6/7：子代理、模型和诊断增强 | 分项 Dev 候选 |

第一轮建议只批准批次 A、B、C。三批完成并稳定后，再根据实际长会话性能数据决定批次 D/E 的实现深度。多模态是独立产品能力，不应与长会话或 Session 架构迁移同时开发。

## 18. 官方更新内容清单

本节记录从本地 `0.1.0-rc.5` 基线之后到官方 `dsh-v0.1.2-alpha.5` 的主要发布内容。它用于确定能力来源和依赖范围，不表示每项更新都适合本产品，也不替代实施前的提交级差异审查。

### 18.1 按官方版本整理

| 官方版本 | 主要更新 | 涉及的关键区域 | 本地判断 |
| --- | --- | --- | --- |
| [`dsh-v0.1.0-rc.7`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.7) | 插件设置卡片；Codex/Claude Code 子代理进入 Job Panel；MCP/ACP 持久图片；修复大历史分页栈溢出和 max-token 截断后无法继续；DeepSeek `low` 推理强度 | Settings、Subagent、Attachment、Session paging、LLM | 设置卡片和部分子代理指标本地已有；分页和截断修复需定向核对；图片链尚不完整 |
| [`dsh-v0.1.0-rc.8`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.8) | DeepSeek 原生图片；`/goal`、`/plan` 图文输入；`@` 文件与会话引用；子代理 Profile Bundle；reasoning 回传修复；大图治理；大历史 Fork 优化；SQLite 格式不兼容调整 | Attachment、LLM、Composer、Subagent、Session fork、SQLite | 本地 reasoning 修复更严格，不能覆盖；引用功能有深度定制；图片与 SQLite 不能只移植单个提交 |
| [`dsh-v0.1.1-rc.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.1-rc.1) | 发布视觉模型；修复 `@` 前编辑布局；修复 Bubblewrap `/proc/<pid>/root` 绕过；`ask_user_question` 多行输入 | LLM catalog、Composer、Linux sandbox、User Questions | macOS 产品不直接使用 Bubblewrap，但仓库 Linux 发行应补安全修复；输入改动会碰撞本地引用协议 |
| [`dsh-v0.1.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.1-rc.2) | DeepSeek Files API 优先上传与文件复用；按模型自动缩放和转换图片 | Attachment、Attachment Local、LLM DeepSeek | 属于完整多模态链的一部分，单独加入会产生可选图但无法可靠重放或发送的半成品状态 |
| [`dsh-v0.1.2-alpha.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.1) | 会话过程和系统提示词折叠；宽度、字号、token 详情和回合导航；运行中排队发送；图片立即回显；引用稳定；会话启动与加载优化；子代理模型选择；ACP 补齐；插件版本上报；Session 日志增量上传；Web token 鉴权；Remote gateway 取代 ApiProxy；会话 UI 大拆包；公网 WebFetch 与 SSRF 防护 | Client UI、Session、Attachment、Subagent、ACP、LLM、API、Web security、Profile | 这是最大架构分界点；可移植独立能力，但不能把整个版本作为升级补丁 |
| [`dsh-v0.1.2-alpha.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.2) | 连接异常提示、自动重试和立即重连；插件按会话/全局分组；Preset 查看搜索；长历史与实时消息优化；每轮 token/耗时详情；Node 24 修复；统一 RemoteError | Connection、Settings、Preset、Conversation、Remote gateway | 连接能力适合优先移植；本地已有统计能力，UI 不应重复；RemoteError 依赖网关迁移，需后置 |
| [`dsh-v0.1.2-alpha.3`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.3) | 全分页回合预览与跳转；长会话内存和代码高亮优化；排队图片可靠投递；无扩展名图片识别；卡顿误判断线修复；移除 SQLite Session 后端 | Turn outline、Paging、Rendering、Attachment、Connection、Persistence | 长会话能力应拆分移植；SQLite 移除会影响现有数据入口，明确暂缓 |
| [`dsh-v0.1.2-alpha.4`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.4) | 父子 Agent 通过 `send_message` 双向沟通；模型发现复用 Profile headers 和搜索；超长会话优化；`Session.events` 替换为索引读取 API；Session seq/log offset 强类型；更多 Profile 默认开启 `web_fetch` | Subagent、Model directory、Session API、WebFetch | 本地已有部分 `send_message`；Session API 替换会冲击核心约 257 个文件和多个插件；WebFetch 未通过安全验收前不得随默认配置开启 |
| [`dsh-v0.1.2-alpha.5`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.5) | Storage 和 Session projection cache 跨版本读取；损坏单元备份跳过；修复升级启动失败与会话标题丢失 | Storage、Projection cache、Upgrade recovery | 数据安全价值最高，适合作为第一批定向移植；仍不能连带引入 handle-based persistence |

### 18.2 按能力域整理

| 能力域 | 官方已经推进的内容 | 本地已有内容 | 本地缺口 | 粗暴引入的主要冲突 |
| --- | --- | --- | --- | --- |
| Session 存储 | 跨版本读取、per-record salvage、projection cache 重建、日志尾部修复提示 | JSONL、SQLite、本地 `readHistoryTail()` 和安全尾页缓存 | 官方格式 fixture 和完整跨版本恢复 | 新 reader/writer 与本地缓存规则混合后可能丢标题、拒绝启动或静默漏事件 |
| Client Session 架构 | Session Controller、深分页、索引读取、强类型 seq/offset、按需快照 | 旧 Client Runtime、Conversation assembler、插件可见 Session/Workspace 接口 | 新 indexed API 和 controller | 直接删除 `.events` 会造成大量编译失败；临时兼容不完整则产生顺序和分页错误 |
| 会话 UI | `ui-chat` 拆包、过程折叠、宽度和字号、回合导航、精确统计弹层 | 深度定制的 `ui-conversation`、统计条、引用、审核和产物 slot | 全日志导航和部分渲染优化 | 整目录覆盖会让审核面板、消息编辑、统一文件打开和引用入口消失或重复 |
| 消息提交 | 乐观回显、运行中排队、图片后台处理、steering 统一 | 本地文本消息即时显示和失败恢复 | 官方队列和图片路径 | 两套 optimistic echo 同时存在会产生重复消息、错误去重或刷新后位置变化 |
| LLM 推理历史 | 官方 reasoning 回传和 OpenAI 兼容修复 | 更严格的 DeepSeek 空思考字段规则、pi-ai 私有块对齐和错误残留恢复 | 需与新多模态序列化联合验证 | 覆盖本地序列化器可能重新触发 400，并让失败提示延续到下一轮 |
| 多模态 | 持久附件、Files API、图片复用、压缩转换、Vision catalog、Trajectory 和 compaction | pi-ai 模态声明、右栏本地图片 Preview | DeepSeek 端到端图片链 | 只复制 UI 或 adapter 会留下不可重放附件、跨 Provider 误复用和重试循环 |
| Connection | 心跳、generation、统一重连、stalled-host 容错、恢复提示 | 基础自动重连和部分 reconnect baseline | 完整状态机、心跳和统一 UI | 同时保留两套 reconnect owner 会产生重复订阅、重复基线和旧响应覆盖新状态 |
| Subagent | Job Panel、模型/Provider/推理参数、父子双向消息、图片跟进 | Job Panel 定制、`send_message`、`interrupt_agent`、文件审核归属 | 参数授权和行为等价性 | 替换生命周期会破坏 Better Sidebar 任务视图和 File Edit 的父会话审核归并 |
| Web 工具 | 公网 WebFetch 默认开启、SSRF 防护、更多 Profile 装配 | `web_search` 已装配，WebFetch Provider 存在但产品配置关闭 | 安全网络层 | 只同步默认配置会把未防护 Provider 暴露给模型，形成内网访问风险 |
| Settings 与模型目录 | 插件登录控件、插件分组、Preset 搜索、Profile headers 模型发现 | `settings.section` 和 About App 定制 | Provider 登录和模型搜索 | 全量替换 Settings UI 会丢 About App；只复制 UI 而不复制 Host 服务会出现空入口 |
| API 与 Profile | Remote gateway、统一 RemoteError、Web 一次性 token、统一 Profile 启动 | ApiProxy、Desktop loopback 后端、产品 Profile 生成与合并策略 | 新 Remote 接口与网络 Web 鉴权 | 直接移除 ApiProxy 会使 Client 和插件调用断裂；替换 Profile 会漏装产品插件或覆盖用户配置 |
| Sandbox 与终端 | Bubblewrap PID namespace、安全修复、PTY/PowerShell/Bash 稳定性 | macOS Seatbelt、Linux bwrap/Landlock、只读 Shell 门禁 | Linux Bubblewrap 修复和部分终端修复 | 对 macOS 影响有限，但发布 Linux 包时会保留已知绕过；整套替换可能削弱 File Edit 的严格 Shell 门禁 |

## 19. “粗暴更新”的定义与直接后果

这里的“粗暴更新”不是指改动量大，而是指没有保留本地行为基线、没有拆分能力依赖、没有经过插件兼容层和数据升级演练，就直接把官方版本放进源码或运行环境。

### 19.1 直接 merge 官方 `master` 或发布标签

- **会发生什么：** Git 会在 Client Runtime、Session、Persistence、LLM、Settings 和 Profile 等高改动区域产生大量文本冲突；自动合并成功的文件也可能存在语义冲突。
- **为什么危险：** 本地 153 个分叉提交和大量未提交产品改动并没有对应的上游 patch identity，Git 无法判断本地规则应保留还是由官方新架构取代。
- **可能结果：** 编译失败只是最容易发现的结果；更危险的是编译通过但消息、父链、审核归属或插件生命周期悄然变化。
- **受影响组件：** 五个产品插件、Harness 核心、Desktop Runtime 和 Profile 构建全链路。

### 19.2 整目录覆盖 `packages/client` 或引入完整 `ui-chat`

- **会发生什么：** 原有 `ui-conversation`、Client Runtime、Session/Workspace 状态和 slot 的导出位置改变或消失。
- **为什么危险：** Better Sidebar、File Edit、Message Edit 和 Workspace Lineage 都直接依赖这些接口，部分定制还挂在 Conversation 的具体投影和 turn-tail 生命周期上。
- **可能结果：** Explorer 仍能出现但文件入口失效；审核面板不显示；消息编辑按钮消失；产物退回官方打开方式；会话谱系无法重命名、排序或打开分支。
- **受影响组件：** Better Sidebar、File Edit、Message Edit、Workspace Lineage；Cowork 的工具卡与产物展示也可能退化。

### 19.3 只 cherry-pick 一个功能的叶子提交

- **会发生什么：** 叶子提交引用尚未移植的类型、Service、事件、配置键、生成目录或前序数据格式。
- **为什么危险：** 官方 `0.1.2` 的功能经常建立在 Session Controller、Remote gateway、附件持久化或 UI 拆包之上，提交标题无法表达全部依赖。
- **可能结果：** 明确的类型错误、运行时注入缺失、设置入口空白、事件能够写入但旧 reader 无法读取，或者测试只在官方完整 composition 中通过。
- **受影响组件：** 取决于能力；多模态、连接和长会话尤其不适合只取最终 UI 提交。

### 19.4 直接替换 `package.json`、lockfile 或整个包集合

- **会发生什么：** Workspace 解析、peer dependency、Client bundle 发现和 Node 原生依赖版本同时变化。
- **为什么危险：** 产品插件依赖 Runtime 内唯一 Harness 核心实例，并由固定 Profile manifest 和 fallback 解析保证 Cordis scope 不被拆成两份。
- **可能结果：** 包存在于 `node_modules`，但 Host 没有挂载或 Client 没有执行；另一类结果是两份 Cordis/Core 实例导致服务已经注册却无法从插件 context 取得。
- **受影响组件：** 全部产品插件、Profile Runtime 验证、Desktop 首次安装与替换升级。

### 19.5 用官方 Profile、Runtime 或 App 产物覆盖本地产物

- **会发生什么：** 官方组成不会自动包含五个产品插件、发行 patch、About App 元数据和 Desktop 的 Profile 合并逻辑。
- **为什么危险：** Runtime、Profile 和 `.app` 是产物平面，不能表达本地源码中的产品白名单、Client bundle 和用户 Profile 保留政策。
- **可能结果：** App 能启动但 Explorer、文件审核、消息编辑或 Cowork 消失；Stable Profile 被替换后还可能丢失用户额外插件与配置。
- **受影响组件：** Desktop、五个产品插件、用户 Profile、Dev/Stable 通道和 About App 构建信息。

### 19.6 直接让新 Runtime 打开真实 Stable 数据

- **会发生什么：** 新存储 reader、projection cache、Session event 支持集合和 SQLite 策略会首次作用于不可替代的真实数据。
- **为什么危险：** `rc.8` 已有不兼容 SQLite 格式，`alpha.3` 移除 SQLite，`alpha.5` 又专门修复跨版本启动和标题丢失，说明该路径不能假定天然兼容。
- **可能结果：** 启动失败、会话列表缺标题、旧分支不可见、缓存被错误视为主数据、SQLite 会话无法进入或升级后无法安全回退旧版本。
- **受影响组件：** Session、Message Edit、Workspace Lineage、Cowork 历史、所有依赖旧会话的用户工作。

## 20. 粗暴全量更新的故障传播链

一次粗暴全量更新通常不会只造成一个 UI 问题，而会沿以下顺序传播：

1. 包和 API 变化首先使部分插件无法解析、注入或注册。
2. 能够加载的插件开始消费新 Session/Workspace 状态，但仍按旧事件顺序和生命周期判断。
3. Client 与 Host 对消息、Fork、审核或队列状态产生不同理解，界面出现重复、缺失或陈旧状态。
4. 新 Persistence 或 projection cache 把这种不一致跨重启保存，问题从临时显示错误变成数据恢复错误。
5. Profile 或 Runtime 若同时被替换，诊断时会出现源码、构建产物、用户 Profile 和当前进程四者版本不一致。
6. 如果直接生成 Stable 包并覆盖安装，回滚代码也不能自动恢复已经被新格式读取、迁移或遗漏的数据。

| 插件或系统 | 最可能出现的表面问题 | 更深层后果 |
| --- | --- | --- |
| Better Sidebar | Explorer、Browser/Preview 或设置入口缺失 | 统一文件打开被绕过，产物和外部文件回到错误路由，布局状态被旧响应覆盖 |
| File Edit | 审核面板、删除墓碑或引用入口不显示 | 修改归属错误、拒绝恢复覆盖新内容、严格 Shell 门禁未挂载，属于数据与安全回归 |
| Message Edit | 编辑、reroll、retry 失败或按钮消失 | 重复创建 Fork、父链断裂、版本事件无法读取，旧分支可能从会话树消失 |
| Workspace Lineage | 会话排序、重命名或两级树异常 | 标题和父链恢复错误，迟到快照覆盖当前选择，用户误以为会话丢失 |
| Cowork | 工具卡或产物不显示，长任务状态卡住 | 工具事件无法回放、任务重复结算、Office/Notebook 产物无法通过统一文件路由打开 |
| Desktop/Profile | App 启动但功能不完整，Dev/Stable 信息混淆 | 错误通道使用错误 userData，产品插件漏装，用户 Profile 或额外插件被覆盖 |
| LLM/Session | 消息重复、历史错误残留、图片发送失败 | `reasoning_content` 400 复发、模型上下文与界面不一致、刷新后消息数量变化 |
| Storage | 启动慢、标题缺失或会话打不开 | 数据被错误跳过、无法回退旧版本，甚至把缓存缺失误判为主日志损坏 |

## 21. 允许扩大升级范围的前置条件

只有同时满足以下条件，才可以评估从“能力移植”扩大为“架构升级”；满足条件也不等于可以直接覆盖 Stable App：

1. 阶段 0、1、2 已完成，消息即时显示、思考历史、存储 salvage 和连接恢复均有稳定测试。
2. 当前工作树已按功能拆分，不再有来源不明或跨能力混合的改动。
3. 已生成旧接口到新接口的机器可读调用点清单，覆盖核心和五个产品插件。
4. 已建立 `Session.events`、Session/Workspace Client Runtime、Conversation slot 和 ApiProxy/Remote 的兼容适配方案。
5. 合成旧数据可以在新 Runtime 启动、读取、回退，并保持标题、父链、事件数量和审核状态不变。
6. 五个产品插件均通过 Host composition、Client bundle、定向测试和真实 Dev UI 回归。
7. 新 Profile 从仓库发行清单生成，能够升级安装并保留用户配置与额外插件。
8. 只构建独立 Dev 候选；用户完成实际验证后，再单独决定 Stable 候选和安装。
