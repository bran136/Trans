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
  playbackRate: 1,
  ttsConfig: null,
  ttsAudio: null,
  ttsToken: 0,
  ttsScope: 0,
  ttsUrls: new Map(),
  ttsBlobs: new Map(),
  ttsWavInfo: new Map(),
  ttsUrlSizes: new Map(),
  ttsUrlOrder: [],
  ttsPending: new Map(),
  activeTtsPlaybackUrl: "",
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
  metadataEditBookId: "",
};

const $ = (id) => document.getElementById(id);
const CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')?.content || "";
const TTS_BROWSER_CACHE_LIMIT = 12;
const TTS_BROWSER_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const TTS_PREFETCH_MIN_ITEMS = 2;
const TTS_PREFETCH_MAX_ITEMS = 5;
const TTS_SHORT_AUDIO_SECONDS = 5;
const TTS_MERGED_AUDIO_TARGET_SECONDS = 6;
const TTS_MERGED_AUDIO_MAX_ITEMS = 6;
const TTS_NEXT_CHAPTER_PREFETCH_MULTIPLIER = 2;
const TTS_SLEEP_FADE_SECONDS = 7;
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
  if (!dialog.open) dialog.showModal();
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

async function apiBlob(path, options = {}, onResponse = null) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.method && !["GET", "HEAD"].includes(options.method.toUpperCase()) ? { "X-CSRF-Token": CSRF_TOKEN } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `请求失败：${response.status}`);
  }
  const cacheState = response.headers.get("X-TTS-Cache") || "";
  const serverTiming = {
    cacheMs: Number(response.headers.get("X-TTS-Cache-Ms")) || 0,
    generateMs: Number(response.headers.get("X-TTS-Generate-Ms")) || 0,
    writeMs: Number(response.headers.get("X-TTS-Write-Ms")) || 0,
    totalMs: Number(response.headers.get("X-TTS-Total-Ms")) || 0,
  };
  if (typeof onResponse === "function") onResponse({ cacheState, ...serverTiming });
  const blob = await response.blob();
  return {
    blob,
    cacheState,
    ...serverTiming,
  };
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
        <button type="button" data-action="delete">删除</button>
      </div>
    `;
    row.querySelector('[data-action="edit"]').addEventListener("click", () => openBookMetadataEditor(book));
    row.querySelector('[data-action="toc-edit"]')?.addEventListener("click", () => openTocEditor(book));
    row.querySelector('[data-action="reparse"]').addEventListener("click", () => reparseBook(book));
    row.querySelector('[data-action="clear-toc"]')?.addEventListener("click", () => clearBookToc(book));
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
  if (canUsePrepared) preparedEntry.adopted = true;
  const prepared = canUsePrepared
    ? await (preparedEntry.readyPromise || preparedEntry.promise)
    : null;
  if (readerState.currentBookId !== bookId) return;
  const data = prepared?.data || await api(`/api/books/${bookId}/chapters/${normalizedChapterIndex}`);
  if (readerState.currentBookId !== bookId) return;
  readerState.currentBook = data.book;
  readerState.currentChapter = data.chapter.index;
  readerState.currentSentence = sentenceIndex;
  $("chapterSelect").value = String(readerState.currentChapter);
  renderChapter(data.chapter, prepared?.audios || []);
  highlightSentence(sentenceIndex, true);
  saveProgressSoon();
  setStatus(readerState.currentBook.title);
  if (readerState.reading) updateMediaSessionMetadata();
}

function renderChapter(chapter, prefetchedAudios = []) {
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
  prefetchedAudios.forEach((audio) => {
    if (sentenceText(audio.index) !== audio.text || !(audio.blob instanceof Blob)) return;
    rememberTtsUrl(audio.index, URL.createObjectURL(audio.blob), audio.blob);
    if (audio.wavInfo) readerState.ttsWavInfo.set(Number(audio.index), Promise.resolve(audio.wavInfo));
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
  focusSentence(normalizedIndex, false);
}

function focusSentence(index, read = false) {
  highlightSentence(index, true);
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

function waitForAudioReady(audio) {
  if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
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
  $("listenPauseBtn").classList.toggle("active", readerState.paused);
  $("listenPauseBtn").textContent = readerState.paused ? "继续" : "暂停";
}

function applyAudioPlaybackRate(audio) {
  if (!audio) return;
  const rate = Math.max(0.5, Math.min(Number(readerState.playbackRate) || 1, 4));
  audio.defaultPlaybackRate = rate;
  audio.playbackRate = rate;
}

function updatePlaybackRate() {
  readerState.playbackRate = Number($("playbackRateSelect").value) || 1;
  window.localStorage.setItem("readerPlaybackRate", String(readerState.playbackRate));
  applyAudioPlaybackRate(readerState.ttsAudio);
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

function formatStageDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${Math.max(1, Math.round(value))} 毫秒`;
  return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} 秒`;
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
  readerState.sleepTimerId = null;
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

function startSleepFadeIfNeeded(audio, stopAt = audio?.duration) {
  if (isIOSLike() || !readerState.sleepPausePending || !audio || !Number.isFinite(audio.duration)) return;
  const normalizedStopAt = Number.isFinite(Number(stopAt)) ? Number(stopAt) : audio.duration;
  const remaining = normalizedStopAt - audio.currentTime;
  if (remaining > TTS_SLEEP_FADE_SECONDS + 0.2) return;
  const applyVolume = () => {
    const secondsLeft = Math.max(0, normalizedStopAt - audio.currentTime);
    audio.volume = Math.max(0.05, Math.min(1, secondsLeft / TTS_SLEEP_FADE_SECONDS));
  };
  applyVolume();
  if (readerState.sleepFadeStarted) return;
  readerState.sleepFadeStarted = true;
  const tick = () => {
    if (!readerState.sleepPausePending || audio.paused || audio.ended) return;
    applyVolume();
    if (audio.volume > 0.05) window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
}

function finishSleepPause(index) {
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
}

function clearTtsBrowserCache() {
  readerState.ttsScope += 1;
  readerState.nextChapterPrefetch = null;
  readerState.ttsPending.clear();
  readerState.ttsUrls.forEach((url) => URL.revokeObjectURL(url));
  readerState.ttsUrls.clear();
  readerState.ttsBlobs.clear();
  readerState.ttsWavInfo.clear();
  readerState.ttsUrlSizes.clear();
  readerState.ttsUrlOrder = [];
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

function upcomingReadableSentenceIndexes(startIndex, maxItems = TTS_PREFETCH_MAX_ITEMS) {
  const indexes = [];
  let index = nextReadableSentenceIndex(startIndex);
  while (index >= 0 && indexes.length < maxItems) {
    indexes.push(index);
    index = nextReadableSentenceIndex(index + 1);
  }
  return indexes;
}

function ttsTextLength(text) {
  return String(text || "").replace(/\s+/g, "").length;
}

function ttsPrefetchBudgetForText(text, requestedRate = readerState.playbackRate) {
  const length = ttsTextLength(text);
  let base;
  if (length <= 35) base = { targetChars: 360, maxItems: 5 };
  else if (length <= 90) base = { targetChars: 280, maxItems: 4 };
  else base = { targetChars: 180, maxItems: 3 };
  const rate = Math.max(1, Math.min(Number(requestedRate) || 1, 2));
  const extraItems = Math.ceil(Math.max(0, rate - 1) * 2);
  return {
    targetChars: Math.round(base.targetChars * rate),
    minItems: TTS_PREFETCH_MIN_ITEMS + extraItems,
    maxItems: base.maxItems + extraItems,
  };
}

function ttsPrefetchBudget(currentIndex) {
  return ttsPrefetchBudgetForText(sentenceText(currentIndex));
}

function ttsPrefetchIndexes(currentIndex) {
  const indexes = [];
  let totalChars = 0;
  const budget = ttsPrefetchBudget(currentIndex);
  for (const index of upcomingReadableSentenceIndexes(Number(currentIndex) + 1, budget.maxItems)) {
    indexes.push(index);
    totalChars += ttsTextLength(sentenceText(index));
    if (indexes.length >= budget.minItems && totalChars >= budget.targetChars) break;
  }
  return indexes;
}

function ttsBrowserCacheSize() {
  let total = 0;
  readerState.ttsUrlSizes.forEach((size) => {
    total += Number(size) || 0;
  });
  return total;
}

function trimTtsBrowserCache(keepIndexes = []) {
  const keep = new Set(keepIndexes.map((item) => Number(item)));
  while (readerState.ttsUrlOrder.length > TTS_BROWSER_CACHE_LIMIT || ttsBrowserCacheSize() > TTS_BROWSER_CACHE_MAX_BYTES) {
    const removableIndex = readerState.ttsUrlOrder.findIndex((item) => !keep.has(Number(item)));
    if (removableIndex < 0) break;
    const staleIndex = readerState.ttsUrlOrder.splice(removableIndex, 1)[0];
    const staleUrl = readerState.ttsUrls.get(staleIndex);
    if (staleUrl) URL.revokeObjectURL(staleUrl);
    readerState.ttsUrls.delete(staleIndex);
    readerState.ttsBlobs.delete(staleIndex);
    readerState.ttsWavInfo.delete(staleIndex);
    readerState.ttsUrlSizes.delete(staleIndex);
  }
}

function rememberTtsUrl(index, url, blob) {
  const normalizedIndex = Number(index);
  const existing = readerState.ttsUrls.get(normalizedIndex);
  if (existing && existing !== url) URL.revokeObjectURL(existing);
  readerState.ttsUrls.set(normalizedIndex, url);
  readerState.ttsBlobs.set(normalizedIndex, blob);
  readerState.ttsWavInfo.delete(normalizedIndex);
  readerState.ttsUrlSizes.set(normalizedIndex, Number(blob?.size) || 0);
  readerState.ttsUrlOrder = readerState.ttsUrlOrder.filter((item) => Number(item) !== normalizedIndex);
  readerState.ttsUrlOrder.push(normalizedIndex);
  trimTtsBrowserCache([readerState.currentSentence, ...upcomingReadableSentenceIndexes(readerState.currentSentence + 1, TTS_BROWSER_CACHE_LIMIT - 1)]);
}

function wavChunkName(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

async function parseWavBlob(blob) {
  if (!blob || blob.size < 44) return null;
  const header = await blob.slice(0, Math.min(blob.size, 64 * 1024)).arrayBuffer();
  const view = new DataView(header);
  if (wavChunkName(view, 0) !== "RIFF" || wavChunkName(view, 8) !== "WAVE") return null;
  let format = null;
  let data = null;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const name = wavChunkName(view, offset);
    const size = view.getUint32(offset + 4, true);
    const valueOffset = offset + 8;
    if (name === "fmt " && size >= 16 && valueOffset + 16 <= view.byteLength) {
      format = {
        audioFormat: view.getUint16(valueOffset, true),
        channels: view.getUint16(valueOffset + 2, true),
        sampleRate: view.getUint32(valueOffset + 4, true),
        byteRate: view.getUint32(valueOffset + 8, true),
        blockAlign: view.getUint16(valueOffset + 12, true),
        bitsPerSample: view.getUint16(valueOffset + 14, true),
      };
    } else if (name === "data") {
      data = {
        offset: valueOffset,
        size: Math.max(0, Math.min(size, blob.size - valueOffset)),
      };
      break;
    }
    offset = valueOffset + size + (size % 2);
  }
  if (!format || !data || format.audioFormat !== 1 || !format.byteRate || !data.size) return null;
  return { ...format, ...data, duration: data.size / format.byteRate };
}

function wavInfoForIndex(index) {
  const normalizedIndex = Number(index);
  if (!readerState.ttsWavInfo.has(normalizedIndex)) {
    const promise = parseWavBlob(readerState.ttsBlobs.get(normalizedIndex)).catch(() => null);
    readerState.ttsWavInfo.set(normalizedIndex, promise);
  }
  return readerState.ttsWavInfo.get(normalizedIndex);
}

function sameWavFormat(left, right) {
  return !!left && !!right
    && left.audioFormat === right.audioFormat
    && left.channels === right.channels
    && left.sampleRate === right.sampleRate
    && left.byteRate === right.byteRate
    && left.blockAlign === right.blockAlign
    && left.bitsPerSample === right.bitsPerSample;
}

function buildWavHeader(format, dataSize) {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const writeName = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeName(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeName(8, "WAVE");
  writeName(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format.audioFormat, true);
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, format.byteRate, true);
  view.setUint16(32, format.blockAlign, true);
  view.setUint16(34, format.bitsPerSample, true);
  writeName(36, "data");
  view.setUint32(40, dataSize, true);
  return buffer;
}

async function prefetchedTtsBlob(index, scope) {
  const normalizedIndex = Number(index);
  let blob = readerState.ttsBlobs.get(normalizedIndex);
  if (blob) return blob;
  const pending = readerState.ttsPending.get(`${scope}:${normalizedIndex}`);
  if (!pending) return null;
  await pending.catch(() => "");
  blob = readerState.ttsBlobs.get(normalizedIndex);
  return blob || null;
}

async function prepareTtsPlayback(index, originalUrl, scope) {
  // Merge browser WAV blobs, including an in-flight prefetch. Server generation and cache entries remain per sentence.
  const normalizedIndex = Number(index);
  const chapterIndex = Number(readerState.currentChapter);
  const firstBlob = readerState.ttsBlobs.get(normalizedIndex);
  const firstInfo = await wavInfoForIndex(normalizedIndex);
  if (!firstBlob || !firstInfo) {
    return {
      url: originalUrl,
      owned: false,
      lastIndex: normalizedIndex,
      lastChapterIndex: chapterIndex,
      segments: [],
    };
  }
  const parts = [{ chapterIndex, index: normalizedIndex, blob: firstBlob, info: firstInfo }];
  let duration = firstInfo.duration;
  if (firstInfo.duration < TTS_SHORT_AUDIO_SECONDS) {
    for (const nextIndex of upcomingReadableSentenceIndexes(normalizedIndex + 1, TTS_MERGED_AUDIO_MAX_ITEMS - 1)) {
      const nextBlob = await prefetchedTtsBlob(nextIndex, scope);
      if (!nextBlob) break;
      const nextInfo = await wavInfoForIndex(nextIndex);
      if (!nextInfo || !sameWavFormat(firstInfo, nextInfo)) break;
      parts.push({ chapterIndex, index: nextIndex, blob: nextBlob, info: nextInfo });
      duration += nextInfo.duration;
      if (duration >= TTS_MERGED_AUDIO_TARGET_SECONDS) break;
    }
  }
  const lastCurrentPart = parts[parts.length - 1];
  if (nextReadableSentenceIndex(Number(lastCurrentPart.index) + 1) < 0) {
    const entry = readerState.nextChapterPrefetch;
    const prepared = entry?.prepared;
    if (entry
      && prepared
      && entry.bookId === readerState.currentBookId
      && entry.chapterIndex === chapterIndex + 1
      && entry.scope === scope) {
      let nextChapterDuration = 0;
      for (const audio of prepared.audios.slice(0, Math.max(1, TTS_MERGED_AUDIO_MAX_ITEMS - parts.length))) {
        const nextInfo = audio.wavInfo || await parseWavBlob(audio.blob).catch(() => null);
        if (!nextInfo || !sameWavFormat(firstInfo, nextInfo)) break;
        parts.push({
          chapterIndex: entry.chapterIndex,
          index: Number(audio.index),
          blob: audio.blob,
          info: nextInfo,
        });
        nextChapterDuration += nextInfo.duration;
        if (nextChapterDuration >= TTS_MERGED_AUDIO_TARGET_SECONDS) break;
      }
    }
  }
  const segments = [];
  let segmentStart = 0;
  parts.forEach((part) => {
    segments.push({
      chapterIndex: part.chapterIndex,
      index: part.index,
      start: segmentStart,
      end: segmentStart + part.info.duration,
    });
    segmentStart += part.info.duration;
  });
  if (parts.length < 2) {
    return {
      url: originalUrl,
      owned: false,
      lastIndex: normalizedIndex,
      lastChapterIndex: chapterIndex,
      segments,
    };
  }
  const dataSize = parts.reduce((total, part) => total + part.info.size, 0);
  const body = parts.map((part) => part.blob.slice(part.info.offset, part.info.offset + part.info.size));
  const mergedBlob = new Blob([buildWavHeader(firstInfo, dataSize), ...body], { type: "audio/wav" });
  return {
    url: URL.createObjectURL(mergedBlob),
    owned: true,
    lastIndex: parts[parts.length - 1].index,
    lastChapterIndex: parts[parts.length - 1].chapterIndex,
    segments,
  };
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
}

function adoptPrefetchedChapterForPlayback(chapterIndex) {
  const entry = readerState.nextChapterPrefetch;
  const prepared = entry?.prepared;
  if (!entry
    || !prepared
    || entry.bookId !== readerState.currentBookId
    || entry.chapterIndex !== Number(chapterIndex)) return false;
  entry.adopted = true;
  const data = prepared.data;
  readerState.currentBook = data.book;
  readerState.currentChapter = data.chapter.index;
  readerState.currentSentence = 0;
  $("chapterSelect").value = String(readerState.currentChapter);
  renderChapter(data.chapter, [...prepared.audios]);
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
  if (readerState.activeTtsPlaybackUrl) URL.revokeObjectURL(readerState.activeTtsPlaybackUrl);
  readerState.activeTtsPlaybackUrl = "";
  readerState.ttsPlaybackSegments = [];
}

async function fetchTtsAudio(index, token = readerState.ttsToken, scope = readerState.ttsScope) {
  const normalizedIndex = Number(index);
  if (!Number.isFinite(normalizedIndex) || normalizedIndex < 0 || normalizedIndex >= readerState.sentences.length) {
    throw new Error("没有可朗读文本");
  }
  if (token === readerState.ttsToken && scope === readerState.ttsScope && readerState.ttsUrls.has(normalizedIndex)) {
    return readerState.ttsUrls.get(normalizedIndex);
  }
  const pendingKey = `${scope}:${normalizedIndex}`;
  if (readerState.ttsPending.has(pendingKey)) {
    // Reuse an in-flight prefetch instead of spending a second MiMo request for the same sentence.
    const isCurrentSentence = Number(readerState.currentSentence) === normalizedIndex;
    if (token === readerState.ttsToken && scope === readerState.ttsScope && readerState.reading && isCurrentSentence) {
      setListenStatus("预加载尚未完成｜等待语音");
    }
    return readerState.ttsPending.get(pendingKey);
  }
  const text = sentenceText(normalizedIndex);
  if (!text || !hasReadableText(text)) throw new Error("没有可朗读文本");
  const isActiveCurrentSentence = () => (
    token === readerState.ttsToken
    && scope === readerState.ttsScope
    && readerState.reading
    && Number(readerState.currentSentence) === normalizedIndex
  );
  const pending = (async () => {
    if (isActiveCurrentSentence()) {
      setListenStatus("正在检查服务器音频缓存");
      try {
        const cacheStatus = await api("/api/reader/tts/cache", {
          method: "POST",
          body: JSON.stringify({ text }),
        });
        if (isActiveCurrentSentence()) {
          setListenStatus(cacheStatus.cached
            ? "服务器缓存命中｜读取音频中"
            : "服务器缓存未命中｜等待 MiMo 生成");
        }
      } catch {
        if (isActiveCurrentSentence()) setListenStatus("缓存状态检查失败，正在直接获取语音");
      }
    }
    return apiBlob(
      "/api/reader/tts",
      {
        method: "POST",
        body: JSON.stringify({ text }),
      },
      ({ cacheState, generateMs }) => {
        if (!isActiveCurrentSentence()) return;
        if (cacheState === "hit") {
          setListenStatus("服务器缓存命中｜读取音频中");
        } else {
          setListenStatus(`MiMo 生成 ${formatStageDuration(generateMs)}｜下载音频中`);
        }
      },
    );
  })().then(({ blob }) => {
    const url = URL.createObjectURL(blob);
    readerState.ttsPending.delete(pendingKey);
    if (scope !== readerState.ttsScope) {
      URL.revokeObjectURL(url);
      return "";
    }
    rememberTtsUrl(normalizedIndex, url, blob);
    return url;
  }).catch((error) => {
    readerState.ttsPending.delete(pendingKey);
    throw error;
  });
  readerState.ttsPending.set(pendingKey, pending);
  return pending;
}

async function prefetchUpcomingTtsAudio(index, token = readerState.ttsToken, scope = readerState.ttsScope) {
  const prefetches = ttsPrefetchIndexes(index);
  const budget = ttsPrefetchBudget(index);
  const nextChapterWindow = budget.maxItems * TTS_NEXT_CHAPTER_PREFETCH_MULTIPLIER;
  const remainingWindow = upcomingReadableSentenceIndexes(
    Number(index) + 1,
    nextChapterWindow + 1,
  );
  const shouldPrefetchNextChapter = remainingWindow.length <= nextChapterWindow;
  for (const nextIndex of prefetches) {
    if (token !== readerState.ttsToken || scope !== readerState.ttsScope || !readerState.reading) return;
    try {
      await fetchTtsAudio(nextIndex, token, scope);
    } catch {
      // Prefetch failures are retried normally when the sentence becomes current.
    }
  }
  if (token === readerState.ttsToken
    && scope === readerState.ttsScope
    && readerState.reading
    && shouldPrefetchNextChapter) {
    await prefetchNextChapterAudio(token, scope);
  }
}

function readableChapterSentences(chapter, limit = TTS_MERGED_AUDIO_MAX_ITEMS) {
  const sentences = [];
  for (const paragraph of chapter?.paragraphs || []) {
    if (paragraph?.type === "image") continue;
    for (const sentence of paragraph?.sentences || []) {
      if (!hasReadableText(sentence?.text)) continue;
      sentences.push(sentence);
      if (sentences.length >= limit) return sentences;
    }
  }
  return sentences;
}

async function extendNextChapterAudio(entry, prepared, token, scope) {
  if (!prepared
    || entry.adopted
    || token !== readerState.ttsToken
    || scope !== readerState.ttsScope
    || readerState.currentBookId !== entry.bookId
    || !readerState.reading) {
    return prepared;
  }
  const firstSentence = readableChapterSentences(prepared.data.chapter, 1)[0];
  if (!firstSentence) return prepared;
  const budget = ttsPrefetchBudgetForText(firstSentence.text, entry.playbackRate);
  const candidates = readableChapterSentences(prepared.data.chapter, budget.maxItems);
  let totalChars = prepared.audios.reduce((total, audio) => total + ttsTextLength(audio.text), 0);
  for (const sentence of candidates.slice(prepared.audios.length)) {
    if (token !== readerState.ttsToken
      || scope !== readerState.ttsScope
      || readerState.currentBookId !== entry.bookId
      || !readerState.reading) break;
    try {
      const { blob } = await apiBlob("/api/reader/tts", {
        method: "POST",
        body: JSON.stringify({ text: sentence.text }),
      });
      if (entry.adopted
        || token !== readerState.ttsToken
        || scope !== readerState.ttsScope
        || readerState.currentBookId !== entry.bookId
        || !readerState.reading) break;
      const wavInfo = await parseWavBlob(blob).catch(() => null);
      prepared.audios.push({ index: Number(sentence.index), text: sentence.text, blob, wavInfo });
      totalChars += ttsTextLength(sentence.text);
      if (prepared.audios.length >= budget.minItems && totalChars >= budget.targetChars) break;
    } catch {
      // The normal current-sentence request retries if chapter-boundary prefetch fails.
      break;
    }
  }
  return prepared;
}

function prefetchNextChapterAudio(token = readerState.ttsToken, scope = readerState.ttsScope) {
  const bookId = readerState.currentBookId;
  const chapterIndex = Number(readerState.currentChapter) + 1;
  const playbackRate = Math.max(1, Math.min(Number(readerState.playbackRate) || 1, 2));
  if (!bookId || chapterIndex >= readerState.chapters.length) return Promise.resolve(null);
  const existing = readerState.nextChapterPrefetch;
  if (existing
    && existing.bookId === bookId
    && existing.chapterIndex === chapterIndex
    && existing.scope === scope) {
    if (playbackRate > existing.playbackRate) {
      existing.playbackRate = playbackRate;
      existing.promise = existing.promise
        .then((prepared) => extendNextChapterAudio(existing, prepared, token, scope))
        .catch(() => null);
    }
    return existing.promise;
  }
  const entry = {
    bookId,
    chapterIndex,
    scope,
    playbackRate,
    adopted: false,
    prepared: null,
    readyPromise: null,
    promise: null,
  };
  entry.readyPromise = (async () => {
    const data = await api(`/api/books/${bookId}/chapters/${chapterIndex}`);
    const prepared = { data, audios: [] };
    entry.prepared = prepared;
    const firstSentence = readableChapterSentences(data.chapter, 1)[0];
    if (!firstSentence
      || token !== readerState.ttsToken
      || scope !== readerState.ttsScope
      || readerState.currentBookId !== bookId
      || !readerState.reading) return prepared;
    try {
      const { blob } = await apiBlob("/api/reader/tts", {
        method: "POST",
        body: JSON.stringify({ text: firstSentence.text }),
      });
      if (token !== readerState.ttsToken
        || scope !== readerState.ttsScope
        || readerState.currentBookId !== bookId
        || !readerState.reading) return prepared;
      const wavInfo = await parseWavBlob(blob).catch(() => null);
      prepared.audios.push({
        index: Number(firstSentence.index),
        text: firstSentence.text,
        blob,
        wavInfo,
      });
    } catch {
      // Normal playback retries the first sentence if this early request fails.
    }
    return prepared;
  })().catch(() => null);
  entry.promise = entry.readyPromise
    .then((prepared) => extendNextChapterAudio(entry, prepared, token, scope))
    .catch(() => null);
  readerState.nextChapterPrefetch = entry;
  return entry.promise;
}

function stopListening(resetStatus = true, clearTimer = true) {
  readerState.ttsToken += 1;
  readerState.reading = false;
  readerState.paused = false;
  if (clearTimer) clearSleepTimer(true);
  if (readerState.ttsAudio) {
    readerState.ttsAudio.pause();
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
  updateListenButtons();
  syncReaderWakeLock();
  await playSentence(nextReadableSentenceIndex(index), readerState.ttsToken);
}

async function playSentence(index, token = readerState.ttsToken) {
  if (!readerState.reading || token !== readerState.ttsToken) return;
  const readableIndex = nextReadableSentenceIndex(index);
  if (readableIndex < 0 || readableIndex >= readerState.sentences.length) {
    if (readerState.currentChapter + 1 < readerState.chapters.length) {
      setListenStatus("正在切换下一章");
      setMediaSessionPlaybackState("playing");
      try {
        await loadChapter(readerState.currentChapter + 1, 0);
        await playSentence(nextReadableSentenceIndex(0), token);
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
  setListenStatus(readerState.ttsUrls.has(Number(index)) ? "浏览器内存缓存命中，正在准备播放" : "正在准备检查服务器缓存");
  try {
    const url = await fetchTtsAudio(index, token, scope);
    if (!readerState.reading || token !== readerState.ttsToken || scope !== readerState.ttsScope) return;
    if (!url) return;
    prefetchUpcomingTtsAudio(index, token, scope);
    const playback = await prepareTtsPlayback(index, url, scope);
    if (!readerState.reading || token !== readerState.ttsToken || scope !== readerState.ttsScope) {
      if (playback.owned) URL.revokeObjectURL(playback.url);
      return;
    }
    if (playback.lastChapterIndex === Number(readerState.currentChapter)
      && playback.lastIndex !== Number(index)) {
      prefetchUpcomingTtsAudio(playback.lastIndex, token, scope);
    }
    const audio = readerState.ttsAudio || new Audio();
    audio.pause();
    audio.onplaying = null;
    audio.onended = null;
    audio.onerror = null;
    audio.ontimeupdate = null;
    releaseActiveTtsPlaybackUrl();
    readerState.activeTtsPlaybackUrl = playback.owned ? playback.url : "";
    readerState.ttsPlaybackSegments = playback.segments;
    if (readerState.sleepPausePending) readerState.sleepPauseTarget = null;
    audio.volume = 1;
    applyAudioPlaybackRate(audio);
    audio.src = playback.url;
    audio.preload = "auto";
    readerState.ttsAudio = audio;
    audio.onplaying = () => {
      if (token === readerState.ttsToken && scope === readerState.ttsScope) {
        applyAudioPlaybackRate(audio);
        setMediaSessionPlaybackState("playing");
        setListenStatus(`正在朗读：第 ${Number(index) + 1} 句`);
      }
    };
    audio.ontimeupdate = () => {
      if (token !== readerState.ttsToken || scope !== readerState.ttsScope) return;
      let sleepTarget = readerState.sleepPauseTarget;
      if (readerState.sleepPausePending && sleepTarget && Number.isFinite(sleepTarget.time)
        && audio.currentTime >= sleepTarget.time - 0.01) {
        if (Number(sleepTarget.chapterIndex) !== Number(readerState.currentChapter)
          && adoptPrefetchedChapterForPlayback(sleepTarget.chapterIndex)) {
          scope = readerState.ttsScope;
        }
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
      if (token !== readerState.ttsToken) return;
      if (Number(playback.lastChapterIndex) !== Number(readerState.currentChapter)
        && adoptPrefetchedChapterForPlayback(playback.lastChapterIndex)) {
        scope = readerState.ttsScope;
      }
      if (scope !== readerState.ttsScope) return;
      audio.volume = 1;
      if (readerState.sleepPausePending) {
        finishSleepPause(readerState.sleepPauseTarget?.index ?? playback.lastIndex);
        return;
      }
      playSentence(nextReadableSentenceIndex(Number(playback.lastIndex) + 1), token);
    };
    audio.onerror = () => {
      if (token === readerState.ttsToken && scope === readerState.ttsScope) {
        setListenStatus(audioErrorMessage(audio));
        stopListening(false);
      }
    };
    await waitForAudioReady(audio);
    if (!readerState.reading || token !== readerState.ttsToken || scope !== readerState.ttsScope) return;
    if (readerState.sleepPausePending && !readerState.sleepPauseTarget) setSleepPauseTargetForCurrentAudio();
    applyAudioPlaybackRate(audio);
    await audio.play();
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
  if (!readerState.reading) {
    await startListeningFrom(readerState.currentSentence);
    return;
  }
  if (!readerState.ttsAudio) return;
  if (readerState.paused) {
    readerState.paused = false;
    applyAudioPlaybackRate(readerState.ttsAudio);
    await readerState.ttsAudio.play();
    setMediaSessionPlaybackState("playing");
    setListenStatus("继续朗读");
  } else {
    readerState.paused = true;
    readerState.ttsAudio.pause();
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
  const savedPlaybackRate = window.localStorage.getItem("readerPlaybackRate");
  if (savedPlaybackRate && $("playbackRateSelect")) {
    $("playbackRateSelect").value = savedPlaybackRate;
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

function renderTtsCacheStats(stats = {}) {
  const node = $("ttsCacheStats");
  if (!node) return;
  const entries = Number(stats.entries || 0);
  const expired = Number(stats.expired_entries || 0);
  const expiredText = expired > 0 ? `，待清理 ${expired} 条` : "";
  node.textContent = `${entries} 条 · ${formatBytes(stats.size_bytes)} / ${formatBytes(stats.limit_bytes)} · 有效期 ${stats.ttl_days || 7} 天 · 最近 ${formatCacheTime(stats.newest_accessed_at)}${expiredText}`;
}

async function loadTtsConfig() {
  const data = await api("/api/reader/tts-config");
  readerState.ttsConfig = data.config;
  renderTtsConfig();
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
$("closeTtsBtn").addEventListener("click", () => $("ttsDialog").close());
$("closeSleepTimerBtn")?.addEventListener("click", () => $("sleepTimerDialog").close());
window.addEventListener("resize", resizeQuickVoiceSelect);
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
