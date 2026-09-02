# Agent Note: 桌面产品打包链路失败即停止

Status: implemented

[English](2026-09-01-desktop-product-build-pipeline.md) | 中文

## Problem

Dev 与 Stable 命令原本是一长串 Shell 步骤，不会强制重建产品插件，也不校验最终 App 的通道元数据和包内 UI 行为。新构建尚未结束时旧 App 仍可能可见，源码修改也可能被旧 Client bundle 遗漏。临时启动验收还使用了 Electron Helper 不采纳的参数形式，并触发了历史 Dev 凭据迁移。

## Decision

`desktop/scripts/build-product-app.mjs` 统一负责两个通道。它会在准备 Runtime 前重建 Harness Host 和 Client 库，再重建并测试产品插件，执行桌面与隐私检查，准备 Runtime 和 Profile，验证真实 Cordis 与 Client 组成，写入发行信息，复用已校验的本机 Electron 发行文件，并在每个通道唯一的固定暂存目录构建。`verify-product-app.mjs` 校验 Bundle ID、产品名、包内通道、版本、构建时间、签名、当前 Better Sidebar 功能标记和选定的 Harness Client Runtime 行为标记。`verify-product-launch.mjs` 使用 `--user-data-dir=<绝对路径>` 启动候选，要求包内 Runtime 与 Profile 成功启动，拒绝迁移凭据，最后只终止自己启动的进程并删除临时数据。

所有检查通过后才覆盖固定 `dist/dev` 或 `dist/stable`。目标 App 正在运行时拒绝替换，并保留唯一固定暂存候选供检查。关闭该 App 后，可使用 `product:publish:candidate:dev` 或 `product:publish:candidate:stable` 重新执行候选隐私、身份/功能与隔离启动验证，再发布已保留的包，无需重建无关依赖。Stable 构建与显式安装继续分离。

## Alternatives considered

**保留 package.json Shell 长链。** 它无法表达最终候选断言，也无法在隔离启动通过后再安全发布。

**相信源码 diff 或包文件存在。** 两者都不能证明打包 Profile 使用了重新构建的 Client bundle。

**复用日常 Dev userData 启动验收。** 这会掩盖首次安装缺陷，并可能把已有凭据或 Profile 状态误当成包内行为。

## Consequences

桌面打包会因重建 Harness 库和产品插件、执行真实隔离启动而耗时更长，但源码改动不会再静默复用旧 Runtime 库，交付路径也只会指向完整候选。Dev 与 Stable 输出保持分离，并且只覆盖各自上一份候选。发行元数据和选定产品行为会在发布前由机器校验。
