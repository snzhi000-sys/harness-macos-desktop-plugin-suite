# Agent Note: 桌面产品打包链路失败即停止

Status: implemented

[English](2026-09-01-desktop-product-build-pipeline.md) | 中文

## Problem

Dev 与 Stable 命令原本是一长串 Shell 步骤，不会强制重建产品插件，也不校验最终 App 的通道元数据和包内 UI 行为。新构建尚未结束时旧 App 仍可能可见，源码修改也可能被旧 Client bundle 遗漏。临时启动验收还使用了 Electron Helper 不采纳的参数形式，并触发了历史 Dev 凭据迁移。

## Decision

下述桌宠仅进入 Dev 的选择已由 [Stable 桌宠](../feature/2026-09-09-stable-desktop-pet.zh.md)替代；其他构建与安装门槛继续有效。

Profile 准备、组成验证和 Electron 打包共用通道选择。桌面宠物保留在 Dev，Stable 排除其包、资源、bundle 条目、原生窗口文件和 IPC 启用；其余六个插件继续执行必需检查。这让尚未验收的可选功能不进入 Stable，同时保留开发源码和用户数据。包内归档检查拒绝误带宠物，隔离启动验证可选模块排除不会破坏 Electron 启动。通道输出共用源码和中间目录，因此构建必须串行执行。

`desktop/scripts/build-product-app.mjs` 统一负责两个通道。它会在准备 Runtime 前重建 Harness Host 和 Client 库，再重建并测试产品插件，执行桌面与隐私检查，准备 Runtime 和 Profile，验证真实 Cordis 与 Client 组成，写入发行信息，复用已校验的本机 Electron 发行文件，并在每个通道唯一的固定暂存目录构建。`verify-product-app.mjs` 校验 Bundle ID、产品名、包内通道、版本、构建时间、签名、当前 Better Sidebar 标记、选定的 Harness Client Runtime 行为，以及 File Edit 包版本与已启用的 v2 Shell 事务、递归 COW、工作区串行化、保留策略、删除结算和首屏不恢复标记。`verify-product-launch.mjs` 使用 `--user-data-dir=<绝对路径>` 启动候选，要求包内 Runtime 与 Profile 成功启动，拒绝迁移凭据，最后只终止自己启动的进程并删除临时数据。`exitCode` 或 `signalCode` 任一完成才代表信号退出已结算；强制终止后还需再次有限等待，递归清理则重试瞬时 `ENOTEMPTY`。干净首次启动最多允许 300 秒完成 Runtime/Profile 解压；超时或提前退出错误只保留已脱敏日志尾部，不能只指向随后被删除的日志路径。

所有检查通过后才覆盖固定 `dist/dev` 或 `dist/stable`。目标 App 正在运行时拒绝替换，并保留唯一固定暂存候选供检查。关闭该 App 后，可使用 `product:publish:candidate:dev` 或 `product:publish:candidate:stable` 重新执行候选隐私、身份/功能与隔离启动验证，再发布已保留的包，无需重建无关依赖。Stable 构建与显式安装继续分离。

## Alternatives considered

**保留 package.json Shell 长链。** 它无法表达最终候选断言，也无法在隔离启动通过后再安全发布。

**相信源码 diff 或包文件存在。** 两者都不能证明打包 Profile 使用了重新构建的 Client bundle。

**复用日常 Dev userData 启动验收。** 这会掩盖首次安装缺陷，并可能把已有凭据或 Profile 状态误当成包内行为。

## Consequences

桌面打包会因重建 Harness 库和产品插件、执行真实隔离启动而耗时更长，但源码改动不会再静默复用旧 Runtime 库，交付路径也只会指向完整候选。Dev 与 Stable 输出保持分离，并且只覆盖各自上一份候选。发行元数据和选定产品行为会在发布前由机器校验。
