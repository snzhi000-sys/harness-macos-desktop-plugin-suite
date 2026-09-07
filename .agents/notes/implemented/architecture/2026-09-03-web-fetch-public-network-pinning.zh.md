# Agent Note：WebFetch 公网验证与地址固定

状态：已实现

[English](2026-09-03-web-fetch-public-network-pinning.md) | 中文

## 问题

本地 HTTP WebFetch Provider 原先会校验 URL 格式、凭据、重定向来源、时间与大小，但会把模型选择的主机名直接交给全局 `fetch()`。因此，主机名可能直接解析到私网服务、返回公网与私网混合答案集，或在验证与连接之间改变结果。IPv6 DNS64／NAT64 还可能把私网 IPv4 目标隐藏在看似全局可达的 IPv6 地址中。

该策略只属于模型可调用的 WebFetch。Better Sidebar Browser 渲染用户明确输入的地址，并保留独立的浏览器权限；它不得复用本 Provider 的判断，也不得把更宽的交互式浏览能力暴露给模型工具。

## 决策

`web-fetch-http` 现在对每一个请求跳执行验证与固定：

1. 基础 URL 策略只接受 HTTP(S)，拒绝嵌入凭据与 Unix socket scheme，并保留可配置 URL 长度上限。
2. `resolvePublicAddresses()` 解析完整 DNS 答案集。任何成员格式错误、结果为空或包含非公网地址时，整个目标都 fail closed。
3. 使用 `ipaddr.js` 分类 IPv4、IPv6 与 IPv4-mapped IPv6，拒绝 loopback、私网、link-local、CGNAT、文档保留、多播、广播、未指定及保留地址。
4. 出现 IPv6 答案时，按 RFC 7050 发现网络专用 RFC 6052 DNS64 前缀；若匹配目标内嵌的 IPv4 地址不是公网地址，则拒绝请求。
5. 请求私有的 Undici `Agent` 通过 `createPinnedLookup()` 只接收已验证地址。URL 主机名保持不变，从而保留 HTTP Host 与 TLS SNI，并阻止二次 DNS 查询。
6. 每个同源重定向都重新执行 URL 校验、完整解析、NAT64 检查和地址固定。跨源重定向在解析或连接第二个目标前即被阻止，并要求发起新的工具调用。

本地实现有意不采用上游代理路径。由代理解析源站时，公开主机名可能在本地验证器不可见的位置映射到私网地址。代理设计能够证明等价的目标验证前，模型 WebFetch 只使用严格的固定地址直连传输。

## 考虑过的替代方案

- 原样复制上游最新的代理感知 Provider。未采用，因为代理侧 DNS 当前无法证明所选源站持续属于公网。
- 只检查 URL 字符串或 IP literal。未采用，因为普通主机名、混合 DNS 答案、rebinding 与 NAT64 仍可被利用。
- 校验 DNS 后调用全局 `fetch()`。未采用，因为传输层会再次进行不受控解析。
- 把同一限制应用到 Better Sidebar Browser。未采用，因为用户驱动的交互式浏览与模型选择的网络访问属于不同权限边界。

## 影响

模型 WebFetch 现在会对私网和不明确目标 fail closed，并为每一跳创建独立 dispatcher，因此增加 DNS 校验和连接池初始化成本。直连代理兼容性有意缺失。既有 URL、超时、大小、解码与同源重定向行为保持稳定。Better Sidebar Browser 不受影响；产品仍保持模型 Fetch 关闭，直到通道专属启用机制完成设计与验收。

## 产品装配边界

产品 Profile 仍设置 `fetch: false`，并且没有挂载 Fetch Provider。Dev 与 Stable 当前共用同一份 Profile 源码，因此阶段 4 不修改这份共享配置。将 WebFetch 打开到可分发 Dev 通道前，需要另行建立通道专属 Profile 组成机制；Stable 是否启用仍是独立的产品与安全决策。

## 验证约定

测试只使用受控 resolver 和通过注入固定地址访问的 loopback HTTP fixture。生产解析覆盖公网／非公网分类、混合答案、空或错误答案、中止、IPv4-mapped IPv6 和 DNS64／NAT64；传输测试证明同源重定向每一跳都会重新解析，跨源重定向不会解析或连接第二个来源。测试不访问真实内网服务。

后续改动必须保留完整答案集校验、逐跳复检、原始主机名 SNI／Host、私有 dispatcher 释放，以及与 Better Sidebar Browser 权限的隔离。
