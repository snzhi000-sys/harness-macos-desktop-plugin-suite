# Agent Note: macOS Electron 桌面外壳

Status: implemented

[English](2026-08-14-macos-electron-desktop-wrapper.md) | 中文

## Problem

已发布的 Web profile 同时需要 Node 进程和浏览器，因此单独的静态 Web 产物无法提供终端、文件系统、会话或模型能力。从 Finder 启动的应用还必须脱离源码检出目录、系统 Node 和 pnpm 运行，适应只读的已签名应用包，并在退出时停止后端且不遗留孤儿进程。

## Decision

根目录下的 `desktop` 构建器围绕现有 `dsh web` profile 生成 Apple Silicon Electron 应用。BrowserWindow 启用上下文隔离和渲染器沙箱，只允许导航到本地回环后端的同源地址，其他 URL 均交给 macOS 打开。

构建过程打包当前检出版本的传递运行时工作区包，安装其生产依赖闭包，复制构建机器的 Node 可执行文件，并将运行时保存为签名的 gzip 归档。应用把每个归档解压到 Application Support 目录下按内容寻址的位置，而且仅在解压成功后写入完成标记。Harness profile 和会话使用单独的 `harness` 子目录，因此 Electron 锁文件不会进入 Harness 文件监视范围。

主进程在系统分配的本地回环端口启动 `dsh web`，并将其完成装配后的 URL 消息视为就绪信号。退出应用时先发送 SIGTERM 并等待后端结束；超过八秒后才使用 SIGKILL。面向 Finder 的可执行路径包含内置运行时以及标准 Homebrew 和系统目录。

macOS 窗口使用 `hiddenInset` 原生标题栏，并由 Renderer 绘制 32 像素高的可拖拽区域。Renderer 把固定的 `Harness` 标题定位在整个窗口宽度的 50%，不受红黄绿窗口按钮影响。沙箱化的 preload 桥接只接收 Harness 界面最终解析出的浅色/深色模式和界面颜色；主进程通过 Electron 原生主题应用该模式并更新窗口背景。因此，在 Harness 的“外观”设置中切换主题时，Renderer 和桌面壳会同步变化，同时页面无法访问 Node API。主进程还会阻止页面标题替换固定的应用标题。

本机构建使用 Electron Builder 的 Hardened Runtime 权限和临时签名。安装器会在复制前保留已有应用，并原样保存 framework 的相对符号链接，避免复制过程破坏签名。

## Alternatives considered

**基于源码目录的 Finder 启动器。** 未采用，因为移动仓库或者改变 Node、pnpm 安装都会导致应用失效。

**静态 WebView 或已安装的 PWA。** 未采用，因为 Web 前端不是独立应用，无法替代 Node Host 能力。

**带 Node sidecar 的 SwiftUI、WKWebView 或 Tauri。** 未采用，因为 Harness 仍然需要 Node，而 Electron 已经提供兼容的 Web 窗口和进程分发模型。增加第二种原生运行时只会增加打包工作，无法移除 Node 运行时。

## Consequences

安装后的应用可以脱离源码从 `/Applications` 启动，把运行时和用户写入都保存在签名包之外，并在首次启动后复用已经解压的运行时。标题会保持横向居中，桌面标题栏也会在运行时跟随 Harness 的外观设置。应用目前是 arm64 本机构建，运行时归档会增加应用和首次启动的磁盘占用。临时签名支持在不关闭 Gatekeeper 的情况下本地安装，但通过互联网分发仍然需要 Developer ID Application 证书、Apple 公证和已经装订的公证票据。
