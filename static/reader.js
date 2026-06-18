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
  sleepTimerId: null,
  sleepCountdownId: null,
  sleepDeadline: 0,
  sleepPausePending: false,
  sleepFadeStarted: false,
};

const $ = (id) => document.getElementById(id);
const TTS_BROWSER_CACHE_LIMIT = 12;
const TTS_BROWSER_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const TTS_PREFETCH_MIN_ITEMS = 2;
const TTS_PREFETCH_MAX_ITEMS = 5;
const FONT_OPTIONS = [
  { id: "system", name: "系统字体", family: '"Microsoft YaHei", "微软雅黑", Arial, sans-serif' },
  { id: "jason", name: "清松手写体", family: '"ReaderJasonHandwriting", "Microsoft YaHei", sans-serif' },
  { id: "source-serif", name: "思源宋体", family: '"ReaderSourceHanSerif", SimSun, "宋体", serif' },
  { id: "source-sans", name: "思源黑体", family: '"ReaderSourceHanSans", "Microsoft YaHei", sans-serif' },
  { id: "lxgw-wenkai", name: "霞鹜文楷", family: '"ReaderLXGWWenKai", KaiTi, "楷体", serif' },
  { id: "song", name: "宋体", family: 'SimSun, "宋体", serif' },
  { id: "hei", name: "黑体", family: 'SimHei, "黑体", "Microsoft YaHei", sans-serif' },
  { id: "kai", name: "楷体", family: 'KaiTi, "楷体", serif' },
  { id: "serif", name: "衬线", family: 'Georgia, "Times New Roman", SimSun, serif' },
];
const FONT_FAMILIES = Object.fromEntries(FONT_OPTIONS.map((font) => [font.id, font.family]));

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

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `请求失败：${response.status}`);
  }
  return response.json();
}

async function apiBlob(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `请求失败：${response.status}`);
  }
  return {
    blob: await response.blob(),
    cacheState: response.headers.get("X-TTS-Cache") || "",
  };
}

function uploadWithProgress(path, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
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
  const serverActiveJobs = readerState.importJobs.filter((job) => ["uploading", "parsing"].includes(job.status));
  const serverIds = new Set(serverActiveJobs.map((job) => job.id));
  const localActive = readerState.localImportJobs.filter((job) => (
    ["uploading", "parsing"].includes(job.status) && (!job.server_id || !serverIds.has(job.server_id))
  )).length;
  const serverActive = serverActiveJobs.length;
  return serverActive + localActive;
}

function statusText(job) {
  if (job.status === "done") return "导入完成";
  if (job.status === "error") return job.error || "导入失败";
  if (job.status === "uploading") return "正在上传";
  return "正在解析";
}

function renderImportJobs() {
  const list = $("importJobs");
  const now = Date.now() / 1000;
  const shouldShowJob = (job) => {
    const age = now - Number(job.updated_at || 0);
    if (["uploading", "parsing"].includes(job.status)) return true;
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
        <button type="button" data-action="rename">编辑</button>
        <button type="button" data-action="reparse">重新解析</button>
        <button type="button" data-action="delete">删除</button>
      </div>
    `;
    row.querySelector('[data-action="rename"]').addEventListener("click", () => renameBook(book));
    row.querySelector('[data-action="reparse"]').addEventListener("click", () => reparseBook(book));
    row.querySelector('[data-action="clear-toc"]')?.addEventListener("click", () => clearBookToc(book));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => deleteBook(book));
    list.appendChild(row);
  });
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
    updated_at: Date.now() / 1000,
  });
  renderImportJobs();
  drop.classList.add("loading");
  setStatus("正在导入");
  showUploadProgress(0);
  setUploadMessage(`正在上传：${file.name}`);
  try {
    const data = await uploadWithProgress("/api/books", form, (percent) => {
      showUploadProgress(percent);
      setUploadMessage(percent >= 100 ? "上传完成，正在解析书本" : `正在上传：${percent}%`);
      if (percent >= 100) showUploadParsing();
    });
    showUploadParsing();
    fileInput.value = "";
    $("selectedFileName").textContent = "TXT / EPUB / PDF，最大 50MB";
    if (data.job) {
      readerState.localImportJobs = readerState.localImportJobs.map((job) => (
        job.id === localJobId ? { ...job, status: "parsing", server_id: data.job.id, updated_at: Date.now() / 1000 } : job
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
      await loadChapter(chapter.index, 0);
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
        focusSentence(sentence.index, false);
      });
      span.addEventListener("dblclick", (event) => {
        event.currentTarget.blur?.();
        focusSentence(sentence.index, true);
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

function focusSentence(index, read = false) {
  highlightSentence(index, true);
  saveProgressSoon();
  if (read) startListeningFrom(index).catch((error) => setListenStatus(error.message));
}

function highlightSentence(index, scroll = false) {
  readerState.currentSentence = Math.max(0, Math.min(Number(index) || 0, Math.max(readerState.sentences.length - 1, 0)));
  document.querySelectorAll(".reader-sentence.active").forEach((item) => item.classList.remove("active"));
  const active = document.querySelector(`.reader-sentence[data-index="${readerState.currentSentence}"]`);
  if (active) {
    active.classList.add("active");
    if (scroll) active.scrollIntoView({ block: "center", behavior: "smooth" });
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
  if (status) status.textContent = text || "点击句子可从该句开始读";
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
  for (let index = Math.max(0, Number(startIndex) || 0); index < readerState.sentences.length; index += 1) {
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
  if (readerState.ttsPending.has(pendingKey)) return readerState.ttsPending.get(pendingKey);
  const text = sentenceText(normalizedIndex);
  if (!text || !hasReadableText(text)) throw new Error("没有可朗读文本");
  const pending = apiBlob("/api/reader/tts", {
    method: "POST",
    body: JSON.stringify({ text }),
  }).then(({ blob, cacheState }) => {
    const url = URL.createObjectURL(blob);
    readerState.ttsPending.delete(pendingKey);
    if (scope !== readerState.ttsScope) {
      URL.revokeObjectURL(url);
      return "";
    }
    if (token === readerState.ttsToken && readerState.reading && cacheState === "hit") {
      setListenStatus("正在读取缓存");
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

function prefetchUpcomingTtsAudio(index, token = readerState.ttsToken, scope = readerState.ttsScope) {
  const prefetches = ttsPrefetchIndexes(index);
  prefetches.forEach((nextIndex) => {
    fetchTtsAudio(nextIndex, token, scope).catch(() => {});
  });
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
  setListenStatus(readerState.ttsUrls.has(Number(index)) ? "正在读取缓存" : "正在准备语音");
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
}

async function moveChapter(delta) {
  const next = readerState.currentChapter + delta;
  if (next < 0 || next >= readerState.chapters.length) {
    return;
  }
  stopListening(false);
  await loadChapter(next, 0);
}

function updateReaderFont() {
  const value = $("fontInput").value;
  $("fontValue").textContent = value;
  $("bookContent").style.setProperty("--reader-font-size", `${value}px`);
  window.localStorage.setItem("readerFontSize", value);
}

function updateReaderFontFamily() {
  const active = document.querySelector(".font-option.active");
  const value = active?.dataset.font || "system";
  $("bookContent").style.setProperty("--reader-font-family", FONT_FAMILIES[value] || FONT_FAMILIES.system);
  window.localStorage.setItem("readerFontFamily", value);
  document.querySelectorAll(".font-option").forEach((button) => {
    button.classList.toggle("active", button.dataset.font === value);
  });
}

function applyReaderTheme(value) {
  const dark = value === "dark";
  document.body.classList.toggle("reader-dark", dark);
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
  FONT_OPTIONS.forEach((font) => {
    const button = document.createElement("button");
    button.className = "font-option";
    button.type = "button";
    button.dataset.font = font.id;
    button.style.fontFamily = font.family;
    button.textContent = font.name;
    button.addEventListener("pointerenter", () => {
      document.querySelectorAll(".font-option").forEach((item) => item.classList.remove("is-hovered"));
      button.classList.add("is-hovered");
    });
    button.addEventListener("pointerleave", () => button.classList.remove("is-hovered"));
    button.addEventListener("pointercancel", () => button.classList.remove("is-hovered"));
    button.addEventListener("click", () => {
      document.querySelectorAll(".font-option").forEach((item) => item.classList.remove("active", "is-hovered"));
      button.classList.add("active");
      button.blur();
      updateReaderFontFamily();
    });
    picker.appendChild(button);
  });
}

function restoreReaderSettings() {
  const savedSize = window.localStorage.getItem("readerFontSize");
  if (savedSize) $("fontInput").value = savedSize;
  renderFontPicker();
  const savedFamily = window.localStorage.getItem("readerFontFamily");
  const fontId = FONT_FAMILIES[savedFamily] ? savedFamily : "system";
  const activeFont = document.querySelector(`.font-option[data-font="${fontId}"]`);
  if (activeFont) activeFont.classList.add("active");
  applyReaderTheme(window.localStorage.getItem("readerTheme") === "dark" ? "dark" : "light");
  const savedPlaybackRate = window.localStorage.getItem("readerPlaybackRate");
  if (savedPlaybackRate && $("playbackRateSelect")) {
    $("playbackRateSelect").value = savedPlaybackRate;
  }
  updatePlaybackRate();
  updateReaderFont();
  updateReaderFontFamily();
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
  $("ttsBaseUrl").title = config.allow_custom_base_url
    ? "可在服务器 .env 中关闭自定义地址"
    : "服务器 .env 中 ALLOW_CUSTOM_MIMO_BASE_URL=false，前端不可修改";
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
  stopListening(false);
  loadChapter(Number($("chapterSelect").value), 0);
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
  document.querySelectorAll(".font-option").forEach((item) => item.classList.remove("is-hovered"));
  openReaderDialog($("settingsDialog"));
});
$("closeManageBtn").addEventListener("click", () => $("manageDialog").close());
$("closeTocBtn").addEventListener("click", () => $("tocDialog").close());
$("closeSettingsBtn").addEventListener("click", () => $("settingsDialog").close());
$("closeTtsBtn").addEventListener("click", () => $("ttsDialog").close());
$("closeSleepTimerBtn")?.addEventListener("click", () => $("sleepTimerDialog").close());
window.addEventListener("resize", resizeQuickVoiceSelect);
document.querySelectorAll(".reader-dialog").forEach((dialog) => {
  dialog.addEventListener("close", unlockReaderScroll);
  dialog.addEventListener("cancel", () => window.setTimeout(unlockReaderScroll, 0));
});
$("logoutBtn").addEventListener("click", async () => {
  await api("/logout", { method: "POST", body: "{}" });
  window.location.href = "/login";
});

restoreReaderSettings();
Promise.all([loadBooks(), loadImportJobs(), loadTtsConfig()]).catch((error) => setStatus(error.message));
