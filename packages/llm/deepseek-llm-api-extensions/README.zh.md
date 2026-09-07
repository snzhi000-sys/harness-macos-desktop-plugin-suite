# @deepseek-ai/dsh-deepseek-llm-api-extensions

[English](README.md) | 中文

用于给官方 DeepSeek 请求增加顶层字段、并由插件生命周期管理所有权的 Registry。

每个字段只能有一个所有者。Provider 会在网络请求前根据已序列化的准确请求准备 JSON 值；Registry 返回分离且深度冻结的快照。Provider 可以返回 `accept` 回调，适配器收到 HTTP 2xx 后至多执行一次。重复或空白字段名会导致注册失败，准备过程响应取消信号，所有确认回调都会结算后再报告失败。

本包自身不携带任何字段。产品能力注册相互独立的 Provider；DeepSeek 适配器会拒绝与原生请求字段冲突的扩展字段。

## 模型体验

### 请求扩展

#### 模型看到什么

Registry 自身不增加 prompt 或消息内容。已注册字段可能影响提供方侧请求处理，但该行为必须由字段所有者说明。

#### Token 影响

Registry 不改变模型可见 token。

#### KV Cache 影响

Registry 不改变模型可见前缀；提供方是否按扩展字段划分缓存不属于 Harness 契约。

## 已知限制与暂缓事项

- 扩展字段目前只由官方 DeepSeek 适配器支持；其他适配器需要各自的 typed Registry。
- 确认属于进程内的 HTTP 2xx 后事务，Host 终止时不能持久恢复。
