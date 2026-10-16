/**
 * 元数据解析 + 导入文件配对
 *
 * 对外接口（挂在 window.TrackMeta 上）：
 *   pairFiles(entries)               把一次导入的文件按文件名配对成「曲目种子」列表
 *   guessFromFilename(name)          从「歌手 - 歌名」「01. 歌名」这类文件名推断标题/歌手
 *   readTags(file)                   读取音频内嵌标签：标题 / 歌手 / 专辑 / 封面 / 歌词
 *   readTextFile(file)               读取文本文件，自动处理 UTF-8 BOM 与中文 .lrc 常见的 GBK 编码
 *   mapLimit(items, limit, worker)   并发受限的 map（批量导入时避免同时打开上百个文件）
 *
 * 标签读取的分工：
 *   mp3 / m4a / mp4 / flac → jsmediatags（js/vendor/jsmediatags.min.js，按魔数嗅探格式，分片读取）
 *   ogg / oga / opus       → 本文件内的 Vorbis 注释解析器（jsmediatags 不支持该容器）
 *   其他格式 / 库缺失      → 返回 null，由调用方回退到文件名推断
 *
 * 本文件不依赖 DOM，可直接在 Node 中测试。
 */
(function (global) {
  "use strict";

  const AUDIO_EXT = [
    "mp3", "m4a", "m4b", "mp4", "aac", "flac", "ogg", "oga", "opus",
    "wav", "weba", "webm", "wma", "aif", "aiff", "ape", "mka",
  ];
  const LYRIC_EXT = ["lrc"];
  const IMAGE_EXT = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"];
  const OGG_EXT = ["ogg", "oga", "opus", "spx"];

  /** 同目录里这些名字的图片会被当作专辑封面（不分大小写，无扩展名） */
  const COVER_STEMS = ["cover", "folder", "album", "albumart", "front", "artwork", "thumb"];

  /** Vorbis 注释里存放 FLAC 风格封面的键 */
  const PICTURE_KEY = "METADATA_BLOCK_PICTURE";

  /** ogg 前缀最多读这么多字节去找注释包（含内嵌封面时注释包会比较大） */
  const OGG_MAX_PREFIX = 4 * 1024 * 1024;

  // ============ 路径与文件名工具 ============

  function extOf(path) {
    const s = String(path || "");
    const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    const base = slash >= 0 ? s.slice(slash + 1) : s;
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  }

  function stemOf(path) {
    const s = String(path || "");
    const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    const base = slash >= 0 ? s.slice(slash + 1) : s;
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(0, dot) : base;
  }

  function dirOf(path) {
    const s = String(path || "");
    const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return slash >= 0 ? s.slice(0, slash) : "";
  }

  /** 配对用的归一化键：忽略大小写与空白差异 */
  function keyOf(str) {
    return String(str || "").toLowerCase().replace(/\s+/g, "");
  }

  /**
   * 从文件名推断标题与歌手。
   *   "01 - 周杰伦 - 晴天"  → { title: "晴天", artist: "周杰伦" }
   *   "周杰伦 - 晴天"       → { title: "晴天", artist: "周杰伦" }
   *   "01. 晴天"            → { title: "晴天", artist: null }
   * 采用「歌手 - 歌名」这一业界惯例（与 foobar2000 / MusicBrainz Picard 一致）。
   * 分隔符要求两侧有空白，避免把 "Jay-Z" 这类含连字符的名字拆开。
   */
  function guessFromFilename(name) {
    let stem = stemOf(name) || String(name || "");
    // 去掉开头的音轨号： "01 " / "01. " / "01 - " / "01_"
    const stripped = stem.replace(/^\s*\d{1,3}\s*[-._、]\s*/, "");
    if (stripped) stem = stripped;
    const parts = stem.split(/\s+[-–—]\s+/);
    if (parts.length >= 2) {
      const artist = parts[0].trim();
      const title = parts.slice(1).join(" - ").trim();
      if (artist && title) return { title, artist, fromFilename: true };
    }
    return { title: stem.trim(), artist: null, fromFilename: false };
  }

  // ============ 文本解码 ============

  function readAsArrayBuffer(blob) {
    if (blob && typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsArrayBuffer(blob);
    });
  }

  function decodeWith(bytes, encoding) {
    try {
      return new TextDecoder(encoding).decode(bytes);
    } catch (err) {
      return null;
    }
  }

  /**
   * 解码文本字节。中文 .lrc 有大量 GBK/GB18030 编码的文件，
   * 先按 UTF-8 解，出现替换字符（U+FFFD）时再试 GB18030（GBK 的超集）。
   */
  function decodeText(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return decodeWith(bytes.subarray(3), "utf-8") || "";
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return decodeWith(bytes.subarray(2), "utf-16le") || "";
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return decodeWith(bytes.subarray(2), "utf-16be") || "";
    }
    const utf8 = decodeWith(bytes, "utf-8") || "";
    if (utf8.indexOf("\uFFFD") === -1) return utf8;
    const gb = decodeWith(bytes, "gb18030");
    return gb && gb.indexOf("\uFFFD") === -1 ? gb : utf8;
  }

  async function readTextFile(file) {
    return decodeText(await readAsArrayBuffer(file));
  }

  // ============ ogg / opus：Vorbis 注释解析 ============

  function concatChunks(chunks) {
    if (chunks.length === 1) return chunks[0];
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  function asciiAt(bytes, start, len) {
    let s = "";
    for (let i = start; i < start + len; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function isOggPage(bytes, off) {
    return bytes[off] === 0x4f && bytes[off + 1] === 0x67 && bytes[off + 2] === 0x67 && bytes[off + 3] === 0x53;
  }

  /**
   * 按 Ogg 页的分段表把字节流切回「包(packet)」。
   * 返回 null 表示数据在包中间被截断（调用方应扩大读取前缀后重试）。
   */
  function collectPackets(bytes, maxPackets) {
    const packets = [];
    let chunks = [];
    let off = 0;
    while (packets.length < maxPackets) {
      if (off + 27 > bytes.length) return null; // 页头不完整
      if (!isOggPage(bytes, off)) return null;
      const segCount = bytes[off + 26];
      const tableStart = off + 27;
      const tableEnd = tableStart + segCount;
      if (tableEnd > bytes.length) return null;
      let pos = tableEnd;
      for (let i = tableStart; i < tableEnd; i++) {
        const len = bytes[i];
        if (pos + len > bytes.length) return null; // 包体被截断
        if (len) chunks.push(bytes.subarray(pos, pos + len));
        pos += len;
        // 分段长度 < 255 表示一个包在此结束；= 255 表示跨段/跨页继续
        if (len < 255) {
          packets.push(concatChunks(chunks));
          chunks = [];
          if (packets.length >= maxPackets) break;
        }
      }
      off = pos;
    }
    return packets;
  }

  /**
   * 解析 Vorbis 注释包（ogg 的第 2 个包）。
   * 返回 null 表示包体不完整或格式不认识，调用方可扩大前缀重试。
   */
  function parseVorbisComments(packet) {
    if (!packet || packet.length < 12) return null;
    let p;
    if (packet[0] === 0x03 && asciiAt(packet, 1, 6) === "vorbis") p = 7;
    else if (asciiAt(packet, 0, 8) === "OpusTags") p = 8;
    else return null;

    const dv = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    if (p + 4 > packet.length) return null;
    const vendorLen = dv.getUint32(p, true);
    p += 4 + vendorLen;
    if (p + 4 > packet.length) return null;
    const count = dv.getUint32(p, true);
    p += 4;
    if (count > 100000) return null;

    const map = {};
    for (let i = 0; i < count; i++) {
      if (p + 4 > packet.length) return null;
      const len = dv.getUint32(p, true);
      p += 4;
      if (p + len > packet.length) return null;
      // 规范要求 UTF-8，但中文 ogg 里偶尔能看到 GBK，交给 decodeText 兜一下
      const entry = decodeText(packet.subarray(p, p + len));
      p += len;
      const eq = entry.indexOf("=");
      // 键名大小写不敏感，取第一个出现的值
      if (eq > 0) {
        const key = entry.slice(0, eq).trim().toUpperCase();
        if (!(key in map)) map[key] = entry.slice(eq + 1);
      }
    }
    return map;
  }

  function base64ToBytes(b64) {
    try {
      const bin = atob(String(b64).replace(/[^A-Za-z0-9+/=]/g, ""));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (err) {
      return null;
    }
  }

  /** 解析 FLAC 风格的图片块（METADATA_BLOCK_PICTURE 的值是它的 base64） */
  function blobFromFlacPicture(b64) {
    const bytes = base64ToBytes(b64);
    if (!bytes || bytes.length < 32) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = 4; // 前 4 字节是图片类型，跳过
    if (p + 4 > bytes.length) return null;
    const mimeLen = dv.getUint32(p, true);
    p += 4;
    if (p + mimeLen + 4 > bytes.length) return null;
    const mime = asciiAt(bytes, p, mimeLen);
    p += mimeLen;
    const descLen = dv.getUint32(p, true);
    p += 4 + descLen;
    p += 16; // width / height / depth / colors
    if (p + 4 > bytes.length) return null;
    const dataLen = dv.getUint32(p, true);
    p += 4;
    if (dataLen <= 0 || p + dataLen > bytes.length) return null;
    try {
      return new Blob([bytes.subarray(p, p + dataLen)], { type: mime || "image/jpeg" });
    } catch (err) {
      return null;
    }
  }

  function tagsFromVorbis(map) {
    const get = (...keys) => {
      for (const k of keys) {
        const v = map[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return null;
    };
    let picture = null;
    if (map[PICTURE_KEY]) picture = blobFromFlacPicture(map[PICTURE_KEY]);
    // 老式（非标准）做法：COVERART 里直接放 base64 图片
    if (!picture && map.COVERART) {
      const bytes = base64ToBytes(map.COVERART);
      if (bytes && bytes.length) {
        try {
          picture = new Blob([bytes], { type: (map.COVERARTMIME || "image/jpeg").trim() });
        } catch (err) {
          picture = null;
        }
      }
    }
    return cleanTags({
      title: get("TITLE"),
      artist: get("ARTIST", "PERFORMER", "ALBUMARTIST"),
      album: get("ALBUM"),
      lyricsText: get("LYRICS", "UNSYNCEDLYRICS", "LYRIC"),
      picture,
    });
  }

  async function readOggTags(file) {
    const size = typeof file.size === "number" ? file.size : Infinity;
    let limit = Math.min(size, 65536);
    for (;;) {
      const bytes = new Uint8Array(await readAsArrayBuffer(file.slice(0, limit)));
      const packets = collectPackets(bytes, 2);
      if (packets && packets.length >= 2) {
        const map = parseVorbisComments(packets[1]);
        if (map) return tagsFromVorbis(map);
      }
      if (limit >= size || limit >= OGG_MAX_PREFIX) return null;
      // 注释包被截断（常见于内嵌了较大封面）：按 64K → 512K → 4M 扩大前缀重试
      limit = Math.min(size, limit * 8, OGG_MAX_PREFIX);
    }
  }

  // ============ 标签读取总入口 ============

  function cleanTags(tags) {
    if (!tags) return null;
    for (const key of ["title", "artist", "album", "lyricsText", "picture"]) {
      if (tags[key] === undefined || tags[key] === "") tags[key] = null;
    }
    const hasAny = ["title", "artist", "album", "lyricsText", "picture"].some((k) => tags[k]);
    return hasAny ? tags : null;
  }

  /**
   * 修复中文 MP3 的经典乱码：ID3v2 的编码字节写着 ISO-8859-1(0x00)，
   * 实际写进去的却是 GBK 字节（国内大量老文件如此），标签库会按 latin1 解出乱码。
   * 判据是「高位字节占比高且有连续高位字节」——正常的西欧重音字符（Café / Björk）
   * 高位字节稀疏且不连续，不会被误伤。
   */
  function rescueLegacyChinese(str) {
    if (!str) return str;
    let high = 0;
    let consecutive = 0;
    let prevHigh = false;
    for (const ch of str) {
      const code = ch.codePointAt(0);
      const isHigh = code >= 0x80 && code <= 0xff;
      if (isHigh) {
        high++;
        if (prevHigh) consecutive++;
      }
      prevHigh = isHigh;
    }
    const visible = str.replace(/\s/g, "").length || 1;
    if (!high || !consecutive || high / visible < 0.4) return str;
    const bytes = new Uint8Array([...str].map((c) => c.codePointAt(0) & 0xff));
    const gb = decodeWith(bytes, "gb18030");
    if (!gb || gb.indexOf("\uFFFD") !== -1) return str;
    return gb;
  }

  function pictureFromLibrary(picture) {
    if (!picture || !picture.data) return null;
    try {
      return new Blob([new Uint8Array(picture.data)], { type: picture.format || "image/jpeg" });
    } catch (err) {
      return null;
    }
  }

  function tagsFromLibrary(tags) {
    if (!tags) return null;
    const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
    // jsmediatags 把 ID3v2 的 USLT 帧解析为
    // tags.lyrics = { language, descriptor, lyrics }（老版本用过 data 字段）
    let lyricsText = null;
    if (typeof tags.lyrics === "string") lyricsText = tags.lyrics;
    else if (tags.lyrics && typeof tags.lyrics.lyrics === "string") lyricsText = tags.lyrics.lyrics;
    else if (tags.lyrics && typeof tags.lyrics.data === "string") lyricsText = tags.lyrics.data;
    return cleanTags({
      title: rescueLegacyChinese(str(tags.title)),
      artist: rescueLegacyChinese(str(tags.artist)) || rescueLegacyChinese(str(tags.albumartist)),
      album: rescueLegacyChinese(str(tags.album)),
      lyricsText: rescueLegacyChinese(lyricsText),
      picture: pictureFromLibrary(tags.picture),
    });
  }

  function readViaLibrary(file) {
    const lib = global.jsmediatags;
    if (!lib || typeof lib.read !== "function") return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        lib.read(file, {
          onSuccess: (result) => finish(tagsFromLibrary(result && result.tags)),
          onError: () => finish(null),
        });
      } catch (err) {
        finish(null);
      }
    });
  }

  /**
   * 读取内嵌标签。任何失败都返回 null，调用方回退到文件名推断。
   * @param {File|Blob} file 需要带 name 属性（用于判断容器格式）
   */
  async function readTags(file) {
    if (!file) return null;
    try {
      const ext = extOf(file.name || "");
      if (OGG_EXT.indexOf(ext) !== -1) return await readOggTags(file);
      return await readViaLibrary(file);
    } catch (err) {
      return null;
    }
  }

  // ============ 导入文件配对 ============

  function indexItems(items) {
    const byDirKey = new Map();
    const byStem = new Map();
    for (const it of items) {
      const stemKey = keyOf(stemOf(it.path));
      const dirKey = dirOf(it.path) + "|" + stemKey;
      if (!byDirKey.has(dirKey)) byDirKey.set(dirKey, it);
      if (!byStem.has(stemKey)) byStem.set(stemKey, []);
      byStem.get(stemKey).push(it);
    }
    return { byDirKey, byStem };
  }

  /**
   * 先找同目录同名；再看全局是否只有一个同名候选，且其中一边没有目录信息。
   * 两个人都带目录却不一致时不配对——宁可漏配（用户可手动导入歌词），
   * 也不要把 A 专辑的歌词安静地配到 B 专辑的同名曲目上。
   */
  function findMatch(index, stem, dir) {
    const exact = index.byDirKey.get(dir + "|" + keyOf(stem));
    if (exact) return exact.file;
    const same = index.byStem.get(keyOf(stem));
    if (!same || same.length !== 1) return null;
    const candidateDir = dirOf(same[0].path);
    return dir === "" || candidateDir === "" ? same[0].file : null;
  }

  function findNamedCover(index, dir) {
    for (const name of COVER_STEMS) {
      const hit = index.byDirKey.get(dir + "|" + name);
      if (hit) return hit.file;
    }
    return null;
  }

  /**
   * 把一次导入的文件分成三类并配对：
   *   音频 → 曲目；同名 .lrc → 该曲目的歌词；同名图片或 cover/folder/album 图 → 该曲目的封面
   * @param {Array<{file: File, path?: string}>} entries
   * @returns {{tracks: Array, warnings: string[]}}
   */
  function pairFiles(entries) {
    const audios = [];
    const lyrics = [];
    const images = [];
    for (const entry of entries || []) {
      if (!entry) continue;
      const file = entry.file || entry;
      const path = entry.path || file.name || "";
      const ext = extOf(path) || extOf(file.name || "");
      const type = String(file.type || "").toLowerCase();
      if (AUDIO_EXT.indexOf(ext) !== -1 || type.indexOf("audio/") === 0) {
        audios.push({ file, path });
      } else if (LYRIC_EXT.indexOf(ext) !== -1) {
        lyrics.push({ file, path });
      } else if (IMAGE_EXT.indexOf(ext) !== -1 || type.indexOf("image/") === 0) {
        images.push({ file, path });
      }
    }

    const lyricIndex = indexItems(lyrics);
    const imageIndex = indexItems(images);
    const usedLyrics = new Set();
    const usedImages = new Set();

    const tracks = audios.map((audio) => {
      const stem = stemOf(audio.path);
      const dir = dirOf(audio.path);
      const guess = guessFromFilename(audio.file.name || audio.path);
      const lrcFile = findMatch(lyricIndex, stem, dir);
      if (lrcFile) usedLyrics.add(lrcFile);
      let coverFile = findMatch(imageIndex, stem, dir);
      if (!coverFile) coverFile = findNamedCover(imageIndex, dir);
      if (coverFile) usedImages.add(coverFile);
      return {
        file: audio.file,
        path: audio.path,
        title: guess.title,
        artist: guess.artist,
        lrcFile,
        coverFile,
      };
    });

    const warnings = [];
    if (!tracks.length) {
      warnings.push(
        lyrics.length || images.length
          ? "没有选中音频文件，只有歌词/图片无法导入"
          : "没有找到可导入的音频文件"
      );
    } else {
      const orphanLyrics = lyrics.filter((l) => !usedLyrics.has(l.file)).length;
      if (orphanLyrics) {
        warnings.push(`${orphanLyrics} 个 .lrc 未配对到音频（要求与音频同名且同目录），已忽略`);
      }
    }
    return { tracks, warnings };
  }

  // ============ 并发控制 ============

  /** 并发受限的 map：批量导入时不要让几百个文件解析同时打满 */
  function mapLimit(items, limit, worker) {
    const list = items || [];
    const results = new Array(list.length);
    let next = 0;
    const workers = [];
    const run = async () => {
      while (next < list.length) {
        const i = next++;
        results[i] = await worker(list[i], i);
      }
    };
    const count = Math.max(1, Math.min(limit || 1, list.length));
    for (let i = 0; i < count; i++) workers.push(run());
    return Promise.all(workers).then(() => results);
  }

  const api = {
    extOf,
    stemOf,
    dirOf,
    guessFromFilename,
    decodeText,
    readTextFile,
    parseVorbisComments,
    collectPackets,
    readTags,
    pairFiles,
    mapLimit,
  };

  global.TrackMeta = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
