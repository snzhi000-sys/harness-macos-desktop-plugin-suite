# 统一工程迁移状态

更新日期：2026-09-01

## 当前结论

统一工程已经成为后续 Harness 核心、macOS Desktop 和产品插件开发的权威源码目录。旧分散源码目录进入只读保留期，不删除，也不再作为新功能修改源。当前系统安装的 Stable App 和真实用户数据没有被迁移、覆盖或重启。

当前工作分支为 `migration/unified-suite`。本轮只提交到本地 Git，没有推送 GitHub。

## 已完成范围

- Harness 固定在上游基线 `47f943859bef60e4160492346772ded9b24f765a`，并叠加本地核心定制。
- Electron Desktop 位于 `desktop/`。
- Better Sidebar、File Edit、Message Edit、Workspace Lineage 和 Cowork 位于 `plugins/`。
- Better Sidebar 与 Cowork 保留上游 Git 历史；其他插件以来源快照迁入。
- 发行组成由 `distribution/profile-manifest.json` 唯一控制。
- Profile 构建不读取 Stable profile，只从统一工程产品插件和固定 Harness 工作区包生成。
- Dev 和 Stable 分别使用独立 product name、appId 和输出目录。
- 普通桌面构建默认指向 Dev；Stable 安装仍是显式动作。
- Runtime 构建遵循包的 `os`/`cpu` 条件，不在 macOS 打包 Linux Landlock 二进制。
- Workspace Lineage 的旧手工依赖软链接已改为可重复生成的仓库内构建准备步骤。

## 验证结果

| 项目 | 结果 |
| --- | --- |
| Harness typecheck | 通过 |
| Harness 全量 build | 通过 |
| Better Sidebar | 49 个测试文件，544 项通过 |
| File Edit | 69 项通过 |
| Workspace Lineage | 10 个测试文件，139 项通过 |
| Cowork | 全部 workspace 测试通过；一次微信桥时序测试抖动，单独复跑及完整复跑均通过 |
| Desktop | 12 项通过 |
| 产品插件统一构建 | 通过 |
| 源码隐私扫描 | 7,785 个 tracked files 通过 |
| 发行 Profile | 生成成功；6 个 bundle；未包含 Stable profile 的个人第三方插件 |
| Profile 隐私 | 未检出开发者主目录、Stable profile 路径或绝对软链接 |
| Dev `.app` | `DeepSeek Harness Dev`，`ai.deepseek.harness.desktop.dev`，约 559MB |
| Stable 候选 `.app` | `DeepSeek Harness`，`ai.deepseek.harness.desktop`，约 559MB；未安装 |
| 签名检查 | 两个 `.app` 均通过 `codesign --verify --deep --strict` |
| 最终包路径扫描 | 未检出开发者主目录、Stable profile 路径或历史测试文件标识 |
| Dev 真实启动 | 全新临时 userData 中 Runtime 解压、Profile 首装、动态端口后端 ready、空白主界面加载均通过 |

Dev 启动使用独立临时数据目录。首次界面只显示空白产品状态，没有读取旧会话、工作区、凭据或审核状态。测试结束后仅关闭 Dev 进程，系统安装的 Stable App 继续运行。

## 当前产物

构建产物不进入 Git：

- Dev：`desktop/dist/dev/mac-arm64/DeepSeek Harness Dev.app`
- Stable 候选：`desktop/dist/stable/mac-arm64/DeepSeek Harness.app`
- Runtime bootstrap：`desktop/.artifacts/runtime/`
- Profile bootstrap：`desktop/.artifacts/profile/`

这些路径是可重建的 artifact plane，不是源码维护入口。

## 尚未完成与发布阻塞

1. File Edit、Message Edit 和 Workspace Lineage 的独立许可证来源仍需补齐并完成法律来源确认。
2. Message Edit 缺少 Host TypeScript 维护源和历史构建脚本，目前只能验证 Host/Client 运行快照；不能宣称完全可复现。
3. Harness 定向 Vitest 仍有迁移前已存在的 152 项 `FiberState`/Client slot 运行时导出失败；不能归因于本次迁移。
4. Dev App 尚未使用测试工作区逐项人工回归 Explorer、Browser/Preview、文件审核、事务删除、重启持久化和媒体播放。
5. Stable 候选尚未用临时 Stable userData 做完整 UI 回归。
6. 未生成 DMG、ZIP、checksums 和组件版本发行清单。
7. 当前仅为 ad-hoc 签名，未执行 Developer ID 签名、Apple 公证或 Gatekeeper 公开发行验证。
8. 未安装新 Stable App，未迁移真实用户数据，未推送 GitHub。

在以上阻塞关闭前，Stable `.app` 只能作为本地候选，不得标记为公开发行版本。

## 后续开发规则

1. 新功能只修改统一工程，不再反向修改旧分散目录。
2. 先运行受影响组件 build/test，再构建 Dev App。
3. 用户可见功能必须在独立 Dev userData 和测试会话中做真实回归。
4. 不使用真实 Stable profile 生成发行包。
5. 不退出、覆盖或安装 Stable App，除非用户明确授权。
6. 公开发行前重新执行许可证、隐私、签名、公证和完整产品回归门禁。
