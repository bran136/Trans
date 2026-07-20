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
  ttsUrlSizes: new Map(),
  ttsUrlOrder: [],
  ttsPending: new Map(),
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
  wakeLock: null,
  wakeLockWanted: false,
  mimoBalance: null,
  mimoBalanceError: "",
  mimoBalanceLoadedAt: 0,
  mimoBalanceRetryAt: 0,
  mimoBalanceTimer: null,
  mimoBalanceRetryTimer: null,
  mimoBalanceCountdownTimer: null,
  tocEditBookId: "",
  tocEditBook: null,
  tocEditChapters: [],
  tocLineChapter: null,
  tocLineRows: [],
};

const $ = (id) => document.getElementById(id);
const CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')?.content || "";
const TTS_BROWSER_CACHE_LIMIT = 12;
const TTS_BROWSER_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const TTS_PREFETCH_MIN_ITEMS = 2;
const TTS_PREFETCH_MAX_ITEMS = 5;
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
const FONT_LOAD_PROBE = "霞鹜文楷 天地玄黄 ABC 123";
const FONT_CACHE_NAME = "reader-font-assets-v1";
const fontLoadPromises = new Map();
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

async function loadBooks() {
  const data = await api("/api/books");
  readerState.books = data.books || [];
  renderBooks();
}

function renderBooks() {
  $("bookCount").textContent = `${readerState.books.length} 本`;
  renderBookList($("bookList"));
  renderManageBooks();
}

function renderBookList(list) {
  list.innerHTML = "";
  if (!readerState.books.length) {
    list.innerHTML = '<div class="book-item"><strong>暂无书籍</strong><span>导入 TXT、EPUB 或 PDF</span></div>';
    return;
  }
  const shelfBooks = [...readerState.books].sort((a, b) => (
    Number(b.last_opened_at || b.updated_at || b.created_at || 0) - Number(a.last_opened_at || a.updated_at || a.created_at || 0)
  ));
  shelfBooks.forEach((book) => {
    const button = document.createElement("button");
    button.className = `book-item ${book.id === readerState.currentBookId ? "active" : ""}`;
    button.type = "button";
    button.innerHTML = `
      ${book.cover_url ? `<span class="book-cover" style="background-image: url('${escapeAttribute(book.cover_url)}')"></span>` : ""}
      <strong>${escapeHtml(book.title)}</strong>
      <span>${escapeHtml(book.author || book.format.toUpperCase())} · ${formatProgress(book)}</span>
    `;
    button.addEventListener("click", async () => {
      await openBook(book.id, book.progress?.chapter || 0, book.progress?.sentence || 0);
    });
    list.appendChild(button);
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
    const row = document.createElement("div");
    row.className = "manage-book-row";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(book.title)}</strong>
        <span>${escapeHtml(book.author || book.format.toUpperCase())} · ${formatProgress(book)}</span>
      </div>
      <div class="manage-book-actions">
        ${book.format === "txt" ? '<button type="button" data-action="clear-toc">清除目录</button>' : '<span class="manage-action-spacer"></span>'}
        ${book.format === "txt" ? '<button type="button" data-action="toc-edit">目录</button>' : '<span class="manage-action-spacer"></span>'}
        <button type="button" data-action="rename">编辑</button>
        <button type="button" data-action="reparse">重新解析</button>
        <button type="button" data-action="delete">删除</button>
      </div>
    `;
    row.querySelector('[data-action="rename"]').addEventListener("click", () => renameBook(book));
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
  if (book.format !== "txt") return;
  readerState.tocEditBookId = book.id;
  readerState.tocEditBook = book;
  readerState.tocEditChapters = [];
  showTocEditMessage("正在加载目录");
  openReaderDialog($("tocEditDialog"));
  await refreshTocEditor(book.id);
}

async function refreshTocEditor(bookId = readerState.tocEditBookId) {
  if (!bookId) return;
  const data = await api(`/api/books/${bookId}`);
  readerState.tocEditBook = data.book;
  readerState.tocEditChapters = data.chapters || [];
  readerState.books = readerState.books.map((book) => (book.id === data.book.id ? data.book : book));
  renderBooks();
  renderTocEditor();
  showTocEditMessage("");
}

function renderTocEditor() {
  const list = $("tocEditList");
  const chapters = readerState.tocEditChapters || [];
  if (!chapters.length) {
    list.innerHTML = '<div class="manage-empty">没有目录</div>';
    return;
  }
  list.innerHTML = "";
  chapters.forEach((chapter) => {
    const row = document.createElement("div");
    row.className = "toc-edit-row";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(chapter.title)}</strong>
        <span>第 ${Number(chapter.index) + 1} 章 · ${Number(chapter.char_count || 0)} 字</span>
      </div>
      <div class="toc-edit-actions">
        <button type="button" data-action="rename">改名</button>
        <button type="button" data-action="split">添加</button>
        <button type="button" data-action="delete">删除</button>
      </div>
    `;
    row.querySelector('[data-action="rename"]').addEventListener("click", () => renameTxtChapter(chapter));
    row.querySelector('[data-action="split"]').addEventListener("click", () => openTocLineChooser(chapter));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => deleteTxtChapterTitle(chapter));
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

async function renameBook(book) {
  const title = window.prompt("请输入新的书名", book.title || "");
  if (title === null) return;
  const trimmed = title.trim();
  if (!trimmed) {
    setUploadMessage("书名不能为空", "error");
    return;
  }
  try {
    const data = await api(`/api/books/${book.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: trimmed }),
    });
    readerState.books = readerState.books.map((item) => (item.id === book.id ? data.book : item));
    if (readerState.currentBookId === book.id && readerState.currentBook) {
      readerState.currentBook.title = data.book.title;
      setStatus(data.book.title);
    }
    renderBooks();
    setUploadMessage("书名已更新", "success");
  } catch (error) {
    setUploadMessage(error.message, "error");
  }
}

async function deleteBook(book) {
  const confirmed = window.confirm(`确定删除《${book.title || "未命名书籍"}》吗？`);
  if (!confirmed) return;
  try {
    await api(`/api/books/${book.id}`, { method: "DELETE" });
    if (readerState.currentBookId === book.id) {
      showShelfView();
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

async function openBook(bookId, chapter = 0, sentence = 0) {
  stopListening(false);
  readerState.currentBookId = bookId;
  const data = await api(`/api/books/${bookId}`);
  readerState.currentBook = data.book;
  readerState.chapters = data.chapters || [];
  renderBooks();
  renderToc();
  renderChapterSelect();
  showReadingView();
  await loadChapter(chapter, sentence);
}

function showReadingView() {
  $("shelfView").hidden = true;
  $("readingView").hidden = false;
}

function showShelfView() {
  stopListening(false);
  $("readingView").hidden = true;
  $("shelfView").hidden = false;
  readerState.currentBookId = "";
  readerState.currentBook = null;
  renderBooks();
  setStatus("本地书架");
}

function renderToc() {
  const list = $("tocList");
  list.innerHTML = "";
  readerState.chapters.forEach((chapter) => {
    const button = document.createElement("button");
    const level = Math.max(1, Math.min(Number(chapter.level || 1), 4));
    button.className = `toc-item level-${level} ${chapter.index === readerState.currentChapter ? "active" : ""}`;
    button.type = "button";
    button.textContent = chapter.title;
    button.addEventListener("click", async () => {
      const shouldResume = readerState.reading && !readerState.paused;
      stopListening(false, false);
      await loadChapter(chapter.index, 0);
      if (shouldResume) await startListeningFrom(0);
      if ($("tocDialog").open) $("tocDialog").close();
    });
    list.appendChild(button);
  });
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
  const data = await api(`/api/books/${readerState.currentBookId}/chapters/${chapterIndex}`);
  readerState.currentBook = data.book;
  readerState.currentChapter = data.chapter.index;
  readerState.currentSentence = sentenceIndex;
  $("chapterSelect").value = String(readerState.currentChapter);
  renderChapter(data.chapter);
  renderToc();
  highlightSentence(sentenceIndex, true);
  saveProgressSoon();
  setStatus(readerState.currentBook.title);
}

function renderChapter(chapter) {
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
  readerState.saveTimer = window.setTimeout(saveProgress, 350);
}

async function saveProgress() {
  if (!readerState.currentBookId) return;
  try {
    await api(`/api/books/${readerState.currentBookId}/progress`, {
      method: "PUT",
      body: JSON.stringify({
        chapter: readerState.currentChapter,
        sentence: readerState.currentSentence,
      }),
    });
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

function updatePlaybackRate() {
  readerState.playbackRate = Number($("playbackRateSelect").value) || 1;
  window.localStorage.setItem("readerPlaybackRate", String(readerState.playbackRate));
  if (readerState.ttsAudio) readerState.ttsAudio.playbackRate = readerState.playbackRate;
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

function startSleepFadeIfNeeded(audio) {
  if (!readerState.sleepPausePending || readerState.sleepFadeStarted || !audio || !Number.isFinite(audio.duration)) return;
  const remaining = audio.duration - audio.currentTime;
  if (remaining > 3.2) return;
  readerState.sleepFadeStarted = true;
  const fadeStart = Math.max(0.1, remaining);
  const fadeStartTime = audio.currentTime;
  const tick = () => {
    if (!readerState.sleepPausePending || audio.paused || audio.ended) return;
    const elapsed = Math.max(0, audio.currentTime - fadeStartTime);
    audio.volume = Math.max(0.05, 1 - elapsed / fadeStart);
    if (audio.volume > 0.05) window.requestAnimationFrame(tick);
  };
  tick();
}

function finishSleepPause(index) {
  const nextIndex = nextReadableSentenceIndex(Number(index) + 1);
  if (nextIndex >= 0) highlightSentence(nextIndex, false);
  readerState.reading = false;
  readerState.paused = false;
  readerState.sleepPausePending = false;
  readerState.sleepFadeStarted = false;
  if (readerState.ttsAudio) readerState.ttsAudio.volume = 1;
  clearSleepTimer(false);
  updateListenButtons();
  syncReaderWakeLock();
  setListenStatus("定时已暂停");
}

function clearTtsBrowserCache() {
  readerState.ttsScope += 1;
  readerState.ttsPending.clear();
  readerState.ttsUrls.forEach((url) => URL.revokeObjectURL(url));
  readerState.ttsUrls.clear();
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

function ttsPrefetchBudget(currentIndex) {
  const length = ttsTextLength(sentenceText(currentIndex));
  if (length <= 35) return { targetChars: 360, maxItems: 5 };
  if (length <= 90) return { targetChars: 280, maxItems: 4 };
  return { targetChars: 180, maxItems: 3 };
}

function ttsPrefetchIndexes(currentIndex) {
  const indexes = [];
  let totalChars = 0;
  const budget = ttsPrefetchBudget(currentIndex);
  for (const index of upcomingReadableSentenceIndexes(Number(currentIndex) + 1, budget.maxItems)) {
    indexes.push(index);
    totalChars += ttsTextLength(sentenceText(index));
    if (indexes.length >= TTS_PREFETCH_MIN_ITEMS && totalChars >= budget.targetChars) break;
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
    readerState.ttsUrlSizes.delete(staleIndex);
  }
}

function rememberTtsUrl(index, url, size = 0) {
  const normalizedIndex = Number(index);
  const existing = readerState.ttsUrls.get(normalizedIndex);
  if (existing && existing !== url) URL.revokeObjectURL(existing);
  readerState.ttsUrls.set(normalizedIndex, url);
  readerState.ttsUrlSizes.set(normalizedIndex, Number(size) || 0);
  readerState.ttsUrlOrder = readerState.ttsUrlOrder.filter((item) => Number(item) !== normalizedIndex);
  readerState.ttsUrlOrder.push(normalizedIndex);
  trimTtsBrowserCache([readerState.currentSentence, ...upcomingReadableSentenceIndexes(readerState.currentSentence + 1, TTS_BROWSER_CACHE_LIMIT - 1)]);
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
    rememberTtsUrl(normalizedIndex, url, blob.size);
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
  for (const nextIndex of prefetches) {
    if (token !== readerState.ttsToken || scope !== readerState.ttsScope || !readerState.reading) return;
    try {
      await fetchTtsAudio(nextIndex, token, scope);
    } catch {
      // Prefetch failures are retried normally when the sentence becomes current.
    }
  }
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
  updateListenButtons();
  syncReaderWakeLock();
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
      await loadChapter(readerState.currentChapter + 1, 0);
      await playSentence(nextReadableSentenceIndex(0), token);
      return;
    }
    stopListening(false);
    setListenStatus("本书朗读完成");
    return;
  }
  index = readableIndex;
  highlightSentence(index, true);
  const scope = readerState.ttsScope;
  saveProgressSoon();
  setListenStatus(readerState.ttsUrls.has(Number(index)) ? "浏览器内存缓存命中，正在准备播放" : "正在准备检查服务器缓存");
  try {
    const url = await fetchTtsAudio(index, token, scope);
    if (!readerState.reading || token !== readerState.ttsToken || scope !== readerState.ttsScope) return;
    if (!url) return;
    prefetchUpcomingTtsAudio(index, token, scope);
    const audio = readerState.ttsAudio || new Audio();
    audio.pause();
    audio.onplaying = null;
    audio.onended = null;
    audio.onerror = null;
    audio.ontimeupdate = null;
    audio.volume = 1;
    audio.src = url;
    audio.preload = "auto";
    audio.playbackRate = readerState.playbackRate;
    readerState.ttsAudio = audio;
    audio.onplaying = () => {
      if (token === readerState.ttsToken && scope === readerState.ttsScope) {
        setListenStatus(`正在朗读：第 ${Number(index) + 1} 句`);
      }
    };
    audio.ontimeupdate = () => {
      if (token === readerState.ttsToken && scope === readerState.ttsScope) startSleepFadeIfNeeded(audio);
    };
    audio.onended = () => {
      if (token !== readerState.ttsToken || scope !== readerState.ttsScope) return;
      audio.volume = 1;
      if (readerState.sleepPausePending) {
        finishSleepPause(index);
        return;
      }
      playSentence(nextReadableSentenceIndex(Number(index) + 1), token);
    };
    audio.onerror = () => {
      if (token === readerState.ttsToken && scope === readerState.ttsScope) {
        setListenStatus(audioErrorMessage(audio));
        stopListening(false);
      }
    };
    await waitForAudioReady(audio);
    if (!readerState.reading || token !== readerState.ttsToken || scope !== readerState.ttsScope) return;
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
    await readerState.ttsAudio.play();
    setListenStatus("继续朗读");
  } else {
    readerState.paused = true;
    readerState.ttsAudio.pause();
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

async function locallyCachedFontResponse(fontId) {
  const url = FONT_ASSET_URLS[fontId];
  if (!url) return null;
  const cache = await openReaderFontCache();
  if (cache) {
    const stored = await cache.match(url).catch(() => null);
    if (stored?.ok) return stored;
  }
  try {
    const response = await fetch(url, {
      cache: "only-if-cached",
      credentials: "same-origin",
      mode: "same-origin",
    });
    if (!response.ok) return null;
    if (cache) await cache.put(url, response.clone()).catch(() => {});
    return response;
  } catch {
    return null;
  }
}

async function persistReaderFontAsset(fontId) {
  const url = FONT_ASSET_URLS[fontId];
  const cache = await openReaderFontCache();
  if (!url || !cache) return;
  try {
    const response = await fetch(url, {
      cache: "force-cache",
      credentials: "same-origin",
      mode: "same-origin",
    });
    if (response.ok) await cache.put(url, response.clone());
  } catch {
    // The loaded font remains usable even if persistent browser storage is unavailable.
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
    return face.status === "loaded";
  } catch {
    return false;
  }
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

async function loadFreshReaderFontFace(fontId) {
  const webFamily = FONT_WEB_FAMILIES[fontId];
  const url = FONT_ASSET_URLS[fontId];
  if (typeof FontFace !== "function" || !document.fonts?.add || !url) {
    const faces = await document.fonts.load(`400 18px "${webFamily}"`, FONT_LOAD_PROBE);
    return faces.length > 0;
  }
  const face = new FontFace(webFamily, `url("${url}") format("woff2")`, {
    style: "normal",
    weight: "400",
  });
  document.fonts.add(face);
  try {
    await face.load();
    return face.status === "loaded";
  } catch {
    document.fonts.delete?.(face);
    return false;
  }
}

async function ensureReaderFontLoaded(fontId, forceRetry = false) {
  const webFamily = FONT_WEB_FAMILIES[fontId];
  if (!webFamily) return true;
  if (!document.fonts?.load) {
    setFontLoadState(fontId, "ready");
    return true;
  }
  if (document.fonts.check(`400 18px "${webFamily}"`, FONT_LOAD_PROBE)) {
    await persistReaderFontAsset(fontId);
    setFontLoadState(fontId, "ready");
    return true;
  }
  if (!fontLoadPromises.has(fontId)) {
    setFontLoadState(fontId, "loading");
    const loadPromise = (forceRetry
      ? waitForFontStatusPaint().then(() => loadFreshReaderFontFace(fontId))
      : document.fonts.load(`400 18px "${webFamily}"`, FONT_LOAD_PROBE).then((faces) => faces.length > 0))
      .catch(() => false)
      .finally(() => fontLoadPromises.delete(fontId));
    fontLoadPromises.set(fontId, loadPromise);
  }
  const loaded = await fontLoadPromises.get(fontId);
  if (loaded) await persistReaderFontAsset(fontId);
  setFontLoadState(fontId, loaded ? "ready" : "failed");
  return loaded;
}

async function activateCachedReaderFont(fontId) {
  const webFamily = FONT_WEB_FAMILIES[fontId];
  if (!webFamily) return true;
  if (document.fonts?.check?.(`400 18px "${webFamily}"`, FONT_LOAD_PROBE)) {
    setFontLoadState(fontId, "ready");
    return true;
  }
  if (fontLoadPromises.has(fontId)) return ensureReaderFontLoaded(fontId);
  const cachedResponse = await locallyCachedFontResponse(fontId);
  if (!cachedResponse) {
    const status = document.querySelector(`.font-load-status[data-font="${fontId}"]`);
    if (status?.dataset.state !== "loading") setFontLoadState(fontId, "idle");
    return false;
  }
  setFontLoadState(fontId, "loading");
  const loaded = await loadReaderFontFromResponse(fontId, cachedResponse);
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
  document.documentElement.classList.toggle("reader-dark-root", dark);
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
      const loaded = document.fonts?.check?.(`400 18px "${FONT_WEB_FAMILIES[font.id]}"`, FONT_LOAD_PROBE);
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
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function formatMimoBalance() {
  const balance = readerState.mimoBalance;
  if (!ttsReady()) return "";
  if (!balance) {
    const reason = readerState.mimoBalanceError || "查询失败";
    const retryLeft = Math.max(0, Math.ceil((readerState.mimoBalanceRetryAt - Date.now()) / 1000));
    return retryLeft > 0
      ? `MiMo 余额：${reason}，${retryLeft} 秒后重试`
      : `MiMo 余额：${reason}，正在重试`;
  }
  if (!balance.total_balance || !balance.currency) return "MiMo 余额：未知";
  const symbol = balance.currency === "CNY" ? "¥" : `${balance.currency} `;
  return `MiMo 余额：${symbol}${balance.total_balance} · ${formatBalanceTime(balance.updated_at)}`;
}

function renderMimoBalance() {
  const node = $("mimoBalance");
  if (!node) return;
  node.textContent = formatMimoBalance();
  node.hidden = !ttsReady();
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

async function loadMimoBalance() {
  if (document.hidden || !ttsReady()) return;
  window.clearTimeout(readerState.mimoBalanceRetryTimer);
  readerState.mimoBalanceRetryAt = 0;
  stopMimoBalanceCountdown();
  try {
    const data = await api("/api/reader/mimo-balance");
    readerState.mimoBalance = data.balance;
    readerState.mimoBalanceError = "";
    readerState.mimoBalanceLoadedAt = Date.now();
  } catch (error) {
    readerState.mimoBalance = null;
    readerState.mimoBalanceError = error.message || "查询失败";
    readerState.mimoBalanceRetryAt = Date.now() + 15 * 1000;
    readerState.mimoBalanceRetryTimer = window.setTimeout(loadMimoBalance, 15 * 1000);
    startMimoBalanceCountdown();
  }
  renderMimoBalance();
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
  loadMimoBalance();
  readerState.mimoBalanceTimer = window.setInterval(loadMimoBalance, 15 * 60 * 1000);
}

function refreshMimoBalanceWhenVisible() {
  if (document.hidden || !ttsReady()) return;
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
  $("ttsBalanceCookie").value = "";
  $("ttsBalanceCookie").placeholder = config.balance_cookie_configured ? "已配置，留空不修改" : "未配置，粘贴 platform.xiaomimimo.com 的 Cookie";
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
    balance_cookie: $("ttsBalanceCookie")?.value || "",
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

async function clearMimoBalanceCookie() {
  if (!window.confirm("确定清空已保存的 MiMo 余额 Cookie？清空后余额可能无法查询。")) return;
  const button = $("ttsClearBalanceCookieBtn");
  if (button) button.disabled = true;
  try {
    showTtsConfigMessage("正在清空余额 Cookie");
    const data = await api("/api/reader/tts-config", {
      method: "PUT",
      body: JSON.stringify(ttsConfigPayload({ balance_cookie: "", clear_balance_cookie: true })),
    });
    readerState.ttsConfig = data.config;
    readerState.mimoBalance = null;
    renderTtsConfig();
    showTtsConfigMessage("余额 Cookie 已清空", "success");
  } catch (error) {
    showTtsConfigMessage(error.message, "error");
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
$("ttsClearBalanceCookieBtn")?.addEventListener("click", () => clearMimoBalanceCookie());
$("ttsModel").addEventListener("change", () => renderTtsVoiceOptions());
$("shelfBtn").addEventListener("click", showShelfView);
$("manageBtn").addEventListener("click", () => {
  renderManageBooks();
  openReaderDialog($("manageDialog"));
});
$("tocBtn").addEventListener("click", () => {
  if (readerState.currentBook) openReaderDialog($("tocDialog"));
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
$("closeTocBtn").addEventListener("click", () => $("tocDialog").close());
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
pruneStoredReaderFonts();
Promise.all([loadBooks(), loadImportJobs(), loadTtsConfig()]).catch((error) => setStatus(error.message));
