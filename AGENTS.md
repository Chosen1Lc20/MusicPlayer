# AGENTS.md

## 项目概览

MusicPlayer 是一个**零构建、无框架**的网页音乐播放器，用原生 HTML + CSS + JavaScript 写成，核心卖点是 **LRC 歌词同步滚动**，以及**导入本地音乐时自动配齐歌词与封面**。

没有 npm 包、没有打包器、没有测试套件，改完文件刷新浏览器即可生效。浏览器通过 `<script>` 标签直接加载四个脚本外加一个 vendored 的 UMD 库（`js/vendor/jsmediatags.min.js`），运行环境就是普通浏览器（使用 ES2015+ 语法：`const`/`let`、箭头函数、模板字符串、可选链、async/await）。

## 技术栈与约定

- 语言：原生 JavaScript，IIFE 包裹，非模块，不使用 ESM/CJS
- 样式：单个手写 CSS 文件，设计令牌集中在 `:root` 的 CSS 变量
- 模块间通信：通过 `window` 上的全局对象传递（`window.LyricsParser`、`window.TrackMeta`、`window.DEFAULT_PLAYLIST`）
- 第三方库只允许以 UMD `<script>` 放在 `js/vendor/`，不走包管理器（目前只有 jsmediatags 3.9.7，MIT，用途与许可见 `js/vendor/README.md`）
- `js/metadata.js` 不依赖 DOM，并用 UMD 风格的 `module.exports` 导出，因此可以直接在 Node 里 `require` 做单元测试
- 无后端、无接口、无持久化，所有状态只存在于内存，刷新即重置
- 注释与 UI 文案使用中文，界面语言 `zh-CN`
- 视觉风格：浅色玻璃拟态（半透明面板 + `backdrop-filter` 模糊），主色天蓝 `#38bdf8`，辅色 `#4ade80` 绿与 `#facc15` 黄

## 目录结构

```
MusicPlayer/
├── index.html          # 全部页面结构：左侧封面/信息/控制，右侧歌词，底部播放列表与导入按钮
├── css/
│   └── style.css       # 全部样式，含 CSS 变量、封面旋转动画、响应式断点
├── js/
│   ├── lyrics.js       # LRC 解析器，挂在 window.LyricsParser
│   ├── metadata.js     # 标签解析（内嵌标签 / 文件名推断）+ 导入配对，挂在 window.TrackMeta
│   ├── playlist.js     # 默认播放列表，挂在 window.DEFAULT_PLAYLIST
│   ├── app.js          # 播放器主逻辑（IIFE，体积最大，几乎全部行为都在这里）
│   └── vendor/         # 第三方库：jsmediatags.min.js（MIT）+ 来源说明
├── assets/
│   ├── audio/          # 音频文件（.gitkeep 占位，已含示例 yuyi.ogg）
│   ├── cover/          # 封面图片（.gitkeep 占位，已含示例 yuyi.jpg）
│   └── lyrics/         # .lrc 歌词（sample1.lrc / sample2.lrc / yuyi.lrc）
└── README.md           # 面向使用者的说明（功能、快捷键、如何加歌）
```

`index.html` 中脚本顺序有依赖，不可调换：`vendor/jsmediatags.min.js` → `lyrics.js` → `metadata.js` → `playlist.js` → `app.js`。因为 `app.js` 在 IIFE 顶部就解构了 `window.LyricsParser`，导入流程依赖全局 `jsmediatags`，而它渲染的数据来自 `playlist.js`。

## 架构与数据流

四层职责划分：

1. `lyrics.js`：纯函数，无 DOM 依赖。`parseLRC(text)` 把 LRC 文本解析成按时间升序的 `{ time, text }[]`；`findActiveIndex(lyrics, currentTime)` 用二分查找返回当前应高亮的行号，找不到时返回 `-1`。
2. `metadata.js`：纯函数 + 文件读取，无 DOM 依赖，可在 Node 里测试。负责标签解析（mp3/m4a/mp4/flac 交给 jsmediatags，ogg/opus 用自己的 Vorbis 注释解析器）、文件名推断、文本解码、导入文件配对、并发受限的 map。
3. `playlist.js`：数据配置。每首歌为 `{ title, artist, src, cover, lrc }`，其中 `cover` 与 `lrc` 可选。
4. `app.js`：全部状态与副作用。单一 `state` 对象持有 `playlist` / `current` / `lyrics` / `activeLine` / `mode` / `isSeeking` / `objectUrls` / `trackSeq`，DOM 引用集中在 `el` 对象，事件绑定统一在 `bindEvents()`。

主流程：`playIndex(i)` 设置 `audio.src`、更新封面与文本、调用 `loadLyrics()`、然后 `play()`；播放期间 `audio` 的 `timeupdate` 触发 `updateProgress()`，进而 `updateLyrics()` 高亮并平滑滚动歌词。

关键实现细节：

- `playIndex` 用 `track.lrcText` 缓存已加载的歌词文本，避免同一首歌重复 `fetch`
- 进度条拖动用 `state.isSeeking` 标志，拖动期间不被 `timeupdate` 覆盖，松手才真正写入 `audio.currentTime`；鼠标与触摸是两套独立事件
- 音频导入用 `URL.createObjectURL` 生成 blob URL，存入 `state.objectUrls`，在 `beforeunload` 时统一 `revokeObjectURL` 释放
- 歌词导入用 `FileReader` 以 UTF-8 读取，并写入当前曲目的 `lrcText`
- 播放列表渲染的文本一律经过 `escapeHtml()` 转义
- `ended` 事件调用 `next(true)`，`auto=true` 时单曲循环才重播当前曲；手动点下一首不会被单曲循环拦住
- 歌词跳转：点击歌词行直接写 `audio.currentTime`，暂停状态下会顺带 `play()`

### 导入管线

一次导入的完整链路（普通文件选择、文件夹选择、拖放三种入口最终都走同一套）：

1. `collectEntries()` 把 `FileList` 转成 `{ file, path }`。`webkitdirectory` 与拖放会带相对路径，普通多选只有文件名。
2. `TrackMeta.pairFiles(entries)` 按扩展名分成音频 / 歌词 / 图片，再按「同目录同名」配对，并给出 warnings。
3. `addImport()` 建曲目（音频用 `URL.createObjectURL`），标题先放文件名推断的结果，`state.current === -1` 时顺带播放第一首。
4. `TrackMeta.mapLimit(tracks, 3, enrichTrack)` 并发 3 补全元数据，避免一次导入上百首时同时打开上百个文件。
5. `enrichTrack()` 按下面的优先级刷新曲目，然后重绘界面。

元数据优先级，左侧优先：

| 字段 | 优先级 |
| --- | --- |
| 标题 / 歌手 / 专辑 | 内嵌标签 > 文件名推断 > 文件名主干 |
| 封面 | 内嵌图片 > 同名图片 > 同目录的 cover / folder / album / artwork / thumb 图 |
| 歌词 | 手动导入的 `.lrc`（当前曲目）> 同名同目录 `.lrc` > 内嵌歌词 |

导入相关的实现要点：

- **只对导入的曲目做标签解析**；`DEFAULT_PLAYLIST` 里手写的条目保持原样（它的 `lrc` 走 `fetch` 路径），这是有意的不对称
- 封面换成新 blob 时 `revokeObjectURL` 掉旧的，所有 blob URL 记在 `state.objectUrls`，`beforeunload` 统一释放
- 标签解析是异步的，回调里必须用 `isCurrentTrack()` 判断界面还能不能改（用户可能已经切歌）
- 列表重绘用 50ms 定时器合并（`schedulePlaylistRender`）。**不要改回 `requestAnimationFrame`**：导入常在后台标签页里完成，那种情况下浏览器不产出渲染帧，列表会一直停在占位标题上
- 配对刻意保守：同名候选不唯一、或两边都有目录却不一致时不配对。宁可漏配（提示条会告知，可手动导入歌词），也不要把 A 专辑的歌词安静地配到 B 专辑的同名曲目上
- 中文 MP3 常见「编码字节写 ISO-8859-1、实际是 GBK 字节」的乱码，`rescueLegacyChinese()` 用「高位字节密集且有连续高位字节」的判据修复；正常的西欧重音字符（Café / Björk）不会被误伤
- `.lrc` 文本解码统一走 `TrackMeta.readTextFile()`：UTF-8 BOM → UTF-16 BOM → UTF-8，出现替换字符再回退 GB18030
- ogg 的注释包可能因内嵌大封面超过 64KB 而被截断，`readOggTags()` 按 64K → 512K → 4M 扩大前缀重试
- 拖放的 `dataTransfer` 在第一个 `await` 之后就失效，`webkitGetAsEntry()` 必须在同步阶段取出；目录展开要循环调 `readEntries`（每次最多 100 项）
- 拖放遮罩的显示用 `dragenter` / `dragleave` 计数抵消子元素冒泡

## 运行与调试

**不要直接双击 `index.html` 来验证歌词功能。** 浏览器对 `file://` 下的 `fetch` 有跨域限制，默认列表中按路径加载的 `.lrc` 会读取失败（代码里 `catch` 成空歌词，界面表现为「暂无歌词」，容易被误判为 bug）。

用本地静态服务器：

```bash
python -m http.server 8000
# 或
npx serve .
```

然后打开 `http://localhost:8000`。

### 怎么验证导入相关改动

导入功能必须用真实浏览器 + 本地服务器验证，Node 只能覆盖到 `js/metadata.js` 的纯逻辑：

- **自动化**：`js/metadata.js` 不依赖 DOM，可以直接 `require` 后跑断言（文件名推断、配对规则、GBK 解码、Vorbis 注释解析、并发限制）。验证 mp3 标签路径时，给 Node 垫一个最小的 `FileReader`（用 `Blob.prototype.arrayBuffer` 实现 `readAsArrayBuffer`）再 `require` `js/vendor/jsmediatags.min.js`，就能在 Node 里跑通真实的 ID3 解析。
- **手工**：把带标签的 mp3 / ogg、同名 `.lrc`、`cover.jpg` 放进一个文件夹，拖进页面，检查标题/歌手/封面/歌词是否自动就位；再故意放一个不同名的 `.lrc`，确认提示条会说明未配对。

浏览器验证时若要用无头模式，注意这台机器上 `msedge --dump-dom` 拿不到 stdout，但 `--headless=new --screenshot=...` 可以正常出图；可以写一个把断言结果渲染成文字的临时页面，截图后用视觉检查读取结论。

## 新增歌曲

1. 音频放 `assets/audio/`，封面放 `assets/cover/`，歌词放 `assets/lyrics/`
2. 在 `js/playlist.js` 的 `window.DEFAULT_PLAYLIST` 数组末尾追加一条记录，`src` / `cover` / `lrc` 使用相对仓库根目录的路径

注意：`DEFAULT_PLAYLIST` **现在是空数组**（原来那三条示例曲目已移除），页面启动时播放列表是空的、只显示空态提示，音乐一律靠导入。`assets/` 下的示例文件（`yuyi.ogg` / `yuyi.jpg` / `yuyi.lrc`、`sample1.lrc` / `sample2.lrc`）还留在仓库里但已无人引用；`sample1.mp3` / `sample2.mp3` 从来就不存在。

## LRC 歌词格式

```
[ti:标题]
[ar:歌手]
[00:12.00]这是 12 秒时显示的歌词
[01:20.35]这是 1 分 20.35 秒时显示的歌词
[00:30.00][01:00.00]同一句歌词出现在两个时间点
```

解析器行为：支持 `[mm:ss.xx]` 与 `[mm:ss.xxx]`（1~3 位毫秒，补齐或截断到 3 位），一行多个时间标签会展开成多条，纯元信息行（无歌词文本）被跳过，结果统一按时间排序。`assets/lyrics/yuyi.lrc` 是真实歌曲歌词，含长度/字数标签与空行，可作为解析健壮性的参考样本。

## 已知限制

- 无构建、无 lint、没有提交进仓库的测试；`js/metadata.js` 的纯逻辑可以在 Node 里临时断言，其余靠浏览器手动验证
- 播放列表、音量、播放模式等状态刷新即丢失，没有使用 `localStorage`
- 导入的本地文件只存活于当前会话（blob URL），刷新后消失
- 没有拖拽排序、搜索、删除曲目等功能
- 标签解析只覆盖 mp3 / m4a / mp4 / flac（jsmediatags）与 ogg / opus（自研 Vorbis 注释）；wav / aac(adts) / wma 等只能靠文件名推断
- 只取第一个 APIC / METADATA_BLOCK_PICTURE 封面，多图与「封面类型」不区分；ID3v1 不读
- `DEFAULT_PLAYLIST` 里手写的条目不会被标签解析补全（缺封面就是缺封面）；它默认为空，所以「播放列表为空」是正常的初始状态，不是 bug
- GBK 乱码修复是启发式的：依赖「编码字节 0x00 + 高位字节密集」这两个特征，编码字节标错的 UTF-16 文件救不回来
- 未处理 `audio` 的 `error` 事件，资源缺失时依赖 `play()` 的 Promise `catch` 静默兜底
- 拖放依赖 `webkitGetAsEntry()`；不支持的浏览器会退化成「只导入拖进来的文件、不递归目录」

## 修改约定

- 保持**零构建**：不要引入框架、包管理器或打包步骤。需要第三方库时按 `js/vendor/` 的方式 vendored 一个 UMD 文件，并写清来源与许可
- 新增导入 / 标签相关逻辑放 `js/metadata.js`，并保持它无 DOM 依赖（方便 Node 测试）；不要在 `app.js` 里直接调 `jsmediatags`
- 改配对或元数据优先级前先读上面「导入管线」一节，改完同步更新它和 README 的说明
- 新增 DOM 元素时，同时更新 `index.html` 与 `app.js` 的 `el` 映射
- 新增 UI 文案用中文；新增可调色值放入 `:root` 的 CSS 变量
- 布局改动后同时检查桌面双栏与 `max-width: 820px` 以下单栏两种形态
