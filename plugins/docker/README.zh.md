# dsh-docker

DSH 的类型化、带防护的容器控制 —— 结构化 Docker 访问，很难被误操作毁掉。

`dsh-docker` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件 bundle。它通过 DSH 的 `ctx.shell` 接缝包装 `docker` CLI，给 Agent 一个**类型化、项目感知、带防护**的容器与 compose 栈操作面 —— 每个工具都返回结构化 JSON（`await tools.docker_ps(...)` 拿到的是真实对象，而不是抓取的散文），破坏性操作必须经过**人工审批门**，而 `stop dev-api` 指的是*你本地*的 compose 服务，而不是机器上恰好同名的容器。

```
┌──────────────┐   docker ps --format json    ┌──────────────┐
│  agent 工具   │ ───────────────────────────▶ │  ctx.shell   │ ──▶ docker CLI
│  调用         │                             │  (沙箱/远程)  │
└──────┬───────┘                             └──────────────┘
       │ classify()                           
       ▼
┌──────────────┐   破坏性？    ┌──────────────────────┐
│ pre-execute  │ ───────────▶ │ 审批门                │ allowed-once → 执行
│ 策略          │  (guarded)   │ (ctx.approval,        │ rejected/unavailable
└──────┬───────┘              │  默认关闭 = 拒绝)      │ → 拒绝
       │ safe / 记录 token    └──────────────────────┘
       ▼
┌──────────────┐   高破坏性且无 token？→ 拒绝（单调）
│ ctx.tools    │
│ .guard()     │   兜底：后来的监听器无法撤销拒绝
└──────────────┘
```

## 旗舰示例 —— 调试失败的集成测试

Agent 调试一个跑不过 `docker-compose.yml` 的测试：

```
$ docker_ps            → { containers: [{ name: "app-api-1", state: "running", ... }] }
$ docker_logs { container: "app-api-1", tail: 200 }
  → { lines: [...], truncated: true }        # 有上限的拉取永远不会被当成完整
$ docker_compose_ps   → { project: "app", services: [{ name: "db", state: "running" }] }
```

Agent 可以**自由读取**。一旦它想做破坏性操作 —— 对运行中的 API 容器 `docker_rm -f`、删除仍有容器引用的镜像、`docker system prune -a`、或 `docker compose down -v` —— 调用会被暂停并转给人工审批门：

```
⏸ docker_rmi "app-api:latest" — image in use by container app-api-1
   [approve]  [reject]
```

没有审批通道，或请求被拒绝？操作被**拒绝**。`execReadOnly` 默认开启，因此不带 `write`/`interactive` 的 `docker_exec` 从不弹审批，而带写标记的 exec 视同破坏性。即使别的插件的策略说了「allow」，单调兜底 guard 仍然会拒绝高破坏性集合，除非本次调用带有 dsh-docker 的审批 token。

## 安装

```console
# 发布到 npm 之后，或直接从本仓库安装：
dsh plugin --profile web add @dsh-docker/bundle          # npm（发布后）
dsh plugin --profile web add github:Jesse-njx/dsh-docker  # 或：直接 GitHub
```

装到你的 Agent 运行所在的 profile 即可（桌面 UI 用 `web`，CLI 会话用 `headless`）。bundle 会挂载工具、策略、可选的健康上下文和 Web 状态渲染器。

## 工具

每个工具都是带类型参数与结构化输出 schema 的 `defineTool` —— Code Mode 里 `await tools.<name>(...)` 返回规范 JSON 值，而不是渲染后的散文。

### 容器

| 工具 | 输出 | 说明 |
| --- | --- | --- |
| `docker_ps` | `{ containers: [{ id, name, image, state, status, ports[], project?, service? }] }` | `--all` 标志；默认按检测到的 compose 项目过滤 |
| `docker_logs` | `{ lines: string[], truncated }` | 有上限的拉取（`tail`，默认 200，上限 5000）；拉 `tail+1` 行让 `truncated` 诚实 |
| `docker_inspect` | 引擎原始 JSON（开放对象） | 适配器 —— 引擎原生结构，经过校验 |
| `docker_exec` | `{ exitCode, stdout, stderr }` | 默认只读（无 TTY）；`write`/`interactive` 进入审批桶 |
| `docker_start` / `docker_stop` / `docker_restart` | `{ affected: string[] }` | 一个引用，或不给引用时作用于整个检测到的项目 |
| `docker_rm` | `{ affected: string[] }` | 目标**运行中**或设置 `force` 时**受保护** |

### 镜像

| 工具 | 输出 | 说明 |
| --- | --- | --- |
| `docker_images` | `{ images: [{ id, repository, tag, size, inUse }] }` | `inUse` 来自 `docker ps -a` 交叉引用 |
| `docker_rmi` | `{ removed: string[] }` | 镜像**使用中**时**受保护** |
| `docker_prune` | `{ scope, all, volumes, ok }` | `--all`、`--volumes` 或 system 范围**受保护** |

### Compose

| 工具 | 输出 | 说明 |
| --- | --- | --- |
| `docker_compose_up` | `{ project, services, detached }` | 默认 detached；可选 `services[]` |
| `docker_compose_down` | `{ project, affected, volumes }` | `volumes: true`（`-v` 标志）时**受保护** |
| `docker_compose_ps` | `{ project, services: [{ name, id, state, status, ports }] }` | 一次读取即可构建健康上下文 |

## 项目感知定位

每个工具每次调用解析一次 compose 项目（纯函数、可单测的 `ProjectResolver`）：

1. 从工具工作目录向上找第一个 `composeFiles` 匹配项（`docker-compose.yml`、`compose.yaml`，按配置顺序）。
2. 推导项目名（目录基名小写），每个 compose 调用都带 `-p <project> -f <file>`；`docker_ps`/`start`/`stop` 默认过滤到 `--filter label=com.docker.compose.project=<project>`。
3. 每个工具接受显式 `project: string` 覆盖；既没有 compose 文件也没有覆盖时，容器级工具全局生效，但项目感知行为关闭。

裸容器名先按项目内解析，只有无歧义时才回退到全局匹配。歧义引用返回列出候选的错误，而不是猜。

## 防护

两层，都在工具管线里：

- **`tools/pre-execute` 策略** —— `classify(toolName, args, resolved)`（纯函数，无守护进程即可单测）判断每次调用的预期效果。受保护操作通过 `ctx.approval`（`approval/request` waterfall）发起一次性审批请求；没有审批则**默认关闭**为 `unavailable` ⇒ 拒绝。不在配置 `approval` globs 覆盖范围内的受保护操作直接拒绝。
- **`ctx.tools.guard()` 兜底** —— 单调拒绝，后来的监听器无法撤销。即使别的插件的 pre-execute 说了「allow」，guard 仍会拒绝高破坏性集合，除非本次调用带有 dsh-docker 审批 token。

只读 `docker_exec` 默认免费；`execReadOnly: false` 为愿意承担风险的运维人员翻转该默认。

## 服务健康上下文（可选）

```yaml
plugins:
  dsh-docker:
    healthContext: { enabled: true, maxServices: 12 }
```

开启后，每个 pre-step 会为检测到的每个 compose 服务注入一行紧凑状态 —— `dev-api ▲up  dev-db ▲up  worker ▼exited(1)` —— 作为**下一次**模型请求看到的持久追加上下文（不是唤醒）。由单次 `docker_compose_ps` 读取构建，带 TTL 缓存，上限 `maxServices`，检测不到 compose 项目时完全跳过。

## 状态渲染器（Web 客户端）

客户端半区为 `docker_ps` / `docker_compose_ps` / `docker_logs` 的输出注册一个可回放会话节点：每个工具调用一个稳定节点（按 `callId` 键控），**默认折叠**、点击展开的表格，日志面板会显示 `truncated` 标志，让有上限的拉取永远不会被当成完整。回放安全：渲染器只消费持久化的 `tool/result` 展示元数据，绝不读取执行期局部值。

## 配置

```yaml
plugins:
  dsh-docker:
    enabled: true
    composeFiles: [docker-compose.yml, compose.yaml]
    approval: ["rmi:*", "rm:*", "prune:*", "compose down -v", "exec:*"]
    execReadOnly: true
    timeoutMs: 30000
    healthContext: { enabled: false, maxServices: 12 }
```

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `composeFiles` | `[docker-compose.yml, compose.yaml]` | 按配置顺序的发现列表 |
| `approval` | `["rmi:*", "rm:*", "prune:*", "compose down -v", "exec:*"]` | 转给审批门的操作（`*` 匹配任意参数；`compose down -v` 只匹配删卷的 down） |
| `execReadOnly` | `true` | `false` 时 `docker_exec` 不设闸 |
| `timeoutMs` | `30000` | 单次 docker 调用超时 |
| `healthContext.enabled` | `false` | 每步注入每服务健康行 |
| `healthContext.maxServices` | `12` | 健康行上限（超出显示 `+ N more`） |

同一 schema 会注册为 `dsh-docker` 用户设置区，实时编辑即刻生效于下一次工具调用。

## v0.1 非目标

Docker context / 远程主机管理 UI；用任何 DSL 从 Dockerfile 构建镜像（原生 `docker build` 透传可以 —— 不做包装）；swarm / k8s；超出 `docker inspect` 的容器运行时内省；日志流式 / follow；registry 认证流程。这些都是 v0.2+ 的问题，不是一个配置开关能解决的。

## 测试

- **单元（无守护进程）：** 每个工具的参数 schema 接受/拒绝；`ProjectResolver` fixtures（compose 文件发现、项目名推导、歧义引用处理）；`classify()` 策略矩阵 —— 每个破坏性操作断言 `guarded`、每个安全操作断言 `safe`、`execReadOnly` 开关翻转 `docker_exec`；审批 glob 匹配器。
- **Guard（无守护进程）：** 始终拒绝的 mock 审批门 —— `rmi` 使用中、`rm` 运行中、`prune --all`、`compose down -v`、写标记 `exec` 均被**拒绝**；始终批准的 mock —— 它们**恰好执行一次**；其他监听器的抢先「allow」会被兜底拒绝。
- **集成（特性检测）：** 探测活守护进程（`docker version`），存在时用 mock 审批门对极简 alpine `sleep` 栈执行 `compose up`/`ps`/`down` —— 类型化行与真实情况一致，且 `down -v` 需要审批。没有守护进程时**干净跳过**（标记为 skipped 而非 failed）。

```sh
pnpm install
pnpm typecheck && pnpm build && pnpm test
```

## Model Experience

### Request context and condition

#### What the model sees

14 个工具 schema（名称、描述、参数）经工具注册表流入系统提示组装，与其它已注册工具完全一致；本包不拥有额外的固定提示散文。当 `healthContext.enabled` 开启且 Agent 工作目录检测到 compose 项目时，每个 pre-step 会注入一条 `source: { kind: 'plugin', plugin: 'dsh-docker' }` 用户消息：

```markdown
[dsh-docker] <project> services: dev-api ▲up  dev-db ▲up  worker ▼exited(1)
```

#### Token effect

工具 schema 是注册表拥有的固定提示 token。健康行是有条件的：上限为 `maxServices` 行加 `+N more` 尾部，仅在功能开启且检测到 compose 项目时出现。

#### KV Cache effect

追加式：每步追加一条新健康消息，下一步请求消费后即丢弃；消息文本依赖数据（服务状态会变），因此保留稳定前缀，但服务状态一变尾部就会失效复用。包内会导致复用的失效变更：运行时没有 —— 重新安装/升级 bundle 会改变 schema，属于正常的依赖变更失效。

## Known Limitations and Deferred Work

- **`docker_ps`/`docker_compose_ps` 需要 docker CLI 支持 `--format json`**（`ps` 需要 Docker ≥ 25，compose `ps` 需要 compose v2）。更老的 CLI 会给出清晰错误而不是抓取文本；ps `Labels` 字段缺失时，`docker inspect` 批量查询是适配器。
- **失败的工具调用不渲染状态表** —— `presentationMeta` 只从成功的规范值计算，因此失败的 `docker_ps` 显示标准错误卡片而非表格。持久日志按设计不携带规范值。
- **`docker_prune` 无法在不抓取散文的情况下报告引擎回收了多少**；规范输出携带请求与成功，引擎的「reclaimed space」行只出现在渲染文本里。
- **`docker_exec --interactive` 输出可能带 TTY 修饰**（CRLF/ANSI）；规范值原样返回，不做清洗。
