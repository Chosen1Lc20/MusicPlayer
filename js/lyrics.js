/**
 * LRC 歌词解析器
 * 解析标准 LRC 文本为按时间排序的 { time, text } 数组。
 * 支持一行多个时间标签，如 [00:12.00][01:20.30] 同一句歌词。
 */
(function (global) {
  const TIME_TAG = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

  function parseLRC(text) {
    if (!text) return [];
    const lines = text.split(/\r?\n/);
    const result = [];

    for (const raw of lines) {
      const times = [];
      let match;
      TIME_TAG.lastIndex = 0;
      while ((match = TIME_TAG.exec(raw)) !== null) {
        const min = parseInt(match[1], 10);
        const sec = parseInt(match[2], 10);
        let ms = 0;
        if (match[3]) {
          // 兼容两位/三位毫秒
          ms = parseInt(match[3].padEnd(3, "0").slice(0, 3), 10);
        }
        times.push(min * 60 + sec + ms / 1000);
      }
      if (times.length === 0) continue;

      const content = raw.replace(TIME_TAG, "").trim();
      if (!content) continue; // 跳过空歌词行（如纯元信息）

      for (const t of times) {
        result.push({ time: t, text: content });
      }
    }

    result.sort((a, b) => a.time - b.time);
    return result;
  }

  /**
   * 根据当前播放时间返回当前应高亮的歌词索引。
   * 使用二分查找，找到最后一个 time <= currentTime 的行。
   */
  function findActiveIndex(lyrics, currentTime) {
    if (!lyrics || lyrics.length === 0) return -1;
    let lo = 0;
    let hi = lyrics.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lyrics[mid].time <= currentTime) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return idx;
  }

  global.LyricsParser = { parseLRC, findActiveIndex };
})(window);
