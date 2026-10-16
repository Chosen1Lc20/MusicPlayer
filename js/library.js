/**
 * 曲库持久化（IndexedDB）
 *
 * 解决的问题：导入的曲目原本只存在内存里，刷新页面就没了。
 * 现在把每首导入曲目的音频文件、已解析出的标题/歌手/专辑/歌词，以及配对到的封面图
 * 存进 IndexedDB，刷新后自动恢复。
 *
 * 为什么不存文件路径：浏览器出于安全考虑不提供本地文件的真实路径，而且刷新后
 * 路径也不能直接用来读文件。File System Access 的句柄（handle）可以结构化克隆并
 * 存下来避免复制文件，但只有 Chromium 支持、恢复时还要用户再点一次授权。
 * 这里选择「存一份文件数据」：所有浏览器行为一致、恢复时不需要任何授权交互，
 * 代价是曲库会在磁盘上多占一份空间（见 AGENTS.md 的说明）。
 *
 * 记录结构：
 *   key      主键（用相对路径，重复导入同一文件夹会覆盖而不是堆积）
 *   path     相对路径 / 文件名
 *   title / artist / album / lrcText
 *   cover    配对到的封面图（Blob，可选；内嵌封面不存，恢复时重新解析音频即可）
 *   audio    音频文件（File / Blob，必需）
 *   savedAt  写入时间，用于恢复时保持原顺序
 *
 * 对外接口挂在 window.TrackLibrary 上。本文件不依赖 DOM。
 */
(function (global) {
  "use strict";

  const DB_NAME = "music-player";
  const DB_VERSION = 1;
  const STORE = "tracks";

  function supported() {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  }

  let dbPromise = null;

  function openDB() {
    if (!supported()) return Promise.reject(new Error("当前浏览器不支持 IndexedDB"));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("打开曲库失败"));
      request.onblocked = () => reject(new Error("曲库被其它标签页占用"));
    }).catch((err) => {
      dbPromise = null; // 失败后允许下次重试
      throw err;
    });
    return dbPromise;
  }

  function put(record) {
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(record);
          tx.oncomplete = () => resolve(record.key);
          tx.onerror = () => reject(tx.error || new Error("写入曲库失败"));
          tx.onabort = () => reject(tx.error || new Error("写入曲库被中止"));
        })
    );
  }

  /** 逐条写入（每条一个事务）：万一空间不够，前面写成功的仍然保留 */
  async function putAll(records) {
    let saved = 0;
    for (const record of records || []) {
      await put(record);
      saved++;
    }
    return saved;
  }

  function getAll() {
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readonly");
          const request = tx.objectStore(STORE).getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error || new Error("读取曲库失败"));
        })
    );
  }

  function remove(key) {
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(key);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error || new Error("删除曲库记录失败"));
        })
    );
  }

  function clear() {
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).clear();
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error || new Error("清空曲库失败"));
        })
    );
  }

  /**
   * 尽量让浏览器把这份数据当作「持久」的，避免磁盘紧张时被清理掉。
   * 不需要用户手势，浏览器会自己决定；失败也无所谓，只是数据可能被回收。
   */
  function requestPersistence() {
    try {
      if (!global.navigator || !global.navigator.storage || !global.navigator.storage.persist) {
        return Promise.resolve(false);
      }
      return global.navigator.storage
        .persisted()
        .then((already) => (already ? true : global.navigator.storage.persist()))
        .catch(() => false);
    } catch (err) {
      return Promise.resolve(false);
    }
  }

  const api = { supported, put, putAll, getAll, remove, clear, requestPersistence };

  global.TrackLibrary = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
