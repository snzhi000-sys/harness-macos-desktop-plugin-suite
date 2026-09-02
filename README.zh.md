# Harness macOS Desktop & Plugin Suite

[主文档](README.md) | 中文镜像

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 二次开发的 macOS 桌面 App 与产品插件套件。本项目保留 Harness 的 Cordis 插件架构和 Agent 能力，在统一工程中维护 Electron 桌面封装、必要的 Harness Web 定制、五个产品插件以及可复现的 Dev/Stable 打包流程。

> 本项目是社区第三方项目，并非 DeepSeek 官方产品。当前 `release/open-source-v1` 是公开审查候选分支，不是已签名、公证或可直接发行的正式版本；上游 Harness 仍处于开发者预览阶段，后续更新可能包含兼容性破坏性变更。

## 产品特色

### macOS 桌面体验

- 使用 Electron 将 Harness Runtime、Web 后端和产品 Profile 封装为独立 macOS App，启动时自动拉起本机回环地址上的 Harness Web 服务。
- 正式界面采用会话列表、Explorer 文件树和对话主面板三栏布局，支持亮色与暗黑主题。
- 启动页使用与三栏结构一致的简洁骨架占位，跟随上次主题并在主界面就绪后平滑淡出。
- Dev 与 Stable 使用不同的 App 标识和用户数据目录。重新打包会复用各自通道已有的模型 Key、设置和偏好，但这些数据始终保存在 App 外部，不会写入源码或发行包。
- “关于 Harness App”显示构建时写入的版本号、构建时间和 Dev/Stable 通道，便于区分测试包与正式候选包。

### 更适合 Agent 工作流的 Explorer

- Explorer 以工作区为单位缓存已加载目录；同一工作区切换不同会话时直接复用文件树，同时保留定时刷新以发现 AI、Finder 或其他进程产生的变化。
- 文件和文件夹都能拖入其他目录，也能移回工作区根目录；Host 会再次检查工作区边界、符号链接、循环移动和同名冲突。
- 文件或文件夹可绑定 Emoji 快捷标记，点击标记即可展开、定位并打开对应路径，标记在 App 重启后继续保留。
- 可将不常用文件或文件夹标记为“非常用”，通过眼睛按钮统一隐藏或显示；标记和隐藏开关都会跨重启持久化。
- 右键菜单提供引用、复制路径、在访达中显示等常用操作。

### 统一的文件打开与多标签预览

- 代码、普通文本和 Markdown 进入顶部“文件”视图，支持多标签、CodeMirror 编辑、Markdown 渲染以及“关闭所有文件 / 关闭已处理文件”。
- 工作区外的普通文本产物也能通过受限的 opaque ID 在“文件”中只读打开，不会因此获得保存或编辑权限。
- 网页、图片、PDF、DOCX、XLSX、PPTX 和视频共享右侧 Browser/Preview 标签栏，可切换、关闭、拖动排序并按会话恢复标签状态。
- MP4、M4V、WebM、MOV 和 OGV 使用 HTTP Range 流式读取，不把完整视频载入 Node 内存；播放器提供播放、暂停、进度、缓冲、音量、倍速、全屏、画中画和局部键盘控制。
- 切换视频标签、收起右栏或切换会话会自动暂停；不支持的容器或编码会显示明确错误，并提供系统播放器和下载兜底。

### 输入框文件引用

- Explorer 右键引用、文件视图选区引用和其他统一入口会生成结构化文件引用。
- 引用在 Harness 原生输入框中显示为紧凑气泡，模型仍能收到可从会话日志重建的完整引用内容。
- 引用气泡与原生文本输入共用同一套 occurrence/draft 机制，不牺牲 Shift+Enter、中文输入法、撤销、删除、光标移动或长文本滚动体验。

### 面向人类审核的文件变更

- AI 通过 `write`、`edit`、`file_move` 和 `file_delete` 产生的新增、修改、移动和删除会直接写入当前会话审核账本，不依赖扫描整个工作区。
- 工作区内外的 AI 文件变化都能进入待审核列表；工作区外条目只以 Host 签发的审核 ID 执行接受或拒绝，界面中的绝对路径仅用于展示。
- 文件视图提供易读的行级 Diff、语法高亮、逐块或整文件接受/拒绝、批量操作和拒绝撤销。
- AI 删除文件或目录前，内容会先进入持久隔离区并生成删除墓碑。目录删除按一个批次展示，可展开查看所有子文件、整批接受，或完整恢复目录结构和内容。
- 被 AI 删除的文本文件仍可从审核入口只读查看删除前快照，文件标签使用红色删除线表达删除状态。
- 可写 Shell 工具受到严格门禁；AI 删除必须经过结构化 `file_delete`，确保删除前已有可恢复副本并进入审核流程。

### 会话编辑与谱系

- Message Edit 支持编辑历史消息、重生成最后回复、重试任意回合以及 truncate/preserve 两种级联策略。
- 每次编辑或重试都会创建真实的新会话版本，不原地改写 append-only 会话日志；原分支仍可访问。
- Workspace Lineage 将工作区与会话组织成两级谱系树，支持父会话、分支会话重命名、最近更新排序和自定义分支标题持久化。

### Office 与 Notebook 能力

- Cowork 为 Agent 提供 XLSX、PDF、DOCX、PPTX 和 Jupyter Notebook 的结构化读取能力。
- XLSX 与 Notebook 支持按单元格或 Cell 定位的创建和编辑；PDF、DOCX 和 PPTX 可按页面、段落或幻灯片读取。
- Office 的 Agent 工具能力与右侧只读 Preview 分离：前者为模型提供结构化内容，后者为用户提供视觉浏览。

## 架构

```mermaid
flowchart TD
  A[macOS Electron App] --> B[内置 Node 与 Harness Runtime]
  A --> C[通道独立的 userData]
  B --> D[dsh web · 127.0.0.1 动态端口]
  D --> E[Harness Web Renderer]
  D --> F[Cordis Host 插件]
  E --> G[Harness Client Packages]
  E --> H[产品插件 Client Bundles]
  F <-->|同源 HTTP / WebSocket / Harness RPC| H
  I[发行 Profile] --> F
  I --> H
  C --> J[Key · 设置 · 会话 · 审核账本 · 插件状态]
```

架构分为四个协作层：

1. **Electron Desktop**：负责窗口、主题启动占位、Runtime/Profile bootstrap、通道隔离和本地后端生命周期。
2. **Harness Runtime**：基于上游 Harness 源码构建，提供 Agent、Session、模型、工具、凭据和 Web UI 基础设施。
3. **Product Profile**：由仓库内白名单生成，决定哪些 Cordis Host 插件和 Client bundle 随 App 装配；构建不会读取已安装 Stable Profile 作为模板。
4. **Product Plugins**：Host 负责文件系统、持久化和本地 HTTP 路由，Client 负责 React UI、标签、文件预览和交互。两端只通过明确的 JSON、HTTP、WebSocket 或 Harness 服务契约通信。

Electron Renderer 不直接获得 Node 文件系统权限。文件读取、审核、媒体 Range 和 Explorer 操作都由 Host 校验会话、路径与权限后执行；App 内 Runtime、Profile 和 `.app` 是可重建产物，不是源码维护入口。

## 产品插件与定制

发行 Profile 固定装配以下产品插件：

| 插件 | 来源 | 本项目中的职责与定制 |
| --- | --- | --- |
| [`dsh-better-sidebar`](plugins/better-sidebar/README.md) | 基于 [DSH Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 持续定制 | 三栏布局、Explorer 缓存与拖动、Emoji/非常用标记、统一文件路由、Browser/Preview 共用多标签、图片/PDF/Office/视频预览、视频 Range 流式播放、关于页面 |
| [`dsh-file-edit`](plugins/file-edit/README.md) | 基于社区 File Edit 插件持续定制 | 顶部文件标签、代码与 Markdown、引用协议、事件驱动审核、工作区外审核与只读浏览、事务化文件/目录删除、隔离恢复、删除墓碑、严格删除门禁 |
| [`dsh-message-edit`](plugins/message-edit/README.md) | 基于 [DSH Message Edit](https://github.com/Moeblack/dsh-message-edit) 定制 | 消息编辑、Reroll、Retry、真实会话 Fork、版本事件、撤销/重做与 Timeline |
| [`dsh-workspace-lineage`](plugins/workspace-lineage/package.json) | 项目维护的 Workspace Browser 分支 | 工作区两级会话树、父子谱系、分支名称持久化、重命名、最近更新与手动排序 |
| [`@dsh-cowork/plugin`](plugins/cowork/README.md) | 集成并定制 [DSH Cowork](https://github.com/Jesse-njx/dsh-cowork) | Office/Notebook 结构化读写工具及其 Host 装配 |

引用气泡、原生输入稳定性和冷会话首屏等跨插件能力位于 Harness Web 核心包；插件局部能力继续留在各自目录。产品组成的机器可读真源是 [`distribution/profile-manifest.json`](distribution/profile-manifest.json) 与 [`distribution/cordis.patch.yml`](distribution/cordis.patch.yml)。

## 工程目录

```text
desktop/       Electron macOS 桌面壳、打包、安装和发行验证
distribution/  产品插件白名单与 Cordis composition patch
plugins/       Better Sidebar、File Edit、Message Edit、Workspace Lineage、Cowork
packages/      DeepSeek Harness 核心与本项目必要的 Web 定制
vendor/        随 Harness 源码维护的 Cordis 及基础库
scripts/       Harness 与产品级构建、测试、文档和隐私检查
docs/          架构、开发、迁移和维护资料
```

统一工程中的 `src/` 与可维护源码是 source plane；`lib/`、`dist/`、`.artifacts/`、Profile、Runtime 和 `.app` 属于 artifact plane。开发只修改前者，不从已安装 App 或用户 Profile 反向覆盖源码。

<a id="run"></a><a id="run-from-source"></a>

## 本地开发

### 环境

- macOS Apple Silicon；当前桌面构建目标为 arm64。
- Node.js `^22.19.0` 或 `>=24.0.0`。
- pnpm `11.7.0`。

```bash
pnpm install
```

### 插件开发与验证

```bash
npm run product:build:plugins
npm run product:test:plugins
npm run product:test:desktop
npm run product:verify:privacy
npm run product:verify:profile-runtime
```

`product:verify:privacy` 会检查已跟踪文件和未被忽略的未跟踪文件；`product:verify:profile-runtime` 会在隔离环境验证五个产品插件的 Host composition、Client 启动清单和空白会话创建主链路。

修改单个插件时应先运行该插件 `package.json` 声明的定向 build/test，再执行上述产品装配检查。用户可见功能还需要在测试工作区和测试会话中做真实回归，不能只以 bundle 存在或后端 ready 作为验收结论。

### 构建 Dev App

```bash
npm run product:dist:dev
```

产物位于：

```text
desktop/dist/dev/mac-arm64/DeepSeek Harness Dev.app
```

Dev 使用独立的 Bundle ID 和 `DeepSeek Harness Dev` userData。产品打包脚本会重建全部产品插件，在固定 `.candidate-dev` 目录生成候选，核验 Dev 身份、版本、构建时间、包内功能标记、签名和隐私，再以 `--user-data-dir=<临时绝对路径>` 自动完成不迁移凭据的干净启动；全部通过后才覆盖固定 `dist/dev` 输出。日常启动发布后的 Dev 会继续使用 Dev 自己的 Key、设置和工作区偏好，不会读取或覆盖 Stable 数据。

### 构建 Stable 候选

只有 Dev 自动化、独立 userData 启动和真实功能回归通过后，才构建 Stable 候选：

```bash
npm run product:dist:stable
```

产物位于：

```text
desktop/dist/stable/mac-arm64/DeepSeek Harness.app
```

Stable 复用同一产品打包脚本并使用固定 `.candidate-stable` 暂存目录，执行插件重建、桌面测试、源码隐私检查、Runtime/Profile 构建、五插件运行装配、包身份与功能标记、隔离启动及发行包解包扫描，并写入新的版本、构建时间与 `stable` 通道。全部通过后只覆盖固定 `dist/stable`；构建候选不会安装或替换 `/Applications/DeepSeek Harness.app`。

本地维护者需要安装 Stable 候选时，必须先确认没有正在运行的 Agent 任务，保留回滚点，再显式运行桌面安装流程。安装器会优先把现有 App 保存为 `DeepSeek Harness.previous.app`，但不会复制、清空或迁移 Stable userData，因此模型 Key、会话、审核账本、Explorer 状态和其他用户配置仍保留在 App 外部。

## 隐私与发行安全

- Profile 只从 [`distribution/profile-manifest.json`](distribution/profile-manifest.json) 的产品白名单生成，不复制本机已安装 Profile、第三方个人插件或用户配置。
- 源码与发行包隐私检查拒绝凭据文件、私钥、数据库、会话、日志、个人主目录路径和绝对软链接。
- `.env`、`.credentials.yaml`、`settings.yaml`、sessions、storages、Mnemon、审核隔离区、userData、Runtime 和构建产物均不进入 Git。
- Dev 与 Stable 的配置继承依靠系统用户数据目录，而不是把 Key 或个人文件打进 `.app`。
- 公开发布前仍需检查完整 Git 历史、第三方许可证、Developer ID 签名、Apple 公证、Gatekeeper、DMG/ZIP 和 checksums。

详细迁移边界见[统一工程迁移执行计划](docs/MIGRATION_PLAN.zh-CN.md)，当前验证事实与未完成项见[迁移状态](docs/migration/STATUS.zh-CN.md)。

## 当前公开发行状态

本分支用于审查可公开源码快照。以下事项关闭前，不应将 Stable `.app` 标记为正式公开发行版：

- File Edit、Message Edit 和 Workspace Lineage 的独立来源与许可证授权仍需完成确认。
- Message Edit 当前包含可运行 Host/Client 快照，但缺少完整的 Host TypeScript 可复现维护源和历史构建链。
- 当前本地候选只使用 ad-hoc 签名，尚未完成 Developer ID 签名、Apple 公证与 Gatekeeper 发行验证。
- 公开安装包仍需完整 UI 回归、发行归档、校验和与组件许可证清单。

## 上游 Harness

DeepSeek Harness (`dsh`) 是 DeepSeek AI 开发的开源 Agent Harness，采用“一切皆插件”的 Cordis 架构。上游资料：

- [DeepSeek Harness 仓库](https://github.com/deepseek-ai/deepseek-harness)
- [本仓库开发指南](docs/development.md)
- [本仓库架构文档](docs/architecture.md)
- [贡献指南](CONTRIBUTING.md)

## License

仓库根源码沿用 [MIT License](LICENSE)，第三方依赖及许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。产品插件仍分别受其来源许可证和授权约束；当前公开审查分支中的许可证待确认项以上一节为准。
