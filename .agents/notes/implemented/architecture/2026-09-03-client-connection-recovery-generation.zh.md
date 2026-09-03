# Agent Note: Client 连接恢复 generation

Status: implemented

[English](2026-09-03-client-connection-recovery-generation.md) | 中文

## Problem

浏览器使用两条独立建立的 WebSocket 下行连接和一个粗粒度重连循环。空闲代理可能回收健康 socket；较慢的就绪握手会在超时后被当作已经连接；Runtime 回调之外无法观察恢复状态；旧 Session 或 Workspace 列表响应可能在新连接已经建立后发布。已打开 Session 的重建还会在替换历史到达前清空已经提交的对话。

## Decision

Host 按一个可配置间隔发送 WebSocket Ping 控制帧，并且只在连续两次未收到 Pong 后终止 socket。现有 mux 与 Host 下行继续保持独立；心跳和恢复所有权不要求合并传输层。

`ConnectionController` 统一持有就绪、generation 身份、卡顿提示、重试退避和立即重连。它通过共享的 `ctx.connection.state` 数据源发布 `connecting`、`connected`、`stalled` 和 `reconnecting`。`ctx.connection.reconnect()` 只中止当前 generation 或退避等待。只有所属 generation 仍有效时，stream sink 才会接收帧。

每个已建立 generation 都触发现有 Runtime 对账路径。Session 与 Workspace 列表刷新会替换旧 generation 的刷新，并且只有最新请求 token 可以发布。已打开 Session 在 resync 加载期间继续显示原历史，并在当前 generation 的历史到达后原子替换。现有模型目录和插件状态消费者继续通过 `connection/reset` 刷新，其 store 已具有最新加载 generation 防护。

恢复流程只重试订阅和权威读取。Fork、重命名、文件操作、审核决定、Browser 布局写入和其他非幂等命令仍由调用方持有，连接层绝不重放。

打包 Desktop 后端如果意外退出，壳层会在原 loopback 端口有限次重启它。原 Renderer 和 origin 保持不变，使 Connection Controller 能恢复现有页面；只有连续恢复失败后才显示静态错误页。

## Alternatives considered

**直接 cherry-pick 上游单 Remote stream 传输。** 不采用，因为本地产品仍公开 API Proxy mux 和 Host 两条下行；替换该载体会把迁移范围扩大到生成 Remote API 与全部传输消费者。

**把就绪超时视为连接成功。** 不采用，因为缺少 stream 订阅会使对账先于增量基线运行。较慢的 Host 保持 stalled，直到真实握手完成或传输结束。

**断线后刷新浏览器页面。** 不采用，因为刷新会丢弃内存中的乐观状态和浏览状态，把恢复扩大为插件重新激活，并且无法区分幂等读取与结果未知的写操作。

**拉取替换历史前清空 Session 状态。** 不采用，因为断线期间已有提交窗口仍是有效展示状态。原子替换可以保留可见用户消息，同时拒绝迟到响应。

## Consequences

空闲连接可以跨过中间层超时，短时 Host 卡顿与传输断开可以区分，用户也能在不重启 Desktop 后端的情况下重新启动恢复。新 generation 会对账 Session、Workspace、模型和插件派生状态，并拒绝旧基线。Host 为每个下行 acceptor 持有一个心跳计时器，客户端在恢复期间保留最后提交的对话。非幂等操作在传输丢失后仍可能返回结果未知，此时必须通过快照对账，而不能自动重试。

Desktop 后端崩溃恢复现在要求继续占用原端口；端口无法重新绑定时会按有界退避重试五次，然后明确失败。该恢复不会导航或刷新 Renderer。
