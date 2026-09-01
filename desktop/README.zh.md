# DeepSeek Harness 桌面构建器

[English](README.md) | 中文

本目录把当前检出版本构建为独立的 Apple Silicon macOS 应用。应用会在系统分配的本地回环端口启动内置的 `dsh web` 后端，等待其就绪消息，然后在启用安全隔离的 Electron 窗口中显示该地址。退出应用时会停止并等待后端进程结束。

构建过程会打包当前工作区的运行时依赖闭包，并复制构建时使用的 Node 可执行文件。首次启动时，应用会把已签名的运行时归档解压到 `~/Library/Application Support/DeepSeek Harness` 下按内容寻址的目录；后续启动会复用这个已经完整解压的目录。安装后的应用不会写入已经签名的应用包。Harness 配置和会话保存在单独的 `harness` 子目录，避免 Electron 自身的锁文件进入 Harness 文件监视范围。

分享构建还会包含一份已安装 Web 插件的干净快照。首次启动且不存在 `profiles/web` 目录时，桌面壳会在启动 Harness 前安装该快照。Dev 构建会记录内置 Profile 标识；替换构建携带新标识时，会原子替换由产品维护的 Profile。Stable 构建会复制现有用户 Profile、叠加包内产品模块，再原子切换到合并副本；用户组成文件和额外插件保持不变。两条路径都会保留 Profile 之外的凭据、会话、工作区、设置、应用日志和状态存储。快照只包含插件包和经过清理的组成清单，不包含用户数据或本机专属路径。

Dev 和 Stable 发行命令会在打包前后执行隐私检查。源码检查同时覆盖 Git 已跟踪文件和未被忽略的未跟踪文件；发行检查会解压包内 Runtime、Profile 和 Electron 应用归档，并拒绝个人状态文件、绝对软链接、私钥文件和构建机主目录路径。Runtime 安装阶段可以使用本地包压缩文件，但进入归档的清单只保留包版本号。

Renderer 会通过沙箱化的 preload 桥接，把最终解析出的浅色/深色模式和界面颜色发送给桌面壳。Electron 据此更新原生外观与窗口背景，Renderer 中的可拖拽区域则绘制固定且横向居中的 `Harness` 标题，因此切换任务或工作区不会再改变 macOS 窗口标题。

在内置运行时和 Web 后端启动期间，桌面窗口只用三个大占位区域暗示会话列表、Explorer 和对话主区，不描绘控件或内容细节。占位区域优先沿用 Harness 上次上报的亮色或暗黑外观；尚无偏好时跟随操作系统，并在实时 Web 界面载入前淡出。桌面壳只会把校验后的 `light` 或 `dark` 值保存到 `~/Library/Application Support/DeepSeek Harness/appearance-state.json`。

应用会将用户最后一次设置的正常窗口位置和大小保存到 `~/Library/Application Support/DeepSeek Harness/window-state.json`。后续启动优先恢复该状态；没有有效记录时才使用 `1380 × 900` 的默认尺寸。显示器断开或分辨率改变后，恢复逻辑会重新约束窗口，避免窗口落在当前可视区域之外。

## 构建和安装

在 Apple Silicon Mac 上进入本目录后运行：

```sh
npm install
npm run install:mac
```

该命令会创建采用临时签名的应用，并将其复制到 `/Applications/DeepSeek Harness.app`。如果已有安装且 `/Applications/DeepSeek Harness.previous.app` 尚未占用，就使用该路径保留旧 App；后续安装改用带时间戳的 `DeepSeek Harness.backup-*.app`，不会覆盖更早备份。复制失败时，安装器会恢复本轮刚移动的旧 App。

本机构建不需要 Apple 开发者证书。通过互联网分发仍然需要 Developer ID Application 证书、Hardened Runtime、Apple 公证和已装订的公证票据。

桌面启动日志保存在 `~/Library/Application Support/DeepSeek Harness/logs/desktop.log`。
