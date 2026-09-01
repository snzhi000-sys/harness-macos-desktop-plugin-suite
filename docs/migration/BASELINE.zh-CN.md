# 统一工程迁移基线

## 迁移来源

| 组件 | 固定来源 | 版本 | 导入方式 |
| --- | --- | --- | --- |
| Harness 核心 | `47f943859bef60e4160492346772ded9b24f765a` | `0.1.0-rc.5` | 合并上游 Git 基线，再叠加本地源码白名单 |
| macOS Desktop | Harness 旧工作树中的未跟踪源码目录 | `0.1.0-rc.5-local.5` | 排除依赖、构建物和 `.artifacts` 后导入 |
| Better Sidebar | `717df775b2414322a22f6a43017dc01e8784db8d` | `0.10.26` | subtree 保留历史，再叠加本地修改 |
| File Edit | 本地维护源快照 | `1.13.32-local` | 排除 `node_modules` 与 Client 构建目录后导入 |
| Message Edit | 本地运行快照 | `0.2.1` | 保留 Host、Client、source map 与 manifest |
| Workspace Lineage | 本地维护源快照 | `0.1.2` | 排除 `node_modules` 与 `lib` 后导入 |
| Cowork | `2ae5cf755c4294a1e988eebf3b12dd062425d84c` | `0.1.0` | subtree 保留历史 |

清单仅使用逻辑组件名和相对路径，不记录开发者用户名或旧工程绝对路径。旧源码目录只读保留，不会由统一工程反向覆盖。

## 阶段 0 测试结果

| 组件 | 结果 |
| --- | --- |
| Harness 类型检查 | 通过 |
| Harness 定向 Vitest | 391 项中 239 项通过；152 项因测试运行时 `FiberState`/Client slot 导出为 `undefined` 集中失败，刷新 Host 构建后仍可复现，记为迁移前既有失败 |
| Better Sidebar | typecheck、build、49 个测试文件共 544 项测试通过 |
| File Edit | Client build、Host/Client 语法检查、69 项测试通过 |
| Message Edit | 失败：`package.json` 指向缺失的 `scripts/build.mjs`，当前仅有可运行 Host/Client 快照 |
| Workspace Lineage | build 通过；原构建脚本依赖旧工程相对路径，迁移后已改为统一仓库根依赖路径 |
| Cowork | typecheck、build、全部 workspace 测试通过 |
| Desktop | 12 项单元测试通过 |

## 许可证与可复现性缺口

- Better Sidebar、Cowork 和 Harness 已保留各自 MIT LICENSE 与历史。
- File Edit、Message Edit、Workspace Lineage 的包 manifest 声明 MIT，但旧源码目录未包含独立 LICENSE；正式公开发行前必须补齐可追溯的版权文本。
- Message Edit 的 Client source map 含完整 `sourcesContent`，但 Host TypeScript 源码和构建脚本缺失。在恢复维护源之前，只能验证快照，不能宣称该插件可从源码完全复现。
- 正式候选打包必须在上述许可证和 Message Edit 可复现性缺口关闭后才能晋级。

## 数据保护确认

迁移未读取或复制会话正文、工作区文件、凭据、审核账本、删除隔离区、日志、settings/state、Mnemon 数据、Stable profile 内容或已安装 App。当前 Stable App 未退出、未覆盖、未重启，目标仓库未推送远程。
