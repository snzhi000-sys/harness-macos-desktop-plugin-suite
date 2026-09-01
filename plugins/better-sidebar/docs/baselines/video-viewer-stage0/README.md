# Video Viewer — 阶段 0 基线

记录时间：2026-08-28（Asia/Shanghai）。本记录用于在实现侧边栏视频播放前固定代码、运行环境、媒体接口和测试样本基线。

## 范围与保护约束

- 权威源码：`<legacy-root>/dsh-better-sidebar-fork`
- 分支 / HEAD：`main` / `717df775b2414322a22f6a43017dc01e8784db8d`
- 插件版本：`0.10.25`
- 仓库已有大量阶段 1–5、Explorer、Browser、Preview、持久化和测试改动；全部按用户既有工作保护。
- 检查开始时共有 65 个 tracked/untracked 状态条目；tracked diff 为 38 个文件、3597 行新增、589 行删除。
- 未执行 `git reset`、`git checkout`、`git clean`，未部署插件，未重启 App，未实现视频 Viewer。
- 按阶段计划执行了 `pnpm build`；该命令重建被 `.gitignore` 排除的 `lib/` 构建产物，没有安装到运行 Profile。

## 桌面运行组成

- App：`/Applications/DeepSeek Harness.app`
- App 版本 / build：`0.1.0-rc.5-local.4`
- Electron：`43.4.0`
- 当前运行时：`<stable-user-data>/runtimes/<runtime-id>`
- Web Profile：`<stable-user-data>/harness/profiles/web`
- Profile 依赖：`dsh-better-sidebar: link:<legacy-root>/dsh-better-sidebar-fork`
- Profile 中的实际软链接解析到上述权威源码，不是另一个插件副本。

## 当前 Preview / 媒体实现

- 右栏 Preview 白名单为 `image`、`pdf`、`docx`、`xlsx`、`pptx`，当前没有 `video` Viewer。
- `/sidebar/file` 仅接受可信 Host 发起的 `GET` 请求，并以会话工作区为边界执行 lexical、`realpath` 和软链接逃逸检查。
- `mediaLimit` 默认值和当前测试契约均为 `20 * 1024 * 1024` bytes。
- 路由先检查文件大小，再用 `readFile(path)` 将整个文件读入内存并返回 `200`。
- 路由未解析请求头 `Range`，也不返回 `206`、`Content-Range` 或 `Accept-Ranges`，因此不适合 1–2GB 视频或原生进度条随机拖动。
- 当前 MIME 映射只显式覆盖图片、PDF 和 HTML；视频扩展名会回退为 `application/octet-stream`。
- 现有 44 个测试文件覆盖 Preview/Browser 共用右栏、文件路由、图片/PDF/Office、安全边界、生命周期和持久化，阶段 0 全量测试通过。

## 本机视频样本

样本为 `ffmpeg` 生成的 2 秒测试图与正弦音，不含用户内容，保存在仓库外：

`<external-test-fixtures>/video-viewer-stage0`

| 文件 | 大小 | 容器 / 轨道 | 目的 |
| --- | ---: | --- | --- |
| `h264-aac-faststart.mp4` | 75,657 B | MP4 / H.264 + AAC | 常规支持格式，`moov` 偏移 36 |
| `h264-aac-moov-tail.mp4` | 75,657 B | MP4 / H.264 + AAC | 文件尾元数据，`moov` 偏移 72,882 |
| `vp9-opus.webm` | 89,325 B | WebM / VP9 + Opus | Chromium 开放格式 |
| `h264-aac.mov` | 75,708 B | MOV / H.264 + AAC | MOV 容器兼容性 |
| `hevc.mp4` | 53,980 B | MP4 / HEVC | 平台/编码兼容性与错误提示 |
| `video-only.mp4` | 56,553 B | MP4 / H.264，无音轨 | 无音轨边界 |
| `audio-only.mp4` | 18,910 B | MP4 / AAC，无视频轨 | 错误类型/兜底边界 |
| `damaged-truncated.mp4` | 1,024 B | 截断 MP4 | 损坏文件错误态 |
| `unsupported-mpeg2.avi` | 119,452 B | AVI / MPEG-2 | 非目标容器/编码负例候选 |

另有工作区边界样本：

- `<external-test-fixtures>/video-viewer-stage0-workspace/inside-workspace.mp4`
- 同目录的 `escape-to-external.mp4` 是指向工作区外样本的软链接，用于验证拒绝逃逸。

当前缺口：未创建或发现 1GB+、接近 2GB 的 MP4。大型样本不会进入 Git，待流式接口完成后再用稀疏/受控本机样本进行性能验收。上述小样本目前也未加入 Git。

## 自动化基线

从插件源码目录执行：

```text
pnpm test
  PASS — 44 test files, 493 tests

pnpm typecheck
  PASS — tsc --noEmit

pnpm build
  PASS — host/client/chunk bundles built
  NOTE — tsdown 输出既有 external/noExternal deprecated 与 onlyBundle 建议警告

git diff --check
  PASS
```

## 阶段 0 结论

- 权威源码、运行 Profile 链接、App/Electron 版本已确认。
- 当前 Browser、Preview、图片、PDF、Office 相关自动化基线为绿色。
- 当前媒体接口的 20MB、整文件读取、无 Range、无视频 MIME/Viewer 限制已固定。
- 小型格式、编码、损坏、无音轨、尾部 `moov` 和软链接逃逸样本已准备；大型性能样本明确留待后续本机验收。
- 阶段 1 尚未开始，运行中的 Harness 没有被部署或重启。
