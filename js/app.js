/**
 * 音乐播放器主逻辑
 * - 播放 / 暂停 / 上一首 / 下一首
 * - 进度条拖动跳转、缓冲显示
 * - 音量调节 / 静音
 * - 播放模式：列表循环 / 单曲循环 / 随机
 * - LRC 歌词解析 + 平滑滚动高亮
 * - 本地导入：音频、同名 .lrc 与封面自动配对，内嵌标签自动读取（见 js/metadata.js）
 */
(function () {
  "use strict";

  const { parseLRC, findActiveIndex } = window.LyricsParser;
  const library = window.TrackLibrary; // 曲库持久化（js/library.js）
  const canPersist = !!(library && library.supported());

  // ---- DOM ----
  const audio = document.getElementById("audio");
  const el = {
    bgBlur: document.getElementById("bgBlur"),
    cover: document.getElementById("cover"),
    title: document.getElementById("trackTitle"),
    artist: document.getElementById("trackArtist"),
    curTime: document.getElementById("curTime"),
    durTime: document.getElementById("durTime"),
    progressBar: document.getElementById("progressBar"),
    played: document.getElementById("progressPlayed"),
    buffered: document.getElementById("progressBuffered"),
    handle: document.getElementById("progressHandle"),
    playBtn: document.getElementById("playBtn"),
    prevBtn: document.getElementById("prevBtn"),
    nextBtn: document.getElementById("nextBtn"),
    modeBtn: document.getElementById("modeBtn"),
    modeIcon: document.getElementById("modeIcon"),
    muteBtn: document.getElementById("muteBtn"),
    volumeSlider: document.getElementById("volumeSlider"),
    lyricsWrap: document.getElementById("lyricsWrap"),
    lyrics: document.getElementById("lyrics"),
    playlist: document.getElementById("playlist"),
    audioInput: document.getElementById("audioInput"),
    folderInput: document.getElementById("folderInput"),
    lrcInput: document.getElementById("lrcInput"),
    clearBtn: document.getElementById("clearBtn"),
    dropHint: document.getElementById("dropHint"),
    toast: document.getElementById("toast"),
  };

  // ---- 状态 ----
  const MODES = ["list", "one", "shuffle"];
  const MODE_ICON = { list: "🔁", one: "🔂", shuffle: "🔀" };
  const MODE_LABEL = { list: "列表循环", one: "单曲循环", shuffle: "随机播放" };

  const state = {
    playlist: [],
    current: -1,
    lyrics: [],
    activeLine: -1,
    mode: "list",
    isSeeking: false,
    objectUrls: [], // 需要释放的 blob url
    trackSeq: 0, // 曲目自增 id
  };

  // ---- 工具 ----
  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  /** 底部提示条 */
  let toastTimer = 0;
  function notify(message) {
    if (!message) return;
    el.toast.textContent = message;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), 4500);
  }

  /** 该曲目是否正在播放（异步回调里用它判断界面还能不能改） */
  function isCurrentTrack(track) {
    return state.playlist[state.current] === track;
  }

  // ============ 播放列表渲染 ============
  let playlistTimer = 0;

  /**
   * 批量导入时合并重绘，避免每首歌都把整个列表重建一遍。
   * 用定时器而不是 requestAnimationFrame：标签解析完成时页面可能在后台标签页里，
   * 那种情况下浏览器不产出渲染帧，用 rAF 的话列表会一直停在占位标题。
   */
  function schedulePlaylistRender() {
    if (playlistTimer) return;
    playlistTimer = setTimeout(() => {
      playlistTimer = 0;
      renderPlaylist();
    }, 50);
  }

  function renderPlaylist() {
    el.playlist.innerHTML = "";
    updateClearBtn();
    if (!state.playlist.length) {
      const li = document.createElement("li");
      li.className = "playlist-empty";
      li.textContent =
        "把音乐文件夹拖进来，或点上方按钮导入：音频、同名 .lrc 与封面会自动配对，内嵌标签会自动读取";
      el.playlist.appendChild(li);
      return;
    }
    state.playlist.forEach((track, i) => {
      const li = document.createElement("li");
      li.className = "playlist-item" + (i === state.current ? " active" : "");
      li.innerHTML = `
        <span class="idx">${i === state.current ? "♪" : i + 1}</span>
        <div class="meta">
          <div class="name">${escapeHtml(track.title)}</div>
          <div class="sub">${escapeHtml(track.artist || "未知歌手")}</div>
        </div>
        <span class="dur">${track.duration ? formatTime(track.duration) : "--:--"}</span>
      `;
      li.addEventListener("click", () => playIndex(i));
      el.playlist.appendChild(li);
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  /** 把曲目的标题 / 歌手 / 封面刷到界面上（标签异步解析完成后会再次调用） */
  function applyTrackInfo(track) {
    el.title.textContent = track.title || "未选择歌曲";
    el.artist.textContent = track.artist || "未知歌手";
    if (track.cover) {
      el.cover.style.backgroundImage = `url("${track.cover}")`;
      el.cover.querySelector(".cover-placeholder")?.style.setProperty("display", "none");
      el.bgBlur.style.backgroundImage = `url("${track.cover}")`;
    } else {
      el.cover.style.backgroundImage = "";
      const ph = el.cover.querySelector(".cover-placeholder");
      if (ph) ph.style.display = "";
      el.bgBlur.style.backgroundImage = "";
    }
  }

  // ============ 加载并播放 ============
  function playIndex(index) {
    if (index < 0 || index >= state.playlist.length) return;
    state.current = index;
    const track = state.playlist[index];

    audio.src = track.src;
    audio.load();

    applyTrackInfo(track);
    loadLyrics(track);
    renderPlaylist();
    play();
  }

  function play() {
    audio.play().then(() => {
      el.playBtn.textContent = "⏸";
      el.cover.classList.add("spinning");
    }).catch(() => {
      // 自动播放被拦截或资源缺失时静默
      el.playBtn.textContent = "▶";
    });
  }

  function pause() {
    audio.pause();
    el.playBtn.textContent = "▶";
    el.cover.classList.remove("spinning");
  }

  function togglePlay() {
    if (state.current === -1 && state.playlist.length) {
      playIndex(0);
      return;
    }
    if (audio.paused) play();
    else pause();
  }

  function next(auto) {
    if (!state.playlist.length) return;
    if (state.mode === "one" && auto) {
      audio.currentTime = 0;
      play();
      return;
    }
    let idx;
    if (state.mode === "shuffle") {
      if (state.playlist.length === 1) idx = state.current;
      else {
        do {
          idx = Math.floor(Math.random() * state.playlist.length);
        } while (idx === state.current);
      }
    } else {
      idx = (state.current + 1) % state.playlist.length;
    }
    playIndex(idx);
  }

  function prev() {
    if (!state.playlist.length) return;
    const idx = (state.current - 1 + state.playlist.length) % state.playlist.length;
    playIndex(idx);
  }

  // ============ 歌词 ============
  function loadLyrics(track) {
    if (track.lrcText) {
      setLyrics(track.lrcText);
      return;
    }
    if (track.lrcFile) {
      // 本地导入时配对到的同名 .lrc：由 enrichTrack 异步读入后再回填
      setLyrics("");
      return;
    }
    if (track.lrc) {
      fetch(track.lrc)
        .then((r) => (r.ok ? r.text() : Promise.reject()))
        .then((txt) => {
          // 手动导入的歌词优先；已经切歌就只缓存，不动界面
          if (track.lrcText) return;
          track.lrcText = txt;
          if (isCurrentTrack(track)) setLyrics(txt);
        })
        .catch(() => {
          if (!track.lrcText && isCurrentTrack(track)) setLyrics("");
        });
    } else {
      setLyrics("");
    }
  }

  function setLyrics(text) {
    state.lyrics = parseLRC(text);
    state.activeLine = -1;
    renderLyrics();
  }

  function renderLyrics() {
    el.lyrics.innerHTML = "";
    if (!state.lyrics.length) {
      const p = document.createElement("p");
      p.className = "lyric-line placeholder";
      p.textContent = "暂无歌词";
      el.lyrics.appendChild(p);
      return;
    }
    state.lyrics.forEach((line, i) => {
      const p = document.createElement("p");
      p.className = "lyric-line";
      p.textContent = line.text;
      p.dataset.index = i;
      p.addEventListener("click", () => {
        audio.currentTime = line.time;
        if (audio.paused) play();
      });
      el.lyrics.appendChild(p);
    });
  }

  function updateLyrics(currentTime) {
    if (!state.lyrics.length) return;
    const idx = findActiveIndex(state.lyrics, currentTime);
    if (idx === state.activeLine) return;
    state.activeLine = idx;

    const lines = el.lyrics.children;
    for (let i = 0; i < lines.length; i++) {
      lines[i].classList.toggle("active", i === idx);
    }

    const activeEl = lines[idx];
    if (activeEl) {
      const wrap = el.lyricsWrap;
      const target =
        activeEl.offsetTop - wrap.clientHeight / 2 + activeEl.clientHeight / 2;
      wrap.scrollTo({ top: target, behavior: "smooth" });
    }
  }

  // ============ 进度条 ============
  function updateProgress() {
    const { currentTime, duration } = audio;
    if (!state.isSeeking) {
      const pct = duration ? (currentTime / duration) * 100 : 0;
      el.played.style.width = pct + "%";
      el.handle.style.left = pct + "%";
    }
    el.curTime.textContent = formatTime(currentTime);
    updateLyrics(currentTime);
  }

  function updateBuffered() {
    if (audio.buffered.length && audio.duration) {
      const end = audio.buffered.end(audio.buffered.length - 1);
      el.buffered.style.width = (end / audio.duration) * 100 + "%";
    }
  }

  function seekFromEvent(e) {
    const rect = el.progressBar.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    let pct = (clientX - rect.left) / rect.width;
    pct = Math.min(1, Math.max(0, pct));
    el.played.style.width = pct * 100 + "%";
    el.handle.style.left = pct * 100 + "%";
    return pct;
  }

  // ============ 事件绑定 ============
  function bindEvents() {
    el.playBtn.addEventListener("click", togglePlay);
    el.nextBtn.addEventListener("click", () => next(false));
    el.prevBtn.addEventListener("click", prev);

    el.modeBtn.addEventListener("click", () => {
      const i = MODES.indexOf(state.mode);
      state.mode = MODES[(i + 1) % MODES.length];
      el.modeIcon.textContent = MODE_ICON[state.mode];
      el.modeBtn.title = MODE_LABEL[state.mode];
    });

    // 音量
    el.volumeSlider.addEventListener("input", () => {
      audio.volume = parseFloat(el.volumeSlider.value);
      audio.muted = false;
      updateMuteIcon();
    });
    el.muteBtn.addEventListener("click", () => {
      audio.muted = !audio.muted;
      updateMuteIcon();
    });

    // 进度条拖动
    el.progressBar.addEventListener("mousedown", (e) => {
      state.isSeeking = true;
      seekFromEvent(e);
    });
    document.addEventListener("mousemove", (e) => {
      if (state.isSeeking) seekFromEvent(e);
    });
    document.addEventListener("mouseup", (e) => {
      if (!state.isSeeking) return;
      state.isSeeking = false;
      if (audio.duration) audio.currentTime = seekFromEvent(e) * audio.duration;
    });
    // 触摸支持
    el.progressBar.addEventListener("touchstart", (e) => {
      state.isSeeking = true;
      seekFromEvent(e);
    });
    el.progressBar.addEventListener("touchmove", (e) => {
      if (state.isSeeking) seekFromEvent(e);
    });
    el.progressBar.addEventListener("touchend", (e) => {
      state.isSeeking = false;
      const rect = el.progressBar.getBoundingClientRect();
      const clientX = e.changedTouches[0].clientX;
      let pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      if (audio.duration) audio.currentTime = pct * audio.duration;
    });

    // audio 事件
    audio.addEventListener("timeupdate", updateProgress);
    audio.addEventListener("progress", updateBuffered);
    audio.addEventListener("loadedmetadata", () => {
      el.durTime.textContent = formatTime(audio.duration);
      if (state.current >= 0) {
        state.playlist[state.current].duration = audio.duration;
        renderPlaylist();
      }
    });
    audio.addEventListener("ended", () => next(true));
    audio.addEventListener("play", () => {
      el.playBtn.textContent = "⏸";
      el.cover.classList.add("spinning");
    });
    audio.addEventListener("pause", () => {
      el.playBtn.textContent = "▶";
      el.cover.classList.remove("spinning");
    });

    // 文件导入：同一批文件里按文件名自动配对音频 / 歌词 / 封面
    el.audioInput.addEventListener("change", (e) => {
      addImport(collectEntries(e.target.files));
      e.target.value = "";
    });
    el.folderInput.addEventListener("change", (e) => {
      addImport(collectEntries(e.target.files));
      e.target.value = "";
    });
    el.lrcInput.addEventListener("change", handleLrcImport);
    el.clearBtn.addEventListener("click", clearLibrary);
    bindDropZone();

    // 键盘快捷键
    document.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT") return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.code === "ArrowRight") {
        audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
      } else if (e.code === "ArrowLeft") {
        audio.currentTime = Math.max(0, audio.currentTime - 5);
      } else if (e.code === "ArrowUp") {
        e.preventDefault();
        audio.volume = Math.min(1, audio.volume + 0.1);
        el.volumeSlider.value = audio.volume;
      } else if (e.code === "ArrowDown") {
        e.preventDefault();
        audio.volume = Math.max(0, audio.volume - 0.1);
        el.volumeSlider.value = audio.volume;
      }
    });
  }

  function updateMuteIcon() {
    if (audio.muted || audio.volume === 0) el.muteBtn.textContent = "🔇";
    else if (audio.volume < 0.5) el.muteBtn.textContent = "🔉";
    else el.muteBtn.textContent = "🔊";
  }

  // ============ 文件导入 ============
  /** 把 FileList 转成 { file, path }；webkitdirectory 会带上相对路径 */
  function collectEntries(fileList) {
    return Array.from(fileList || []).map((file) => ({
      file,
      path: file.webkitRelativePath || file.name,
    }));
  }

  /** 设置曲目封面（Blob / File），并释放被替换掉的旧封面 blob */
  function setTrackCover(track, source) {
    if (!source) return;
    if (track.coverBlobUrl) URL.revokeObjectURL(track.coverBlobUrl);
    const url = URL.createObjectURL(source);
    state.objectUrls.push(url);
    track.coverBlobUrl = url;
    track.cover = url;
  }

  /**
   * 一次导入：解析配对结果 → 入列表 → 异步补全标签。
   * 音频先以文件名推断的标题占位，标签解析完成后再刷新。
   */
  function addImport(entries) {
    const list = (entries || []).filter(Boolean);
    if (!list.length) return;

    const plan = TrackMeta.pairFiles(list);
    if (!plan.tracks.length) {
      notify(plan.warnings[0] || "没有找到可导入的音频文件");
      return;
    }

    // 已经在列表里的（含刷新后恢复的）不重复导入
    const known = new Set(state.playlist.map((t) => t.path).filter(Boolean));
    const seeds = plan.tracks.filter((seed) => !known.has(seed.path));
    const skipped = plan.tracks.length - seeds.length;
    if (!seeds.length) {
      notify(`这 ${skipped} 首已经在播放列表里了`);
      return;
    }

    const startLen = state.playlist.length;
    const added = seeds.map((seed) => {
      const src = URL.createObjectURL(seed.file);
      state.objectUrls.push(src);
      const track = {
        id: ++state.trackSeq,
        title: seed.title,
        artist: seed.artist,
        src,
        file: seed.file,
        path: seed.path,
        lrcFile: seed.lrcFile || null,
        coverFile: seed.coverFile || null,
      };
      // 先亮出配对的封面图，内嵌封面解析完成后会替换掉
      if (track.coverFile) setTrackCover(track, track.coverFile);
      return track;
    });

    state.playlist.push(...added);
    renderPlaylist();
    if (state.current === -1) playIndex(startLen);

    // 并发 3，避免一次导入上百首时同时打开上百个文件；补全标签后写入本地曲库
    TrackMeta.mapLimit(added, 3, (track, i) => enrichTrack(track, seeds[i]))
      .then(() => persistTracks(added))
      .catch(() => notify("部分曲目的标签读取失败，已回退到文件名"));

    const notes = [`已导入 ${added.length} 首`];
    if (skipped) notes.push(`跳过 ${skipped} 首重复曲目`);
    notes.push(...plan.warnings);
    if (!canPersist) notes.push("当前浏览器无法保存曲库，刷新后会丢失");
    notify(notes.join("；"));
  }

  /**
   * 异步补全曲目元数据。
   * 优先级：内嵌标签 > 文件名推断；同名 .lrc > 内嵌歌词；内嵌封面 > 配对到的封面图。
   */
  async function enrichTrack(track, seed) {
    let tags = null;
    try {
      tags = await TrackMeta.readTags(track.file);
    } catch (err) {
      tags = null;
    }

    if (tags) {
      if (tags.title) track.title = tags.title;
      if (tags.artist) track.artist = tags.artist;
      if (tags.album) track.album = tags.album;
      if (tags.picture) setTrackCover(track, tags.picture);
    }

    // 手动导入的歌词（track.lrcText 已存在）优先级最高，不覆盖
    if (!track.lrcText) {
      let text = "";
      if (seed.lrcFile) {
        try {
          text = await TrackMeta.readTextFile(seed.lrcFile);
        } catch (err) {
          text = "";
        }
      }
      if (!text && tags && tags.lyricsText) text = tags.lyricsText;
      if (text) {
        track.lrcText = text;
        if (isCurrentTrack(track)) setLyrics(text);
      }
    }

    if (isCurrentTrack(track)) applyTrackInfo(track);
    schedulePlaylistRender();
  }

  function handleLrcImport(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (state.current < 0) {
      notify("请先在播放列表里选一首歌，再导入歌词");
      return;
    }
    const track = state.playlist[state.current];
    TrackMeta.readTextFile(file)
      .then((text) => {
        track.lrcText = text;
        setLyrics(text);
        persistTracks([track]);
        notify(`已为「${track.title}」加载歌词，共 ${parseLRC(text).length} 行`);
      })
      .catch(() => notify("歌词文件读取失败"));
  }

  // ============ 曲库持久化 ============
  let persistWarned = false;
  let persistenceAsked = false;

  function trackToRecord(track) {
    return {
      key: track.path || (track.file && track.file.name) || `track-${track.id}`,
      path: track.path || null,
      title: track.title || null,
      artist: track.artist || null,
      album: track.album || null,
      lrcText: track.lrcText || null,
      cover: track.coverFile || null, // 内嵌封面不存，恢复时重新解析音频即可
      audio: track.file,
      savedAt: Date.now(),
    };
  }

  /** 把曲目写进本地曲库；失败只提示一次，不打断播放 */
  async function persistTracks(tracks) {
    if (!canPersist) return;
    const records = (tracks || []).filter((t) => t && t.file).map(trackToRecord);
    if (!records.length) return;
    try {
      await library.putAll(records);
      if (!persistenceAsked) {
        persistenceAsked = true;
        library.requestPersistence();
      }
    } catch (err) {
      if (!persistWarned) {
        persistWarned = true;
        notify("曲库保存失败（浏览器存储空间不足或不可用），刷新后这部分会丢失");
      }
    }
  }

  /** 页面加载时恢复上次导入的曲目 */
  async function restoreLibrary() {
    if (!canPersist) return;
    let records = [];
    try {
      records = await library.getAll();
    } catch (err) {
      return;
    }
    const usable = records
      .filter((record) => record && record.audio && typeof record.audio.size === "number")
      .sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
    if (!usable.length) return;

    const restored = usable.map((record) => {
      const src = URL.createObjectURL(record.audio);
      state.objectUrls.push(src);
      const track = {
        id: ++state.trackSeq,
        title: record.title || TrackMeta.stemOf(record.path || record.audio.name || ""),
        artist: record.artist || null,
        album: record.album || null,
        src,
        file: record.audio,
        path: record.path || record.audio.name || "",
        lrcText: record.lrcText || null,
        coverFile: record.cover || null,
        restored: true,
      };
      if (track.coverFile) setTrackCover(track, track.coverFile);
      return track;
    });

    state.playlist.push(...restored);
    renderPlaylist();
    // 重新解析一遍标签，让内嵌封面/标题在刷新后也回来（已保存的歌词不会被覆盖）
    TrackMeta.mapLimit(restored, 3, (track) => enrichTrack(track, { lrcFile: null })).catch(() => {});
  }

  function clearLibrary() {
    const removed = state.playlist.filter((t) => t.file);
    removed.forEach((track) => {
      if (track.src) URL.revokeObjectURL(track.src);
      if (track.coverBlobUrl) URL.revokeObjectURL(track.coverBlobUrl);
    });
    state.playlist = state.playlist.filter((t) => !t.file);

    state.current = -1;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    el.playBtn.textContent = "▶";
    el.cover.classList.remove("spinning");
    el.cover.style.backgroundImage = "";
    el.bgBlur.style.backgroundImage = "";
    const placeholder = el.cover.querySelector(".cover-placeholder");
    if (placeholder) placeholder.style.display = "";
    el.title.textContent = "未选择歌曲";
    el.artist.textContent = "—";
    el.curTime.textContent = "00:00";
    el.durTime.textContent = "00:00";
    el.played.style.width = "0";
    el.handle.style.left = "0";
    el.buffered.style.width = "0";
    setLyrics("");
    renderPlaylist();

    if (canPersist) library.clear().catch(() => {});
    notify(removed.length ? `已清空 ${removed.length} 首导入的曲目` : "曲库已经是空的");
  }

  // ============ 拖放导入 ============
  function hasFiles(e) {
    const types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, "Files") !== -1;
  }

  /** 递归展开拖入的目录（readEntries 每次最多返回 100 项，必须循环读到返回空数组） */
  async function walkEntry(entry, prefix, out) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, path: prefix + file.name });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await walkEntry(child, prefix + entry.name + "/", out);
    }
  }

  async function collectDroppedEntries(dataTransfer) {
    // dataTransfer 在 await 之后就失效了，entry 必须在同步阶段取出
    const items = Array.from(dataTransfer.items || []);
    const entries = items
      .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
      .filter(Boolean);
    if (!entries.length) {
      return Array.from(dataTransfer.files || []).map((file) => ({ file, path: file.name }));
    }
    const out = [];
    for (const entry of entries) await walkEntry(entry, "", out);
    return out;
  }

  function bindDropZone() {
    let depth = 0;
    window.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      el.dropHint.classList.add("show");
    });
    window.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    window.addEventListener("dragleave", (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) el.dropHint.classList.remove("show");
    });
    window.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      el.dropHint.classList.remove("show");
      collectDroppedEntries(e.dataTransfer)
        .then(addImport)
        .catch(() => notify("导入失败：无法读取拖入的文件"));
    });
  }

  // ============ 初始化 ============
  function init() {
    state.playlist = (window.DEFAULT_PLAYLIST || []).slice();
    state.mode = "list";
    el.modeIcon.textContent = MODE_ICON[state.mode];
    audio.volume = parseFloat(el.volumeSlider.value);
    renderPlaylist();
    bindEvents();

    // 预加载第一首信息（但不自动播放）
    if (state.playlist.length) {
      const t = state.playlist[0];
      el.title.textContent = t.title;
      el.artist.textContent = t.artist || "未知歌手";
    }

    // 页面卸载时释放 blob url
    window.addEventListener("beforeunload", () => {
      state.objectUrls.forEach((u) => URL.revokeObjectURL(u));
    });

    // 恢复上次导入的曲库（刷新后还在）
    restoreLibrary();
  }

  // 「清空曲库」只在有导入曲目时才显示（.btn 是 display:grid，用不了 hidden 属性）
  function updateClearBtn() {
    el.clearBtn.classList.toggle("is-hidden", !state.playlist.some((t) => t.file));
  }

  init();
})();
