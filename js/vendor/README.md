# vendor/

## jsmediatags.min.js

- 版本：jsmediatags 3.9.7
- 来源：https://cdn.jsdelivr.net/npm/jsmediatags@3.9.7/dist/jsmediatags.min.js
- 许可：MIT（版权归上游作者所有，未做任何修改）
- 用途：读取 mp3 / m4a / mp4 / flac 的 ID3v2 与 MP4 标签（标题、歌手、专辑、封面、内嵌歌词）
- 为什么放进仓库：播放器要求离线可用，且不希望依赖 CDN 的可用性；浏览器通过 `<script>` 标签加载，暴露全局 `jsmediatags`

注意：该库**不支持 ogg / opus 容器**。ogg 音频的 Vorbis 注释由 `js/metadata.js` 内的解析器处理。
