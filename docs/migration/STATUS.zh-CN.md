# 统一工程迁移状态

更新日期：2026-09-01

## 当前结论

统一工程已经成为后续 Harness 核心、macOS Desktop 和产品插件开发的权威源码目录。旧分散源码目录进入只读保留期，不删除，也不再作为新功能修改源。当前系统安装的是 v1.00.03 Stable App；真实凭据、会话和配置继续位于 App 外部的 Stable userData，本轮隐私补丁没有覆盖或重启该 App。

当前工作分支为 `migration/unified-suite`。本轮只提交到本地 Git，没有推送 GitHub。

## 已完成范围

- Harness 固定在上游基线 `47f943859bef60e4160492346772ded9b24f765a`，并叠加本地核心定制。
- Electron Desktop 位于 `desktop/`。
- Better Sidebar、File Edit、Message Edit、Workspace Lineage 和 Cowork 位于 `plugins/`。
- Better Sidebar 与 Cowork 保留上游 Git 历史；其他插件以来源快照迁入。
- 发行组成由 `distribution/profile-manifest.json` 唯一控制。
- `requiredRuntimePlugins` 将 Workspace Lineage、Better Sidebar、Cowork、Message Edit 和 File Edit 固定为桌面候选的必需插件。
- Profile 构建不读取 Stable profile，只从统一工程产品插件和固定 Harness 工作区包生成。
- Dev/Stable 打包在 Electron Builder 前使用打包 Runtime 启动隔离 Web 后端，验证 Cordis composition 和 Client 启动清单；仅有 `node_modules` 文件不算插件已装配。
- Profile 不携带 Harness 核心 peer 包；产品插件经启动器维护的 fallback 解析 Runtime 的单一核心实例，避免 scope 被两份核心模块拆分。
- 打包验证会通过隔离 Web API 创建空白会话，不发送模型请求；这同时验证会话、输入和模型选择依赖的 Host 主链路。
- Dev 和 Stable 分别使用独立 product name、appId 和输出目录。
- 普通桌面构建默认指向 Dev；Stable 安装仍是显式动作。
- Runtime 构建遵循包的 `os`/`cpu` 条件，不在 macOS 打包 Linux Landlock 二进制。
- Runtime 的本地包安装路径不会进入发行清单；归档中的根依赖只保留包版本号。
- Dev/Stable 打包前扫描 Git 已跟踪文件与未忽略的未跟踪文件，打包后解压扫描 Runtime、Profile 和 `app.asar`；个人状态、构建机主目录、私钥文件或绝对软链接会使发行失败。
- Workspace Lineage 的旧手工依赖软链接已改为可重复生成的仓库内构建准备步骤。

## 验证结果

| 项目 | 结果 |
| --- | --- |
| Harness typecheck | 通过 |
| Harness 全量 build | 通过 |
| Better Sidebar | 49 个测试文件，544 项通过 |
| File Edit | 69 项通过 |
| Workspace Lineage | 10 个测试文件，139 项通过 |
| Cowork | 构建通过；Core 35 项通过；微信桥 35 项中 34 项通过，`task-started` 消息先于最终回答的既有时序断言失败，定向复跑可重复 |
| Desktop | 12 项通过 |
| 产品插件统一构建 | 通过 |
| 源码隐私扫描 | 7,790 个 tracked files 和 19 个未忽略的未跟踪文件通过 |
| 发行 Profile | 生成成功；6 个 bundle；未包含 Stable profile 的个人第三方插件 |
| Profile 隐私 | 未检出开发者主目录、Stable profile 路径或绝对软链接 |
| 产品插件运行装配 | 5 个必需插件通过；Workspace Lineage、Better Sidebar、Message Edit、File Edit 的 Client bundle 均进入 Web 启动清单，Cowork Host 进入 Cordis composition |
| 会话主链路 smoke | 通过隔离 HTTP API 创建空白会话，并取得该会话的模型列表；不发送模型请求 |
| Dev 插件列表 | 全新临时 userData 的真实设置页显示 `workspace-lineage`、`better-sidebar`、Cowork `include:cowork-docs`、`message-edit`、`file-edit` 均为 Mounted、Enabled |
| Dev `.app` | `DeepSeek Harness Dev`，`ai.deepseek.harness.desktop.dev`，约 559MB |
| Stable 候选 `.app` | `DeepSeek Harness`，`ai.deepseek.harness.desktop`，约 559MB；未安装 |
| 签名检查 | 两个 `.app` 均通过 `codesign --verify --deep --strict` |
| 最终包路径扫描 | v1.00.04 Dev 隐私候选的 Runtime、Profile 和 `app.asar` 完整解包扫描通过；未检出开发者主目录或个人状态文件 |
| Dev 真实启动 | 全新临时 userData 中 Runtime `82852207636f1f42` 解压、Profile `f1757aca4f78941e` 首装、动态端口后端 ready、空白主界面和插件列表加载均通过 |

Dev 启动使用独立临时数据目录。首次界面只显示空白产品状态，没有读取旧会话、工作区、凭据或审核状态。测试结束后仅关闭 Dev 进程，系统安装的 Stable App 继续运行。

## 当前产物

构建产物不进入 Git：

- Dev：`desktop/dist/dev/mac-arm64/DeepSeek Harness Dev.app`
- Dev 隐私候选：`desktop/dist/dev-privacy-candidate/mac-arm64/DeepSeek Harness Dev.app`
- Stable 候选：`desktop/dist/stable/mac-arm64/DeepSeek Harness.app`
- Runtime bootstrap：`desktop/.artifacts/runtime/`
- Profile bootstrap：`desktop/.artifacts/profile/`

这些路径是可重建的 artifact plane，不是源码维护入口。

## 尚未完成与发布阻塞

1. File Edit、Message Edit 和 Workspace Lineage 的独立许可证来源仍需补齐并完成法律来源确认。
2. Message Edit 缺少 Host TypeScript 维护源和历史构建脚本，目前只能验证 Host/Client 运行快照；不能宣称完全可复现。
3. Harness 定向 Vitest 仍有迁移前已存在的 152 项 `FiberState`/Client slot 运行时导出失败；不能归因于本次迁移。
4. Cowork 微信桥的 task-started/最终回答发送顺序测试仍失败；本轮没有扩大迁移任务去修改 Cowork 消息调度逻辑。
5. Dev App 尚未使用测试工作区逐项人工回归 Explorer、Browser/Preview、文件审核、事务删除、重启持久化和媒体播放。
6. Stable 候选尚未用临时 Stable userData 做完整 UI 回归。
7. 未生成 DMG、ZIP、checksums 和组件版本发行清单。
8. 当前仅为 ad-hoc 签名，未执行 Developer ID 签名、Apple 公证或 Gatekeeper 公开发行验证。
9. 本轮未替换正在运行的 v1.00.03 Stable App，也未推送 GitHub。

在以上阻塞关闭前，Stable `.app` 只能作为本地候选，不得标记为公开发行版本。

## 后续开发规则

1. 新功能只修改统一工程，不再反向修改旧分散目录。
2. 先运行受影响组件 build/test，再构建 Dev App。
3. 用户可见功能必须在独立 Dev userData 和测试会话中做真实回归。
4. 不使用真实 Stable profile 生成发行包。
5. 不退出、覆盖或安装 Stable App，除非用户明确授权。
6. 公开发行前重新执行许可证、隐私、签名、公证和完整产品回归门禁。
