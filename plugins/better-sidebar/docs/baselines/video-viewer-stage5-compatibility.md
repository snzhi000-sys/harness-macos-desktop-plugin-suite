# Video Viewer — 阶段 5 编码兼容与错误兜底基线

记录时间：2026-08-28（Asia/Shanghai）。权威源码为 `<legacy-root>/dsh-better-sidebar-fork`。

## 检测与错误契约

- 视频首次激活后先向同一流式 URL 发起无正文 `HEAD`，成功后才给 `<video>` 附加 `src`；不会 `fetch().arrayBuffer()`，不会建立完整文件 Blob。
- Host 用 `x-dsh-media-error` 区分 `missing`、`too-large`、`forbidden`、`range`、`unreadable` 和 `network`。
- Client 联合 `HEAD`、`canPlayType()`、`loadedmetadata`、`canplay`、`waiting`、`stalled`、`error` 和 `MediaError.code` 判断失败原因。
- 首次加载 20 秒仍没有 metadata 时结束无限 loading，进入可操作错误页。
- 错误页始终提供重试、系统默认播放器和下载。超过 `videoLimit` 的文件不能内置预览，但显式下载仍走文件流，不进入 Node 整文件内存。
- 浏览器无法可靠区分“视频编码不支持”“音频编码不支持”和“文件数据损坏”；`MEDIA_ERR_DECODE` 因此明确显示组合说明，避免伪造过度精确的诊断。只有 Host 状态、无视频轨道、容器能力为空等可证实时才单独分类。
- 不引入转码、媒体探测依赖、缓存副本或大型临时文件。

## 本机样本确认

样本位于仓库外的 `<external-test-fixtures>/video-viewer-stage0`。本阶段以 `ffprobe` 再次确认容器与轨道；真实 Harness/Electron 解码结果需要部署后人工验收，未验证项不得写成已支持。

| 样本 | ffprobe 结果 | 路由/错误预期 | 当前状态 |
| --- | --- | --- | --- |
| `h264-aac-faststart.mp4` | MP4，H.264 High + AAC LC | 右栏播放；支持拖动 | Host/UI 自动化通过，桌面解码待验收 |
| `h264-aac-moov-tail.mp4` | MP4，H.264 High + AAC LC，尾部 metadata | Range 读取 metadata 后播放 | Host/UI 自动化通过，桌面解码待验收 |
| `vp9-opus.webm` | WebM，VP9 Profile 0 + Opus | 右栏播放 | Host/UI 自动化通过，桌面解码待验收 |
| `h264-aac.mov` | MOV，H.264 High + AAC LC | 尽量播放，失败则明确兜底 | 桌面解码待验收 |
| `hevc.mp4` | MP4，HEVC Main | 由当前 Electron/系统解码能力决定 | 桌面设备结果待验收 |
| WebM AV1/Opus | 尚无本机样本 | 由当前 Electron 解码能力决定 | 待补样本与桌面验收 |
| `video-only.mp4` | MP4，H.264，无音轨 | 正常无声播放 | 桌面解码待验收 |
| `audio-only.mp4` | MP4，AAC，无视频轨道 | 明确“没有可显示的视频轨道”并兜底 | 自动化通过 |
| `damaged-truncated.mp4` | ffprobe 无法读取 header | metadata/decode 错误并兜底 | 自动化错误路径通过，桌面样本待验收 |
| `unsupported-mpeg2.avi` | AVI，MPEG-2 Video | 不创建 Preview，系统打开或下载 | 路由自动化通过 |
| MKV/WMV | Viewer 不认领 | 系统打开或下载 | 路由契约已固定；WMV 样本待补 |

## 自动化覆盖

- HEAD 仅在视频首次激活后发出；恢复且面板收起时没有媒体请求。
- 404、413、403、416、不可读和网络状态分类。
- `MediaError` aborted/network/decode/src-not-supported 分类与 `canPlayType()` 联合判断。
- metadata 超时、音频-only 黑屏防护、重试重新创建媒体元素。
- 错误后的系统播放器和下载入口。
- Viewer 关闭时新请求继续走统一系统/下载兜底。

桌面人工验收不得在本文件中预填结果；部署后应记录 Electron 实际播放、音频、拖动、全屏和画中画结果。
