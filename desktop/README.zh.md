# DeepSeek Harness 桌面构建器

[English](README.md) | 中文

桌面宠物通过 `product-channel.cjs` 同时进入 Dev 和 Stable，包含资源、bundle 注册、原生窗口及受限 IPC。Stable 升级在暂存用户清单中补入缺失的桌宠 bundle 和依赖，原清单备份为 `package.json.before-desktop-pet`；无关配置和状态保持不变。Dev 与 Stable 共用中间产物，必须串行构建。

本目录把当前检出版本构建为独立的 Apple Silicon macOS 应用。应用会在系统分配的本地回环端口启动内置的 `dsh web` 后端，等待其就绪消息，然后在启用安全隔离的 Electron 窗口中显示该地址。退出应用时会停止并等待后端进程结束。

构建过程会打包当前工作区的运行时依赖闭包，并复制构建时使用的 Node 可执行文件。首次启动时，应用会把已签名的运行时归档解压到 `~/Library/Application Support/DeepSeek Harness` 下按内容寻址的目录；后续启动会复用这个已经完整解压的目录。安装后的应用不会写入已经签名的应用包。Harness 配置和会话保存在单独的 `harness` 子目录，避免 Electron 自身的锁文件进入 Harness 文件监视范围。

分享构建还会包含一份已安装 Web 插件的干净快照。首次启动且不存在 `profiles/web` 目录时，桌面壳会在启动 Harness 前安装该快照。Dev 构建会记录内置 Profile 标识；替换构建携带新标识时，会原子替换由产品维护的 Profile。Stable 构建会复制现有用户 Profile、叠加包内产品模块，再原子切换到合并副本；用户组成文件和额外插件保持不变。两条路径都会保留 Profile 之外的凭据、会话、工作区、设置、应用日志和状态存储。快照只包含插件包和经过清理的组成清单，不包含用户数据或本机专属路径。

Dev 和 Stable 发行命令会在打包前后执行隐私检查。源码检查同时覆盖 Git 已跟踪文件和未被忽略的未跟踪文件；发行检查会解压包内 Runtime、Profile 和 Electron 应用归档，并拒绝个人状态文件、绝对软链接、私钥文件和构建机主目录路径。Runtime 安装阶段可以使用本地包压缩文件，但进入归档的清单只保留包版本号。

Renderer 会通过沙箱化的 preload 桥接，把最终解析出的浅色/深色模式和界面颜色发送给桌面壳。Electron 据此更新原生外观与窗口背景，Renderer 中的可拖拽区域则绘制固定且横向居中的 `Harness` 标题，因此切换任务或工作区不会再改变 macOS 窗口标题。

在内置运行时和 Web 后端启动期间，桌面窗口只用三个大占位区域暗示会话列表、Explorer 和对话主区，不描绘控件或内容细节。占位区域优先沿用 Harness 上次上报的亮色或暗黑外观；尚无偏好时跟随操作系统，并在实时 Web 界面载入前淡出。桌面壳只会把校验后的 `light` 或 `dark` 值保存到 `~/Library/Application Support/DeepSeek Harness/appearance-state.json`。

应用会将用户最后一次设置的正常窗口位置和大小保存到 `~/Library/Application Support/DeepSeek Harness/window-state.json`。后续启动优先恢复该状态；没有有效记录时才使用 `1380 × 900` 的默认尺寸。显示器断开或分辨率改变后，恢复逻辑会重新约束窗口，避免窗口落在当前可视区域之外。

Stable 会为 `cordis.patch.yml` 中启用的字面量 `dsh-file-edit` 条目补齐缺失的 `shellTransactionLifecycle`，即使 Profile 标识相同也会检查。显式值和禁用条目保持不变。迁移保留无关 YAML 值与注释，将原 patch 备份为 `.before-shell-transactions`，再原子替换；无效 YAML 会阻止启动。包内升级验证器在临时数据中执行该迁移，并验证真实 Bash 写入、删除、审核记录和拒绝恢复。

## 构建和安装

共用的 Electron Session 允许主窗口后端来源写入剪贴板，包括 Explorer 路径复制。剪贴板读取仍被拒绝；麦克风权限仅限所属桌宠聊天页面。在桌宠插件目录执行 `node scripts/clipboard-electron-smoke.mjs` 可回放完整装配的剪贴板回归。

[桌宠插件](../plugins/desktop-pet/README.md)负责角色资源、互动和设置。桌面壳提供沙箱隔离的透明窗口，其位置独立于主窗口保存。所属 Client 关闭或卸载时释放桌宠窗口，本地互动不需要语言模型请求。

在统一工程根目录构建 Dev 或 Stable：

```sh
npm run product:dist:dev
npm run product:dist:stable
```

两个命令都通过 `scripts/build-product-app.mjs` 先重建产品插件，在固定通道暂存目录生成候选，使用本机已校验的 Electron 缓存，校验 App 标识、版本、构建时间、包内功能标记、签名和隐私，并以 `--user-data-dir=<临时绝对路径>` 做无凭据迁移的隔离启动。全部通过后才分别覆盖 `dist/dev` 或 `dist/stable`；目标通道 App 正在运行时拒绝发布并保留唯一暂存候选。

Stable 候选不会自动安装。明确执行 `npm run install:stable` 时，安装器才会复制到 `/Applications/DeepSeek Harness.app`。如果已有安装且 `/Applications/DeepSeek Harness.previous.app` 尚未占用，就使用该路径保留旧 App；后续安装改用带时间戳的 `DeepSeek Harness.backup-*.app`，不会覆盖更早备份。复制失败时，安装器会恢复本轮刚移动的旧 App。

本机构建不需要 Apple 开发者证书。通过互联网分发仍然需要 Developer ID Application 证书、Hardened Runtime、Apple 公证和已装订的公证票据。

桌面启动日志保存在 `~/Library/Application Support/DeepSeek Harness/logs/desktop.log`。
