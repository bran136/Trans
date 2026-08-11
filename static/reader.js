const readerState = {
  books: [],
  currentBookId: "",
  currentBook: null,
  chapters: [],
  currentChapter: 0,
  currentSentence: 0,
  sentences: [],
  voices: [],
  reading: false,
  paused: false,
  ttsPreparing: false,
  playbackRate: 1,
  ttsConfig: null,
  ttsAudio: null,
  ttsToken: 0,
  ttsScope: 0,
  ttsPacks: new Map(),
  ttsPackPending: new Map(),
  ttsPackOrder: [],
  ttsPackPrepareMs: 0,
  activeTtsPackKey: "",
  ttsPlaybackSegments: [],
  nextChapterPrefetch: null,
  mediaMetadataSignature: "",
  saveTimer: null,
  importJobs: [],
  localImportJobs: [],
  importPollTimer: null,
  importDisplayTimer: null,
  scrollLockTop: 0,
  lastUserScrollAt: 0,
  deferredAutoScrollTimer: null,
  lastSentenceTapIndex: -1,
  lastSentenceTapAt: 0,
  sleepTimerId: null,
  sleepCountdownId: null,
  sleepBoundaryTimerId: null,
  sleepFadeTimerId: null,
  sleepDeadline: 0,
  sleepPausePending: false,
  sleepFadeStarted: false,
  sleepPauseTarget: null,
  wakeLock: null,
  wakeLockWanted: false,
  mimoBalance: null,
  mimoBalanceError: "",
  mimoBalanceLoadedAt: 0,
  mimoBalanceRetryAt: 0,
  mimoBalanceTimer: null,
  mimoBalanceRetryTimer: null,
  mimoBalanceCountdownTimer: null,
  mimoBalanceRequestId: 0,
  tocEditBookId: "",
  tocEditBook: null,
  tocEditChapters: [],
  tocLineChapter: null,
  tocLineRows: [],
  offlineBookId: "",
  offlineBook: null,
  offlineStatus: null,
  offlineLocalStats: new Map(),
  offlineBusy: false,
  offlineActiveJobId: "",
  offlineDownloadController: null,
  offlineCancelRequested: false,
  offlineRetry: null,
  metadataEditBookId: "",
};

const $ = (id) => document.getElementById(id);
const CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')?.content || "";
const TTS_OFFLINE_DB_NAME = "trans-reader-offline-v1";
const TTS_OFFLINE_PACK_STORE = "packs";
const TTS_OFFLINE_DOWNLOAD_WORKERS = 6;
const TTS_OFFLINE_MAX_CHAPTERS = 300;
const TTS_PACK_PREFETCH_WORKERS = 4;
const TTS_PACK_SCHEMA_VERSION = 2;
const TTS_MAX_PACK_BYTES = 32 * 1024 * 1024;
let ttsOfflineDbPromise = null;
let ttsCacheStatsRetryTimer = null;
let mediaVolumeAdjustmentSupported = null;
const TTS_BROWSER_PACK_CACHE_LIMIT = 20;
const TTS_SLEEP_FADE_SECONDS = 7;
const TTS_AUDIO_READY_TIMEOUT_MS = 3 * 60 * 1000;
const BOOK_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const FONT_OPTIONS = [
  { id: "system", name: "系统字体", family: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "微软雅黑", Arial, sans-serif', reliableOnIOS: true },
  { id: "kai", name: "楷体", family: 'KaiTi, "楷体", serif', reliableOnIOS: false },
  { id: "lxgw-wenkai", name: "霞鹜文楷", family: '"ReaderLXGWWenKai", "LXGW WenKai", "霞鹜文楷", KaiTi, "楷体", serif', reliableOnIOS: true },
  { id: "source-serif", name: "思源宋体", family: '"ReaderSourceHanSerif", "Source Han Serif CN", "思源宋体", SimSun, "宋体", serif', reliableOnIOS: true },
  { id: "source-sans", name: "思源黑体", family: '"ReaderSourceHanSans", "Source Han Sans CN", "思源黑体", "Microsoft YaHei", sans-serif', reliableOnIOS: true },
  { id: "jason", name: "清松手写体", family: '"ReaderJasonHandwriting", "清松手写体", "JasonHandwriting", "Microsoft YaHei", sans-serif', reliableOnIOS: true },
  { id: "yshi-written", name: "写意体", family: '"ReaderYShiWritten", "YShi-Written", "写意体", "Microsoft YaHei", sans-serif', reliableOnIOS: true },
  { id: "peak-plus", name: "随峰体Plus", family: '"ReaderThePeakFontPlus", "The Peak Font Plus", "随峰体Plus", "隨峰體Plus", "Microsoft YaHei", sans-serif', reliableOnIOS: true },
];
const FONT_FAMILIES = Object.fromEntries(FONT_OPTIONS.map((font) => [font.id, font.family]));
const FONT_WEB_FAMILIES = {
  jason: "ReaderJasonHandwriting",
  "source-serif": "ReaderSourceHanSerif",
  "source-sans": "ReaderSourceHanSans",
  "lxgw-wenkai": "ReaderLXGWWenKai",
  "yshi-written": "ReaderYShiWritten",
  "peak-plus": "ReaderThePeakFontPlus",
};
const FONT_DOWNLOAD_SIZES = {
  jason: "4.1 MiB",
  "source-serif": "8.0 MiB",
  "source-sans": "5.9 MiB",
  "lxgw-wenkai": "7.6 MiB",
  "yshi-written": "1.7 MiB",
  "peak-plus": "8.0 MiB",
};
const FONT_ASSET_URLS = {
  jason: "/static/fonts/JasonHandwriting1.woff2?v=a937a66f",
  "source-serif": "/static/fonts/SourceHanSerifCN-Regular.woff2?v=46fe8158",
  "source-sans": "/static/fonts/SourceHanSansCN-Regular.woff2?v=e766621f",
  "lxgw-wenkai": "/static/fonts/LXGWWenKai-Regular.woff2?v=8c92d1b4",
  "yshi-written": "/static/fonts/YShiWritten-Regular.woff2?v=943d3985",
  "peak-plus": "/static/fonts/ThePeakFontPlus-Regular.woff2?v=5f91f0d2",
};
const FONT_CACHE_NAME = "reader-font-assets-v1";
const fontLoadPromises = new Map();
const fontActivationPromises = new Map();
const loadedReaderFontIds = window.readerLoadedFontIds instanceof Set
  ? window.readerLoadedFontIds
  : new Set();
window.readerLoadedFontIds = loadedReaderFontIds;
let fontApplyGeneration = 0;

function isIOSLike() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function canAdjustMediaVolume() {
  if (mediaVolumeAdjustmentSupported !== null) return mediaVolumeAdjustmentSupported;
  try {
    const probe = document.createElement("audio");
    probe.volume = 0.5;
    mediaVolumeAdjustmentSupported = Math.abs(probe.volume - 0.5) < 0.01;
  } catch {
    mediaVolumeAdjustmentSupported = false;
  }
  return mediaVolumeAdjustmentSupported;
}

function availableFontOptions() {
  if (!isIOSLike()) return FONT_OPTIONS;
  return FONT_OPTIONS.filter((font) => font.reliableOnIOS);
}

function normalizeFontId(fontId) {
  const options = availableFontOptions();
  return options.some((font) => font.id === fontId) ? fontId : "system";
}

function lockReaderScroll() {
  if (document.body.classList.contains("dialog-scroll-locked")) return;
  readerState.scrollLockTop = window.scrollY || document.documentElement.scrollTop || 0;
  document.body.style.setProperty("--dialog-scroll-top", `-${readerState.scrollLockTop}px`);
  document.body.classList.add("dialog-scroll-locked");
}

function unlockReaderScroll() {
  if (document.querySelector(".reader-dialog[open]")) return;
  if (!document.body.classList.contains("dialog-scroll-locked")) return;
  document.body.classList.remove("dialog-scroll-locked");
  document.body.style.removeProperty("--dialog-scroll-top");
  window.scrollTo(0, readerState.scrollLockTop || 0);
}

function openReaderDialog(dialog) {
  if (!dialog) return;
  lockReaderScroll();
  if (dialog.open) return;
  dialog.showModal();
  const panel = dialog.querySelector(".dialog-panel");
  if (panel) {
    panel.tabIndex = -1;
    try {
      panel.focus({ preventScroll: true });
    } catch {
      panel.focus();
    }
  }
}
function markUserScrollIntent() {
  readerState.lastUserScrollAt = Date.now();
}

async function requestReaderWakeLock() {
  if (!("wakeLock" in navigator) || readerState.wakeLock || document.visibilityState !== "visible") return;
  try {
    const lock = await navigator.wakeLock.request("screen");
    readerState.wakeLock = lock;
    lock.addEventListener("release", () => {
      if (readerState.wakeLock === lock) readerState.wakeLock = null;
      if (readerState.wakeLockWanted && readerState.reading && !readerState.paused && document.visibilityState === "visible") {
        window.setTimeout(() => requestReaderWakeLock(), 250);
      }
    });
  } catch {
    readerState.wakeLock = null;
  }
}

function releaseReaderWakeLock() {
  const lock = readerState.wakeLock;
  readerState.wakeLock = null;
  if (lock) lock.release().catch(() => {});
}

function syncReaderWakeLock() {
  const shouldKeepAwake = readerState.reading && !readerState.paused;
  readerState.wakeLockWanted = shouldKeepAwake;
  if (shouldKeepAwake) {
    requestReaderWakeLock();
  } else {
    releaseReaderWakeLock();
  }
}

function mediaSessionAvailable() {
  return "mediaSession" in navigator && "MediaMetadata" in window;
}

function currentChapterTitle() {
  const chapter = readerState.chapters.find((item) => Number(item.index) === Number(readerState.currentChapter));
  return chapter?.title || "在线读书";
}

function updateMediaSessionMetadata() {
  if (!mediaSessionAvailable() || !readerState.currentBook) return;
  const artworkUrl = document.body.dataset.mediaArtworkUrl;
  const title = readerState.currentBook.title || "在线读书";
  const artist = currentChapterTitle();
  const signature = [readerState.currentBookId, title, readerState.currentChapter, artist, artworkUrl || ""].join("|");
  if (signature === readerState.mediaMetadataSignature) return;
  const metadata = {
    title,
    artist,
    album: "Trans工具 · 在线读书",
  };
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      ...metadata,
      artwork: artworkUrl ? [{ src: artworkUrl, sizes: "512x512", type: "image/png" }] : [],
    });
    readerState.mediaMetadataSignature = signature;
  } catch {
    try {
      navigator.mediaSession.metadata = new MediaMetadata(metadata);
      readerState.mediaMetadataSignature = signature;
    } catch {
      // Incomplete Media Session support must not interrupt playback.
    }
  }
}

function setMediaSessionPlaybackState(state) {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.playbackState = state;
  } catch {
    // Older browsers may expose Media Session without playbackState support.
  }
}

function initializeMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const setHandler = (action, handler) => {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // Ignore actions not supported by this browser.
    }
  };
  setHandler("play", () => {
    if (!readerState.reading) {
      startListeningFrom(readerState.currentSentence).catch((error) => setListenStatus(error.message));
      return;
    }
    if (readerState.paused) {
      toggleListeningPause().catch((error) => setListenStatus(error.message));
    }
  });
  setHandler("pause", () => {
    if (readerState.reading && !readerState.paused) {
      toggleListeningPause().catch((error) => setListenStatus(error.message));
    }
  });
  setHandler("stop", () => stopListening());
}

function promiseWithTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.method && !["GET", "HEAD"].includes(options.method.toUpperCase()) ? { "X-CSRF-Token": CSRF_TOKEN } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.error || `请求失败：${response.status}`);
    error.code = data.code || "";
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return response.json();
}

function openTtsOfflineDb() {
  if (!("indexedDB" in window)) return Promise.reject(new Error("当前浏览器不支持本机离线缓存"));
  if (ttsOfflineDbPromise) return ttsOfflineDbPromise;
  let openPromise;
  openPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(TTS_OFFLINE_DB_NAME, 6);
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      fail(new Error("读取本机离线缓存超时，请关闭其他读书页面后重试"));
    }, 8000);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      if (ttsOfflineDbPromise === openPromise) ttsOfflineDbPromise = null;
      reject(error);
    };
    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (database.objectStoreNames.contains("audio")) {
        database.deleteObjectStore("audio");
      }
      if (Number(event.oldVersion) < 6 && database.objectStoreNames.contains(TTS_OFFLINE_PACK_STORE)) {
        database.deleteObjectStore(TTS_OFFLINE_PACK_STORE);
      }
      const packStore = database.objectStoreNames.contains(TTS_OFFLINE_PACK_STORE)
        ? request.transaction.objectStore(TTS_OFFLINE_PACK_STORE)
        : database.createObjectStore(TTS_OFFLINE_PACK_STORE, { keyPath: "id" });
      if (!packStore.indexNames.contains("book")) {
        packStore.createIndex("book", "bookId", { unique: false });
      }
      if (!packStore.indexNames.contains("bookProfile")) {
        packStore.createIndex("bookProfile", ["bookId", "profileKey"], { unique: false });
      }
      if (!packStore.indexNames.contains("bookProfileChapter")) {
        packStore.createIndex("bookProfileChapter", ["bookId", "profileKey", "chapterIndex"], { unique: false });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      database.onversionchange = () => {
        database.close();
        if (ttsOfflineDbPromise === openPromise) ttsOfflineDbPromise = null;
      };
      resolve(database);
    };
    request.onerror = () => fail(request.error || new Error("无法打开本机离线缓存"));
    request.onblocked = () => fail(new Error("离线缓存数据库正在被其他页面占用，请关闭其他读书页面后重试"));
  });
  ttsOfflineDbPromise = openPromise;
  return openPromise;
}

function normalizedOfflineTtsText(value) {
  const maxChars = Math.max(80, Math.min(Number(readerState.ttsConfig?.chunk_chars) || 260, 800));
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function offlinePackRecordId(bookId, profileKey, chapterIndex, packKey) {
  return `${bookId}:${profileKey}:${Number(chapterIndex)}:${packKey}`;
}

function validPackSegments(segments) {
  if (!Array.isArray(segments) || !segments.length) return false;
  let previousEnd = 0;
  let previousIndex = -1;
  return segments.every((segment) => {
    const index = Number(segment.index);
    const start = Number(segment.start);
    const end = Number(segment.end);
    const first = previousIndex < 0;
    const valid = Number.isInteger(index)
      && index > previousIndex
      && Number.isFinite(start)
      && Number.isFinite(end)
      && (!first || Math.abs(start) <= 0.05)
      && start >= previousEnd - 0.01
      && end > start;
    previousIndex = index;
    previousEnd = end;
    return valid;
  });
}

function samePackSegments(left, right) {
  return validPackSegments(left)
    && validPackSegments(right)
    && left.length === right.length
    && left.every((segment, index) => (
      Number(segment.index) === Number(right[index].index)
      && Math.abs(Number(segment.start) - Number(right[index].start)) <= 0.002
      && Math.abs(Number(segment.end) - Number(right[index].end)) <= 0.002
      && normalizedOfflineTtsText(segment.text) === normalizedOfflineTtsText(right[index].text)
    ));
}

function chapterSentenceTextMap(chapter) {
  const result = new Map();
  (chapter?.paragraphs || []).forEach((paragraph) => {
    if (paragraph?.type === "image") return;
    (paragraph?.sentences || []).forEach((sentence) => {
      result.set(Number(sentence.index), normalizedOfflineTtsText(sentence.text));
    });
  });
  return result;
}

async function localOfflinePackForChapter(bookId, profileKey, chapterIndex, index, textByIndex) {
  if (!bookId || !profileKey) return null;
  try {
    const database = await openTtsOfflineDb();
    return await new Promise((resolve, reject) => {
      const request = database.transaction(TTS_OFFLINE_PACK_STORE, "readonly")
        .objectStore(TTS_OFFLINE_PACK_STORE).index("bookProfileChapter")
        .openCursor(IDBKeyRange.only([bookId, profileKey, Number(chapterIndex)]));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(null);
          return;
        }
        const record = cursor.value;
        const recordSegments = Array.isArray(record.segments) ? record.segments : [];
        const lastSegment = recordSegments[recordSegments.length - 1];
        const valid = Number(record.chapterIndex) === Number(chapterIndex)
          && Number(record.schemaVersion) === TTS_PACK_SCHEMA_VERSION
          && record.format === "m4a"
          && record.blob instanceof Blob
          && record.blob.size > 0
          && record.blob.size <= TTS_MAX_PACK_BYTES
          && Number(record.duration) >= 5
          && Number(record.sentenceCount) === recordSegments.length
          && Number.isInteger(Number(record.chapterSentenceCount))
          && Number(record.chapterSentenceCount) >= recordSegments.length
          && Math.abs(Number(lastSegment?.end) - Number(record.duration)) <= 0.15
          && validPackSegments(recordSegments)
          && recordSegments.some((segment) => Number(segment.index) === Number(index))
          && recordSegments.every((segment) => (
            textByIndex.get(Number(segment.index)) === normalizedOfflineTtsText(segment.text)
          ));
        if (valid) {
          resolve(record);
          return;
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

async function hasLocalOfflinePack(manifest, entry) {
  try {
    const database = await openTtsOfflineDb();
    const id = offlinePackRecordId(
      manifest.book_id,
      manifest.profile_key,
      manifest.chapter_index,
      entry.pack_key,
    );
    const record = await new Promise((resolve, reject) => {
      const request = database.transaction(TTS_OFFLINE_PACK_STORE, "readonly")
        .objectStore(TTS_OFFLINE_PACK_STORE).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    normalizedPackManifest(record || {}, record?.blob, null, {
      bookId: manifest.book_id,
      chapterIndex: manifest.chapter_index,
      profileKey: manifest.profile_key,
      chapterHash: manifest.chapter_hash,
    });
    return !!record
      && record.chapterHash === manifest.chapter_hash
      && Number(record.chapterSentenceCount) === Number(manifest.sentence_count)
      && Number(record.schemaVersion) === Number(entry.schema_version || TTS_PACK_SCHEMA_VERSION)
      && record.packKey === entry.pack_key
      && Number(record.startSentenceIndex) === Number(entry.start_sentence_index)
      && Number(record.endSentenceIndex) === Number(entry.end_sentence_index)
      && Number(record.sentenceCount) === Number(entry.sentence_count)
      && Math.abs(Number(record.duration) - Number(entry.duration)) <= 0.1
      && record.format === entry.format
      && Number(record.size) === Number(record.blob?.size)
      && samePackSegments(record.segments, entry.segments)
      && record.blob instanceof Blob
      && record.blob.size > 0
      && record.blob.size <= TTS_MAX_PACK_BYTES;
  } catch {
    return false;
  }
}

async function saveLocalOfflinePack(manifest, entry, blob) {
  if (!(blob instanceof Blob) || !blob.size || blob.size > TTS_MAX_PACK_BYTES) {
    throw new Error("下载的播放包大小无效");
  }
  const normalized = normalizedPackManifest(entry, blob, null, {
    bookId: manifest.book_id,
    chapterIndex: manifest.chapter_index,
    profileKey: manifest.profile_key,
    chapterHash: manifest.chapter_hash,
  });
  const chapterSentenceCount = Number(manifest.sentence_count);
  if (!Number.isInteger(chapterSentenceCount) || chapterSentenceCount < normalized.sentenceCount) {
    throw new Error("离线章节句数无效");
  }
  const database = await openTtsOfflineDb();
  const record = {
    id: offlinePackRecordId(manifest.book_id, manifest.profile_key, manifest.chapter_index, normalized.packKey),
    bookId: manifest.book_id,
    profileKey: manifest.profile_key,
    chapterIndex: Number(manifest.chapter_index),
    chapterHash: manifest.chapter_hash,
    chapterSentenceCount,
    schemaVersion: normalized.schemaVersion,
    packKey: normalized.packKey,
    startSentenceIndex: normalized.startSentenceIndex,
    endSentenceIndex: normalized.endSentenceIndex,
    sentenceCount: normalized.sentenceCount,
    segments: normalized.segments,
    duration: normalized.duration,
    format: normalized.format,
    nextStartSentenceIndexes: normalized.nextStartSentenceIndexes,
    remainingPackCount: normalized.remainingPackCount,
    size: blob.size,
    savedAt: Date.now(),
    blob,
  };
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(TTS_OFFLINE_PACK_STORE, "readwrite");
    transaction.objectStore(TTS_OFFLINE_PACK_STORE).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("写入本机播放包失败"));
    transaction.onabort = () => reject(transaction.error || new Error("本机缓存空间不足"));
  });
}

async function localOfflineStats(bookId, profileKey, chapters = []) {
  const stats = new Map();
  if (!bookId || !profileKey) return stats;
  const chapterHashes = new Map(chapters
    .filter((chapter) => /^[0-9a-f]{64}$/.test(String(chapter.chapter_hash || "")))
    .map((chapter) => [Number(chapter.index), chapter.chapter_hash]));
  const chapterSentenceCounts = new Map(chapters
    .filter((chapter) => chapter.total_sentences !== null && Number.isInteger(Number(chapter.total_sentences)))
    .map((chapter) => [Number(chapter.index), Number(chapter.total_sentences)]));
  try {
    const database = await openTtsOfflineDb();
    await new Promise((resolve, reject) => {
      const request = database.transaction(TTS_OFFLINE_PACK_STORE, "readonly")
        .objectStore(TTS_OFFLINE_PACK_STORE).index("bookProfile")
        .openCursor(IDBKeyRange.only([bookId, profileKey]));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const record = cursor.value;
        const chapterIndex = Number(record.chapterIndex);
        const recordSegments = Array.isArray(record.segments) ? record.segments : [];
        const lastSegment = recordSegments[recordSegments.length - 1];
        const expectedChapterHash = chapterHashes.get(chapterIndex);
        const expectedChapterSentenceCount = chapterSentenceCounts.get(chapterIndex);
        if ((!expectedChapterHash || expectedChapterHash === record.chapterHash)
          && (expectedChapterSentenceCount === undefined || expectedChapterSentenceCount === Number(record.chapterSentenceCount))
          && Number(record.schemaVersion) === TTS_PACK_SCHEMA_VERSION
          && record.format === "m4a"
          && Number(record.duration) >= 5
          && Number(record.sentenceCount) === recordSegments.length
          && Number.isInteger(Number(record.chapterSentenceCount))
          && Number(record.chapterSentenceCount) >= recordSegments.length
          && Math.abs(Number(lastSegment?.end) - Number(record.duration)) <= 0.15
          && record.blob instanceof Blob
          && record.blob.size > 0
          && record.blob.size <= TTS_MAX_PACK_BYTES
          && validPackSegments(recordSegments)) {
          const current = stats.get(chapterIndex) || {
            entries: 0,
            packs: 0,
            sizeBytes: 0,
            totalSentences: 0,
            indexes: new Set(),
          };
          recordSegments.forEach((segment) => current.indexes.add(Number(segment.index)));
          current.entries = current.indexes.size;
          current.packs += 1;
          current.sizeBytes += Number(record.size) || Number(record.blob.size) || 0;
          current.totalSentences = Math.max(current.totalSentences, Number(record.chapterSentenceCount));
          stats.set(chapterIndex, current);
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    throw error;
  }
  return stats;
}

async function deleteLocalOfflineStoreRecords(database, storeName, bookId, profileKey = "", chapterIndexes = null) {
  const selected = chapterIndexes ? new Set(chapterIndexes.map(Number)) : null;
  let entries = 0;
  let sizeBytes = 0;
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const indexName = profileKey ? "bookProfile" : "book";
    const key = profileKey ? [bookId, profileKey] : bookId;
    const request = store.index(indexName).openCursor(IDBKeyRange.only(key));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (!selected || selected.has(Number(cursor.value.chapterIndex))) {
        entries += 1;
        sizeBytes += Number(cursor.value.size) || Number(cursor.value.blob?.size) || 0;
        cursor.delete();
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error("读取本机缓存失败"));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("删除本机缓存失败"));
    transaction.onabort = () => reject(transaction.error || new Error("删除本机缓存失败"));
  });
  return { entries, sizeBytes };
}

async function deleteLocalOfflineChapters(bookId, profileKey, chapterIndexes) {
  if (!bookId || !profileKey || !chapterIndexes.length) return { entries: 0, packs: 0, sizeBytes: 0 };
  const database = await openTtsOfflineDb();
  const packs = await deleteLocalOfflineStoreRecords(database, TTS_OFFLINE_PACK_STORE, bookId, profileKey, chapterIndexes);
  return { entries: packs.entries, packs: packs.entries, sizeBytes: packs.sizeBytes };
}

async function deleteLocalOfflineBook(bookId) {
  if (!bookId) return { entries: 0, packs: 0, sizeBytes: 0 };
  const database = await openTtsOfflineDb();
  const packs = await deleteLocalOfflineStoreRecords(database, TTS_OFFLINE_PACK_STORE, bookId);
  return { entries: packs.entries, packs: packs.entries, sizeBytes: packs.sizeBytes };
}

async function discardLocalOfflineBook(bookId) {
  try {
    return await deleteLocalOfflineBook(bookId);
  } catch {
    return { entries: 0, sizeBytes: 0 };
  }
}

async function browserStorageSummary() {
  if (!navigator.storage?.estimate) {
    return window.isSecureContext ? "本机容量不可查询" : "HTTP 下无法查询本机容量";
  }
  try {
    const [estimate, persisted] = await Promise.all([
      promiseWithTimeout(navigator.storage.estimate(), 3000, "读取本机存储容量超时"),
      window.isSecureContext && navigator.storage.persisted
        ? promiseWithTimeout(navigator.storage.persisted(), 3000, "读取持久化状态超时")
        : Promise.resolve(false),
    ]);
    const persistence = !window.isSecureContext
      ? " · HTTP 下不能持久化"
      : persisted ? " · 已持久化" : " · 可能被回收";
    return "本机存储 " + formatBytes(estimate.usage || 0) + " / " + formatBytes(estimate.quota || 0)
      + persistence;
  } catch {
    return "本机容量不可查询";
  }
}

async function requestPersistentBrowserStorage() {
  if (!window.isSecureContext || !navigator.storage?.persist) return false;
  try {
    return await promiseWithTimeout(navigator.storage.persist(), 5000, "申请持久化存储超时");
  } catch {
    return false;
  }
}

function uploadWithProgress(path, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.setRequestHeader("X-CSRF-Token", CSRF_TOKEN);
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener("load", () => {
      const data = JSON.parse(xhr.responseText || "{}");
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
      } else {
        reject(new Error(data.error || `请求失败：${xhr.status}`));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("上传失败，请检查网络")));
    xhr.addEventListener("abort", () => reject(new Error("上传已取消")));
    xhr.send(form);
  });
}

function setStatus(text) {
  $("readerStatus").textContent = text || "本地书架";
}

function setUploadMessage(text, type = "") {
  const message = $("uploadMessage");
  if (!message) return;
  message.textContent = text;
  message.className = `upload-message ${type}`.trim();
}

function showUploadProgress(percent) {
  const wrap = $("uploadProgress");
  const bar = $("uploadProgressBar");
  wrap.hidden = false;
  wrap.classList.remove("parsing");
  bar.style.width = `${Math.max(0, Math.min(percent, 100))}%`;
}

function showUploadParsing() {
  const wrap = $("uploadProgress");
  const bar = $("uploadProgressBar");
  wrap.hidden = false;
  wrap.classList.add("parsing");
  bar.style.width = "";
}

function hideUploadProgress() {
  const wrap = $("uploadProgress");
  const bar = $("uploadProgressBar");
  wrap.hidden = true;
  wrap.classList.remove("parsing");
  bar.style.width = "0%";
}

function activeImportCount() {
  const serverActiveJobs = readerState.importJobs.filter((job) => ["uploading", "receiving", "parsing"].includes(job.status));
  const serverIds = new Set(serverActiveJobs.map((job) => job.id));
  const localActive = readerState.localImportJobs.filter((job) => (
    ["uploading", "receiving", "parsing"].includes(job.status) && (!job.server_id || !serverIds.has(job.server_id))
  )).length;
  const serverActive = serverActiveJobs.length;
  return serverActive + localActive;
}

function statusText(job) {
  if (job.status === "done") return "导入完成";
  if (job.status === "error") return job.error || "导入失败";
  if (job.status === "uploading") return "正在上传";
  if (job.status === "receiving") return "等待服务器接收";
  return job.message || "正在解析";
}

function renderImportJobs() {
  const list = $("importJobs");
  const now = Date.now() / 1000;
  const shouldShowJob = (job) => {
    const age = now - Number(job.updated_at || 0);
    if (["uploading", "receiving", "parsing"].includes(job.status)) return true;
    if (job.status === "done") return age < 20;
    if (job.status === "error") return age < 120;
    return age < 20;
  };
  const serverJobs = readerState.importJobs.filter(shouldShowJob);
  const localJobs = readerState.localImportJobs.filter(shouldShowJob);
  const serverIds = new Set(serverJobs.map((job) => job.id));
  const jobs = [
    ...localJobs.filter((job) => !job.server_id || !serverIds.has(job.server_id)),
    ...serverJobs,
  ];
  list.hidden = jobs.length === 0;
  list.innerHTML = jobs.map((job) => (
    `<div class="import-job ${escapeHtml(job.status)}">
      <strong>${escapeHtml(job.name)}</strong>
      <span>${escapeHtml(statusText(job))}</span>
      <div class="import-job-progress"><i style="width: ${Math.max(0, Math.min(Number(job.progress || 0), 100))}%"></i></div>
    </div>`
  )).join("");
  const limited = activeImportCount() >= 2;
  $("uploadForm").classList.toggle("limit-reached", limited);
  $("bookFile").disabled = limited;
  window.clearTimeout(readerState.importDisplayTimer);
  const expiries = jobs
    .filter((job) => !["uploading", "parsing"].includes(job.status))
    .map((job) => {
      const ttl = job.status === "error" ? 120 : 20;
      return Math.max(1, ttl - (Date.now() / 1000 - Number(job.updated_at || 0)));
    });
  if (expiries.length) {
    readerState.importDisplayTimer = window.setTimeout(renderImportJobs, Math.min(...expiries) * 1000);
  }
  if (limited) {
    setUploadMessage("已有 2 本书正在导入，请等待至少一本完成");
  } else if (!$("bookFile").files[0]) {
    setUploadMessage("选择文件后导入到本地书架");
  }
}

async function loadImportJobs() {
  const data = await api("/api/book-imports");
  const previousDone = new Set(readerState.importJobs.filter((job) => job.status === "done").map((job) => job.id));
  readerState.importJobs = data.jobs || [];
  const serverIds = new Set(readerState.importJobs.map((job) => job.id));
  readerState.localImportJobs = readerState.localImportJobs.filter((job) => !job.server_id || !serverIds.has(job.server_id));
  renderImportJobs();
  const hasNewDone = readerState.importJobs.some((job) => job.status === "done" && !previousDone.has(job.id));
  if (hasNewDone) await loadBooks();
  const hasActive = activeImportCount() > 0;
  window.clearTimeout(readerState.importPollTimer);
  if (hasActive) {
    readerState.importPollTimer = window.setTimeout(() => loadImportJobs().catch((error) => setStatus(error.message)), 1500);
  }
}

function startImportPolling() {
  window.clearTimeout(readerState.importPollTimer);
  readerState.importPollTimer = window.setTimeout(() => loadImportJobs().catch((error) => setStatus(error.message)), 500);
}

function formatProgress(book) {
  const progress = book.progress || {};
  if (!book.chapter_count) return "未开始";
  return `第 ${Number(progress.chapter || 0) + 1} / ${book.chapter_count} 章`;
}

function formatBookAuthor(book) {
  return book.author || "作者未知";
}

function bookProgressPercent(book) {
  const chapterCount = Math.max(0, Number(book.chapter_count) || 0);
  if (!chapterCount) return 0;
  const chapterIndex = Math.max(0, Math.min(chapterCount - 1, Number(book.progress?.chapter) || 0));
  return Math.round(((chapterIndex + 1) / chapterCount) * 100);
}

function formatBookLastOpened(book) {
  const timestamp = Number(book.last_opened_at || book.updated_at || book.created_at || 0);
  if (!timestamp) return "暂无记录";
  const date = new Date(timestamp > 1e12 ? timestamp : timestamp * 1000);
  if (Number.isNaN(date.getTime())) return "暂无记录";
  return BOOK_DATE_FORMATTER.format(date);
}

function recentlyOpenedBooks() {
  return [...readerState.books].sort((a, b) => (
    Number(b.last_opened_at || b.updated_at || b.created_at || 0) - Number(a.last_opened_at || a.updated_at || a.created_at || 0)
  ));
}

async function loadBooks() {
  const data = await api("/api/books");
  readerState.books = data.books || [];
  renderBooks();
}

function renderBooks() {
  $("bookCount").textContent = `${readerState.books.length} 本`;
  renderBookList($("bookList"));
  renderManageBooks();
  renderStatistics();
}

function renderBookList(list) {
  list.innerHTML = "";
  if (!readerState.books.length) {
    list.innerHTML = '<div class="book-item"><strong>暂无书籍</strong><span>导入 TXT、EPUB 或 PDF</span></div>';
    return;
  }
  const shelfBooks = recentlyOpenedBooks();
  shelfBooks.forEach((book) => {
    const button = document.createElement("button");
    button.className = `book-item ${book.id === readerState.currentBookId ? "active" : ""}`;
    button.type = "button";
    button.innerHTML = `
      ${book.cover_url ? `<span class="book-cover" style="background-image: url('${escapeAttribute(book.cover_url)}')"></span>` : ""}
      <strong>${escapeHtml(book.title)}</strong>
      <span>${escapeHtml(formatBookAuthor(book))} · ${formatProgress(book)}</span>
    `;
    button.addEventListener("click", async () => {
      await openBook(book.id, book.progress?.chapter || 0, book.progress?.sentence || 0);
    });
    list.appendChild(button);
  });
}

function renderStatistics() {
  const summary = $("statisticsSummary");
  const list = $("statisticsList");
  if (!summary || !list) return;
  const books = recentlyOpenedBooks();
  summary.textContent = books.length ? `共 ${books.length} 本 · 按最近打开排列 · 进度按章节估算` : "书架中还没有书籍";
  list.innerHTML = "";
  books.forEach((book) => {
    const progressPercent = bookProgressPercent(book);
    const item = document.createElement("article");
    item.className = "statistics-book";
    item.innerHTML = `
      <div class="statistics-book-head">
        <strong>${escapeHtml(book.title)}</strong>
        <span>${progressPercent}%</span>
      </div>
      <div class="statistics-progress" role="progressbar" aria-label="${escapeAttribute(`${book.title} 章节进度`)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progressPercent}">
        <i style="width: ${progressPercent}%"></i>
      </div>
      <div class="statistics-book-meta">
        <span>${escapeHtml(formatProgress(book))}</span>
        <span>最近打开 ${escapeHtml(formatBookLastOpened(book))}</span>
      </div>
    `;
    list.appendChild(item);
  });
}

function renderManageBooks() {
  const list = $("manageBookList");
  if (!list) return;
  list.innerHTML = "";
  if (!readerState.books.length) {
    list.innerHTML = '<div class="manage-empty">暂无书籍</div>';
    return;
  }
  const managedBooks = [...readerState.books].sort((a, b) => (
    Number(b.created_at || 0) - Number(a.created_at || 0)
  ));
  managedBooks.forEach((book) => {
    const hasToc = book.format === "txt" || book.format === "epub";
    const row = document.createElement("div");
    row.className = "manage-book-row";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(book.title)}</strong>
        <span>${escapeHtml(formatBookAuthor(book))} · ${formatProgress(book)}</span>
      </div>
      <div class="manage-book-actions">
        ${book.format === "txt" ? '<button type="button" data-action="clear-toc">清除目录</button>' : '<span class="manage-action-spacer"></span>'}
        ${hasToc ? '<button type="button" data-action="toc-edit">目录</button>' : '<span class="manage-action-spacer"></span>'}
        <button type="button" data-action="edit">编辑</button>
        <button type="button" data-action="reparse">重新解析</button>
        <button type="button" data-action="offline-cache">离线缓存</button>
        <button type="button" data-action="delete">删除</button>
      </div>
    `;
    row.querySelector('[data-action="edit"]').addEventListener("click", () => openBookMetadataEditor(book));
    row.querySelector('[data-action="toc-edit"]')?.addEventListener("click", () => openTocEditor(book));
    row.querySelector('[data-action="reparse"]').addEventListener("click", () => reparseBook(book));
    row.querySelector('[data-action="clear-toc"]')?.addEventListener("click", () => clearBookToc(book));
    row.querySelector('[data-action="offline-cache"]').addEventListener("click", () => openOfflineCacheManager(book));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => deleteBook(book));
    list.appendChild(row);
  });
}

function showTocEditMessage(text, type = "") {
  const node = $("tocEditMessage");
  node.textContent = text || "";
  node.className = `reader-config-message ${type}`.trim();
  node.hidden = !text;
}

async function openTocEditor(book) {
  if (!["txt", "epub"].includes(book.format)) return;
  readerState.tocEditBookId = book.id;
  readerState.tocEditBook = book;
  readerState.tocEditChapters = [];
  $("tocEditTitle").textContent = book.format === "epub" ? "EPUB 目录" : "TXT 目录编辑";
  showTocEditMessage("正在加载目录");
  openReaderDialog($("tocEditDialog"));
  await refreshTocEditor(book.id);
}

async function refreshTocEditor(bookId = readerState.tocEditBookId) {
  if (!bookId) return;
  const data = await api(`/api/books/${bookId}?inspect=1`);
  readerState.tocEditBook = data.book;
  readerState.tocEditChapters = data.chapters || [];
  readerState.books = readerState.books.map((book) => (book.id === data.book.id ? data.book : book));
  renderBooks();
  renderTocEditor();
  showTocEditMessage(
    data.book.format === "epub" ? "EPUB 目录由书籍文件定义，此处仅供查看" : ""
  );
}

function renderTocEditor() {
  const list = $("tocEditList");
  const chapters = readerState.tocEditChapters || [];
  if (!chapters.length) {
    list.innerHTML = '<div class="manage-empty">没有目录</div>';
    return;
  }
  list.innerHTML = "";
  const editable = readerState.tocEditBook?.format === "txt";
  chapters.forEach((chapter) => {
    const row = document.createElement("div");
    row.className = "toc-edit-row";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(chapter.title)}</strong>
        <span>第 ${Number(chapter.index) + 1} 章 · ${Number(chapter.char_count || 0)} 字</span>
      </div>
      <div class="toc-edit-actions">
        ${editable ? '<button type="button" data-action="rename">改名</button>' : ""}
        ${editable ? '<button type="button" data-action="split">添加</button>' : ""}
        ${editable ? '<button type="button" data-action="delete">删除</button>' : ""}
      </div>
    `;
    row.querySelector('[data-action="rename"]')?.addEventListener("click", () => renameTxtChapter(chapter));
    row.querySelector('[data-action="split"]')?.addEventListener("click", () => openTocLineChooser(chapter));
    row.querySelector('[data-action="delete"]')?.addEventListener("click", () => deleteTxtChapterTitle(chapter));
    list.appendChild(row);
  });
}

async function renameTxtChapter(chapter) {
  const title = window.prompt("请输入新的章节标题", chapter.title || "");
  if (title === null) return;
  const trimmed = title.trim();
  if (!trimmed) {
    showTocEditMessage("标题不能为空", "error");
    return;
  }
  try {
    await api(`/api/books/${readerState.tocEditBookId}/chapters/${chapter.index}/title`, {
      method: "PATCH",
      body: JSON.stringify({ title: trimmed }),
    });
    await refreshTocEditor();
    if (readerState.currentBookId === readerState.tocEditBookId) await openBook(readerState.currentBookId, readerState.currentChapter, readerState.currentSentence);
    showTocEditMessage("标题已更新", "success");
  } catch (error) {
    showTocEditMessage(error.message, "error");
  }
}

async function deleteTxtChapterTitle(chapter) {
  if (!window.confirm(`确定删除标题“${chapter.title}”吗？正文会合并到相邻章节。`)) return;
  try {
    await api(`/api/books/${readerState.tocEditBookId}/chapters/${chapter.index}/title`, { method: "DELETE" });
    await discardLocalOfflineBook(readerState.tocEditBookId);
    await refreshTocEditor();
    if (readerState.currentBookId === readerState.tocEditBookId) await openBook(readerState.currentBookId, Math.max(0, Math.min(readerState.currentChapter, readerState.tocEditChapters.length - 1)), 0);
    showTocEditMessage("标题已删除", "success");
  } catch (error) {
    showTocEditMessage(error.message, "error");
  }
}

async function openTocLineChooser(chapter) {
  readerState.tocLineChapter = chapter;
  readerState.tocLineRows = [];
  $("tocLineSearch").value = "";
  $("tocLineList").innerHTML = '<div class="manage-empty">正在加载章节内容</div>';
  openReaderDialog($("tocLineDialog"));
  try {
    const data = await api(`/api/books/${readerState.tocEditBookId}/chapters/${chapter.index}/lines`);
    readerState.tocLineRows = data.lines || [];
    renderTocLineRows();
  } catch (error) {
    $("tocLineList").innerHTML = `<div class="manage-empty">${escapeHtml(error.message)}</div>`;
  }
}

function renderTocLineRows() {
  const list = $("tocLineList");
  const keyword = $("tocLineSearch").value.trim().toLowerCase();
  const rows = (readerState.tocLineRows || []).filter((line) => (
    !keyword || String(line.text || "").toLowerCase().includes(keyword)
  ));
  if (!rows.length) {
    list.innerHTML = '<div class="manage-empty">没有匹配的行</div>';
    return;
  }
  list.innerHTML = "";
  rows.slice(0, 1200).forEach((line) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `toc-line-row ${line.candidate ? "candidate" : ""}`;
    button.innerHTML = `<span>${Number(line.index) + 1}</span><strong>${escapeHtml(line.text)}</strong>`;
    button.addEventListener("click", () => splitTxtChapterAtLine(line));
    list.appendChild(button);
  });
  if (rows.length > 1200) {
    const note = document.createElement("div");
    note.className = "manage-empty";
    note.textContent = `还有 ${rows.length - 1200} 行未显示，请搜索缩小范围`;
    list.appendChild(note);
  }
}

async function splitTxtChapterAtLine(line) {
  const chapter = readerState.tocLineChapter;
  if (!chapter) return;
  if (!window.confirm(`把这一行作为新标题吗？\n\n${line.text}`)) return;
  try {
    await api(`/api/books/${readerState.tocEditBookId}/chapters/${chapter.index}/split`, {
      method: "POST",
      body: JSON.stringify({ line_index: line.index, title: line.text }),
    });
    await discardLocalOfflineBook(readerState.tocEditBookId);
    $("tocLineDialog").close();
    await refreshTocEditor();
    if (readerState.currentBookId === readerState.tocEditBookId) await openBook(readerState.currentBookId, chapter.index, 0);
    showTocEditMessage("标题已添加", "success");
  } catch (error) {
    $("tocLineList").insertAdjacentHTML("afterbegin", `<div class="reader-config-message error">${escapeHtml(error.message)}</div>`);
  }
}

function showBookMetadataMessage(text, type = "") {
  const message = $("bookMetadataMessage");
  message.textContent = text || "";
  message.className = `reader-config-message ${type}`.trim();
  message.hidden = !text;
}

function openBookMetadataEditor(book) {
  readerState.metadataEditBookId = book.id;
  $("bookTitleInput").value = book.title || "";
  $("bookAuthorInput").value = book.author || "";
  showBookMetadataMessage("");
  openReaderDialog($("bookMetadataDialog"));
  $("bookTitleInput").focus();
}

async function saveBookMetadata(event) {
  event.preventDefault();
  const bookId = readerState.metadataEditBookId;
  if (!bookId) return;
  const trimmedTitle = $("bookTitleInput").value.trim();
  if (!trimmedTitle) {
    showBookMetadataMessage("书名不能为空", "error");
    return;
  }
  const trimmedAuthor = $("bookAuthorInput").value.trim();
  $("saveBookMetadataBtn").disabled = true;
  showBookMetadataMessage("正在保存");
  try {
    const data = await api(`/api/books/${bookId}`, {
      method: "PATCH",
      body: JSON.stringify({ title: trimmedTitle, author: trimmedAuthor }),
    });
    readerState.books = readerState.books.map((item) => (item.id === bookId ? data.book : item));
    if (readerState.currentBookId === bookId && readerState.currentBook) {
      readerState.currentBook.title = data.book.title;
      readerState.currentBook.author = data.book.author;
      setStatus(data.book.title);
    }
    renderBooks();
    $("bookTitleInput").value = data.book.title || "";
    $("bookAuthorInput").value = data.book.author || "";
    showBookMetadataMessage("书籍信息已保存", "success");
  } catch (error) {
    showBookMetadataMessage(error.message, "error");
  } finally {
    $("saveBookMetadataBtn").disabled = false;
  }
}

async function deleteBook(book) {
  const confirmed = window.confirm(`确定删除《${book.title || "未命名书籍"}》吗？`);
  if (!confirmed) return;
  try {
    await api(`/api/books/${book.id}`, { method: "DELETE" });
    await discardLocalOfflineBook(book.id);
    if (readerState.currentBookId === book.id) {
      window.clearTimeout(readerState.saveTimer);
      readerState.saveTimer = null;
      readerState.currentBookId = "";
      readerState.currentBook = null;
      if (window.history.state?.readerView === "book") {
        window.history.back();
      } else {
        showShelfView();
      }
    }
    await loadBooks();
    setUploadMessage("已删除书籍", "success");
  } catch (error) {
    setUploadMessage(error.message, "error");
  }
}

async function reparseBook(book) {
  const confirmed = window.confirm(`确定重新解析《${book.title || "未命名书籍"}》吗？旧章节缓存会被清除。`);
  if (!confirmed) return;
  try {
    setUploadMessage("正在重新解析书籍");
    const data = await api(`/api/books/${book.id}/reparse`, { method: "POST", body: "{}" });
    await discardLocalOfflineBook(book.id);
    readerState.books = readerState.books.map((item) => (item.id === book.id ? data.book : item));
    if (readerState.currentBookId === book.id) {
      await openBook(book.id, data.book.progress?.chapter || 0, data.book.progress?.sentence || 0);
    } else {
      renderBooks();
    }
    setUploadMessage("重新解析完成", "success");
  } catch (error) {
    setUploadMessage(error.message, "error");
  }
}

async function clearBookToc(book) {
  const confirmed = window.confirm(`确定清除《${book.title || "未命名书籍"}》的 TXT 目录信息吗？清除后会作为一整章显示。`);
  if (!confirmed) return;
  try {
    setUploadMessage("正在清除目录信息");
    const data = await api(`/api/books/${book.id}/clear-toc`, { method: "POST", body: "{}" });
    await discardLocalOfflineBook(book.id);
    readerState.books = readerState.books.map((item) => (item.id === book.id ? data.book : item));
    if (readerState.currentBookId === book.id) {
      await openBook(book.id, 0, 0);
    } else {
      renderBooks();
    }
    setUploadMessage("目录信息已清除", "success");
  } catch (error) {
    setUploadMessage(error.message, "error");
  }
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(text) {
  return escapeHtml(text).replace(/'/g, "&#39;");
}

async function uploadBook(event) {
  event.preventDefault();
  if (activeImportCount() >= 2) {
    setUploadMessage("已有 2 本书正在导入，请等待至少一本完成", "error");
    return;
  }
  const formEl = event.currentTarget;
  const fileInput = formEl.querySelector('input[type="file"]');
  const file = fileInput.files[0];
  if (!file) {
    setUploadMessage("请先选择一本 TXT、EPUB 或 PDF", "error");
    return;
  }
  const form = new FormData();
  form.append("book", file);
  const drop = formEl.querySelector(".upload-drop");
  const localJobId = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  readerState.localImportJobs.unshift({
    id: localJobId,
    name: file.name,
    status: "uploading",
    message: "正在上传",
    error: "",
    progress: 0,
    updated_at: Date.now() / 1000,
  });
  renderImportJobs();
  drop.classList.add("loading");
  setStatus("正在导入");
  showUploadProgress(0);
  setUploadMessage(`正在上传：${file.name}`);
  try {
    const data = await uploadWithProgress("/api/books", form, (percent) => {
      const waitingForServer = percent >= 100;
      readerState.localImportJobs = readerState.localImportJobs.map((job) => (
        job.id === localJobId
          ? {
              ...job,
              status: waitingForServer ? "receiving" : "uploading",
              message: waitingForServer ? "等待服务器接收" : "正在上传",
              progress: percent,
              updated_at: Date.now() / 1000,
            }
          : job
      ));
      renderImportJobs();
      showUploadProgress(percent);
      setUploadMessage(waitingForServer ? "浏览器上传完成，等待服务器接收" : `正在上传：${percent}%`);
      if (waitingForServer) showUploadParsing();
    });
    showUploadParsing();
    fileInput.value = "";
    $("selectedFileName").textContent = "TXT / EPUB / PDF，最大 50MB";
    if (data.job) {
      readerState.localImportJobs = readerState.localImportJobs.map((job) => (
        job.id === localJobId ? { ...job, status: "parsing", progress: 100, server_id: data.job.id, updated_at: Date.now() / 1000 } : job
      ));
      readerState.importJobs = [data.job, ...readerState.importJobs.filter((job) => job.id !== data.job.id)];
      renderImportJobs();
      startImportPolling();
      setStatus("正在解析");
      setUploadMessage(`已加入导入队列：${data.job.name}`, "success");
    } else if (data.book) {
      await loadBooks();
      setStatus("导入完成");
      setUploadMessage(`已导入：《${data.book.title}》`, "success");
    }
  } catch (error) {
    readerState.localImportJobs = readerState.localImportJobs.map((job) => (
      job.id === localJobId ? { ...job, status: "error", error: error.message, updated_at: Date.now() / 1000 } : job
    ));
    renderImportJobs();
    setStatus(error.message);
    setUploadMessage(error.message, "error");
  } finally {
    drop.classList.remove("loading");
    window.setTimeout(hideUploadProgress, 900);
  }
}

async function openBook(bookId, chapter = 0, sentence = 0, addHistory = true) {
  const openedFromShelf = !$("shelfView").hidden;
  stopListening(false);
  readerState.currentBookId = bookId;
  const data = await api(`/api/books/${bookId}`);
  readerState.currentBook = data.book;
  readerState.chapters = data.chapters || [];
  renderBooks();
  renderChapterSelect();
  showReadingView(addHistory && openedFromShelf);
  await loadChapter(chapter, sentence);
}

function syncReaderNavigation(isReading) {
  $("statisticsBtn").hidden = isReading;
  $("shelfBtn").hidden = !isReading;
}

function showReadingView(addHistory = false) {
  $("shelfView").hidden = true;
  $("readingView").hidden = false;
  syncReaderNavigation(true);
  if (addHistory) {
    window.history.pushState({ readerView: "book", bookId: readerState.currentBookId }, "", window.location.href);
  }
}

function updateCurrentBookProgressLocally() {
  const bookId = readerState.currentBookId;
  if (!bookId) return null;
  const now = Date.now() / 1000;
  const snapshot = {
    bookId,
    chapter: readerState.currentChapter,
    sentence: readerState.currentSentence,
  };
  readerState.books = readerState.books.map((book) => (
    book.id === bookId
      ? {
          ...book,
          progress: { chapter: snapshot.chapter, sentence: snapshot.sentence },
          updated_at: now,
          last_opened_at: now,
        }
      : book
  ));
  return snapshot;
}

function showShelfView() {
  stopListening(false);
  window.clearTimeout(readerState.saveTimer);
  readerState.saveTimer = null;
  const progressSnapshot = updateCurrentBookProgressLocally();
  if (progressSnapshot) saveProgress(progressSnapshot);
  $("readingView").hidden = true;
  $("shelfView").hidden = false;
  readerState.currentBookId = "";
  readerState.currentBook = null;
  renderBooks();
  syncReaderNavigation(false);
  setStatus("本地书架");
}

function returnToShelf() {
  if (window.history.state?.readerView === "book") {
    window.history.back();
    return;
  }
  showShelfView();
}

function renderChapterSelect() {
  const select = $("chapterSelect");
  select.innerHTML = "";
  readerState.chapters.forEach((chapter) => {
    const option = document.createElement("option");
    option.value = chapter.index;
    option.textContent = `${"　".repeat(Math.max(0, Number(chapter.level || 1) - 1))}${chapter.title}`;
    select.appendChild(option);
  });
}

async function loadChapter(chapterIndex, sentenceIndex = 0) {
  if (!readerState.currentBookId) return;
  const bookId = readerState.currentBookId;
  const normalizedChapterIndex = Number(chapterIndex);
  const preparedEntry = readerState.nextChapterPrefetch;
  const canUsePrepared = preparedEntry
    && preparedEntry.bookId === bookId
    && preparedEntry.chapterIndex === normalizedChapterIndex
    && preparedEntry.scope === readerState.ttsScope;
  let prepared = canUsePrepared ? preparedEntry.prepared : null;
  if (!prepared && canUsePrepared && readerState.reading) {
    prepared = await preparedEntry.promise;
  }
  if (readerState.currentBookId !== bookId) return;
  const data = prepared?.data || await api(`/api/books/${bookId}/chapters/${normalizedChapterIndex}`);
  if (readerState.currentBookId !== bookId) return;
  readerState.currentBook = data.book;
  readerState.currentChapter = data.chapter.index;
  readerState.currentSentence = sentenceIndex;
  $("chapterSelect").value = String(readerState.currentChapter);
  renderChapter(data.chapter, prepared?.packs || []);
  highlightSentence(sentenceIndex, true);
  saveProgressSoon();
  setStatus(readerState.currentBook.title);
  if (readerState.reading) updateMediaSessionMetadata();
}

function renderChapter(chapter, prefetchedPacks = []) {
  clearTtsBrowserCache();
  const content = $("bookContent");
  content.classList.remove("empty");
  content.innerHTML = "";
  readerState.sentences = [];
  let hasRenderableContent = false;
  const title = document.createElement("h2");
  title.className = "chapter-title";
  title.textContent = chapter.title;
  content.appendChild(title);
  chapter.paragraphs.forEach((paragraph) => {
    if (paragraph.type === "image") {
      const figure = document.createElement("figure");
      figure.className = "reader-figure";
      const image = document.createElement("img");
      image.src = paragraph.src;
      image.alt = paragraph.alt || "插图";
      image.loading = "lazy";
      figure.appendChild(image);
      content.appendChild(figure);
      hasRenderableContent = true;
      return;
    }
    const p = document.createElement("p");
    p.className = "reader-paragraph";
    paragraph.sentences.forEach((sentence) => {
      const span = document.createElement("span");
      span.className = "reader-sentence";
      span.dataset.index = sentence.index;
      span.textContent = sentence.text;
      span.addEventListener("click", (event) => {
        event.currentTarget.blur?.();
        handleSentenceTap(event, sentence.index);
      });
      p.appendChild(span);
      p.appendChild(document.createTextNode(" "));
      readerState.sentences.push(sentence);
      hasRenderableContent = true;
    });
    content.appendChild(p);
  });
  if (!hasRenderableContent) {
    content.classList.add("empty");
    content.textContent = "本章没有可阅读文本";
  }
  prefetchedPacks.forEach((pack) => {
    if (!(pack?.blob instanceof Blob) || !validPackSegments(pack.segments)) return;
    const textByIndex = new Map(readerState.sentences.map((sentence) => [
      Number(sentence.index),
      normalizedOfflineTtsText(sentence.text),
    ]));
    if (!pack.segments.every((segment) => textByIndex.get(Number(segment.index)) === segment.text)) return;
    rememberTtsPack(pack, pack.blob);
  });
}

function handleSentenceTap(event, index) {
  const normalizedIndex = Number(index);
  const now = Date.now();
  const sameSentence = readerState.lastSentenceTapIndex === normalizedIndex;
  const isDoubleTap = sameSentence && now - readerState.lastSentenceTapAt <= 460;
  readerState.lastSentenceTapIndex = normalizedIndex;
  readerState.lastSentenceTapAt = now;
  if (isDoubleTap) {
    event.preventDefault();
    focusSentence(normalizedIndex, true);
    return;
  }
  if (readerState.reading) {
    window.clearTimeout(readerState.deferredAutoScrollTimer);
    readerState.lastUserScrollAt = now;
    return;
  }
  focusSentence(normalizedIndex, false);
}

function focusSentence(index, read = false) {
  highlightSentence(index, !read);
  saveProgressSoon();
  if (read) startListeningFrom(index).catch((error) => setListenStatus(error.message));
}

function activeSentenceElement() {
  return document.querySelector(`.reader-sentence[data-index="${readerState.currentSentence}"]`);
}

function scrollActiveSentence(behavior = "smooth") {
  const active = activeSentenceElement();
  if (active) active.scrollIntoView({ block: "center", behavior });
}

function scheduleAutoCenterSentence() {
  window.clearTimeout(readerState.deferredAutoScrollTimer);
  const elapsed = Date.now() - Number(readerState.lastUserScrollAt || 0);
  const delay = Math.max(0, 5000 - elapsed);
  readerState.deferredAutoScrollTimer = window.setTimeout(() => {
    if (readerState.reading && Date.now() - Number(readerState.lastUserScrollAt || 0) >= 5000) {
      scrollActiveSentence("smooth");
    }
  }, delay + 30);
}

function highlightSentence(index, scroll = false) {
  readerState.currentSentence = Math.max(0, Math.min(Number(index) || 0, Math.max(readerState.sentences.length - 1, 0)));
  document.querySelectorAll(".reader-sentence.active").forEach((item) => item.classList.remove("active"));
  const active = activeSentenceElement();
  if (active) {
    active.classList.add("active");
    if (scroll) {
      if (readerState.reading && Date.now() - Number(readerState.lastUserScrollAt || 0) < 5000) {
        scheduleAutoCenterSentence();
      } else {
        scrollActiveSentence("smooth");
      }
    }
  }
}

function saveProgressSoon() {
  window.clearTimeout(readerState.saveTimer);
  readerState.saveTimer = window.setTimeout(() => {
    readerState.saveTimer = null;
    saveProgress();
  }, 350);
}

async function saveProgress(snapshot = null) {
  const bookId = snapshot?.bookId || readerState.currentBookId;
  const chapter = snapshot?.chapter ?? readerState.currentChapter;
  const sentence = snapshot?.sentence ?? readerState.currentSentence;
  if (!bookId) return;
  try {
    const data = await api(`/api/books/${bookId}/progress`, {
      method: "PUT",
      body: JSON.stringify({
        chapter,
        sentence,
      }),
    });
    if (data.book) {
      readerState.books = readerState.books.map((book) => (book.id === data.book.id ? data.book : book));
      if (readerState.currentBookId === data.book.id && readerState.currentBook) {
        readerState.currentBook = { ...readerState.currentBook, ...data.book };
      }
      if (!$("shelfView").hidden) renderBooks();
    }
  } catch (error) {
    setStatus(error.message);
  }
}

function setListenStatus(text) {
  const status = $("listenStatus");
  if (!status) return;
  const message = text || "点击句子可从该句开始读";
  status.textContent = message;
  status.title = message;
}

function audioErrorMessage(audio) {
  const code = audio?.error?.code;
  const messages = {
    1: "音频播放被中止",
    2: "音频网络加载失败",
    3: "音频解码失败",
    4: "浏览器不支持该音频格式",
  };
  return messages[code] || "音频播放失败";
}

function waitForAudioReady(audio, token, scope) {
  if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("浏览器加载播放包超时，请重试"));
    }, TTS_AUDIO_READY_TIMEOUT_MS);
    const cancelId = window.setInterval(() => {
      if (token === readerState.ttsToken && scope === readerState.ttsScope) return;
      cleanup();
      reject(new Error("播放准备已取消"));
    }, 100);
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      window.clearInterval(cancelId);
      audio.removeEventListener("canplay", handleReady);
      audio.removeEventListener("loadeddata", handleReady);
      audio.removeEventListener("error", handleError);
    };
    const handleReady = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error(audioErrorMessage(audio)));
    };
    audio.addEventListener("canplay", handleReady, { once: true });
    audio.addEventListener("loadeddata", handleReady, { once: true });
    audio.addEventListener("error", handleError, { once: true });
    audio.load();
  });
}

function updateListenButtons() {
  const pauseButton = $("listenPauseBtn");
  pauseButton.classList.toggle("active", readerState.paused);
  pauseButton.textContent = readerState.paused ? "继续" : "暂停";
}

function applyAudioPlaybackRate(audio) {
  if (!audio) return;
  const rate = Math.max(0.8, Math.min(Number(readerState.playbackRate) || 1, 2));
  audio.defaultPlaybackRate = rate;
  audio.playbackRate = rate;
}

function updatePlaybackRate() {
  const selectedRate = Number($("playbackRateSelect").value);
  readerState.playbackRate = [0.8, 1, 1.2, 1.5, 2].includes(selectedRate) ? selectedRate : 1;
  $("playbackRateSelect").value = String(readerState.playbackRate);
  window.localStorage.setItem("readerPlaybackRate", String(readerState.playbackRate));
  applyAudioPlaybackRate(readerState.ttsAudio);
  if (readerState.sleepPausePending) scheduleSleepBoundaryPause();
  if (readerState.reading) {
    const segments = readerState.ttsPlaybackSegments;
    const lastSegment = segments.length ? segments[segments.length - 1] : null;
    const lastPreparedIndex = lastSegment
      && Number(lastSegment.chapterIndex) === Number(readerState.currentChapter)
      ? lastSegment.index
      : readerState.currentSentence;
    prefetchUpcomingTtsAudio(lastPreparedIndex, readerState.ttsToken, readerState.ttsScope);
  }
}

function ttsReady(config = readerState.ttsConfig || {}) {
  return !!config.enabled && !!config.api_key_configured;
}

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function updateSleepTimerButton() {
  const button = $("sleepTimerBtn");
  if (!button) return;
  if (readerState.sleepPausePending) {
    button.textContent = "本句后停";
    button.classList.add("active");
    return;
  }
  if (readerState.sleepDeadline) {
    button.textContent = formatCountdown(readerState.sleepDeadline - Date.now());
    button.classList.add("active");
    return;
  }
  button.textContent = "定时";
  button.classList.remove("active");
}

function clearSleepTimer(resetInput = false) {
  window.clearTimeout(readerState.sleepTimerId);
  window.clearInterval(readerState.sleepCountdownId);
  window.clearTimeout(readerState.sleepBoundaryTimerId);
  stopSleepFade();
  readerState.sleepTimerId = null;
  readerState.sleepBoundaryTimerId = null;
  readerState.sleepCountdownId = null;
  readerState.sleepDeadline = 0;
  readerState.sleepPausePending = false;
  readerState.sleepFadeStarted = false;
  readerState.sleepPauseTarget = null;
  if (readerState.ttsAudio) readerState.ttsAudio.volume = 1;
  if (resetInput && $("sleepCustomMinutes")) $("sleepCustomMinutes").value = "";
  updateSleepTimerButton();
}

function armSleepPause() {
  window.clearTimeout(readerState.sleepTimerId);
  window.clearInterval(readerState.sleepCountdownId);
  readerState.sleepTimerId = null;
  readerState.sleepCountdownId = null;
  readerState.sleepDeadline = 0;
  readerState.sleepPausePending = true;
  readerState.sleepFadeStarted = false;
  setSleepPauseTargetForCurrentAudio();
  updateSleepTimerButton();
  setListenStatus("定时已到，本句读完后暂停");
}

function scheduleSleepTimer(minutes) {
  const normalized = Math.max(0, Math.min(Number(minutes || 0), 480));
  clearSleepTimer(false);
  if (!normalized) {
    setListenStatus(ttsReady() ? "定时已取消" : "听书未启用");
    return;
  }
  readerState.sleepDeadline = Date.now() + normalized * 60 * 1000;
  readerState.sleepTimerId = window.setTimeout(armSleepPause, normalized * 60 * 1000);
  readerState.sleepCountdownId = window.setInterval(updateSleepTimerButton, 1000);
  updateSleepTimerButton();
  setListenStatus(`${normalized} 分钟后自动暂停`);
}

function openSleepTimerDialog() {
  $("sleepCustomMinutes").value = "";
  openReaderDialog($("sleepTimerDialog"));
}

function applyCustomSleepTimer() {
  const minutes = Number($("sleepCustomMinutes").value || 0);
  scheduleSleepTimer(minutes);
  $("sleepTimerDialog").close();
}

function stopSleepFade(resetVolume = true) {
  window.clearInterval(readerState.sleepFadeTimerId);
  readerState.sleepFadeTimerId = null;
  readerState.sleepFadeStarted = false;
  if (resetVolume && readerState.ttsAudio) readerState.ttsAudio.volume = 1;
}

function startSleepFadeIfNeeded(audio, stopAt = audio?.duration) {
  if (!canAdjustMediaVolume()
    || !readerState.sleepPausePending
    || !audio
    || !Number.isFinite(audio.duration)) return;
  const normalizedStopAt = Number.isFinite(Number(stopAt)) ? Number(stopAt) : audio.duration;
  const secondsLeft = () => Math.max(
    0,
    (normalizedStopAt - audio.currentTime)
      / Math.max(0.8, Math.min(Number(audio.playbackRate) || 1, 2)),
  );
  if (secondsLeft() > TTS_SLEEP_FADE_SECONDS + 0.2) return;
  const applyVolume = () => {
    const remainingSeconds = secondsLeft();
    audio.volume = Math.max(0.05, Math.min(1, remainingSeconds / TTS_SLEEP_FADE_SECONDS));
  };
  applyVolume();
  if (readerState.sleepFadeStarted) return;
  readerState.sleepFadeStarted = true;
  readerState.sleepFadeTimerId = window.setInterval(() => {
    if (!readerState.sleepPausePending || audio.paused || audio.ended || readerState.ttsAudio !== audio) {
      stopSleepFade(false);
      return;
    }
    applyVolume();
    if (audio.volume <= 0.05) stopSleepFade(false);
  }, 200);
}

function finishSleepPause(index) {
  window.clearTimeout(readerState.sleepBoundaryTimerId);
  stopSleepFade();
  readerState.sleepBoundaryTimerId = null;
  const finishedChapter = readerState.currentChapter;
  const currentBookId = readerState.currentBookId;
  const nextIndex = nextReadableSentenceIndex(Number(index) + 1);
  if (nextIndex >= 0) highlightSentence(nextIndex, false);
  readerState.reading = false;
  readerState.paused = true;
  readerState.sleepPausePending = false;
  readerState.sleepFadeStarted = false;
  readerState.sleepPauseTarget = null;
  if (readerState.ttsAudio) readerState.ttsAudio.volume = 1;
  clearSleepTimer(false);
  updateListenButtons();
  syncReaderWakeLock();
  setMediaSessionPlaybackState("paused");
  setListenStatus("定时已暂停");
  if (nextIndex < 0 && finishedChapter + 1 < readerState.chapters.length) {
    window.setTimeout(async () => {
      if (readerState.reading
        || readerState.currentBookId !== currentBookId
        || readerState.currentChapter !== finishedChapter) return;
      try {
        await loadChapter(finishedChapter + 1, 0);
        const firstIndex = nextReadableSentenceIndex(0);
        if (firstIndex >= 0) highlightSentence(firstIndex, false);
        setListenStatus("定时已暂停｜下次从下一章开始");
      } catch (error) {
        setListenStatus(error.message || "下一章准备失败，下次播放时重试");
      }
    }, 0);
  }
}

function clearTtsBrowserCache() {
  readerState.ttsScope += 1;
  readerState.nextChapterPrefetch = null;
  readerState.ttsPackPending.clear();
  readerState.ttsPacks.forEach((pack) => {
    if (pack?.url) URL.revokeObjectURL(pack.url);
  });
  readerState.ttsPacks.clear();
  readerState.ttsPackOrder = [];
  readerState.activeTtsPackKey = "";
}

function sentenceText(index) {
  const sentence = readerState.sentences.find((item) => Number(item.index) === Number(index));
  return sentence?.text || "";
}

function hasReadableText(text) {
  return /[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text || "");
}

function nextReadableSentenceIndex(startIndex) {
  const normalizedStart = Number(startIndex);
  if (!Number.isFinite(normalizedStart) || normalizedStart < 0) return -1;
  for (let index = Math.max(0, normalizedStart); index < readerState.sentences.length; index += 1) {
    if (hasReadableText(sentenceText(index))) return index;
  }
  return -1;
}

function rememberedTtsPack(chapterIndex, sentenceIndex, bookId = readerState.currentBookId) {
  for (const pack of readerState.ttsPacks.values()) {
    if (pack.bookId !== bookId
      || pack.profileKey !== readerState.ttsConfig?.offline_profile_key
      || Number(pack.chapterIndex) !== Number(chapterIndex)) continue;
    if (pack.segments.some((segment) => Number(segment.index) === Number(sentenceIndex))) return pack;
  }
  return null;
}

function trimTtsPackBrowserCache() {
  while (readerState.ttsPackOrder.length > TTS_BROWSER_PACK_CACHE_LIMIT) {
    const removable = readerState.ttsPackOrder.find((key) => key !== readerState.activeTtsPackKey);
    if (!removable) break;
    readerState.ttsPackOrder = readerState.ttsPackOrder.filter((key) => key !== removable);
    const stale = readerState.ttsPacks.get(removable);
    if (stale?.url) URL.revokeObjectURL(stale.url);
    readerState.ttsPacks.delete(removable);
  }
}

function rememberTtsPack(manifest, blob) {
  const existing = readerState.ttsPacks.get(manifest.packKey);
  if (existing) {
    readerState.ttsPackOrder = readerState.ttsPackOrder.filter((key) => key !== manifest.packKey);
    readerState.ttsPackOrder.push(manifest.packKey);
    return existing;
  }
  const pack = { ...manifest, blob, url: URL.createObjectURL(blob) };
  readerState.ttsPacks.set(pack.packKey, pack);
  readerState.ttsPackOrder = readerState.ttsPackOrder.filter((key) => key !== pack.packKey);
  readerState.ttsPackOrder.push(pack.packKey);
  trimTtsPackBrowserCache();
  return pack;
}

function normalizedPackManifest(raw, blob, textByIndex, expected = {}) {
  const packKey = String(raw.pack_key || raw.packKey || "");
  const chapterIndex = Number(raw.chapter_index ?? raw.chapterIndex);
  const segments = (raw.segments || []).map((segment) => ({
    chapterIndex,
    index: Number(segment.index),
    start: Number(segment.start),
    end: Number(segment.end),
    text: normalizedOfflineTtsText(segment.text),
  }));
  const schemaVersion = Number(raw.schema_version ?? raw.schemaVersion ?? 0);
  const kind = String(raw.kind || "chapter");
  const duration = Number(raw.duration);
  const sentenceCount = Number(raw.sentence_count ?? raw.sentenceCount);
  const startSentenceIndex = Number(raw.start_sentence_index ?? raw.startSentenceIndex);
  const endSentenceIndex = Number(raw.end_sentence_index ?? raw.endSentenceIndex);
  const format = String(raw.format || "").toLowerCase();
  const chapterHash = String(raw.chapter_hash ?? raw.chapterHash ?? "");
  const nextStartSentenceIndexes = [...new Set(
    (raw.next_start_sentence_indexes || raw.nextStartSentenceIndexes || []).map(Number),
  )];
  const hasRemainingPackCount = raw.remaining_pack_count !== undefined
    || raw.remainingPackCount !== undefined;
  const remainingPackCount = hasRemainingPackCount
    ? Number(raw.remaining_pack_count ?? raw.remainingPackCount)
    : null;
  const blobSize = Number(blob?.size) || 0;
  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1];
  if (schemaVersion !== TTS_PACK_SCHEMA_VERSION
    || kind !== "chapter"
    || !/^[0-9a-f]{64}$/.test(packKey)
    || !Number.isInteger(chapterIndex)
    || chapterIndex < 0
    || !/^[0-9a-f]{64}$/.test(chapterHash)
    || format !== "m4a"
    || blobSize <= 0
    || blobSize > TTS_MAX_PACK_BYTES
    || !Number.isFinite(duration)
    || duration < 5
    || !validPackSegments(segments)
    || sentenceCount !== segments.length
    || startSentenceIndex !== Number(firstSegment?.index)
    || endSentenceIndex !== Number(lastSegment?.index)
    || Math.abs(Number(lastSegment?.end) - duration) > 0.15
    || nextStartSentenceIndexes.some((index) => (
      !Number.isInteger(index)
      || index <= endSentenceIndex
      || (textByIndex && !textByIndex.has(index))
    ))
    || (remainingPackCount !== null && (
      !Number.isInteger(remainingPackCount)
      || remainingPackCount < nextStartSentenceIndexes.length
    ))) {
    throw new Error("播放包时间轴无效");
  }
  if (textByIndex && !segments.every((segment) => textByIndex.get(segment.index) === segment.text)) {
    throw new Error("播放包与当前章节内容不一致，请重新生成");
  }
  const manifestBookId = String(raw.book_id ?? raw.bookId ?? "");
  const manifestProfileKey = String(raw.profile_key ?? raw.profileKey ?? "");
  if ((expected.bookId && manifestBookId !== String(expected.bookId))
    || (Number.isFinite(Number(expected.chapterIndex)) && chapterIndex !== Number(expected.chapterIndex))
    || (expected.profileKey && manifestProfileKey !== String(expected.profileKey))
    || (expected.chapterHash && chapterHash !== String(expected.chapterHash))) {
    throw new Error("播放包身份不一致，请重新生成");
  }
  return {
    packKey,
    kind,
    schemaVersion,
    bookId: manifestBookId,
    profileKey: manifestProfileKey,
    chapterIndex,
    chapterHash,
    startSentenceIndex,
    endSentenceIndex,
    sentenceCount,
    duration,
    size: blobSize,
    format,
    segments,
    nextStartSentenceIndexes,
    remainingPackCount,
  };
}

async function fetchPackBlob(url) {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `播放包下载失败：${response.status}`);
  }
  const blob = await response.blob();
  if (!blob.size || blob.size > TTS_MAX_PACK_BYTES) {
    throw new Error("播放包音频大小无效");
  }
  return blob;
}

async function requestTtsPackForChapter(
  bookId,
  chapterIndex,
  sentenceIndex,
  textByIndex,
  scope,
) {
  const remembered = rememberedTtsPack(chapterIndex, sentenceIndex, bookId);
  if (remembered) return remembered;
  const pendingKey = `${scope}:${bookId}:${Number(chapterIndex)}:${Number(sentenceIndex)}`;
  if (readerState.ttsPackPending.has(pendingKey)) return readerState.ttsPackPending.get(pendingKey);
  const pending = (async () => {
    const local = await promiseWithTimeout(
      localOfflinePackForChapter(
        bookId,
        readerState.ttsConfig?.offline_profile_key,
        chapterIndex,
        sentenceIndex,
        textByIndex,
      ),
      8000,
      "读取本机播放包超时，请关闭其他读书页面后重试",
    ).catch(() => null);
    if (local) {
      if (scope !== readerState.ttsScope) return null;
      const manifest = normalizedPackManifest(local, local.blob, textByIndex, {
        bookId,
        chapterIndex,
        profileKey: readerState.ttsConfig?.offline_profile_key,
      });
      manifest.source = "local";
      return rememberTtsPack(manifest, local.blob);
    }
    const serverStartedAt = performance.now();
    const raw = await api("/api/reader/tts-pack", {
      method: "POST",
      body: JSON.stringify({
        book_id: bookId,
        chapter_index: Number(chapterIndex),
        sentence_index: Number(sentenceIndex),
      }),
    });
    const blob = await fetchPackBlob(raw.url);
    const prepareMs = Math.max(0, performance.now() - serverStartedAt);
    readerState.ttsPackPrepareMs = Math.max(prepareMs, Number(readerState.ttsPackPrepareMs || 0) * 0.75);
    if (scope !== readerState.ttsScope) return null;
    const manifest = normalizedPackManifest(raw, blob, textByIndex, {
      bookId,
      chapterIndex,
      profileKey: readerState.ttsConfig?.offline_profile_key,
    });
    manifest.source = "server";
    return rememberTtsPack(manifest, blob);
  })().finally(() => readerState.ttsPackPending.delete(pendingKey));
  readerState.ttsPackPending.set(pendingKey, pending);
  return pending;
}

async function fetchTtsPack(
  index,
  token = readerState.ttsToken,
  scope = readerState.ttsScope,
) {
  const normalizedIndex = Number(index);
  if (!Number.isFinite(normalizedIndex) || normalizedIndex < 0 || normalizedIndex >= readerState.sentences.length) {
    throw new Error("没有可朗读文本");
  }
  const textByIndex = new Map(readerState.sentences.map((sentence) => [
    Number(sentence.index),
    normalizedOfflineTtsText(sentence.text),
  ]));
  const pack = await requestTtsPackForChapter(
    readerState.currentBookId,
    readerState.currentChapter,
    normalizedIndex,
    textByIndex,
    scope,
  );
  if (token !== readerState.ttsToken || scope !== readerState.ttsScope) return null;
  if (pack?.source === "local") setListenStatus("本机离线播放包命中｜正在准备播放");
  return pack;
}

function playbackSegmentAtTime(segments, currentTime) {
  if (!segments.length) return null;
  let active = segments[0];
  for (const segment of segments) {
    if (currentTime + 0.02 < segment.start) break;
    active = segment;
  }
  return active;
}

function scheduleSleepBoundaryPause() {
  window.clearTimeout(readerState.sleepBoundaryTimerId);
  readerState.sleepBoundaryTimerId = null;
  const audio = readerState.ttsAudio;
  const target = readerState.sleepPauseTarget;
  if (!readerState.sleepPausePending || !audio || audio.paused || !target || !Number.isFinite(Number(target.time))) return;
  const rate = Math.max(0.8, Math.min(Number(audio.playbackRate) || 1, 2));
  const delay = Math.max(0, (Number(target.time) - audio.currentTime) / rate * 1000);
  readerState.sleepBoundaryTimerId = window.setTimeout(() => {
    if (!readerState.sleepPausePending || readerState.ttsAudio !== audio || readerState.sleepPauseTarget !== target) return;
    audio.pause();
    audio.volume = 1;
    finishSleepPause(target.index);
  }, delay);
}

function setSleepPauseTargetForCurrentAudio() {
  const audio = readerState.ttsAudio;
  if (!audio) {
    readerState.sleepPauseTarget = null;
    return;
  }
  const segment = playbackSegmentAtTime(readerState.ttsPlaybackSegments, audio.currentTime);
  readerState.sleepPauseTarget = segment
    ? { chapterIndex: segment.chapterIndex, index: segment.index, time: segment.end }
    : { chapterIndex: readerState.currentChapter, index: readerState.currentSentence, time: audio.duration };
  scheduleSleepBoundaryPause();
}

function adoptPrefetchedChapterForPlayback(chapterIndex) {
  const entry = readerState.nextChapterPrefetch;
  const prepared = entry?.prepared;
  if (!entry
    || !prepared
    || entry.bookId !== readerState.currentBookId
    || entry.chapterIndex !== Number(chapterIndex)
    || entry.scope !== readerState.ttsScope) return false;
  const data = prepared.data;
  readerState.currentBook = data.book;
  readerState.currentChapter = data.chapter.index;
  readerState.currentSentence = 0;
  $("chapterSelect").value = String(readerState.currentChapter);
  renderChapter(data.chapter, [...(prepared.packs || [])]);
  saveProgressSoon();
  setStatus(readerState.currentBook.title);
  updateMediaSessionMetadata();
  setMediaSessionPlaybackState("playing");
  return true;
}

function syncTtsPlaybackSegment(audio, token) {
  const segment = playbackSegmentAtTime(readerState.ttsPlaybackSegments, audio.currentTime);
  if (!segment) return readerState.ttsScope;
  const chapterChanged = Number(segment.chapterIndex) !== Number(readerState.currentChapter);
  if (chapterChanged && !adoptPrefetchedChapterForPlayback(segment.chapterIndex)) {
    return readerState.ttsScope;
  }
  if (!chapterChanged && Number(segment.index) === Number(readerState.currentSentence)) {
    return readerState.ttsScope;
  }
  highlightSentence(segment.index, true);
  updateMediaSessionMetadata();
  saveProgressSoon();
  setListenStatus(`正在朗读：第 ${Number(segment.index) + 1} 句`);
  if (chapterChanged) {
    prefetchUpcomingTtsAudio(segment.index, token, readerState.ttsScope);
  }
  return readerState.ttsScope;
}

function releaseActiveTtsPlaybackUrl() {
  readerState.activeTtsPackKey = "";
  readerState.ttsPlaybackSegments = [];
}

function ttsPrefetchPackCount(rate = readerState.playbackRate) {
  const normalizedRate = Math.max(0.8, Math.min(Number(rate) || 1, 2));
  const baseCount = Math.max(2, Math.ceil(normalizedRate * 2));
  const minimumWallSeconds = 5 / normalizedRate;
  const measuredPrepareSeconds = Math.max(0, Number(readerState.ttsPackPrepareMs || 0) / 1000);
  const latencyCount = measuredPrepareSeconds > minimumWallSeconds * 0.5
    ? Math.ceil(measuredPrepareSeconds / minimumWallSeconds) + 2
    : baseCount;
  return Math.min(8, Math.max(baseCount, latencyCount));
}

async function prefetchChapterPackStarts(
  bookId,
  chapterIndex,
  sentenceIndexes,
  textByIndex,
  token = readerState.ttsToken,
  scope = readerState.ttsScope,
) {
  const indexes = [...new Set(sentenceIndexes.map(Number).filter(Number.isFinite))];
  const results = new Array(indexes.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < indexes.length) {
      if (token !== readerState.ttsToken
        || scope !== readerState.ttsScope
        || readerState.currentBookId !== bookId
        || !readerState.reading) return;
      const position = cursor;
      cursor += 1;
      results[position] = await requestTtsPackForChapter(
        bookId,
        chapterIndex,
        indexes[position],
        textByIndex,
        scope,
      );
    }
  };
  const workerCount = Math.min(TTS_PACK_PREFETCH_WORKERS, indexes.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (results.some((pack) => !pack)) return null;
  return results;
}

async function prefetchNextChapterIfNeeded(pack, preparedCount, token, scope) {
  if (pack.remainingPackCount === null || pack.remainingPackCount > preparedCount) return;
  const nextChapter = await prefetchNextChapterAudio(token, scope);
  if (Number(readerState.currentChapter) + 1 < readerState.chapters.length && !nextChapter) {
    throw new Error("下一章播放缓冲准备失败");
  }
}

async function prefetchFollowingTtsPacks(pack, token = readerState.ttsToken, scope = readerState.ttsScope) {
  if (!pack || token !== readerState.ttsToken || scope !== readerState.ttsScope || !readerState.reading) return;
  const desiredPacks = ttsPrefetchPackCount();
  const hintedIndexes = Array.isArray(pack.nextStartSentenceIndexes)
    ? pack.nextStartSentenceIndexes.slice(0, desiredPacks)
    : [];
  if (pack.remainingPackCount !== null) {
    const textByIndex = new Map(readerState.sentences.map((sentence) => [
      Number(sentence.index),
      normalizedOfflineTtsText(sentence.text),
    ]));
    const prepared = await prefetchChapterPackStarts(
      readerState.currentBookId,
      readerState.currentChapter,
      hintedIndexes,
      textByIndex,
      token,
      scope,
    );
    if (prepared === null) return;
    await prefetchNextChapterIfNeeded(pack, hintedIndexes.length, token, scope);
    return;
  }

  let nextIndex = nextReadableSentenceIndex(Number(pack.endSentenceIndex) + 1);
  let prepared = 0;
  while (nextIndex >= 0 && prepared < desiredPacks) {
    if (token !== readerState.ttsToken || scope !== readerState.ttsScope || !readerState.reading) return;
    const nextPack = await fetchTtsPack(nextIndex, token, scope);
    if (!nextPack) return;
    prepared += 1;
    nextIndex = nextReadableSentenceIndex(Number(nextPack.endSentenceIndex) + 1);
  }
  if (nextIndex < 0 && token === readerState.ttsToken && scope === readerState.ttsScope && readerState.reading) {
    const nextChapter = await prefetchNextChapterAudio(token, scope);
    if (Number(readerState.currentChapter) + 1 < readerState.chapters.length && !nextChapter) {
      throw new Error("下一章播放缓冲准备失败");
    }
  }
}

async function prefetchUpcomingTtsAudio(index, token = readerState.ttsToken, scope = readerState.ttsScope) {
  if (token !== readerState.ttsToken || scope !== readerState.ttsScope || !readerState.reading) return;
  try {
    const pack = rememberedTtsPack(readerState.currentChapter, Number(index), readerState.currentBookId)
      || await fetchTtsPack(Number(index), token, scope);
    await prefetchFollowingTtsPacks(pack, token, scope);
  } catch {
    // Playback performs the authoritative retry when a prefetched pack is needed.
  }
}

function readableChapterSentences(chapter) {
  const sentences = [];
  for (const paragraph of chapter?.paragraphs || []) {
    if (paragraph?.type === "image") continue;
    for (const sentence of paragraph?.sentences || []) {
      if (hasReadableText(sentence?.text)) sentences.push(sentence);
    }
  }
  return sentences;
}

function prefetchNextChapterAudio(
  token = readerState.ttsToken,
  scope = readerState.ttsScope,
) {
  const bookId = readerState.currentBookId;
  const chapterIndex = Number(readerState.currentChapter) + 1;
  if (!bookId || chapterIndex >= readerState.chapters.length) return Promise.resolve(null);
  const existing = readerState.nextChapterPrefetch;
  if (existing
    && existing.bookId === bookId
    && existing.chapterIndex === chapterIndex
    && existing.scope === scope) return existing.promise;
  const entry = {
    bookId,
    chapterIndex,
    scope,
    prepared: null,
    promise: null,
  };
  entry.promise = (async () => {
    const data = await api(`/api/books/${bookId}/chapters/${chapterIndex}`);
    const chapterSentences = readableChapterSentences(data.chapter);
    const firstSentence = chapterSentences[0];
    const prepared = { data, packs: [] };
    if (!firstSentence) {
      entry.prepared = prepared;
      return prepared;
    }
    if (token !== readerState.ttsToken
      || scope !== readerState.ttsScope
      || readerState.currentBookId !== bookId
      || !readerState.reading) return null;
    const textByIndex = chapterSentenceTextMap(data.chapter);
    const firstPack = await requestTtsPackForChapter(
      bookId,
      chapterIndex,
      Number(firstSentence.index),
      textByIndex,
      scope,
    );
    if (!firstPack) return null;
    const desiredPacks = ttsPrefetchPackCount();
    const hintedIndexes = Array.isArray(firstPack.nextStartSentenceIndexes)
      ? firstPack.nextStartSentenceIndexes.slice(0, Math.max(0, desiredPacks - 1))
      : [];
    let following = [];
    if (firstPack.remainingPackCount !== null) {
      following = await prefetchChapterPackStarts(
        bookId,
        chapterIndex,
        hintedIndexes,
        textByIndex,
        token,
        scope,
      );
    } else {
      let nextSentence = chapterSentences.find(
        (sentence) => Number(sentence.index) > Number(firstPack.endSentenceIndex),
      );
      while (nextSentence && following.length < Math.max(0, desiredPacks - 1)) {
        const pack = await requestTtsPackForChapter(
          bookId,
          chapterIndex,
          Number(nextSentence.index),
          textByIndex,
          scope,
        );
        if (!pack) return null;
        following.push(pack);
        nextSentence = chapterSentences.find(
          (sentence) => Number(sentence.index) > Number(pack.endSentenceIndex),
        );
      }
    }
    if (following === null
      || token !== readerState.ttsToken
      || scope !== readerState.ttsScope
      || readerState.currentBookId !== bookId
      || !readerState.reading) return null;
    prepared.packs = [firstPack, ...following];
    entry.prepared = prepared;
    return prepared;
  })().catch(() => null);
  readerState.nextChapterPrefetch = entry;
  return entry.promise;
}

function stopListening(resetStatus = true, clearTimer = true) {
  readerState.ttsToken += 1;
  readerState.reading = false;
  readerState.paused = false;
  readerState.ttsPreparing = false;
  stopSleepFade();
  if (clearTimer) clearSleepTimer(true);
  if (readerState.ttsAudio) {
    readerState.ttsAudio.pause();
    window.clearTimeout(readerState.sleepBoundaryTimerId);
    readerState.sleepBoundaryTimerId = null;
    readerState.ttsAudio.autoplay = false;
    readerState.ttsAudio.onplaying = null;
    readerState.ttsAudio.onended = null;
    readerState.ttsAudio.onerror = null;
    readerState.ttsAudio.ontimeupdate = null;
    readerState.ttsAudio.removeAttribute("src");
    readerState.ttsAudio.load();
  }
  releaseActiveTtsPlaybackUrl();
  updateListenButtons();
  syncReaderWakeLock();
  setMediaSessionPlaybackState("none");
  if (resetStatus) setListenStatus("已停止");
}

async function startListeningFrom(index = readerState.currentSentence) {
  if (!readerState.currentBookId || !readerState.sentences.length) return;
  const config = readerState.ttsConfig || {};
  if (!config.enabled || !config.api_key_configured) {
    setListenStatus("请先在设置里启用并配置 API Key");
    openReaderDialog($("settingsDialog"));
    return;
  }
  stopListening(false, false);
  readerState.ttsToken += 1;
  readerState.reading = true;
  readerState.paused = false;
  readerState.ttsPreparing = true;
  const token = readerState.ttsToken;
  updateListenButtons();
  syncReaderWakeLock();
  try {
    await playSentence(nextReadableSentenceIndex(index), token);
  } finally {
    if (token === readerState.ttsToken) {
      readerState.ttsPreparing = false;
      updateListenButtons();
    }
  }
}

async function playSentence(index, token = readerState.ttsToken, continuous = false) {
  if (!readerState.reading || token !== readerState.ttsToken) return;
  const readableIndex = nextReadableSentenceIndex(index);
  if (readableIndex < 0 || readableIndex >= readerState.sentences.length) {
    if (readerState.currentChapter + 1 < readerState.chapters.length) {
      setListenStatus("正在切换下一章");
      setMediaSessionPlaybackState("playing");
      try {
        await loadChapter(readerState.currentChapter + 1, 0);
        await playSentence(nextReadableSentenceIndex(0), token, true);
      } catch (error) {
        if (readerState.reading && token === readerState.ttsToken) {
          setListenStatus(error.message || "切换下一章失败");
          stopListening(false);
        }
      }
      return;
    }
    stopListening(false);
    setListenStatus("本书朗读完成");
    return;
  }

  index = readableIndex;
  highlightSentence(index, true);
  updateMediaSessionMetadata();
  setMediaSessionPlaybackState("playing");
  let scope = readerState.ttsScope;
  saveProgressSoon();
  const remembered = rememberedTtsPack(readerState.currentChapter, index, readerState.currentBookId);
  setListenStatus(remembered ? "播放包内存缓存命中｜正在准备播放" : "正在准备当前句音频");

  try {
    const pack = remembered || await fetchTtsPack(index, token, scope);
    if (!pack || !readerState.reading || token !== readerState.ttsToken || scope !== readerState.ttsScope) return;
    const startSegment = pack.segments.find((segment) => Number(segment.index) === Number(index));
    if (!startSegment) throw new Error("播放包不包含当前句");

    if (!continuous) {
      setListenStatus(`正在准备连续播放缓冲（后续 ${ttsPrefetchPackCount()} 个播放包）`);
      await prefetchFollowingTtsPacks(pack, token, scope);
      if (!readerState.reading || token !== readerState.ttsToken || scope !== readerState.ttsScope) return;
    } else {
      prefetchFollowingTtsPacks(pack, token, scope).catch(() => {});
    }
    const audio = readerState.ttsAudio || new Audio();
    if (!continuous) audio.pause();
    audio.onplaying = null;
    audio.onended = null;
    audio.onerror = null;
    audio.ontimeupdate = null;
    releaseActiveTtsPlaybackUrl();
    readerState.activeTtsPackKey = pack.packKey;
    readerState.ttsPlaybackSegments = pack.segments;
    if (readerState.sleepPausePending) readerState.sleepPauseTarget = null;
    audio.volume = 1;
    applyAudioPlaybackRate(audio);
    audio.autoplay = continuous;
    audio.src = pack.url;
    audio.preload = "auto";
    readerState.ttsAudio = audio;

    audio.onplaying = () => {
      if (token !== readerState.ttsToken || scope !== readerState.ttsScope) return;
      applyAudioPlaybackRate(audio);
      setMediaSessionPlaybackState("playing");
      if (readerState.sleepPausePending) scheduleSleepBoundaryPause();
      const segment = playbackSegmentAtTime(pack.segments, audio.currentTime) || startSegment;
      setListenStatus(`正在朗读：第 ${Number(segment.index) + 1} 句`);
    };
    audio.ontimeupdate = () => {
      if (token !== readerState.ttsToken || scope !== readerState.ttsScope) return;
      let sleepTarget = readerState.sleepPauseTarget;
      if (readerState.sleepPausePending && sleepTarget && Number.isFinite(sleepTarget.time)
        && audio.currentTime >= sleepTarget.time - 0.03) {
        audio.pause();
        audio.volume = 1;
        finishSleepPause(sleepTarget.index);
        return;
      }
      scope = syncTtsPlaybackSegment(audio, token);
      if (readerState.sleepPausePending && !readerState.sleepPauseTarget) {
        setSleepPauseTargetForCurrentAudio();
        sleepTarget = readerState.sleepPauseTarget;
      }
      startSleepFadeIfNeeded(audio, sleepTarget?.time);
    };
    audio.onended = () => {
      if (token !== readerState.ttsToken || scope !== readerState.ttsScope) return;
      stopSleepFade();
      audio.volume = 1;
      if (readerState.sleepPausePending) {
        finishSleepPause(readerState.sleepPauseTarget?.index ?? pack.endSentenceIndex);
        return;
      }
      const nextIndex = nextReadableSentenceIndex(Number(pack.endSentenceIndex) + 1);
      if (nextIndex < 0
        && readerState.currentChapter + 1 < readerState.chapters.length
        && adoptPrefetchedChapterForPlayback(readerState.currentChapter + 1)) {
        scope = readerState.ttsScope;
        playSentence(nextReadableSentenceIndex(0), token, true);
        return;
      }
      playSentence(nextIndex, token, true);
    };
    audio.onerror = () => {
      if (token === readerState.ttsToken && scope === readerState.ttsScope) {
        setListenStatus(audioErrorMessage(audio));
        stopListening(false);
      }
    };

    await waitForAudioReady(audio, token, scope);
    if (!readerState.reading || token !== readerState.ttsToken || scope !== readerState.ttsScope) return;
    const safeStart = Math.max(0, Math.min(Number(startSegment.start) || 0, Math.max(0, audio.duration - 0.05)));
    if (safeStart > 0.01) audio.currentTime = safeStart;
    if (readerState.sleepPausePending && !readerState.sleepPauseTarget) setSleepPauseTargetForCurrentAudio();
    applyAudioPlaybackRate(audio);
    try {
      await audio.play();
    } catch (error) {
      if (error?.name === "NotAllowedError") {
        throw new Error("浏览器阻止了自动播放，请再次点击播放");
      }
      throw error;
    }
    if (readerState.sleepPausePending) scheduleSleepBoundaryPause();
  } catch (error) {
    if (token === readerState.ttsToken && scope === readerState.ttsScope) {
      setListenStatus(error.message);
      stopListening(false);
    }
  } finally {
    updateListenButtons();
  }
}

async function toggleListeningPause() {
  if (readerState.ttsPreparing) {
    stopListening(false, false);
    readerState.paused = true;
    updateListenButtons();
    setMediaSessionPlaybackState("paused");
    setListenStatus("已暂停");
    return;
  }
  if (!readerState.reading) {
    await startListeningFrom(readerState.currentSentence);
    return;
  }
  if (!readerState.ttsAudio) return;
  if (readerState.paused) {
    readerState.paused = false;
    applyAudioPlaybackRate(readerState.ttsAudio);
    await readerState.ttsAudio.play();
    if (readerState.sleepPausePending) scheduleSleepBoundaryPause();
    setMediaSessionPlaybackState("playing");
    setListenStatus("继续朗读");
  } else {
    readerState.paused = true;
    readerState.ttsAudio.pause();
    stopSleepFade();
    window.clearTimeout(readerState.sleepBoundaryTimerId);
    readerState.sleepBoundaryTimerId = null;
    readerState.ttsAudio.autoplay = false;
    setMediaSessionPlaybackState("paused");
    setListenStatus("已暂停");
  }
  updateListenButtons();
  syncReaderWakeLock();
}

async function moveChapter(delta) {
  const next = readerState.currentChapter + delta;
  if (next < 0 || next >= readerState.chapters.length) {
    return;
  }
  const shouldResume = readerState.reading && !readerState.paused;
  stopListening(false, false);
  await loadChapter(next, 0);
  if (shouldResume) await startListeningFrom(0);
}

function updateReaderFont() {
  const value = $("fontInput").value;
  $("fontValue").textContent = value;
  $("bookContent").style.setProperty("--reader-font-size", `${value}px`);
  window.localStorage.setItem("readerFontSize", value);
}

async function openReaderFontCache() {
  if (!("caches" in window)) return null;
  try {
    return await window.caches.open(FONT_CACHE_NAME);
  } catch {
    return null;
  }
}

function readerFontRequest(url) {
  return new Request(new URL(url, window.location.href).href, {
    credentials: "same-origin",
  });
}

async function locallyCachedFontResponse(fontId) {
  const url = FONT_ASSET_URLS[fontId];
  if (!url) return null;
  const cache = await openReaderFontCache();
  if (!cache) return null;
  const stored = await cache.match(readerFontRequest(url), { ignoreVary: true }).catch(() => null);
  return stored?.ok ? stored : null;
}

async function downloadAndStoreReaderFont(fontId, forceRetry = false) {
  const url = FONT_ASSET_URLS[fontId];
  if (!url) return false;
  try {
    const response = await fetch(url, {
      cache: forceRetry ? "reload" : "default",
      credentials: "same-origin",
      mode: "same-origin",
    });
    if (!response.ok) return false;
    const cache = await openReaderFontCache();
    if (cache) await cache.put(readerFontRequest(url), response.clone()).catch(() => {});
    return loadReaderFontFromResponse(fontId, response);
  } catch {
    return false;
  }
}

async function loadReaderFontFromResponse(fontId, response) {
  const webFamily = FONT_WEB_FAMILIES[fontId];
  if (!webFamily || typeof FontFace !== "function" || !document.fonts?.add || !response) return false;
  try {
    const face = new FontFace(webFamily, await response.arrayBuffer(), {
      style: "normal",
      weight: "400",
    });
    await face.load();
    document.fonts.add(face);
    const loaded = face.status === "loaded";
    if (loaded) loadedReaderFontIds.add(fontId);
    return loaded;
  } catch {
    return false;
  }
}

function isReaderFontLoaded(fontId) {
  return loadedReaderFontIds.has(fontId);
}

async function pruneStoredReaderFonts() {
  const cache = await openReaderFontCache();
  if (!cache) return;
  const currentUrls = new Set(Object.values(FONT_ASSET_URLS).map((url) => new URL(url, window.location.href).href));
  const requests = await cache.keys().catch(() => []);
  await Promise.all(requests
    .filter((request) => !currentUrls.has(request.url))
    .map((request) => cache.delete(request)));
}

function setFontLoadState(fontId, state) {
  const status = document.querySelector(`.font-load-status[data-font="${fontId}"]`);
  const loadButton = document.querySelector(`.font-load-button[data-font="${fontId}"]`);
  if (!status) return;
  const labels = {
    idle: "未加载",
    loading: "加载中",
    ready: "已加载",
    failed: "加载失败",
  };
  const size = FONT_DOWNLOAD_SIZES[fontId];
  status.dataset.state = state;
  status.textContent = `${labels[state] || labels.idle}${size ? ` · ${size}` : ""}`;
  if (loadButton) {
    loadButton.disabled = state === "loading" || state === "ready";
    loadButton.textContent = state === "failed" ? "重试" : state === "ready" ? "完成" : state === "loading" ? "加载中" : "加载";
  }
}

function waitForFontStatusPaint() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
  });
}

async function ensureReaderFontLoaded(fontId, forceRetry = false) {
  const webFamily = FONT_WEB_FAMILIES[fontId];
  if (!webFamily) return true;
  if (!document.fonts?.add || typeof FontFace !== "function") {
    setFontLoadState(fontId, "ready");
    return true;
  }
  if (isReaderFontLoaded(fontId)) {
    setFontLoadState(fontId, "ready");
    return true;
  }
  const activated = await activateCachedReaderFont(fontId);
  if (activated) {
    setFontLoadState(fontId, "ready");
    return true;
  }
  if (!fontLoadPromises.has(fontId)) {
    setFontLoadState(fontId, "loading");
    const loadPromise = (forceRetry
      ? waitForFontStatusPaint().then(() => downloadAndStoreReaderFont(fontId, true))
      : downloadAndStoreReaderFont(fontId))
      .catch(() => false)
      .finally(() => fontLoadPromises.delete(fontId));
    fontLoadPromises.set(fontId, loadPromise);
  }
  const loaded = await fontLoadPromises.get(fontId);
  setFontLoadState(fontId, loaded ? "ready" : "failed");
  return loaded;
}

async function activateCachedReaderFont(fontId) {
  const webFamily = FONT_WEB_FAMILIES[fontId];
  if (!webFamily) return true;
  if (fontId === "yshi-written" && window.readerRequiredFontPromise) {
    await window.readerRequiredFontPromise.catch(() => false);
  }
  if (isReaderFontLoaded(fontId)) {
    setFontLoadState(fontId, "ready");
    return true;
  }
  if (fontLoadPromises.has(fontId)) {
    return fontLoadPromises.get(fontId);
  }
  if (!fontActivationPromises.has(fontId)) {
    const activationPromise = (async () => {
      const cachedResponse = await locallyCachedFontResponse(fontId);
      if (!cachedResponse) return false;
      setFontLoadState(fontId, "loading");
      return loadReaderFontFromResponse(fontId, cachedResponse);
    })()
      .catch(() => false)
      .finally(() => fontActivationPromises.delete(fontId));
    fontActivationPromises.set(fontId, activationPromise);
  }
  const loaded = await fontActivationPromises.get(fontId);
  setFontLoadState(fontId, loaded ? "ready" : "idle");
  return loaded;
}

function activateCachedReaderFonts() {
  availableFontOptions().forEach((font) => {
    if (!FONT_WEB_FAMILIES[font.id]) return;
    activateCachedReaderFont(font.id).then((loaded) => {
      if (!loaded) return;
      const button = document.querySelector(`.font-option[data-font="${font.id}"]`);
      if (button) button.style.fontFamily = font.family;
    });
  });
}

async function updateReaderFontFamily(fontId = "", announce = true, allowDownload = true) {
  const active = document.querySelector(".font-option.active");
  const value = normalizeFontId(fontId || active?.dataset.font || "system");
  const generation = ++fontApplyGeneration;
  const content = $("bookContent");
  window.localStorage.setItem("readerFontFamily", value);
  document.querySelectorAll(".font-option").forEach((button) => {
    button.classList.toggle("active", button.dataset.font === value);
  });
  if (!FONT_WEB_FAMILIES[value]) {
    content.dataset.fontState = "ready";
    content.style.setProperty("--reader-font-family", FONT_FAMILIES[value] || FONT_FAMILIES.system);
    return;
  }
  content.dataset.fontState = "loading";
  if (announce && readerState.currentBook) {
    const fontName = FONT_OPTIONS.find((font) => font.id === value)?.name || "字体";
    setStatus(`正在加载${fontName}`);
  }
  const loaded = allowDownload
    ? await ensureReaderFontLoaded(value)
    : await activateCachedReaderFont(value);
  if (generation !== fontApplyGeneration) return;
  if (!loaded) {
    content.dataset.fontState = "failed";
    content.style.setProperty("--reader-font-family", FONT_FAMILIES.system);
    if (announce) setStatus("字体加载失败，已临时使用系统字体");
    return;
  }
  content.dataset.fontState = "ready";
  content.style.removeProperty("--reader-font-family");
  void content.offsetWidth;
  content.style.setProperty("--reader-font-family", FONT_FAMILIES[value]);
  if (announce && readerState.currentBook) setStatus(readerState.currentBook.title);
  const selectedButton = document.querySelector(`.font-option[data-font="${value}"]`);
  if (selectedButton) selectedButton.style.fontFamily = FONT_FAMILIES[value];
}

function refreshSelectedReaderFont() {
  const value = normalizeFontId(window.localStorage.getItem("readerFontFamily") || "system");
  updateReaderFontFamily(value, false, false);
}

function applyReaderTheme(value) {
  const dark = value === "dark";
  document.body.classList.toggle("reader-dark", dark);
  if (typeof window.applyReaderDocumentTheme === "function") {
    window.applyReaderDocumentTheme(dark);
  } else {
    document.documentElement.classList.toggle("reader-dark-root", dark);
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = dark ? "#0e1320" : "#dfe4fb";
  }
  const button = $("darkModeBtn");
  if (button) {
    button.classList.toggle("active", dark);
    button.setAttribute("aria-pressed", dark ? "true" : "false");
    button.textContent = dark ? "日间" : "黑暗";
  }
  window.localStorage.setItem("readerTheme", dark ? "dark" : "light");
}

function updateReaderTheme() {
  applyReaderTheme(document.body.classList.contains("reader-dark") ? "light" : "dark");
}

function renderFontPicker() {
  const picker = $("fontPicker");
  if (!picker) return;
  picker.innerHTML = "";
  availableFontOptions().forEach((font) => {
    const card = document.createElement("div");
    card.className = "font-option-card";
    const button = document.createElement("button");
    button.className = "font-option";
    button.type = "button";
    button.dataset.font = font.id;
    button.textContent = font.name;
    button.addEventListener("click", () => {
      document.querySelectorAll(".font-option").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      button.blur();
      updateReaderFontFamily(font.id);
    });
    card.appendChild(button);

    const tools = document.createElement("div");
    tools.className = "font-load-tools";
    const status = document.createElement("span");
    status.className = "font-load-status";
    status.dataset.font = font.id;
    status.setAttribute("aria-live", "polite");
    tools.appendChild(status);
    if (FONT_WEB_FAMILIES[font.id]) {
      const loadButton = document.createElement("button");
      loadButton.className = "font-load-button";
      loadButton.type = "button";
      loadButton.dataset.font = font.id;
      loadButton.setAttribute("aria-label", `预先加载${font.name}`);
      loadButton.addEventListener("click", async () => {
        const retry = status.dataset.state === "failed";
        const loaded = await ensureReaderFontLoaded(font.id, retry);
        if (loaded) {
          button.style.fontFamily = font.family;
          if (button.classList.contains("active")) updateReaderFontFamily(font.id, false);
        }
      });
      tools.appendChild(loadButton);
      const loaded = isReaderFontLoaded(font.id);
      card.appendChild(tools);
      picker.appendChild(card);
      setFontLoadState(font.id, loaded ? "ready" : "idle");
      return;
    }
    status.dataset.state = "ready";
    status.textContent = "无需加载";
    card.appendChild(tools);
    picker.appendChild(card);
  });
}

function restoreReaderSettings() {
  const savedSize = window.localStorage.getItem("readerFontSize");
  if (savedSize) $("fontInput").value = savedSize;
  renderFontPicker();
  const savedFamily = window.localStorage.getItem("readerFontFamily");
  const fontId = normalizeFontId(FONT_FAMILIES[savedFamily] ? savedFamily : "system");
  if (fontId !== savedFamily) window.localStorage.setItem("readerFontFamily", fontId);
  const activeFont = document.querySelector(`.font-option[data-font="${fontId}"]`);
  if (activeFont) activeFont.classList.add("active");
  applyReaderTheme(window.localStorage.getItem("readerTheme") === "dark" ? "dark" : "light");
  const savedPlaybackRate = Number(window.localStorage.getItem("readerPlaybackRate"));
  if ($("playbackRateSelect")) {
    $("playbackRateSelect").value = [0.8, 1, 1.2, 1.5, 2].includes(savedPlaybackRate)
      ? String(savedPlaybackRate)
      : "1";
  }
  updatePlaybackRate();
  updateReaderFont();
  updateReaderFontFamily(fontId, false, false);
}

function selectOption(label, value, selected = false) {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  item.selected = selected;
  return item;
}

function showTtsConfigMessage(text, type = "") {
  const message = $("ttsConfigMessage");
  message.hidden = !text;
  message.textContent = text || "";
  message.className = `reader-config-message ${type}`.trim();
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 * 1024 ? 0 : 1)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function formatCacheTime(timestamp) {
  const value = Number(timestamp) || 0;
  if (!value) return "暂无";
  const diff = Math.max(0, Date.now() / 1000 - value);
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

function formatBalanceTime(timestamp) {
  if (!timestamp) return "未更新";
  const date = new Date(Number(timestamp) * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function formatMimoBalance() {
  const balance = readerState.mimoBalance;
  if (!ttsReady()) return "";
  if (!readerState.ttsConfig?.balance_cookie_configured) return "MiMo 余额：未配置 Cookie";
  const hasBalance = !!balance?.total_balance && !!balance?.currency;
  const symbol = hasBalance ? (balance.currency === "CNY" ? "¥" : `${balance.currency} `) : "";
  const value = hasBalance ? `${symbol}${balance.total_balance}` : "";
  if (balance?.auth_expired) {
    return hasBalance
      ? `MiMo 余额：${value} · 数据已过期（最后更新 ${formatBalanceTime(balance.updated_at)}）`
      : "MiMo 余额：Cookie 已过期";
  }
  if (!balance) {
    const reason = readerState.mimoBalanceError || "查询失败";
    const retryLeft = Math.max(0, Math.ceil((readerState.mimoBalanceRetryAt - Date.now()) / 1000));
    return retryLeft > 0
      ? `MiMo 余额：${reason}，${retryLeft} 秒后重试`
      : `MiMo 余额：${reason}，正在重试`;
  }
  if (readerState.mimoBalanceError) {
    const retryLeft = Math.max(0, Math.ceil((readerState.mimoBalanceRetryAt - Date.now()) / 1000));
    const retryText = retryLeft > 0 ? `${retryLeft} 秒后重试` : "正在重试";
    return hasBalance
      ? `MiMo 余额：${value} · 更新失败：${readerState.mimoBalanceError}，${retryText}`
      : `MiMo 余额：${readerState.mimoBalanceError}，${retryText}`;
  }
  if (!hasBalance) return "MiMo 余额：未知";
  return `MiMo 余额：${value} · 更新于 ${formatBalanceTime(balance.updated_at)}`;
}

function renderMimoBalance() {
  const node = $("mimoBalance");
  const panel = $("mimoBalancePanel");
  if (!node) return;
  node.textContent = formatMimoBalance();
  if (panel) panel.hidden = !ttsReady();
}

function stopMimoBalanceCountdown() {
  window.clearInterval(readerState.mimoBalanceCountdownTimer);
  readerState.mimoBalanceCountdownTimer = null;
}

function startMimoBalanceCountdown() {
  stopMimoBalanceCountdown();
  renderMimoBalance();
  readerState.mimoBalanceCountdownTimer = window.setInterval(() => {
    renderMimoBalance();
    if (!readerState.mimoBalanceRetryAt || Date.now() >= readerState.mimoBalanceRetryAt) {
      stopMimoBalanceCountdown();
    }
  }, 1000);
}

function scheduleMimoBalanceInterval() {
  window.clearInterval(readerState.mimoBalanceTimer);
  readerState.mimoBalanceTimer = null;
  if (!ttsReady() || !readerState.ttsConfig?.balance_cookie_configured || readerState.mimoBalance?.auth_expired) return;
  readerState.mimoBalanceTimer = window.setInterval(loadMimoBalance, 15 * 60 * 1000);
}

async function loadMimoBalance(options = {}) {
  const force = !!options.force;
  if ((!force && document.hidden) || !ttsReady() || !readerState.ttsConfig?.balance_cookie_configured) return false;
  const requestId = ++readerState.mimoBalanceRequestId;
  window.clearTimeout(readerState.mimoBalanceRetryTimer);
  readerState.mimoBalanceRetryAt = 0;
  stopMimoBalanceCountdown();
  renderMimoBalance();
  try {
    const data = await api(`/api/reader/mimo-balance${force ? "?force=1" : ""}`);
    if (requestId !== readerState.mimoBalanceRequestId) return false;
    readerState.mimoBalance = data.balance;
    readerState.ttsConfig.balance_status = data.balance;
    readerState.mimoBalanceError = "";
    readerState.mimoBalanceLoadedAt = Date.now();
    if (data.balance?.auth_expired) {
      window.clearInterval(readerState.mimoBalanceTimer);
      readerState.mimoBalanceTimer = null;
    } else {
      scheduleMimoBalanceInterval();
    }
    renderMimoBalance();
    return !data.balance?.auth_expired;
  } catch (error) {
    if (requestId !== readerState.mimoBalanceRequestId) return false;
    if (error.data?.balance) readerState.mimoBalance = error.data.balance;
    readerState.mimoBalanceError = error.message || "查询失败";
    const shouldRetry = error.code !== "missing_cookie" && !readerState.mimoBalance?.auth_expired;
    if (shouldRetry) {
      readerState.mimoBalanceRetryAt = Date.now() + 15 * 1000;
      readerState.mimoBalanceRetryTimer = window.setTimeout(loadMimoBalance, 15 * 1000);
      startMimoBalanceCountdown();
    } else {
      window.clearInterval(readerState.mimoBalanceTimer);
      readerState.mimoBalanceTimer = null;
    }
    renderMimoBalance();
    return false;
  }
}

function startMimoBalanceRefresh() {
  window.clearInterval(readerState.mimoBalanceTimer);
  window.clearTimeout(readerState.mimoBalanceRetryTimer);
  stopMimoBalanceCountdown();
  if (!ttsReady()) {
    readerState.mimoBalance = null;
    readerState.mimoBalanceError = "";
    readerState.mimoBalanceRetryAt = 0;
    renderMimoBalance();
    return;
  }
  if (!readerState.ttsConfig?.balance_cookie_configured) {
    readerState.mimoBalanceError = "";
    readerState.mimoBalanceRetryAt = 0;
    renderMimoBalance();
    return;
  }
  if (readerState.mimoBalance?.auth_expired) {
    readerState.mimoBalanceError = "";
    readerState.mimoBalanceRetryAt = 0;
    renderMimoBalance();
    return;
  }
  loadMimoBalance();
}

function refreshMimoBalanceWhenVisible() {
  if (document.hidden || !ttsReady()) return;
  if (!readerState.ttsConfig?.balance_cookie_configured || readerState.mimoBalance?.auth_expired) return;
  if (Date.now() - readerState.mimoBalanceLoadedAt >= 15 * 60 * 1000) {
    loadMimoBalance();
  }
}

function selectedOfflineChapterIndexes() {
  return [...document.querySelectorAll("#offlineChapterList input[type=checkbox]:checked")]
    .map((input) => Number(input.value))
    .filter(Number.isFinite);
}

function setOfflineCacheBusy(busy) {
  readerState.offlineBusy = !!busy;
  const selected = selectedOfflineChapterIndexes();
  [
    "cacheAndDownloadOfflineBtn",
    "cacheServerOfflineBtn",
    "deleteLocalOfflineBtn",
    "unpinServerOfflineBtn",
  ].forEach((id) => {
    const button = $(id);
    if (button) button.disabled = busy || !selected.length;
  });
  document.querySelectorAll("#offlineChapterList input[type=checkbox]").forEach((input) => {
    input.disabled = busy;
  });
  ["selectAllOfflineBtn", "selectRangeOfflineBtn", "clearOfflineSelectionBtn"].forEach((id) => {
    const button = $(id);
    if (button) button.disabled = busy;
  });
  const retryButton = $("retryOfflineJobBtn");
  if (retryButton) retryButton.disabled = busy || !readerState.offlineRetry;
}
function updateOfflineProgressDensity() {
  const text = $("offlineCacheProgressText");
  text.classList.remove("compact");
  if (!text.textContent) return;
  window.requestAnimationFrame(() => {
    const lineHeight = Number.parseFloat(window.getComputedStyle(text).lineHeight) || 15;
    if (text.scrollHeight > lineHeight * 2 + 1) text.classList.add("compact");
  });
}

function setOfflineRetry(retry = null) {
  const valid = retry
    && retry.bookId === readerState.offlineBookId
    && Array.isArray(retry.chapterIndexes)
    && retry.chapterIndexes.length;
  readerState.offlineRetry = valid ? {
    bookId: retry.bookId,
    chapterIndexes: [...new Set(retry.chapterIndexes.map(Number).filter(Number.isFinite))],
    downloadToDevice: !!retry.downloadToDevice,
  } : null;
  const button = $("retryOfflineJobBtn");
  if (!button) return;
  button.hidden = !readerState.offlineRetry;
  button.disabled = readerState.offlineBusy || !readerState.offlineRetry;
}

function showOfflineCacheProgress(message, type = "", bookId = "", retry = null) {
  if (bookId && bookId !== readerState.offlineBookId) return;
  const node = $("offlineCacheProgress");
  const text = $("offlineCacheProgressText");
  text.textContent = message || "";
  text.title = message || "";
  node.classList.toggle("visible", !!message);
  node.classList.toggle("error", type === "error");
  node.setAttribute("aria-hidden", message ? "false" : "true");
  setOfflineRetry(retry);
  updateOfflineProgressDensity();
}

function offlineDownloadSummary(downloaded) {
  const complete = offlineDownloadIsComplete(downloaded);
  const missingServer = Math.max(0, downloaded.expectedSentences - downloaded.completedSentences);
  if (!complete) {
    return "本机下载结束 · 覆盖 " + downloaded.completedSentences + " 句 · 服务器缺失 " + missingServer + " 句";
  }
  if (downloaded.downloaded) {
    return "本机下载完成 · 新增 " + downloaded.downloaded + " 包 · 已有 " + downloaded.existing
      + " 包 · 覆盖 " + downloaded.completedSentences + " 句 · " + formatBytes(downloaded.downloadedBytes);
  }
  return "本机缓存已完整 · " + downloaded.existing + " 包 · 覆盖 " + downloaded.completedSentences + " 句";
}

function offlineDownloadIsComplete(downloaded) {
  return Number(downloaded?.completed || 0) >= Number(downloaded?.expectedPacks || 0)
    && Number(downloaded?.completedSentences || 0) >= Number(downloaded?.expectedSentences || 0);
}

function serverOfflineChaptersAreComplete(chapterIndexes) {
  const chapters = new Map((readerState.offlineStatus?.chapters || []).map((chapter) => (
    [Number(chapter.index), chapter]
  )));
  return chapterIndexes.every((chapterIndex) => {
    const chapter = chapters.get(Number(chapterIndex));
    if (!chapter) return false;
    if (chapter.total_sentences === null || chapter.total_sentences === undefined) return false;
    const totalSentences = Number(chapter.total_sentences);
    const serverSentences = Number(chapter.server_sentences || 0);
    if (!Number.isInteger(totalSentences) || !Number.isFinite(serverSentences)
      || serverSentences < totalSentences) return false;
    if (totalSentences === 0) return true;
    if (chapter.total_packs === null || chapter.total_packs === undefined) return false;
    const totalPacks = Number(chapter.total_packs);
    return Number.isInteger(totalPacks) && Number(chapter.server_packs || 0) >= totalPacks;
  });
}

function setOfflineActiveJob(job = null) {
  const active = job
    && job.book_id === readerState.offlineBookId
    && ["queued", "running"].includes(job.status);
  readerState.offlineActiveJobId = active ? job.id : "";
  const downloading = readerState.offlineDownloadController?.bookId === readerState.offlineBookId;
  const button = $("cancelOfflineJobBtn");
  button.hidden = !active && !downloading;
  button.disabled = readerState.offlineCancelRequested || (active ? !!job.cancel_requested : false);
  updateOfflineProgressDensity();
}

function offlineJobProgressMessage(job) {
  const completed = Number(job?.completed_sentences || 0);
  const failed = Number(job?.failed_sentences || 0);
  const total = Number(job?.total_sentences || 0);
  const processed = completed + failed;
  let message = (job?.message || "正在生成并固定服务器缓存") + " · "
    + processed + " / " + (total || "…") + " 句 · 复用 "
    + Number(job?.cached_sentences || 0) + " · 生成 "
    + Number(job?.generated_sentences || 0);
  if (failed) message += " · 失败 " + failed;
  const totalPacks = Number(job?.total_packs || 0);
  if (totalPacks) {
    message += " · 播放包 " + Number(job?.completed_packs || 0) + " / " + totalPacks;
    if (Number(job?.failed_packs || 0)) message += "（失败 " + Number(job.failed_packs) + "）";
  }
  return message;
}

async function resumeOfflineJob(job, bookId) {
  if (!job?.id || readerState.offlineBusy) return;
  readerState.offlineCancelRequested = false;
  setOfflineCacheBusy(true);
  try {
    const completedJob = await waitForOfflineJob(job, bookId);
    const failed = Number(completedJob.failed_sentences || 0);
    const failedPacks = Number(completedJob.failed_packs || 0);
    const hasFailures = completedJob.status === "done" && (failed > 0 || failedPacks > 0);
    const retry = hasFailures ? {
      bookId,
      chapterIndexes: completedJob.chapter_indexes || [],
      downloadToDevice: false,
    } : null;
    showOfflineCacheProgress(
      completedJob.message || (completedJob.status === "cancelled" ? "任务已取消" : "服务器固定完成"),
      hasFailures ? "error" : "",
      bookId,
      retry,
    );
    await loadOfflineCacheStatus(bookId);
  } catch (error) {
    showOfflineCacheProgress(error.message, "error", bookId);
  } finally {
    readerState.offlineCancelRequested = false;
    setOfflineCacheBusy(false);
  }
}

function captureOfflineChapterViewport(list) {
  const listTop = list.getBoundingClientRect().top;
  const anchor = [...list.querySelectorAll(".offline-chapter-item")].find((item) => (
    item.getBoundingClientRect().bottom > listTop + 1
  ));
  return {
    scrollTop: list.scrollTop,
    chapterIndex: anchor?.dataset.chapterIndex || "",
    offset: anchor ? anchor.getBoundingClientRect().top - listTop : 0,
  };
}

function restoreOfflineChapterViewport(list, viewport) {
  list.scrollTop = viewport.scrollTop;
  if (!viewport.chapterIndex) return;
  const anchor = [...list.querySelectorAll(".offline-chapter-item")].find((item) => (
    item.dataset.chapterIndex === viewport.chapterIndex
  ));
  if (!anchor) return;
  const currentOffset = anchor.getBoundingClientRect().top - list.getBoundingClientRect().top;
  list.scrollTop += currentOffset - viewport.offset;
}

function renderOfflineCacheStatus(storage = "正在读取本机缓存") {
  const bookId = readerState.offlineBookId;
  const status = readerState.offlineStatus;
  const list = $("offlineChapterList");
  const checked = new Set(selectedOfflineChapterIndexes());
  const viewport = captureOfflineChapterViewport(list);
  list.innerHTML = "";
  if (!status?.chapters?.length) {
    list.innerHTML = '<div class="offline-cache-summary">当前书籍没有可缓存章节。</div>';
    setOfflineCacheBusy(readerState.offlineBusy);
    return;
  }
  const fragment = document.createDocumentFragment();
  status.chapters.forEach((chapter) => {
    const local = readerState.offlineLocalStats.get(Number(chapter.index)) || {
      entries: 0,
      sizeBytes: 0,
      totalSentences: null,
    };
    const label = document.createElement("label");
    label.className = "offline-chapter-item";
    label.dataset.chapterIndex = String(chapter.index);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = chapter.index;
    input.checked = checked.has(Number(chapter.index));
    input.addEventListener("change", () => setOfflineCacheBusy(readerState.offlineBusy));
    const name = document.createElement("span");
    name.className = "offline-chapter-name";
    name.textContent = (Number(chapter.index) + 1) + ". " + chapter.title;
    const state = document.createElement("span");
    state.className = "offline-chapter-state";
    const serverTotalNumber = Number(chapter.total_sentences);
    const localTotalNumber = Number(local.totalSentences);
    const total = chapter.total_sentences !== null && Number.isFinite(serverTotalNumber)
      ? Math.max(0, serverTotalNumber)
      : local.totalSentences !== null && local.totalSentences !== undefined
        && Number.isInteger(localTotalNumber) && localTotalNumber >= Number(local.entries || 0)
        ? localTotalNumber
        : null;
    const totalLabel = total === null ? "…" : String(total);
    state.textContent = "服务器固定 " + Number(chapter.server_sentences || 0) + "/" + totalLabel + "句 · "
      + formatBytes(chapter.server_size_bytes || 0) + "｜本机 " + Number(local.entries || 0)
      + "/" + totalLabel + "句 · " + formatBytes(local.sizeBytes || 0);
    label.append(input, name, state);
    fragment.appendChild(label);
  });
  list.appendChild(fragment);
  restoreOfflineChapterViewport(list, viewport);
  if (bookId !== readerState.offlineBookId) return;
  const profileLabel = status.profile_label || "默认音色";
  $("offlineCacheSummary").textContent = "《" + (readerState.offlineBook?.title || "当前书籍")
    + "》 · 音色：" + profileLabel + " · " + storage;
  setOfflineCacheBusy(readerState.offlineBusy);
}

async function loadOfflineCacheStatus(bookId = readerState.offlineBookId) {
  if (!bookId) throw new Error("请先选择一本书，再管理离线缓存");
  const status = await promiseWithTimeout(
    api("/api/books/" + bookId + "/tts-offline"),
    180000,
    "读取服务器离线缓存状态超时",
  );
  if (bookId !== readerState.offlineBookId) return null;
  readerState.offlineStatus = status;
  readerState.offlineLocalStats = new Map();
  const storagePromise = browserStorageSummary();
  renderOfflineCacheStatus();
  try {
    readerState.offlineLocalStats = await promiseWithTimeout(
      localOfflineStats(bookId, status.profile_key, status.chapters),
      8000,
      "读取本机离线缓存超时",
    );
    status.local_cache_error = "";
  } catch (error) {
    readerState.offlineLocalStats = new Map();
    status.local_cache_error = error.message || "读取本机离线缓存失败";
  }
  if (bookId !== readerState.offlineBookId) return null;
  const storage = await storagePromise;
  renderOfflineCacheStatus(storage);
  return status;
}

async function openOfflineCacheManager(book) {
  if (!book?.id) return;
  readerState.offlineBookId = book.id;
  readerState.offlineBook = book;
  readerState.offlineStatus = null;
  $("offlineChapterList").innerHTML = "";
  $("offlineCacheSummary").textContent = "《" + book.title + "》 · 正在读取缓存状态";
  readerState.offlineLocalStats = new Map();
  if ($("manageDialog").open) $("manageDialog").close();
  openReaderDialog($("offlineCacheDialog"));
  setOfflineActiveJob(null);
  showOfflineCacheProgress("正在读取服务器和本机缓存状态");
  try {
    const status = await loadOfflineCacheStatus(book.id);
    if (!status) return;
    if (status.active_job) {
      setOfflineActiveJob(status.active_job);
      showOfflineCacheProgress(offlineJobProgressMessage(status.active_job), "", book.id);
      resumeOfflineJob(status.active_job, book.id);
    } else {
      setOfflineActiveJob(null);
      const idleMessage = status.chapters?.length
        ? "请选择章节后执行缓存操作"
        : "当前书籍没有可缓存章节";
      showOfflineCacheProgress(
        status.local_cache_error ? `服务器状态已加载；${status.local_cache_error}` : idleMessage,
        status.local_cache_error ? "error" : "",
        book.id,
      );
    }
  } catch (error) {
    showOfflineCacheProgress(error.message, "error", book.id);
  }
}

function closeOfflineCacheManager() {
  $("offlineCacheDialog").close();
  window.setTimeout(() => {
    renderManageBooks();
    openReaderDialog($("manageDialog"));
  }, 0);
}

function selectOfflineChapterRange(mode) {
  document.querySelectorAll("#offlineChapterList input[type=checkbox]").forEach((input) => {
    input.checked = mode === "all";
  });
  setOfflineCacheBusy(readerState.offlineBusy);
}

function showOfflineRangeMessage(message = "") {
  const node = $("offlineRangeMessage");
  node.textContent = message;
  node.className = "reader-config-message error";
  node.hidden = !message;
}

function openOfflineChapterRangeDialog() {
  const inputs = [...document.querySelectorAll("#offlineChapterList input[type=checkbox]")];
  if (!inputs.length || readerState.offlineBusy) return;
  const selected = selectedOfflineChapterIndexes().sort((left, right) => left - right);
  const maxChapter = Math.max(...inputs.map((input) => Number(input.value) + 1));
  const defaultStart = selected.length ? selected[0] + 1 : 1;
  const defaultEnd = selected.length
    ? Math.min(selected[selected.length - 1] + 1, defaultStart + TTS_OFFLINE_MAX_CHAPTERS - 1)
    : Math.min(maxChapter, TTS_OFFLINE_MAX_CHAPTERS);
  [$("offlineRangeStart"), $("offlineRangeEnd")].forEach((input) => {
    input.max = String(maxChapter);
  });
  $("offlineRangeStart").value = String(defaultStart);
  $("offlineRangeEnd").value = String(defaultEnd);
  showOfflineRangeMessage();
  openReaderDialog($("offlineRangeDialog"));
  window.setTimeout(() => {
    $("offlineRangeStart").focus();
    $("offlineRangeStart").select();
  }, 0);
}

function applyOfflineChapterNumberRange(event) {
  event.preventDefault();
  if (readerState.offlineBusy) {
    $("offlineRangeDialog").close();
    return;
  }
  const inputs = [...document.querySelectorAll("#offlineChapterList input[type=checkbox]")];
  const start = Number($("offlineRangeStart").value);
  const end = Number($("offlineRangeEnd").value);
  const maxChapter = Number($("offlineRangeEnd").max);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    showOfflineRangeMessage("请正确填写起始章节和结束章节");
    return;
  }
  if (end > maxChapter) {
    showOfflineRangeMessage(`当前书籍最多到第 ${maxChapter} 章`);
    return;
  }
  if (end - start + 1 > TTS_OFFLINE_MAX_CHAPTERS) {
    showOfflineRangeMessage(`单次最多选择 ${TTS_OFFLINE_MAX_CHAPTERS} 章`);
    return;
  }
  const rangeInputs = inputs.filter((input) => {
    const chapterNumber = Number(input.value) + 1;
    return chapterNumber >= start && chapterNumber <= end;
  });
  if (!rangeInputs.length) {
    showOfflineRangeMessage("该范围内没有章节");
    return;
  }
  const rangeSet = new Set(rangeInputs);
  inputs.forEach((input) => {
    input.checked = rangeSet.has(input);
  });
  $("offlineRangeDialog").close();
  showOfflineCacheProgress(`已选择第 ${start}-${end} 章，共 ${rangeInputs.length} 章`, "", readerState.offlineBookId);
  setOfflineCacheBusy(false);
}

async function cancelOfflineJob() {
  if (readerState.offlineCancelRequested) return;
  const jobId = readerState.offlineActiveJobId;
  const bookId = readerState.offlineBookId;
  const downloadTask = readerState.offlineDownloadController;
  const downloadController = downloadTask?.bookId === bookId ? downloadTask.controller : null;
  if ((!jobId && !downloadController) || !bookId) return;

  const button = $("cancelOfflineJobBtn");
  button.disabled = true;
  readerState.offlineCancelRequested = true;

  if (downloadController) {
    showOfflineCacheProgress("正在取消本机下载", "", bookId);
    downloadController.abort();
    return;
  }

  showOfflineCacheProgress("正在取消，当前处理完成后停止", "", bookId);
  const ownsWait = !readerState.offlineBusy;
  if (ownsWait) setOfflineCacheBusy(true);

  try {
    const data = await api("/api/reader/tts-offline/jobs/" + jobId + "/cancel", {
      method: "POST",
      body: "{}",
    });
    setOfflineActiveJob(data.job);

    if (ownsWait) {
      const completedJob = await waitForOfflineJob(data.job, bookId);
      showOfflineCacheProgress(completedJob.message || "任务已取消", "", bookId);
      await loadOfflineCacheStatus(bookId);
    }
  } catch (error) {
    readerState.offlineCancelRequested = false;
    button.disabled = false;
    showOfflineCacheProgress(error.message, "error", bookId);
  } finally {
    if (ownsWait) {
      readerState.offlineCancelRequested = false;
      setOfflineCacheBusy(false);
    }
  }
}

async function waitForOfflineJob(job, bookId) {
  let current = job;
  setOfflineActiveJob(current);

  while (["queued", "running"].includes(current.status)) {
    showOfflineCacheProgress(offlineJobProgressMessage(current), "", bookId);
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    const data = await promiseWithTimeout(
      api("/api/reader/tts-offline/jobs/" + current.id),
      180000,
      "读取服务器固定进度超时",
    );
    current = data.job;
    setOfflineActiveJob(current);
  }

  setOfflineActiveJob(null);

  if (current.status === "error") {
    throw new Error(current.error || current.message || "服务器缓存任务失败");
  }
  return current;
}

async function downloadOfflineChapters(bookId, chapterIndexes) {
  const controller = new AbortController();
  readerState.offlineDownloadController = { controller, bookId };
  setOfflineActiveJob(null);
  try {
    const manifests = new Array(chapterIndexes.length);
    let nextChapter = 0;
    let loadedChapters = 0;
    const loadManifest = async () => {
      while (nextChapter < chapterIndexes.length) {
        const position = nextChapter;
        nextChapter += 1;
        const chapterIndex = chapterIndexes[position];
        manifests[position] = await promiseWithTimeout(
          api(
            "/api/books/" + bookId + "/tts-offline/chapters/" + chapterIndex,
            { signal: controller.signal },
          ),
          180000,
          "读取服务器播放包超时",
        );
        loadedChapters += 1;
        showOfflineCacheProgress(
          "正在读取服务器播放包 · " + loadedChapters + " / " + chapterIndexes.length + " 章",
          "",
          bookId,
        );
      }
    };
    showOfflineCacheProgress(
      "正在读取服务器播放包 · 0 / " + chapterIndexes.length + " 章",
      "",
      bookId,
    );
    await Promise.all(Array.from(
      { length: Math.min(TTS_OFFLINE_DOWNLOAD_WORKERS, chapterIndexes.length) },
      () => loadManifest(),
    ));
    const pending = manifests.flatMap((manifest) => (
      manifest.entries.map((entry) => ({ manifest, entry }))
    ));
    const total = pending.length;
    const expectedPacks = manifests.reduce((count, manifest) => count + Number(manifest.pack_count || 0), 0);
    const expectedSentences = manifests.reduce((count, manifest) => count + Number(manifest.sentence_count || 0), 0);
    const workerCount = Math.min(TTS_OFFLINE_DOWNLOAD_WORKERS, total);
    let nextIndex = 0;
    let completed = 0;
    let completedSentences = 0;
    let downloaded = 0;
    let existing = 0;
    let downloadedBytes = 0;

    const showProgress = () => {
      let message = "正在下载到本机";
      if (workerCount > 1) message += "（" + workerCount + " 路并行）";
      message += " · " + completedSentences + " / " + expectedSentences + " 句"
        + " · " + completed + " / " + expectedPacks + " 包 · " + formatBytes(downloadedBytes);
      if (existing) message += " · 已有 " + existing;
      showOfflineCacheProgress(message, "", bookId);
    };
    const abortIfRequested = () => {
      if (!controller.signal.aborted) return;
      const error = new Error("本机下载已取消");
      error.name = "AbortError";
      throw error;
    };
    const downloadNext = async () => {
      while (nextIndex < pending.length) {
        abortIfRequested();
        const { manifest, entry } = pending[nextIndex];
        nextIndex += 1;
        if (await promiseWithTimeout(
          hasLocalOfflinePack(manifest, entry),
          180000,
          "检查本机播放包超时",
        )) {
          existing += 1;
          completed += 1;
          completedSentences += Number(entry.sentence_count || 0);
          showProgress();
          continue;
        }
        const response = await promiseWithTimeout(
          fetch(entry.url, {
            credentials: "same-origin",
            signal: controller.signal,
          }),
          180000,
          "音频下载超时",
        );
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "音频下载失败：" + response.status);
        }
        const blob = await promiseWithTimeout(response.blob(), 180000, "读取下载音频超时");
        if (!blob.size) throw new Error("下载的音频为空");
        await promiseWithTimeout(
          saveLocalOfflinePack(manifest, entry, blob),
          180000,
          "写入本机播放包超时",
        );
        downloaded += 1;
        completed += 1;
        completedSentences += Number(entry.sentence_count || 0);
        downloadedBytes += blob.size;
        showProgress();
      }
    };

    const workers = Array.from({ length: workerCount }, () => downloadNext());
    try {
      await Promise.all(workers);
    } catch (error) {
      controller.abort();
      await Promise.allSettled(workers);
      throw error;
    }
    return {
      completed,
      total,
      expectedPacks,
      expectedSentences,
      completedSentences,
      downloaded,
      existing,
      downloadedBytes,
    };
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    if (readerState.offlineDownloadController?.controller === controller) {
      readerState.offlineDownloadController = null;
      setOfflineActiveJob(null);
    }
  }
}


async function ensureServerOfflineCache(bookId, chapterIndexes) {
  let lastJob = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let data;
    let joinedExisting = false;
    try {
      data = await promiseWithTimeout(
        api("/api/books/" + bookId + "/tts-offline", {
          method: "POST",
          body: JSON.stringify({ chapters: chapterIndexes }),
        }),
        180000,
        "检查服务器固定状态超时",
      );
    } catch (error) {
      if (error.status !== 429 || !error.data?.job || error.data.job.book_id !== bookId) throw error;
      data = { job: error.data.job };
      joinedExisting = true;
    }
    if (data.complete) return lastJob;
    const completed = await waitForOfflineJob(data.job, bookId);
    lastJob = completed;
    if (completed.status === "cancelled" || readerState.offlineCancelRequested || !joinedExisting) return completed;
  }
  return lastJob;
}


async function createOfflineCache(downloadToDevice, requestedChapterIndexes = null) {
  const bookId = readerState.offlineBookId;
  const validIndexes = new Set((readerState.offlineStatus?.chapters || []).map((item) => Number(item.index)));
  const chapterIndexes = [...new Set((requestedChapterIndexes || selectedOfflineChapterIndexes())
    .map(Number)
    .filter((index) => Number.isFinite(index) && validIndexes.has(index)))];
  if (!bookId || !chapterIndexes.length || readerState.offlineBusy) return;
  if (chapterIndexes.length > TTS_OFFLINE_MAX_CHAPTERS) {
    showOfflineCacheProgress(
      `单次最多缓存 ${TTS_OFFLINE_MAX_CHAPTERS} 章，请使用“选择范围”分段处理`,
      "error",
      bookId,
    );
    return;
  }
  readerState.offlineCancelRequested = false;
  setOfflineCacheBusy(true);
  try {
    let completedJob = null;
    if (downloadToDevice) {
      await requestPersistentBrowserStorage();
    }
    if (!serverOfflineChaptersAreComplete(chapterIndexes)) {
      showOfflineCacheProgress("正在检查服务器固定状态", "", bookId);
      completedJob = await ensureServerOfflineCache(bookId, chapterIndexes);
    }
    if (completedJob?.status === "cancelled" || readerState.offlineCancelRequested) {
      const message = completedJob?.status === "cancelled"
        ? completedJob.message || "任务已取消"
        : downloadToDevice ? "已停止后续本机下载" : completedJob?.message;
      showOfflineCacheProgress(message, "", bookId);
      await loadOfflineCacheStatus(bookId);
      return;
    }
    const failed = Math.max(0, Number(completedJob?.failed_sentences || 0));
    const failedPacks = Math.max(0, Number(completedJob?.failed_packs || 0));
    const failedText = (failed ? " · " + failed + " 句生成失败" : "")
      + (failedPacks ? " · " + failedPacks + " 个播放包失败" : "")
      + (failed || failedPacks ? "，可稍后重试" : "");
    const retry = failed || failedPacks ? { bookId, chapterIndexes, downloadToDevice } : null;
    if (!downloadToDevice) {
      const message = completedJob
        ? "服务器固定完成 · 复用 " + Number(completedJob.cached_sentences || 0)
          + " 句 · 生成 " + Number(completedJob.generated_sentences || 0) + " 句" + failedText
        : "所选章节已完整固定，无需重复处理";
      showOfflineCacheProgress(message, failed || failedPacks ? "error" : "", bookId, retry);
      await loadOfflineCacheStatus(bookId);
      return;
    }
    const downloaded = await downloadOfflineChapters(bookId, chapterIndexes);
    const complete = offlineDownloadIsComplete(downloaded);
    showOfflineCacheProgress(
      offlineDownloadSummary(downloaded) + failedText,
      failed || failedPacks || !complete ? "error" : "",
      bookId,
      failed || failedPacks || !complete ? { bookId, chapterIndexes, downloadToDevice: true } : null,
    );
    await loadOfflineCacheStatus(bookId);
  } catch (error) {
    if (error.name === "AbortError") {
      showOfflineCacheProgress("本机下载已取消，已下载部分已保留", "", bookId);
      await loadOfflineCacheStatus(bookId);
    } else {
      showOfflineCacheProgress(
        error.message,
        "error",
        bookId,
        { bookId, chapterIndexes, downloadToDevice },
      );
    }
  } finally {
    readerState.offlineCancelRequested = false;
    setOfflineCacheBusy(false);
  }
}

async function retryOfflineCache() {
  const retry = readerState.offlineRetry;
  if (!retry || retry.bookId !== readerState.offlineBookId || readerState.offlineBusy) return;
  document.querySelectorAll("#offlineChapterList input[type=checkbox]").forEach((input) => {
    input.checked = retry.chapterIndexes.includes(Number(input.value));
  });
  await createOfflineCache(retry.downloadToDevice, retry.chapterIndexes);
}


async function deleteSelectedLocalOffline() {
  const bookId = readerState.offlineBookId;
  const chapterIndexes = selectedOfflineChapterIndexes();
  const profileKey = readerState.offlineStatus?.profile_key;
  if (!bookId || !profileKey || !chapterIndexes.length || readerState.offlineBusy) return;
  if (!window.confirm(`确定删除当前浏览器中选定的 ${chapterIndexes.length} 章音频吗？`)) return;
  setOfflineCacheBusy(true);
  try {
    const removed = await deleteLocalOfflineChapters(bookId, profileKey, chapterIndexes);
    showOfflineCacheProgress(
      `已删除本机缓存 ${removed.packs} 个播放包 · ${formatBytes(removed.sizeBytes)}`,
      "",
      bookId,
    );
    await loadOfflineCacheStatus(bookId);
  } catch (error) {
    showOfflineCacheProgress(error.message, "error", bookId);
  } finally {
    setOfflineCacheBusy(false);
  }
}

async function unpinSelectedServerOffline() {
  const bookId = readerState.offlineBookId;
  const chapterIndexes = selectedOfflineChapterIndexes();
  if (!bookId || !chapterIndexes.length || readerState.offlineBusy) return;
  if (!window.confirm(`确定取消选定的 ${chapterIndexes.length} 章服务器固定吗？各设备的本机缓存不会删除。`)) return;
  setOfflineCacheBusy(true);
  try {
    const removed = await api(`/api/books/${bookId}/tts-offline`, {
      method: "DELETE",
      body: JSON.stringify({ chapters: chapterIndexes }),
    });
    showOfflineCacheProgress(
      `已取消服务器固定 ${removed.entries} 条 · 清理播放包 `
        + `${Number(removed.pack_entries || 0)} 个 / ${formatBytes(removed.removed_size_bytes || 0)}`,
      "",
      bookId,
    );
    await loadOfflineCacheStatus(bookId);
  } catch (error) {
    showOfflineCacheProgress(error.message, "error", bookId);
  } finally {
    setOfflineCacheBusy(false);
  }
}

function renderTtsCacheStats(stats = {}) {
  const node = $("ttsCacheStats");
  if (!node) return;
  const entries = Number(stats.cache_entries ?? stats.entries ?? 0);
  const fixed = Number(stats.fixed_entries ?? stats.pinned_entries ?? 0);
  node.textContent = "缓存 " + entries + "句 · " + formatBytes(
    stats.cache_disk_size_bytes ?? stats.disk_size_bytes ?? stats.size_bytes,
  )
    + "/" + formatBytes(stats.limit_bytes)
    + " · 固定 " + fixed + "句/" + formatBytes(
      stats.fixed_disk_size_bytes ?? stats.pinned_disk_size_bytes ?? stats.pinned_size_bytes ?? 0,
    )
    + " · 有效" + (stats.ttl_days || 7) + "天 · 更新" + formatCacheTime(stats.newest_accessed_at);
}

function scheduleTtsCacheStatsRetry(stats, attempt = 0) {
  window.clearTimeout(ttsCacheStatsRetryTimer);
  if (!stats?.refreshing || attempt >= 6) return;
  ttsCacheStatsRetryTimer = window.setTimeout(async () => {
    try {
      const data = await api("/api/reader/tts-config");
      const latest = data.config?.cache_stats || {};
      if (readerState.ttsConfig) readerState.ttsConfig.cache_stats = latest;
      renderTtsCacheStats(latest);
      scheduleTtsCacheStatsRetry(latest, attempt + 1);
    } catch {
      // The regular config reload will retry later.
    }
  }, 400);
}

async function loadTtsConfig() {
  const data = await api("/api/reader/tts-config");
  readerState.ttsConfig = data.config;
  renderTtsConfig();
  scheduleTtsCacheStatsRetry(data.config?.cache_stats || {});
}

function resizeTtsStylePrompt() {
  const textarea = $("ttsStylePrompt");
  if (!textarea) return;
  if (!window.matchMedia("(max-width: 760px)").matches) {
    textarea.style.height = "";
    textarea.style.overflowY = "";
    return;
  }
  textarea.style.height = "auto";
  const maxHeight = Math.max(38, Math.min(180, Math.round(window.innerHeight * 0.28)));
  const contentHeight = Math.max(38, textarea.scrollHeight);
  textarea.style.height = `${Math.min(contentHeight, maxHeight)}px`;
  textarea.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
}

function renderTtsConfig() {
  const config = readerState.ttsConfig || {};
  readerState.mimoBalance = config.balance_status || readerState.mimoBalance;
  $("ttsEnabled").checked = !!config.enabled;
  $("ttsApiKey").value = "";
  $("ttsApiKey").placeholder = config.api_key_configured ? "已配置，留空不修改" : "未配置";
  $("ttsBaseUrl").value = config.base_url || "";
  $("ttsBaseUrl").disabled = !config.allow_custom_base_url;
  $("ttsBaseUrl").title = "服务端接口地址只能在服务器 .env 中修改";
  $("ttsModel").innerHTML = "";
  const modelOptions = config.model_options || [];
  const models = modelOptions.includes(config.model) ? modelOptions : [config.model, ...modelOptions].filter(Boolean);
  const modelLabels = {
    "mimo-v2.5-tts": "mimo-v2.5-tts · 内置音色",
  };
  models.forEach((model) => $("ttsModel").appendChild(selectOption(modelLabels[model] || model, model, model === config.model)));
  renderTtsVoiceOptions(config);
  $("ttsChunkChars").value = config.chunk_chars ?? 260;
  $("ttsStylePrompt").value = config.style_prompt || "";
  window.requestAnimationFrame(resizeTtsStylePrompt);
  $("ttsCacheEnabled").checked = config.cache_enabled !== false;
  renderTtsCacheStats(config.cache_stats || {});
  renderQuickVoiceOptions(config);
  if ($("listenToolbar")) $("listenToolbar").hidden = !ttsReady(config);
  setListenStatus(ttsReady(config) ? "点击句子可从该句开始读" : "听书未启用");
  startMimoBalanceRefresh();
}

function ttsVoicesForModel(config = readerState.ttsConfig || {}, model = "") {
  const selectedModel = model || $("ttsModel")?.value || config.model || "mimo-v2.5-tts";
  const allVoices = config.voice_options || [];
  return allVoices.filter((voice) => (voice.models || []).includes(selectedModel));
}

function voiceOptionLabel(voice) {
  return `${voice.name || voice.id} · ${voice.language || ""}${voice.gender ? ` ${voice.gender}` : ""}`.trim();
}

function renderTtsVoiceOptions(config = readerState.ttsConfig || {}) {
  const voices = ttsVoicesForModel(config);
  $("ttsVoiceId").innerHTML = "";
  $("ttsVoiceId").disabled = false;
  voices.forEach((voice) => {
    $("ttsVoiceId").appendChild(selectOption(voiceOptionLabel(voice), voice.id, voice.id === config.voice_id));
  });
  if (config.voice_id && !voices.some((voice) => voice.id === config.voice_id)) {
    $("ttsVoiceId").appendChild(selectOption(config.voice_id, config.voice_id, true));
  }
}

function renderQuickVoiceOptions(config = readerState.ttsConfig || {}) {
  const select = $("quickVoiceSelect");
  if (!select) return;
  select.innerHTML = "";
  const voices = ttsVoicesForModel(config, config.model);
  voices.forEach((voice) => {
    select.appendChild(selectOption(voiceOptionLabel(voice), voice.id, voice.id === config.voice_id));
  });
  if (config.voice_id && !voices.some((voice) => voice.id === config.voice_id)) {
    select.appendChild(selectOption(config.voice_id, config.voice_id, true));
  }
  select.disabled = !ttsReady(config);
  resizeQuickVoiceSelect();
}

function resizeQuickVoiceSelect() {
  const select = $("quickVoiceSelect");
  if (!select) return;
  if (window.matchMedia("(max-width: 760px)").matches) {
    select.style.width = "";
    return;
  }
  const label = select.selectedOptions?.[0]?.textContent || select.value || "";
  const canvas = resizeQuickVoiceSelect.canvas || document.createElement("canvas");
  resizeQuickVoiceSelect.canvas = canvas;
  const context = canvas.getContext("2d");
  const style = window.getComputedStyle(select);
  context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const measured = Math.ceil(context.measureText(label).width);
  const width = Math.min(Math.max(measured + 64, 178), 360);
  select.style.width = `${width}px`;
}

function ttsConfigPayload(overrides = {}) {
  const config = readerState.ttsConfig || {};
  return {
    enabled: $("ttsEnabled") ? $("ttsEnabled").checked : !!config.enabled,
    api_key: $("ttsApiKey") ? $("ttsApiKey").value : "",
    base_url: config.allow_custom_base_url
      ? ($("ttsBaseUrl")?.value || config.base_url)
      : config.base_url,
    model: $("ttsModel")?.value || config.model,
    voice_id: $("ttsVoiceId")?.value || config.voice_id,
    style_prompt: $("ttsStylePrompt")?.value ?? config.style_prompt ?? "",
    chunk_chars: Number($("ttsChunkChars")?.value || config.chunk_chars || 260),
    cache_enabled: $("ttsCacheEnabled") ? $("ttsCacheEnabled").checked : config.cache_enabled !== false,
    ...overrides,
  };
}

async function saveTtsConfig() {
  const previousConfigured = !!readerState.ttsConfig?.api_key_configured;
  const payload = ttsConfigPayload();
  if (payload.enabled && !payload.api_key && !previousConfigured) {
    showTtsConfigMessage("请先配置 API Key", "error");
    return;
  }
  try {
    showTtsConfigMessage("正在保存");
    const data = await api("/api/reader/tts-config", { method: "PUT", body: JSON.stringify(payload) });
    readerState.ttsConfig = data.config;
    clearTtsBrowserCache();
    renderTtsConfig();
    showTtsConfigMessage("听书配置已保存", "success");
  } catch (error) {
    showTtsConfigMessage(error.message, "error");
  }
}

async function refreshMimoBalance() {
  const button = $("refreshMimoBalanceBtn");
  if (button) button.disabled = true;
  try {
    await loadMimoBalance({ force: true });
  } finally {
    if (button) button.disabled = false;
  }
}

function showMimoCookieMessage(text, type = "") {
  const node = $("mimoCookieMessage");
  if (!node) return;
  node.textContent = text || "";
  node.className = `reader-config-message ${type}`.trim();
  node.hidden = !text;
}

function openMimoCookieDialog() {
  const input = $("mimoBalanceCookieInput");
  input.value = "";
  input.placeholder = readerState.ttsConfig?.balance_cookie_configured
    ? "已配置，粘贴新的 Cookie 后覆盖"
    : "粘贴 platform.xiaomimimo.com 的完整 Cookie";
  showMimoCookieMessage("");
  openReaderDialog($("mimoCookieDialog"));
  window.setTimeout(() => input.focus(), 0);
}

function persistedTtsConfigPayload(overrides = {}) {
  const config = readerState.ttsConfig || {};
  return {
    enabled: !!config.enabled,
    api_key: "",
    base_url: config.base_url || "",
    model: config.model || "mimo-v2.5-tts",
    voice_id: config.voice_id || "mimo_default",
    style_prompt: config.style_prompt || "",
    chunk_chars: Number(config.chunk_chars || 260),
    cache_enabled: config.cache_enabled !== false,
    ...overrides,
  };
}

async function saveMimoBalanceCookie() {
  const input = $("mimoBalanceCookieInput");
  const cookie = input.value.trim();
  if (!cookie) {
    showMimoCookieMessage("请先粘贴 Cookie", "error");
    return;
  }
  const button = $("saveMimoCookieBtn");
  if (button) button.disabled = true;
  try {
    showMimoCookieMessage("正在保存");
    const data = await api("/api/reader/tts-config", {
      method: "PUT",
      body: JSON.stringify(persistedTtsConfigPayload({ balance_cookie: cookie })),
    });
    readerState.ttsConfig = data.config;
    readerState.mimoBalance = data.config.balance_status || readerState.mimoBalance;
    input.value = "";
    $("mimoCookieDialog").close();
    showTtsConfigMessage("Cookie 已保存，正在更新余额", "success");
    const updated = await loadMimoBalance({ force: true });
    if (updated) {
      showTtsConfigMessage("Cookie 已保存，余额已更新", "success");
    } else if (readerState.mimoBalance?.auth_expired) {
      showTtsConfigMessage("Cookie 已保存，但已失效，请重新获取", "error");
    } else {
      showTtsConfigMessage("Cookie 已保存，余额更新失败，正在重试", "error");
    }
  } catch (error) {
    showMimoCookieMessage(error.message, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function changeQuickVoice() {
  const select = $("quickVoiceSelect");
  if (!select) return;
  resizeQuickVoiceSelect();
  const voiceId = select.value;
  if (!voiceId || !readerState.ttsConfig) return;
  const wasReading = readerState.reading;
  if (wasReading) stopListening(false);
  setListenStatus("正在切换音色");
  try {
    const data = await api("/api/reader/tts-config", {
      method: "PUT",
      body: JSON.stringify(ttsConfigPayload({
        enabled: readerState.ttsConfig.enabled,
        api_key: "",
        voice_id: voiceId,
      })),
    });
    readerState.ttsConfig = data.config;
    clearTtsBrowserCache();
    renderTtsConfig();
    setListenStatus(wasReading ? "音色已切换，请重新开始朗读" : "音色已切换");
  } catch (error) {
    setListenStatus(error.message);
    renderQuickVoiceOptions(readerState.ttsConfig || {});
  }
}

$("uploadForm").addEventListener("submit", uploadBook);
$("bookFile").addEventListener("change", () => {
  if (activeImportCount() >= 2) {
    $("bookFile").value = "";
    $("selectedFileName").textContent = "TXT / EPUB / PDF，最大 50MB";
    setUploadMessage("已有 2 本书正在导入，请等待至少一本完成", "error");
    return;
  }
  const file = $("bookFile").files[0];
  $("selectedFileName").textContent = file ? file.name : "TXT / EPUB / PDF，最大 50MB";
  setUploadMessage(file ? "已选择文件，正在导入" : "选择文件后导入到本地书架");
  if (file) $("uploadForm").requestSubmit();
});
$("chapterSelect").addEventListener("change", () => {
  const shouldResume = readerState.reading && !readerState.paused;
  stopListening(false, false);
  loadChapter(Number($("chapterSelect").value), 0)
    .then(() => {
      if (shouldResume) return startListeningFrom(0);
      return null;
    })
    .catch((error) => setListenStatus(error.message));
});
$("prevChapterBtn").addEventListener("click", () => moveChapter(-1));
$("nextChapterBtn").addEventListener("click", () => moveChapter(1));
$("listenPauseBtn").addEventListener("click", () => toggleListeningPause().catch((error) => setListenStatus(error.message)));
$("listenStopBtn").addEventListener("click", () => stopListening());
$("playbackRateSelect").addEventListener("change", updatePlaybackRate);
$("quickVoiceSelect")?.addEventListener("change", () => changeQuickVoice().catch((error) => setListenStatus(error.message)));
$("sleepTimerBtn")?.addEventListener("click", openSleepTimerDialog);
$("applySleepCustomBtn")?.addEventListener("click", applyCustomSleepTimer);
$("clearSleepTimerBtn")?.addEventListener("click", () => {
  clearSleepTimer(true);
  setListenStatus(ttsReady() ? "定时已取消" : "听书未启用");
  $("sleepTimerDialog").close();
});
document.querySelectorAll("[data-sleep-minutes]").forEach((button) => {
  button.addEventListener("click", () => {
    scheduleSleepTimer(Number(button.dataset.sleepMinutes));
    $("sleepTimerDialog").close();
  });
});
$("fontInput").addEventListener("input", updateReaderFont);
$("darkModeBtn").addEventListener("click", updateReaderTheme);
$("saveTtsConfigBtn").addEventListener("click", () => saveTtsConfig());
$("configureMimoCookieBtn")?.addEventListener("click", openMimoCookieDialog);
$("saveMimoCookieBtn")?.addEventListener("click", () => saveMimoBalanceCookie());
$("closeMimoCookieBtn")?.addEventListener("click", () => $("mimoCookieDialog").close());
$("refreshMimoBalanceBtn")?.addEventListener("click", () => refreshMimoBalance());
$("ttsModel").addEventListener("change", () => renderTtsVoiceOptions());
$("ttsStylePrompt").addEventListener("input", resizeTtsStylePrompt);
$("shelfBtn").addEventListener("click", returnToShelf);
$("statisticsBtn").addEventListener("click", () => {
  renderStatistics();
  openReaderDialog($("statisticsDialog"));
});
$("manageBtn").addEventListener("click", () => {
  renderManageBooks();
  openReaderDialog($("manageDialog"));
});
$("ttsBtn").addEventListener("click", () => {
  loadTtsConfig().catch((error) => showTtsConfigMessage(error.message, "error"));
  openReaderDialog($("ttsDialog"));
  window.requestAnimationFrame(resizeTtsStylePrompt);
});
$("settingsBtn").addEventListener("click", () => {
  openReaderDialog($("settingsDialog"));
  activateCachedReaderFonts();
});
$("closeManageBtn").addEventListener("click", () => $("manageDialog").close());
$("closeStatisticsBtn").addEventListener("click", () => $("statisticsDialog").close());
$("bookMetadataForm").addEventListener("submit", saveBookMetadata);
$("closeBookMetadataBtn").addEventListener("click", () => $("bookMetadataDialog").close());
$("closeTocEditBtn").addEventListener("click", () => $("tocEditDialog").close());
$("closeTocLineBtn").addEventListener("click", () => $("tocLineDialog").close());
$("tocLineSearch").addEventListener("input", renderTocLineRows);
$("closeSettingsBtn").addEventListener("click", () => $("settingsDialog").close());

$("closeOfflineCacheBtn")?.addEventListener("click", closeOfflineCacheManager);
$("selectAllOfflineBtn")?.addEventListener("click", () => selectOfflineChapterRange("all"));
$("selectRangeOfflineBtn")?.addEventListener("click", openOfflineChapterRangeDialog);
$("offlineRangeForm")?.addEventListener("submit", applyOfflineChapterNumberRange);
$("closeOfflineRangeBtn")?.addEventListener("click", () => $("offlineRangeDialog").close());
$("clearOfflineSelectionBtn")?.addEventListener("click", () => selectOfflineChapterRange("clear"));
$("cancelOfflineJobBtn")?.addEventListener("click", cancelOfflineJob);
$("retryOfflineJobBtn")?.addEventListener("click", retryOfflineCache);
$("cacheAndDownloadOfflineBtn")?.addEventListener("click", () => createOfflineCache(true));
$("cacheServerOfflineBtn")?.addEventListener("click", () => createOfflineCache(false));
$("deleteLocalOfflineBtn")?.addEventListener("click", () => deleteSelectedLocalOffline());
$("unpinServerOfflineBtn")?.addEventListener("click", () => unpinSelectedServerOffline());
$("closeTtsBtn").addEventListener("click", () => $("ttsDialog").close());
$("closeSleepTimerBtn")?.addEventListener("click", () => $("sleepTimerDialog").close());
window.addEventListener("resize", () => {
  resizeQuickVoiceSelect();
  resizeTtsStylePrompt();
  updateOfflineProgressDensity();
});
window.addEventListener("wheel", markUserScrollIntent, { passive: true });
window.addEventListener("touchmove", markUserScrollIntent, { passive: true });
window.addEventListener("keydown", (event) => {
  if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
    markUserScrollIntent();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refreshSelectedReaderFont();
    syncReaderWakeLock();
    refreshMimoBalanceWhenVisible();
  } else {
    releaseReaderWakeLock();
  }
});
window.addEventListener("pageshow", refreshSelectedReaderFont);
window.addEventListener("popstate", (event) => {
  const state = event.state || {};
  if (state.readerView === "book" && state.bookId) {
    const book = readerState.books.find((item) => item.id === state.bookId);
    if (book) {
      openBook(state.bookId, book.progress?.chapter || 0, book.progress?.sentence || 0, false)
        .catch((error) => {
          setStatus(error.message);
          showShelfView();
        });
      return;
    }
  }
  showShelfView();
});
window.addEventListener("pagehide", () => {
  readerState.wakeLockWanted = false;
  releaseReaderWakeLock();
  window.clearTimeout(readerState.mimoBalanceRetryTimer);
  window.clearTimeout(ttsCacheStatsRetryTimer);
});
document.querySelectorAll(".reader-dialog").forEach((dialog) => {
  dialog.addEventListener("close", unlockReaderScroll);
  dialog.addEventListener("cancel", () => window.setTimeout(unlockReaderScroll, 0));
});
$("logoutBtn").addEventListener("click", async () => {
  readerState.wakeLockWanted = false;
  releaseReaderWakeLock();
  await api("/logout", { method: "POST", body: "{}" });
  window.location.href = "/login";
});

restoreReaderSettings();
initializeMediaSession();
window.history.replaceState({ readerView: "shelf" }, "", window.location.href);
ensureReaderFontLoaded("yshi-written").then((loaded) => {
  if (loaded && window.localStorage.getItem("readerFontFamily") === "yshi-written") {
    updateReaderFontFamily("yshi-written", false, false);
  }
});
pruneStoredReaderFonts();
Promise.all([loadBooks(), loadImportJobs(), loadTtsConfig()]).catch((error) => setStatus(error.message));
