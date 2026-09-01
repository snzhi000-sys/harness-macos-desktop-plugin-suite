# Harness macOS 桌面端与插件套件统一工程迁移执行计划

> 执行状态：截至 2026-09-01，阶段 0–5 的源码迁移、统一构建和自动化测试已完成；阶段 6 已完成隔离 Dev App 构建、首次启动、干净 Profile 安装和主界面加载验证；阶段 7 已完成未安装的 Stable `.app` 候选构建、签名与隐私检查。完整产品交互回归、许可证缺口、Message Edit 可复现源码、Developer ID 签名、公证及公开发布仍未完成。当前事实以 [迁移状态](migration/STATUS.zh-CN.md) 为准。

## 1. 文档目的

本文规划将当前分散维护的 Harness 核心定制、Electron macOS 桌面端和产品插件迁移到 `harness-macos-desktop-plugin-suite` 单一工程仓库，并建立可重复的开发、测试、Dev App 打包、Stable App 打包和后续迭代流程。

本文定义实施顺序、保护边界、测试矩阵、验收条件和回滚条件。迁移的实际执行结果单独记录在迁移状态文档中；本轮没有安装 App、修改真实 Stable profile 或推送 GitHub。

为避免把开发者用户名和本机目录写入公开仓库，文中使用以下逻辑名称：

| 名称 | 含义 |
| --- | --- |
| `SUITE_ROOT` | `harness-macos-desktop-plugin-suite` 统一工程根目录 |
| `LEGACY_ROOT` | 当前分散存放 Harness 和插件源码的本机工作区根目录 |
| `STABLE_USER_DATA` | 当前日常使用 Stable App 的 Electron 用户数据目录 |
| `DEV_USER_DATA` | 新统一工程 Dev App 的独立或临时 Electron 用户数据目录 |
| `STABLE_DSH_HOME` | Stable App 使用的 Harness 数据根 |
| `DEV_DSH_HOME` | Dev App 使用的独立或临时 Harness 数据根 |

任何面向公开仓库的脚本、文档和配置都不得硬编码真实用户名、主目录或 `LEGACY_ROOT`。

## 2. 总体结论与执行原则

统一维护具有可行性，推荐采用单仓库模式：Harness 上游源码位于仓库根层级，Electron 桌面端继续位于 `desktop/`，产品插件统一位于 `plugins/`，发行组成位于 `distribution/`。后续产品功能允许在一个提交中同时修改 Harness 公共契约、插件 Host/Client、desktop 和测试。

迁移必须遵循以下原则：

1. **不覆盖现有运行环境。** 迁移期不替换当前 Stable App，不修改真实 Stable profile，不清除用户数据。
2. **先冻结证据，再移动源码。** 当前源仓库存在大量未提交修改和构建产物，禁止直接整目录复制或一次性 `git add -A`。
3. **源码单向生成产物。** 统一仓库是迁移后的唯一维护源；profile、runtime、`.app`、DMG 和 ZIP 只能由源码生成，不能反向覆盖源码。
4. **先 Dev 后 Stable。** 新仓库先构建完全独立的 Dev App；只有迁移测试和 Dev 实测通过后才构建 Stable 候选。
5. **Skill 最后切换。** Harness Skill 只有在新工程被证明可构建、可运行、可部署后才改写权威路径。
6. **不把个人 profile 当发行模板。** 开发 profile 和发行 profile 都从仓库内固定清单生成。
7. **每阶段可回滚。** 旧源码目录在至少两个成功发布周期内只读保留，不在迁移中删除。
8. **每阶段单独授权。** 计划阶段结束后，进入任何会移动源码、修改 Git 历史、构建 App、启动测试 App、改 Skill 或推送远程的阶段前，重新确认范围。

## 3. 当前情况基线

### 3.1 目标仓库

当前 `SUITE_ROOT` 已存在：

- Git 分支：`main`。
- 远程：`snzhi000-sys/harness-macos-desktop-plugin-suite`。
- 当前提交：`992e729 Initial commit`。
- 当前工作树：干净。
- 当前内容：README、MIT LICENSE、通用 `.gitignore`。
- 尚未导入 Harness、desktop 或任何产品插件源码。

迁移开始前不得直接在 `main` 上堆叠未验证源码。应创建 `migration/unified-suite` 分支，并在阶段门禁通过后分批合并。

### 3.2 当前源码来源

| 逻辑组件 | 当前来源 | 当前版本/提交 | Git 情况 |
| --- | --- | --- | --- |
| Harness 核心 | `LEGACY_ROOT/deepseek-harness` | Harness `0.1.0-rc.5`；HEAD `47f943859bef60e4160492346772ded9b24f765a` | 有 Git 历史；当前大量已修改和未跟踪条目 |
| Electron desktop | `LEGACY_ROOT/deepseek-harness/desktop` | `0.1.0-rc.5-local.5` | 当前位于 Harness 工作树的未跟踪目录中 |
| Better Sidebar | `LEGACY_ROOT/dsh-better-sidebar-fork` | `0.10.26`；HEAD `717df775b2414322a22f6a43017dc01e8784db8d` | 有上游 Git 历史；当前大量本地修改 |
| File Edit | `LEGACY_ROOT/dsh-file-edit-fork` | `1.13.32-local` | 没有独立 Git 历史 |
| Message Edit | `LEGACY_ROOT/dsh-message-edit-fork` | `0.2.1` | 没有独立 Git 历史 |
| Workspace Lineage | `LEGACY_ROOT/dsh-workspace-lineage-fork` | `0.1.2` | 没有独立 Git 历史 |
| DSH Cowork | `LEGACY_ROOT/dsh-cowork` | `0.1.0`；HEAD `2ae5cf755c4294a1e988eebf3b12dd062425d84c` | 有独立 Git 历史；当前工作树干净 |

以上状态会继续变化。阶段 0 必须重新生成机器可读清单，不能只依赖本文中的数量或版本。

### 3.3 当前运行状态

只读诊断确认：

- 当前 Stable App 为 `0.1.0-rc.5-local.4`，已签名且正在运行。
- 后端从 Stable 用户数据目录下的内容寻址 runtime 启动。
- Harness 使用 `--port 0` 动态端口，具备 Stable 与 Dev 并行运行的基础。
- 当前 profile 包含产品插件及多个第三方插件，不能直接作为公开发行白名单。
- Better Sidebar、Message Edit、Workspace Lineage 和 Cowork 当前主要通过源码软链接运行。
- File Edit 当前是实体副本，但源码、profile 和插件镜像已同步到 `1.13.32-local`，关键 Host/Client 摘要一致。

当前 Stable App、Stable profile 和真实用户数据在整个迁移期保持原样。迁移验收使用新 Dev 数据根和新测试会话。

### 3.4 当前需要保护的定制

迁移不得丢失以下已经存在的产品能力：

- Harness 原生输入、引用气泡、消息渲染和冷会话尾页相关核心定制。
- Electron 三栏启动骨架、亮暗主题、窗口状态、内置 runtime 和首次 profile 安装。
- Explorer 文件/文件夹拖动、Emoji 标记、非常用路径标记与隐藏状态持久化。
- Browser 与图片、PDF、Office、视频 Preview 共用右栏多标签。
- 视频 Range 流式播放、生命周期释放、错误兜底和播放器控制。
- 文件标签、Markdown/代码浏览、外部产物与工作区外文件只读打开。
- AI 修改审核、工作区内外修改捕获、严格 Shell 删除门禁、文件和目录事务化删除、墓碑账本和恢复。
- 已删除文件的只读快照浏览与稳定删除线。
- 消息编辑、重生成、真实会话 Fork、会话谱系和分支标题持久化。
- 文件标签“更多”菜单、关闭所有文件和关闭已处理文件。

阶段 0 应将 Harness Skill 的 `current-customizations.md` 转换成回归检查清单，但不得在新仓库验证通过前改写 Skill 的权威路径。

## 4. 目标工程结构

迁移后建议结构如下：

```text
SUITE_ROOT/
├── apps/                              # Harness 上游应用
├── packages/                          # Harness 核心包与必要定制
├── vendor/                            # Harness vendored 包
├── native/                            # Harness 原生组件
├── examples/
├── website/
├── python/
│
├── desktop/                           # Electron macOS 桌面端
│   ├── src/
│   ├── scripts/
│   ├── tests/
│   ├── build/
│   └── package.json
│
├── plugins/
│   ├── better-sidebar/
│   ├── file-edit/
│   ├── message-edit/
│   ├── workspace-lineage/
│   └── cowork/
│
├── distribution/
│   ├── channels/
│   │   ├── dev.json
│   │   └── stable.json
│   ├── profile-manifest.json
│   ├── cordis.patch.yml
│   ├── product.json
│   └── third-party/
│
├── scripts/
│   ├── product/
│   │   ├── build-plugins.mjs
│   │   ├── prepare-development-profile.mjs
│   │   ├── prepare-release-profile.mjs
│   │   ├── build-desktop.mjs
│   │   ├── launch-dev.mjs
│   │   ├── verify-versions.mjs
│   │   ├── verify-privacy.mjs
│   │   └── verify-release.mjs
│   └── ...                            # Harness 上游脚本
│
├── docs/
├── LICENSE
├── THIRD_PARTY_NOTICES.md
├── SECURITY.md
├── pnpm-workspace.yaml
└── package.json
```

第一轮迁移优先保证现有构建命令和测试可运行，不立即强制所有插件共用同一个包管理器：

- Harness 根继续使用其声明的 pnpm 版本。
- Better Sidebar 暂时保留自己的构建方式。
- File Edit 暂时保留 npm 构建和锁文件。
- Cowork 暂时保留自身 pnpm workspace。
- 根产品脚本负责调度，不在迁移导入阶段重写所有工具链。

等迁移和 App 回归通过后，再单独评估是否将各插件纳入根 pnpm workspace。工具链统一不是第一轮迁移的验收前提。

## 5. 阶段与总门禁

| 阶段 | 目标 | 是否触碰当前 Stable App/数据 |
| --- | --- | --- |
| 阶段 0 | 重新检查现状、冻结源码证据和测试基线 | 否 |
| 阶段 1 | 建立统一仓库结构和安全边界 | 否 |
| 阶段 2 | 导入 Harness 核心定制与 desktop | 否 |
| 阶段 3 | 逐个导入产品插件 | 否 |
| 阶段 4 | 建立统一构建、开发 profile 和发行 profile | 否 |
| 阶段 5 | 完成迁移后的源码、构建和集成测试 | 否 |
| 阶段 6 | 构建并实测独立 Dev App | 否，必须独立数据根 |
| 阶段 7 | 构建并验证 Stable 候选包 | 否，默认只测试候选，不安装覆盖 |
| 阶段 8 | 将后续迭代流程切换到统一工程 | 不覆盖；先以 Dev 验证 |
| 阶段 9 | 更新 Harness Skill 和交接资料 | 不修改 App/数据 |
| 阶段 10 | 经用户确认后进行正式切换或公开发布 | 仅在明确授权后 |

任何阶段失败，都停止进入下一阶段。不得因为迁移进度已经较多而跳过测试或把半成品路径写入 Skill。

## 6. 阶段 0：当前情况检查与迁移冻结

### 6.1 目标

建立迁移前的可验证事实，使所有后续导入都能回答“文件来自哪里、是不是当前最新版、是否包含生成物、迁移后是否一致”。

### 6.2 工作内容

1. 检查 `SUITE_ROOT` 的 Git 分支、remote、工作树和现有文件。
2. 检查每个旧源码目录的 Git root、HEAD、remote、tracked diff 和 untracked 文件。
3. 按以下类别给 Harness 和插件未跟踪文件分类：
   - 必须迁移的源码。
   - 必须迁移的测试。
   - 必须迁移的文档和 Agent Note。
   - 必须由构建重新生成的 `lib`、`dist`、`.d.ts`、`.map` 或 `.tgz`。
   - 依赖、缓存和临时文件。
   - 需要人工确认来源的文件。
4. 生成机器可读的迁移来源清单，记录相对路径、大小、SHA-256、来源组件和分类；清单不得包含文件正文、用户名和绝对本机路径。
5. 保存各 Git 仓库的补丁和未跟踪源码列表到仓库外临时迁移证据目录，不把包含本机路径的原始补丁直接提交公开仓库。
6. 比较 File Edit 源码、当前 profile 和插件镜像版本与摘要，确认迁移源仍为最新版。
7. 核对 Harness 核心冷会话尾页等“源码完成但当前 App 尚未部署”的功能，防止以运行 App 反向覆盖更新源码。
8. 盘点所有许可证和上游来源，标记缺失 LICENSE/NOTICE 的插件。
9. 记录当前 Stable App 版本、runtime ID、profile bundles 和运行进程，但不复制会话、profile 或日志进入迁移仓库。
10. 检查是否有正在运行的 AI 任务；阶段 0 不重启或退出 App。

### 6.3 基线测试

只运行对当前源码无破坏、与迁移风险匹配的测试：

- Harness 当前已修改核心包的定向测试、类型检查和必要构建。
- Better Sidebar 的 typecheck、build 和 test。
- File Edit 的 Client 构建、Host/Client 语法检查和 test。
- Message Edit 的现有 build/test。
- Workspace Lineage 的现有 build/test，并验证 Host bundle 确实来自 `src/index.ts`。
- Cowork 的现有 build/test。
- Desktop 的单元测试。
- `git diff --check` 或等价空白检查。

如果某项基线测试在迁移前已经失败，必须记录为“既有失败”，不能在迁移后误判为导入回归，也不能为了让迁移变绿而静默删除测试。

### 6.4 阶段验收

- 所有待迁移文件均已分类。
- 没有不明来源文件进入迁移清单。
- 许可证缺口有明确责任组件和处理方案。
- 基线测试结果已记录。
- 当前 Stable App、真实 profile、会话和工作区未发生变化。
- `SUITE_ROOT/main` 仍保持初始干净状态。

## 7. 阶段 1：建立统一仓库骨架与安全门禁

### 7.1 目标

让目标仓库具备承载 Harness 单仓库源码的目录、忽略规则、远程关系和隐私门禁，但尚不导入本地产品定制。

### 7.2 工作内容

1. 从 `main` 创建 `migration/unified-suite`。
2. 保留现有 GitHub `origin`。
3. 增加 DeepSeek Harness 官方仓库为 `upstream-harness`，并固定阶段 0 记录的基线 commit。
4. 选择保留历史的导入方式：目标仓库根采用 Harness 根结构，优先通过合并固定上游 commit 并处理不相关初始历史，而不是把 Harness 放进二级 `harness-core/`。
5. 保留目标仓库现有 README 的“非 DeepSeek 官方项目”声明。
6. 合并上游 LICENSE 时保留 DeepSeek 原 MIT 版权行和目标项目版权行，不能用一个版权声明覆盖另一个。
7. 将通用 `.gitignore` 扩展为 Harness 产品级忽略规则，至少覆盖：
   - 所有 `node_modules`、`lib`、`dist`、`.artifacts`、`.desktop-runtime` 和包缓存。
   - session、profile、runtime、state、logs、credentials、SQLite、JSONL 和删除隔离区。
   - `.env`、私钥、证书和签名导出文件。
   - App、DMG、ZIP 和本机安装备份。
8. 增加 source/artifact 边界检查和隐私扫描脚本骨架。
9. 增加 `plugins/`、`distribution/`、`scripts/product/` 和文档目录。
10. 暂不修改当前 Stable profile 的任何插件链接。

### 7.3 测试

- 在目标仓库执行 `git status`，确认生成文件不会被误纳入。
- 用受控假文件验证隐私扫描能拒绝用户名路径、`.env`、JSONL、SQLite、私钥头和绝对软链接。
- 验证扫描日志只输出文件名和规则，不打印秘密全文。
- 验证上游 Harness 的 LICENSE 和第三方声明仍然存在。
- 验证 `origin` 与 `upstream-harness` 的 push/fetch 角色明确，禁止误推上游。

### 7.4 阶段验收

- 目标仓库结构与安全门禁可工作。
- Harness 上游历史或基线可以追溯。
- 构建产物和用户数据默认无法进入 Git。
- 尚未触碰 Stable App 和真实 profile。

## 8. 阶段 2：迁移 Harness 核心定制与 Electron desktop

### 8.1 目标

将 Harness 上游基线、本地核心定制和 desktop 源码迁入统一仓库，并保持来源可审查。

### 8.2 Harness 核心迁移

1. 以阶段 0 固定的 Harness HEAD 为基线。
2. 导入已跟踪的本地 diff，保持原路径和逻辑，不在迁移提交中顺便重构业务。
3. 从未跟踪清单中只导入已分类为源码、测试、文档和有效 Agent Note 的文件。
4. 不导入由 TypeScript 构建生成的 `.js`、`.d.ts`、`.map` 和缓存，除非该包的官方源码布局明确要求跟踪对应文件。
5. 每组定制单独提交，例如输入/引用、消息渲染、冷会话尾页和配套文档分别提交。
6. 对上游规则要求的 `AGENTS.md`、README、JSDoc 和 Agent Note 一并迁移。

### 8.3 Desktop 迁移

只迁移：

- `desktop/src/`。
- `desktop/scripts/`。
- `desktop/tests/`。
- `desktop/package.json`。
- `desktop/build/entitlements.mac.plist`。
- desktop README 和必要翻译元数据。

不迁移：

- `desktop/node_modules/`。
- `desktop/.artifacts/`。
- `desktop/dist/`。
- 生成的 `.icns` 和 iconset。
- 本地 Electron 下载缓存。
- 现有 `.app`。

Desktop 导入后先保持当前行为，不在同一提交中完成 Stable/Dev 双通道；双通道在阶段 4 单独实现和测试。

### 8.4 测试

- Harness 受影响包定向测试通过或与阶段 0 的既有失败一致。
- Harness 根类型检查和必要构建能从 `SUITE_ROOT` 运行。
- Desktop 单元测试从新路径通过。
- `prepare-runtime` 的包闭包能从新仓库定位 Harness 包。
- Desktop npm pack/electron-builder 文件清单不包含源码仓库外路径。
- 迁移前后关键源码文件摘要一致；只允许因公开路径脱敏、许可证或导入说明产生的已审查差异。

### 8.5 阶段验收

- Harness 核心和 desktop 在目标仓库成为可构建源码。
- 旧 Harness 目录仍保持未删除、未覆盖。
- 没有运行 App、profile 或用户数据被导入。
- 本阶段没有安装或启动新 App。

## 9. 阶段 3：逐个迁移产品插件

### 9.1 迁移顺序

为降低依赖和 UI 联动风险，建议顺序：

1. Workspace Lineage。
2. Message Edit。
3. File Edit。
4. Better Sidebar。
5. Cowork 中实际用于产品的包。

### 9.2 有 Git 历史的插件

Better Sidebar 和 Cowork 优先使用保留历史的 subtree 或等价方式导入固定 commit。因为 subtree 操作要求干净工作树，应先导入上游历史，再应用阶段 0 保存的本地修改和新增源码。

不得把原插件仓库的 `node_modules`、构建缓存和本地 profile 链接带入目标仓库。

### 9.3 没有 Git 历史的插件

File Edit、Message Edit 和 Workspace Lineage按明确文件白名单导入，第一次提交标为“迁移来源快照”，并在提交说明中记录：

- 原包名和版本。
- 原上游地址或来源说明。
- 阶段 0 的摘要清单 ID。
- 本地修改的当前职责。
- 许可证来源。

File Edit 的运行源码与生成 Client bundle需区分：源文件、Host 文件、测试和 package manifest 是维护源；`client/dist/client.js` 如果运行协议要求随包分发，则作为受构建验证的发布产物处理，不能成为手工修改源。

### 9.4 许可证处理

- Better Sidebar 保留原 MIT LICENSE。
- File Edit 补齐源码根 LICENSE、`package.json` license 字段和第三方许可证。
- Message Edit 的 pack 必须包含原作者 MIT LICENSE。
- Workspace Lineage 保留 DeepSeek/Harness 来源版权和 MIT 声明。
- Cowork 子包的发行包必须能定位根 MIT LICENSE。
- 不因目标仓库已有一份 MIT LICENSE 就删除各上游组件的版权声明。

### 9.5 每个插件的独立测试

- manifest、exports 和 `dsh.client` 发现配置正确。
- Host/Client build 通过。
- typecheck 通过，或记录与迁移前一致的既有失败。
- 插件现有测试通过。
- `npm pack --dry-run` 或 pnpm pack 清单符合预期。
- pack 不含个人路径、测试状态、profile、依赖缓存或密钥。
- 关键 bundle 包含本轮源码标识，不能只看命令退出码。

### 9.6 阶段验收

- 五类产品插件均位于 `SUITE_ROOT/plugins`。
- 每个插件有明确来源、版本、许可证、构建和测试入口。
- 迁移前后关键源码和行为一致。
- 旧插件目录尚未删除，也不再接受新功能修改。
- 当前 Stable profile 仍指向旧来源，不在本阶段切换。

## 10. 阶段 4：统一构建、profile 和 Stable/Dev 双通道

### 10.1 根构建调度

增加根级产品命令，能力至少包括：

```text
检查所有组件版本
构建 Harness 核心
构建所有产品插件
运行产品插件测试
生成开发 profile
生成发行 profile
构建 Dev App
构建 Stable 候选 App
启动 Dev App
验证隐私和许可证
验证最终发行包
```

根脚本只调度各组件已声明命令，不在第一轮迁移中臆造统一参数。

### 10.2 开发 profile

开发 profile 从仓库固定配置生成：

- 默认写入临时 `DEV_DSH_HOME` 或明确的 Dev 数据根。
- 只链接或打包 `SUITE_ROOT/plugins` 中的产品插件。
- 不读取当前 Stable profile 作为插件清单。
- 不覆盖已经存在的 Stable profile。
- 记录生成时的 commit、组件版本、插件摘要和 profile ID。
- 支持删除临时测试环境，但删除目标必须是脚本刚创建并验证过的临时目录，不能接受主目录、工作区根或真实 `DSH_HOME`。

### 10.3 发行 profile

`distribution/profile-manifest.json` 作为唯一白名单。第一版候选范围为：

- Harness base 和 Web app。
- Workspace Lineage。
- Better Sidebar。
- File Edit。
- Message Edit。
- Cowork 中完成许可证审核的最小产品包。

当前个人 profile 中的 Voice、Docker、Computer Use、Visualize、GenUI、Mnemon、Skin、Tmux、Custom Tool 等不得因为“已安装”而自动进入发行包。需要加入时必须单独审查来源、版本、许可证、权限和测试。

发行 profile 固定生成空白配置和固定 patch，不复制个人 `cordis.patch.yml`、session、workspace、credential、settings、logs、state、Mnemon 或审核数据。

### 10.4 Stable/Dev 双通道

至少区分：

| 项目 | Stable | Dev |
| --- | --- | --- |
| 产品名 | 正式社区产品名 | 正式名加 `Dev` |
| Bundle ID | 独立正式 ID | 正式 ID 加 `.dev` |
| App 输出 | Stable 候选目录 | `desktop/dist/dev` 或等价构建目录 |
| 安装 | 仅正式发布时允许 | 默认不安装，直接运行构建产物 |
| userData | 独立 Stable 目录 | 独立或临时 Dev 目录 |
| DSH_HOME | Stable userData 下独立目录 | Dev userData 下独立目录 |
| profile/runtime/log/state | Stable 独立 | Dev 独立 |
| 凭据 | 用户正式配置 | 默认无真实凭据或专用测试凭据 |

实现要求：

1. 在 Electron ready 之前确定通道并设置 `userData`。
2. `productName`、`appId`、可执行名、单实例锁和日志标识随通道隔离。
3. Stable 和 Dev 均使用动态后端端口，允许同时运行。
4. Dev App 不读取、迁移或覆盖 Stable profile、会话、审核账本、删除隔离区和 Explorer 状态。
5. 当前 `/Applications/DeepSeek Harness.app` 在迁移和测试阶段保持不动。
6. 原 `install-mac` 只能作为显式 Stable 发布动作；普通开发命令不得调用。

### 10.5 许可证和隐私门禁

最终 App Resources 至少包含：

- 项目 LICENSE。
- DeepSeek Harness 原 MIT 声明。
- `THIRD_PARTY_NOTICES.md`。
- Electron LICENSE。
- `LICENSES.chromium.html`。
- 产品插件和附加依赖的许可证集合或可验证索引。

扫描必须覆盖源码、profile tar、runtime tar、app.asar、`.app`、DMG/ZIP 和 checksums 旁的元数据。命中真实用户名、主目录、工作区路径、凭据、JSONL、SQLite、日志、session、state 或绝对软链接时直接阻止构建晋级。

### 10.6 阶段测试和验收

- 根构建能调度所有组件。
- 开发 profile 只含白名单插件并使用 Dev 数据根。
- 发行 profile 在没有个人 Stable profile 的机器环境中也能生成。
- Stable 与 Dev 标识、App 路径和数据根完全不同。
- 缺失插件、版本不一致或许可证缺失时 fail closed。
- 构建脚本不会修改当前 Stable App 和真实用户数据。

## 11. 阶段 5：完成迁移后的自动化与集成测试

### 11.1 源码完整性测试

- 对照阶段 0 清单验证所有必须迁移文件已进入目标仓库。
- 检查没有从旧目录跨路径 import、require、软链接或脚本引用。
- 搜索并清除公开源码中的真实 `LEGACY_ROOT`、用户名和绝对路径。
- 验证旧目录内容发生变化不会影响目标仓库构建。
- 在临时重命名或不可访问旧目录的条件下执行一次目标构建，证明目标仓库自包含；该验证不得修改真实旧目录，可使用隔离环境或只读挂载模拟。

### 11.2 自动化测试矩阵

| 层级 | 必测内容 |
| --- | --- |
| Harness 核心 | 受影响包定向 Vitest、类型检查、必要 build、Agent Note/文档门禁 |
| Desktop | window state、appearance、startup skeleton、runtime path、profile bootstrap |
| Better Sidebar | Explorer、Browser/Preview、布局持久化、视频 Range/安全/生命周期/控制 |
| File Edit | 文件标签、外部浏览、审核账本、删除事务、批次恢复、Shell 门禁、重启水合 |
| Message Edit | edit/reroll/retry、Fork、版本事件、Timeline |
| Workspace Lineage | 会话树、排序、分支标题、Host bundle 来源 |
| Cowork | Office 读取/渲染和安全边界 |
| 组成 | profile 插件发现、Cordis patch、Client/Host 对应版本 |
| 安全 | 工作区边界、symlink、外部文件 opaque ID、隐私扫描、许可证 |

### 11.3 关键产品回归矩阵

- 新建、打开、切换、重命名、归档和分支会话。
- 消息编辑、reroll、retry 和谱系切换。
- 普通输入、Shift+Enter、中文输入法和引用气泡。
- Explorer 文件夹展开、拖动文件/目录、Emoji 标记、非常用标记和重启恢复。
- 文件标签、代码、Markdown、外部文件和回答产物入口。
- 图片、PDF、DOCX、XLSX、PPTX 和视频 Preview。
- Browser 与多个 Preview 在同一右栏切换、关闭、排序和恢复。
- AI 工作区内外创建、修改、移动、删除文件和删除目录的审核。
- 接受、拒绝、恢复、重启后审核保留和已删除文件只读预览。
- 亮色、暗黑、启动骨架和窗口状态。

### 11.4 阶段验收

- 目标仓库在不依赖旧源码目录时完成构建。
- 自动化测试达到迁移前基线或更好。
- 所有新增迁移门禁通过。
- 本阶段仍不安装 Stable App。

## 12. 阶段 6：开发版打包测试与真实验证

### 12.1 构建要求

从 `SUITE_ROOT` 的干净 commit 构建 macOS arm64 Dev App：

- 产品名带明确 `Dev` 标识。
- Bundle ID 使用 Dev 后缀。
- App 从仓库构建目录直接启动，不复制到 Stable 安装路径。
- 使用全新临时 `DEV_USER_DATA` 和 `DEV_DSH_HOME`。
- 启动环境不暴露真实模型凭据；需要模型回归时使用明确批准的测试凭据。

### 12.2 启动测试

- Dev App 启动并显示三栏骨架。
- 内置 runtime 解压到 Dev 数据根。
- 后端使用动态端口并成功 ready。
- 发行白名单 profile 只在 Dev profile 不存在时安装。
- Stable App 在 Dev 启动期间继续运行，不发生单实例锁或端口冲突。
- Stable 数据目录在 Dev 启动前后文件清单不发生变化。

### 12.3 真实回归要求

使用新建测试会话和独立临时工作区，不触碰已有会话区：

1. 创建文本、Markdown、图片、PDF、Office 和小视频测试文件。
2. 验证 Explorer、文件标签、Preview 和 Browser。
3. 验证 AI 文件修改审核；需要模型调用时使用测试凭据并限定在临时工作区。
4. 验证工作区外临时文件的只读打开和审核。
5. 验证文件和嵌套目录事务化删除、拒绝恢复、再次删除和接受。
6. 重启 Dev App，验证 Explorer、Browser/Preview、审核和会话状态只在 Dev 数据根内恢复。
7. 关闭 Dev App 后确认没有后台 backend、视频请求或残留文件句柄。

大体积视频可继续由用户后续人工验收；本阶段至少使用工程已有小视频验证 Range、播放控制和生命周期。

### 12.4 Dev 验收门槛

- Dev App 可以独立运行完整产品能力。
- Dev 和 Stable 可以并行存在。
- Dev 不读取或写入 Stable 数据。
- Dev 构建和启动不需要备份 `/Applications` 中的 App。
- 真实回归问题修复后重新执行受影响自动化测试和 Dev 回归。

## 13. 阶段 7：正式版候选打包测试

### 13.1 目标

证明统一仓库可以生成适合正式发布的 Stable 候选，但本阶段默认不覆盖当前安装 App，也不迁移真实数据。

### 13.2 构建要求

- 从经过 Dev 验收的同一个 commit 构建。
- Stable 产品名、Bundle ID、图标和 userData 与 Dev 区分。
- profile 来自固定白名单，不读取个人 profile。
- runtime 和插件包来自当前 commit 构建产物。
- 生成 macOS arm64 `.app`，并根据发行需要生成 ZIP/DMG。
- 生成 SHA-256 checksums、组件版本清单、profile ID、runtime ID 和许可证索引。
- 本地测试可使用临时签名；公开发行必须使用 Developer ID 并完成 Apple 公证。

### 13.3 包体检查

- `codesign --verify --deep --strict` 通过。
- 公开候选进一步通过 Gatekeeper 和公证验证。
- app.asar、runtime、profile 和插件包版本一致。
- 没有绝对软链接或指向仓库外的依赖。
- 没有用户主目录、工作区路径、会话、日志、凭据、审核账本和插件状态。
- LICENSE、第三方声明、Electron 和 Chromium 许可证完整。
- DMG/ZIP 解压后摘要与 checksums 一致。

### 13.4 Stable 候选启动验证

使用新的临时 Stable 测试数据根启动候选，而不是当前真实 `STABLE_USER_DATA`：

- 首次启动为空白，无历史会话和工作区。
- 白名单插件加载完整。
- 重启后候选自身状态恢复。
- 不读取 Dev 或当前 Stable 数据。
- 最小 Explorer、文件审核、Browser/Preview 和主题测试通过。

### 13.5 阶段验收

- Stable 候选满足包体、隐私、许可证、签名和启动要求。
- 候选对应唯一 commit 和组件清单。
- 当前 `/Applications/DeepSeek Harness.app` 未被替换。
- 是否正式安装、公开 Release 或迁移用户数据由用户另行确认。

## 14. 阶段 8：切换后续迭代与开发流程

### 14.1 权威源码切换

阶段 7 通过后：

- `SUITE_ROOT` 宣布为唯一权威源码。
- 旧 Harness 和插件目录进入只读归档期，不再接受新开发。
- 不立即删除旧目录；至少保留两个成功发布周期。
- 当前旧 Stable App 可继续日常使用，直到用户决定安装新的 Stable 产品。
- 后续功能需求只在 `SUITE_ROOT` 创建分支、测试和构建。

### 14.2 后续每次迭代的最低流程

任何产品功能或缺陷修复都必须：

1. 从目标仓库干净基线创建功能分支。
2. 先确认功能所有权：Harness 核心、desktop、插件 Client、插件 Host 或发行组成。
3. 添加与风险匹配的定向自动化测试。
4. 运行受影响组件 typecheck/build/test。
5. 构建受影响插件并验证 bundle/pack 中确有新代码。
6. 生成或刷新独立 Dev profile。
7. 对用户可见功能构建并启动 Dev App，使用测试会话做真实回归。
8. 验证 Stable App 和 Stable 数据未被修改。
9. 只有准备发布时才运行 Stable 候选全套门禁。
10. 更新相关文档、Agent Note 和组件版本。

以下变化必须进行 Dev App 实测，而不能只报告单元测试：

- Desktop main/preload、启动、窗口、主题、profile 或 runtime。
- Harness Web 公共 UI、输入、会话或插件发现。
- 插件 Host/Client 跨平面协议。
- Explorer、文件、审核、Browser、Preview、视频和持久化行为。
- 任何声称“重启后仍保留”或“Stable/Dev 隔离”的功能。

### 14.3 后续开发完成定义

- 源码、构建产物和 Dev profile 版本一致。
- 自动化测试通过。
- Dev App 真实回归通过。
- 不影响 Stable App 和真实数据。
- 文档和 Skill 中的路径、命令与实际工程一致。
- 未执行的 Stable、签名、公证或大文件人工测试被明确报告，不能暗示已经完成。

## 15. 阶段 9：更新 Harness Skill 与系统维护资料

### 15.1 切换时机

只有阶段 6 Dev App 真实回归和阶段 7 Stable 候选验证都通过后，才更新 Harness Skill。提前修改会使后续代理把半成品目标仓库误认为可用维护源。

### 15.2 Skill 更新范围

更新 `harness-plugin-development`：

1. `SKILL.md`
   - 默认工作区改为 `SUITE_ROOT`。
   - 明确统一仓库是唯一权威源码。
   - 默认开发流程改为 Dev App，不再覆盖 Stable App。
   - Stable 安装仍需用户明确授权。
2. `references/architecture.md`
   - 更新统一目录结构。
   - 增加 Stable/Dev 两套 App、userData、DSH_HOME、profile、runtime 和日志关系。
3. `references/current-customizations.md`
   - 将五类插件权威路径改为 `SUITE_ROOT/plugins/*`。
   - 保留现有产品行为和禁用护栏。
4. `references/plugin-development.md`
   - 更新插件发现、开发 profile 和统一根构建方式。
5. `references/build-and-deploy.md`
   - 替换所有旧 fork 路径和手工实体同步流程。
   - 增加 build/test/launch Dev 标准命令。
   - 将 Stable 安装与普通开发彻底分开。
6. `references/diagnostics.md`
   - 增加通道识别、Dev/Stable process、userData、runtime、profile 和 commit 诊断。
7. `scripts/inspect-runtime.sh`
   - 支持 `SUITE_ROOT`。
   - 同时检查 Stable 和 Dev App。
   - 输出每个通道的版本、进程、userData、DSH_HOME、profile、runtime 和插件摘要。
   - 保持只读，绝不清理状态。
8. `agents/openai.yaml`
   - 仅在触发范围或说明需要变化时更新。

### 15.3 Skill 验证

- 完整读取修改后的 Skill 和引用文件，检查不存在旧权威路径。
- 运行 `skill-creator/scripts/quick_validate.py`。
- 对修改后的诊断脚本执行 shell 语法检查。
- 运行一次只读 runtime 检查，确认同时识别 Stable 和 Dev。
- 使用一个模拟 Harness 需求检查 Skill 是否首先定位到 `SUITE_ROOT`，且默认选择 Dev 流程。
- 检查 Skill 不会引导删除 profile、session、state 或旧源码归档。

### 15.4 其他资料更新

- 更新本机 Harness 总览和专题交接文档中的权威路径。
- 将旧路径标记为迁移前历史，不保留相互冲突的“当前路径”。
- 在统一仓库增加架构、开发、测试和发行文档。
- 对公开文档移除开发者用户名和本机绝对路径。

### 15.5 阶段验收

- Skill 校验通过。
- Skill、统一仓库和真实 Dev 运行环境一致。
- 后续开发默认修改统一仓库并运行 Dev App。
- 当前 Stable App 和真实数据仍未因 Skill 更新被修改。

## 16. 阶段 10：正式切换、安装或公开发布

本阶段不是自动执行项。用户明确选择后才进行以下一种或多种动作：

- 将新的 Stable App 作为独立产品与旧 App 并行安装。
- 制定只读、可回滚的旧用户数据导入流程。
- 替换旧 Stable App，并保留上一正式版本作为唯一明确回滚点。
- 提交并推送迁移分支/主分支。
- 创建 GitHub Release。
- 发布签名、公证的 DMG/ZIP 和 checksums。

公开发布前再次执行完整隐私和许可证审计。任何本机用户数据都不得因“迁移旧用户体验”而进入 Git 或 Release。

## 17. 回滚策略

### 17.1 源码迁移回滚

- 目标仓库的每个组件独立提交，可以按组件撤销。
- 不使用 `git reset --hard`、`git clean` 或 checkout 覆盖旧源码。
- 旧源码目录保留，失败时继续从旧 Stable App 工作，但不把目标仓库半成品写入 Skill。

### 17.2 Dev 回滚

- Dev 使用独立数据根，失败时只停止 Dev 进程。
- 不删除 Stable userData。
- Dev 临时目录只由创建它的测试脚本清理，并严格校验目标路径。

### 17.3 Stable 候选回滚

- 阶段 7 默认不安装，因此失败只丢弃候选构建，不影响当前 Stable。
- 正式安装必须保留上一正式版本，且执行前确认没有运行中的 AI 任务。
- 不覆盖已经存在、来源未知的 `.previous.app` 备份。

### 17.4 Skill 回滚

- 新 Skill 只在新工程通过完整门禁后切换。
- 如果切换后发现目标仓库不可用，恢复上一版 Skill 路径，同时记录目标仓库阻塞原因。
- 不通过删除 Skill 或用户状态解决路径错误。

## 18. 迁移风险与阻断条件

| 风险 | 严重度 | 门禁 |
| --- | --- | --- |
| Harness/Better Sidebar 未提交定制丢失 | 极高 | 阶段 0 清单、补丁、摘要和分类导入 |
| 生成文件被误当源码提交 | 高 | source/artifact 检查和显式文件白名单 |
| File Edit 源码与运行副本再次漂移 | 高 | 统一版本和 SHA-256 校验 |
| 目标构建暗中依赖旧目录 | 极高 | 旧目录不可访问条件下的自包含构建测试 |
| Dev 读取真实会话或审核数据 | 极高 | 独立 userData/DSH_HOME 和写入差异检查 |
| 开发构建覆盖 Stable App | 极高 | Dev 直接运行构建产物，Stable 安装命令独立授权 |
| 个人 profile 插件全部进入发行包 | 极高 | 固定 `profile-manifest.json` 白名单 |
| 许可证遗漏 | 高 | pack/App/DMG 许可证门禁 |
| 使用 DeepSeek 品牌造成官方误认 | 高 | 社区第三方声明、独立产品身份和 Bundle ID |
| Skill 提前切换到半成品仓库 | 高 | 阶段 9 必须等待 Dev 与 Stable 候选验收 |
| 真实测试影响现有会话 | 极高 | 新测试会话、临时工作区、独立 Dev 数据根 |

发生以下任一情况必须停止晋级：

- 未能解释某个迁移文件的来源。
- 迁移后测试比基线新增失败且根因未确认。
- 目标构建仍读取旧源码目录或个人 profile。
- Dev 启动修改了 Stable 数据目录。
- 发行包包含白名单外插件、用户路径、状态文件或秘密。
- 许可证或品牌授权无法解释。
- Stable/Dev 标识或单实例锁没有隔离。
- Skill 校验失败或仍指向互相冲突的权威路径。

## 19. 最终完成定义

只有同时满足以下条件，本次统一工程维护调整才算完成：

1. Harness 核心、desktop 和五类产品插件全部由 `SUITE_ROOT` 管理。
2. 目标仓库保留可追溯的上游来源和许可证。
3. 目标仓库不依赖旧源码目录、个人 profile 或安装 App 才能构建。
4. 开发 profile 和发行 profile 都由固定仓库配置生成。
5. 自动化测试与迁移前基线一致或更好。
6. 独立 Dev App 完成真实回归，且不影响当前 Stable App 和数据。
7. Stable 候选完成包体、隐私、许可证、签名和隔离启动验证。
8. 后续每次用户可见迭代都使用 Dev App 进行真实测试。
9. Harness Skill、诊断脚本和交接资料已切换到统一仓库并通过校验。
10. 旧源码目录进入明确只读归档期，没有被立即删除。
11. 是否正式安装、数据迁移和 GitHub Release 均由用户另行明确授权。

## 20. 建议的实际执行顺序

后续按以下批次逐轮执行，每一批完成后报告结果并等待进入下一批：

1. **批次 A：阶段 0。** 只读检查、文件分类、摘要清单和基线测试。
2. **批次 B：阶段 1。** 目标仓库骨架、上游基线、忽略和安全门禁。
3. **批次 C：阶段 2。** Harness 核心定制与 desktop 导入和测试。
4. **批次 D：阶段 3。** 五类产品插件逐个导入和测试。
5. **批次 E：阶段 4。** 统一构建、固定 profile 和 Stable/Dev 双通道。
6. **批次 F：阶段 5。** 迁移完整性、自动化和集成回归。
7. **批次 G：阶段 6。** Dev App 打包、隔离启动和新测试会话真实回归。
8. **批次 H：阶段 7。** Stable 候选打包、隐私、许可证、签名和启动测试。
9. **批次 I：阶段 8–9。** 宣布统一权威源，更新后续开发流程、Harness Skill 和交接资料。
10. **批次 J：阶段 10。** 仅在用户明确同意后安装 Stable、迁移数据、推送或发布。

下一轮最安全的起点是批次 A。批次 A 不创建或覆盖产品源码，不修改目标仓库 main，不退出当前 App，也不触碰真实会话和用户数据。
