# Agent Note: 验证桌面产品插件的实际运行装配

Status: implemented

[English](2026-09-01-desktop-profile-runtime-verification.md) | 中文

## Problem

桌面 Profile 包含某个 NPM 包，不代表它的 Cordis patch 已经挂载，也不代表它的 Client bundle 已经发布。仅检查压缩包内容和后端就绪状态，无法证明定制桌面 App 依赖的产品插件真实可用。

## Decision

`distribution/profile-manifest.json` 为每个必需产品插件记录包名、Cordis 配置项 id 和 Client 要求。桌面打包命令在准备[干净产品 Profile](../feature/2026-08-27-desktop-clean-plugin-distribution.md) 与运行时之后、调用 Electron Builder 之前运行 `verify:profile-runtime`。

验证器将两个压缩包解压到新建的临时目录，检查 Profile 的组合包顺序与包身份，使用打包运行时生成最终 Cordis 配置，并启动隔离的 Web 后端。缺少必需 Cordis 配置项或必需 Client bundle 时，构建直接失败。验证结束后清理临时后端和文件。

必需集合包括 Workspace Lineage、Better Sidebar、Cowork、Message Edit 和 File Edit。Cowork 只包含 Host；其余四个插件还必须出现在 Web 启动 manifest 中。

## Alternatives considered

**只检查 `node_modules`。** 这种检查只能证明包已安装，无法发现 Cordis 组合或 Client 发现缺失。

**将开发者的 Stable Profile 用作发行模板。** 这种方式会掩盖产品声明缺失，并可能把个人插件、路径、状态或凭据复制进 App。

**只依赖人工 UI 测试。** 人工测试仍用于验证产品行为，但它发生较晚，也容易被遗漏，不适合作为唯一打包保护措施。

## Consequences

桌面打包会额外执行一次隔离后端启动和压缩包解压。任何必需定制插件没有进入实际运行 composition 时，Dev 或 Stable 候选都无法生成。用户数据和已安装的 Stable App 不作为验证输入。
