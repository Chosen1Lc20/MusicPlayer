# TECH_DESIGN · 网页音乐播放器（MusicPlayer）

| 项 | 内容 |
| --- | --- |
| 文档状态 | 随代码维护 |
| 最后更新 | 2026-10-20 |
| 关联文档 | [PRD](PRD.md)（需求与验收）、[AGENTS.md](AGENTS.md)（协作约定） |
| 部署 | GitHub Pages，`main` 分支根目录，无构建步骤 |

## 1. 约束与前提

- **零构建**：不引入包管理器、打包器、转译器，浏览器用 `<script>` 直接加载源码
- **无框架**：原生 DOM API + 原生 CSS
- **无服务端**：所有逻辑在浏览器内完成，导入的音频不离开用户设备
- **单页面无路由**：一个 `index.html` 就是一个应用，页内状态即全部状态
- 运行环境：现代浏览器（ES2015+、`async/await`、可选链、`TextDecoder`、`File`/`Blob`、IndexedDB）；拖放目录与曲库持久化在 Chromium 上体验最完整

## 2. 技术选型与代价

| 决策 | 选择 | 理由 | 代价 |
| --- | --- | --- | --- |
| 语言与组织 | 原生 JS + IIFE + `window` 全局对象 | 零构建是硬约束 | 没有模块系统，靠加载顺序和全局对象通信 |
| 标签解析 | vendored `jsmediatags` 3.9.7（MIT） | 自己实现 ID3v2 帧解析 + MP4 atom 遍历成本高、易错 | 多一个 53KB 第三方文件；**不支持 ogg**；其 FLAC 读取器不含歌词 |
| ogg / opus 标签 | 自研 Vorbis 注释解析（`js/metadata.js`） | 库不支持 ogg 容器，而国内客户端下载的 ogg 恰好最多 | 需要自己处理 Ogg 页/分段表、BASE64 图片块 |
| 曲库持久化 | IndexedDB 存**文件字节** | 各浏览器行为一致，恢复时不需要任何授权交互 | 磁盘上多存一份音频；大曲库占空间，空间不足只能提示 |
| 样式 | 单文件 CSS + `:root` 设计令牌 | 与零构建一致 | 无预处理器，复用靠类名约定 |
| 歌词格式 | LRC | 事实标准，用户可用文本工具自行修补 | 不支持逐字（KRC/QRC）或增强格式 |

未采用：`music-metadata-browser`（体积更大、浏览器全局名不稳定）、Web Audio API（当前不需要可视化/均衡器）、File System Access 句柄（见 §10）。

## 3. 模块架构

```
index.html
  │ <script> 顺序加载，不可调换
  ▼
js/vendor/jsmediatags.min.js ──► window.jsmediatags    标签解析库（UMD）
js/lyrics.js                 ──► window.LyricsParser   LRC 解析 + 二分查找当前行（纯函数）
js/metadata.js               ──► window.TrackMeta      标签解析 / 文件名推断 / 文本解码 / 文件配对 / 并发限制（无 DOM）
js/library.js                ──► window.TrackLibrary   IndexedDB 曲库读写（无 DOM）
js/playlist.js               ──► window.DEFAULT_PLAYLIST 内置曲目（当前为空数组）
js/app.js                                            播放器主逻辑：状态、渲染、事件、导入与持久化编排（唯一持有 DOM）
```

依赖方向单向：`app.js` 依赖其余全部；`lyrics.js`、`metadata.js`、`library.js` 互不依赖（`metadata.js` 只单向调用 `window.jsmediatags`）。后两者无 DOM 依赖，所以能直接在 Node 里 `require` 测试。

**加载顺序的原因**：`app.js` 在 IIFE 顶部就解构 `window.LyricsParser` 和 `window.TrackLibrary`，启动时会读 `window.DEFAULT_PLAYLIST`；导入流程依赖全局 `jsmediatags`。

**DOM 契约**：所有 `getElementById` 集中在 `app.js` 的 `el` 对象里。新增 DOM 元素必须同时改 `index.html` 和 `el`，否则启动时静默变成 `null`，后续交互全部失效。

## 4. 数据模型

### 4.1 曲目对象（`state.playlist[i]`）

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `id` | `state.trackSeq++` | 自增 id |
| `title` / `artist` / `album` | 文件名推断 → 内嵌标签覆盖 | 由 `enrichTrack` 二次覆盖 |
| `src` | `URL.createObjectURL(file)` | 播放源（blob URL） |
| `file` | 用户选择的 `File` | 重新解析标签、写入曲库都靠它；内置列表条目没有此字段 |
| `path` | `webkitRelativePath` 或文件名 | 配对键、曲库主键、重复导入判据 |
| `lrcFile` / `coverFile` | `pairFiles` 配对结果 | 同目录同名的 `.lrc` / 图片 |
| `lrcText` | 手动导入 > 同名 `.lrc` > 内嵌标签 | 有值即不再重复解析 |
| `cover` / `coverBlobUrl` | blob URL | `coverBlobUrl` 单独记录，替换封面时精确回收 |
| `duration` | `loadedmetadata` 事件 | 列表里显示时长 |
| `restored` | 恢复流程 | 标记来自曲库而非本次导入 |

### 4.2 运行时状态（`state`）

`playlist[]`、`current`、`lyrics[]`（`{time, text}` 升序）、`activeLine`、`mode`（`list` / `one` / `shuffle`）、`isSeeking`、`objectUrls[]`、`trackSeq`。

### 4.3 LRC 解析结果

`parseLRC(text)` → `[{ time: 秒(浮点), text: 歌词 }]`，按 `time` 升序；`findActiveIndex(lyrics, t)` 用二分查找返回 `time <= t` 的最后一个下标，找不到返回 `-1`。

### 4.4 曲库记录（IndexedDB）

数据库 `music-player`，version 1，objectStore `tracks`，`keyPath: "key"`。

| 字段 | 说明 |
| --- | --- |
| `key` | = `path`（同路径重复导入会覆盖而不是堆积） |
| `path` / `title` / `artist` / `album` | 展示用元数据 |
| `lrcText` | 歌词文本（内嵌或同名 `.lrc` 读到的结果） |
| `cover` | 配对到的封面图 Blob；**内嵌封面不存**，恢复时重新解析音频即可 |
| `audio` | 音频 `File`/`Blob` |
| `savedAt` | 恢复时保持原顺序 |

## 5. 关键流程

### 5.1 导入与配对

三种入口（拖放 / `webkitdirectory` 文件夹 / 多选文件）最终都走同一条链路：

1. `collectEntries(fileList)` → `[{ file, path }]`（`webkitRelativePath` 优先，否则用文件名）
2. `TrackMeta.pairFiles(entries)`：按扩展名分成音频 / 歌词 / 图片，建立两个索引（`目录|文件名主干` 精确索引、`文件名主干` 全局索引），为每首音频找 `lrcFile` 与 `coverFile`，产出 `warnings`
3. `addImport(seeds)`：按 `path` 去重（已导入或已恢复的跳过）；为音频创建 blob URL；标题/歌手先用文件名推断值；`state.current === -1` 时把第一首设为当前曲目
4. `TrackMeta.mapLimit(tracks, 3, enrichTrack)`：并发 3 补全标签，避免一次打开上百个文件
5. `persistTracks(tracks)`：补全完成后写入 IndexedDB

**配对规则（刻意保守）**

| 情况 | 行为 |
| --- | --- |
| 同目录 + 同文件名主干 | 直接配对 |
| 全局只有一个同名候选，且其中一边没有目录信息 | 配对 |
| 两边都有目录但目录不同 | **不配对**（宁可漏配，也不能把 A 专辑的歌词配到 B 专辑） |
| 同名候选不唯一 | **不配对** |
| 封面：同目录同名图片 | 优先 |
| 封面：同目录 `cover` / `folder` / `album` / `albumart` / `front` / `artwork` / `thumb` | 次选 |
| 未配对 | 提示条告知数量，用户可用「+ 当前歌词(.lrc)」手动补 |

### 5.2 元数据优先级

| 字段 | 优先级（左优先） |
| --- | --- |
| 标题 / 歌手 / 专辑 | 内嵌标签 → 文件名推断 → 文件名主干 |
| 封面 | 内嵌图片 → 同名图片 → 同目录的通用封面图 |
| 歌词 | 手动导入（当前曲目）→ 同名同目录 `.lrc` → 内嵌歌词 |

### 5.3 歌词加载

`loadLyrics(track)` 的分支：

1. `track.lrcText` 有值 → 直接 `setLyrics`
2. `track.lrcFile` 有值（本地导入配对到的 `.lrc`）→ 先清空，等 `enrichTrack` 异步读入后回填
3. `track.lrc` 有值（内置列表的路径）→ `fetch` 后缓存到 `lrcText`
4. 都没有 → 清空歌词

第 3 条有两个防护：`track.lrcText` 已存在时不再覆盖（手动导入优先），响应回来时若已切歌只缓存、不动界面（避免上一首的歌词闪到当前曲目上）。

### 5.4 播放与歌词同步

`playIndex(i)` 设置 `audio.src` → `applyTrackInfo()` → `loadLyrics()` → `renderPlaylist()` → `play()`。

播放期间 `audio.timeupdate` → `updateProgress()`（更新进度条与时间）→ `updateLyrics(currentTime)`（二分查找当前行；行号变化才做 DOM 操作）→ 平滑滚动到歌词容器中央（`scrollTo({behavior:"smooth"})`）。

进度条是一个小型状态机：`mousedown` 置 `isSeeking = true`，拖动期间只改视觉；`timeupdate` 在 `isSeeking` 为真时跳过进度更新；`mouseup` 落定并写入 `currentTime`。触摸事件是独立的第二套（`touchstart` / `touchmove` / `touchend`）。

### 5.5 曲库持久化

- **写入**：`trackToRecord()` 只存带 `file` 的曲目；`library.putAll()` 逐条独立事务写入（空间不足时前面的记录仍然保留）
- **恢复**：`init()` 末尾调用 `restoreLibrary()` → `getAll()` → 过滤掉没有音频的记录 → 按 `savedAt` 排序 → 重建曲目（恢复 blob URL、`lrcText`、配对封面）→ 重绘列表 → 再用 `enrichTrack(track, { lrcFile: null })` 重读内嵌标签（内嵌封面因此自动回来）
- **失败处理**：写入异常只在本次会话提示一次，不打断播放
- **清空**：`clearLibrary()` 移除所有带 `file` 的曲目、回收 blob URL、复位播放器 UI 与歌词、清空 IndexedDB
- **持久化声明**：首次写入成功后尽力调用 `navigator.storage.persist()`，避免磁盘紧张时被淘汰

### 5.6 拖放

- `dataTransfer` 在第一个 `await` 之后失效，`webkitGetAsEntry()` 必须在同步阶段取出
- 目录展开要循环调用 `readEntries`（Chrome 每次最多返回 100 项，读到空数组为止）
- 遮罩用 `dragenter` / `dragleave` 深度计数抵消子元素冒泡
- 取不到 entry 时退回 `dataTransfer.files`（只导入文件本身，不递归目录）

## 6. 防回归清单

这些是踩过坑后固定下来的行为，改代码时别破坏：

1. **列表重绘用 50ms 定时器合并（`schedulePlaylistRender`），不要改回 `requestAnimationFrame`**。导入常在后台标签页里完成，那种情况下浏览器不产出渲染帧，列表会一直停在文件名占位标题上。
2. **异步回调必须用 `isCurrentTrack(track)` 判断**：标签解析可能比用户切歌慢，否则会把上一首的封面/歌词刷到当前界面上。
3. **手动导入的歌词优先级最高**：`enrichTrack` 与 `fetch` 回调都不能覆盖已有的 `lrcText`。
4. **blob URL 的生命周期**：音频与封面 URL 都进 `state.objectUrls`，`beforeunload` 统一 `revokeObjectURL`；封面被替换时先回收旧的 `coverBlobUrl`。
5. **播放列表渲染必须 `escapeHtml`**：文件名与标签都可能含 `<` 或引号。
6. **`ended` 只对"自动切歌"应用单曲循环**：`next(true)` 与 `next(false)` 语义不同。
7. **配对宁可漏配**：不要为了"多配上几首"放宽目录判断，错配歌词比漏配更难发现。
8. **ogg 注释包需要前缀重试**：内嵌大封面时注释包可能远超 64KB，按 64K → 512K → 4M 扩大读取范围。
9. **GBK 修复是启发式的**：只在「编码字节 0x00 + 高位字节占比 ≥ 40% 且有连续高位字节」时触发，否则会误伤 `Café`、`Björk` 这类正常文本。
10. **脚本加载顺序不可调换**（见 §3）。

## 7. 兼容性与边界

**编解码支持**（实测 Chromium/Edge 155 的 `canPlayType`）：

| 编码 | 结果 |
| --- | --- |
| ALAC（m4a 无损） | `""` —— **完全不支持**，导入后时长为 00:00、无法播放 |
| AAC-LC（m4a）、MP3、FLAC、Ogg Vorbis、Opus | `"probably"` |
| WAV | `"maybe"` |

因此文档与提示的口径是：**m4a 要选 AAC 而不是 ALAC；FLAC 能播但内嵌歌词读不到；WAV/AIFF 的标签基本读不到**。

**标签能力边界**

- mp3：ID3v2 `TIT2`/`TPE1`/`TALB`/`APIC`/`USLT` ✔
- m4a/mp4：`©nam`/`©ART`/`©alb`/`covr`/`©lyr` ✔（`covr` 会带正确 MIME）
- flac：标题/歌手/专辑/曲目/流派 + 图片块 ✔，**歌词 ✘**
- ogg/opus：Vorbis 注释的 `TITLE`/`ARTIST`/`ALBUM`/`PERFORMER`/`LYRICS`/`UNSYNCEDLYRICS`/`METADATA_BLOCK_PICTURE`/`COVERART` ✔
- wav / aac(adts) / wma / ape：无标签解析，退回文件名推断
- 只取第一个封面；ID3v1 不读

**其他边界**

- `file://` 下按路径 `fetch` 的 `.lrc` 会被跨域限制挡住 → 歌词为空，需用本地服务器
- IndexedDB 在隐私模式、清站点数据、存储压力下可能丢失
- 拖放目录依赖 `webkitGetAsEntry()`；`webkitdirectory` 是非标准但广泛支持的属性
- 没有 `audio` 的 `error` 事件处理：资源缺失/编码不支持时依赖 `play()` 的 Promise `catch` 静默兜底

## 8. 部署

- 托管：GitHub Pages，来源 `main` 分支根目录（legacy build），无 Actions、无构建
- `.nojekyll`：跳过 Jekyll 处理，避免模板渲染与不必要的构建
- 更新流程：`git push` 到 `main` 后约一分钟重新构建
- 仓库内只放源码与文档；音频、封面、歌词由 `.gitignore` 排除（体积 + 版权），目录用 `.gitkeep` 保留结构
- 站点全部使用相对路径，因此部署在 `/<repo>/` 子路径下也能正常工作

## 9. 测试与验证策略

项目没有提交进仓库的测试套件，验证靠下面三种手段：

1. **Node 直测 `js/metadata.js`**（无 DOM 依赖）：文件名推断、配对规则、GBK 解码、Vorbis 注释解析、并发限制。测 mp3 标签路径时，用 `Blob.prototype.arrayBuffer` 垫一个最小 `FileReader`，再 `require` 真实的 `js/vendor/jsmediatags.min.js`，就能跑通真实 ID3 解析（含 `USLT` 歌词与 `APIC` 封面）。
2. **无头浏览器断言页**：临时写一个页面，用 iframe 加载 `index.html`，伪造 `DataTransfer` 触发导入、拖放与切歌，把断言结果渲染成文字后截图读取。本机 `msedge --dump-dom` 拿不到 stdout，`--headless=new --screenshot` 可用，因此采用截图法。
3. **手工清单**：见 PRD §6。

**当前未覆盖**：曲库持久化的完整恢复链路（F13 仍是 ⚠️）、真实目录拖放（`webkitGetAsEntry` 无法用合成事件模拟）、移动端真机。

## 10. 演进候选与代价

| 候选 | 做法 | 代价 |
| --- | --- | --- |
| 解码失败提示 | 监听 `audio` 的 `error` 事件，弹提示条 | 约 5 行，无兼容性风险；注意提示文案要区分"文件不存在"和"编码不支持" |
| FLAC 内嵌歌词 | 遍历 FLAC metadata block（type 4），复用 `parseVorbisComments` | 约 40 行；需要处理 block 头与图片块 |
| 大曲库持久化 | 改用 File System Access 句柄存 IndexedDB | 约 150 行；仅 Chromium；恢复需要一次用户手势授权；需要"待恢复"UI |
| 曲库管理 | 搜索框、单曲删除、拖动排序 | 渲染层改动集中在 `renderPlaylist` 与 `state`；删除要同步 IndexedDB |
| 播放状态持久化 | 在 IndexedDB 里加一条 `player-state` 记录 | 小；注意多标签页互相覆盖 |
