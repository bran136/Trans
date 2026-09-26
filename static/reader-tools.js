/* Book search and editor handoff are separate from playback scheduling. */
(() => {
  const desktop = matchMedia('(hover: hover) and (pointer: fine)').matches
    && !/Android|iPhone|iPad|iPod/.test(navigator.userAgent)
    && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  document.body.classList.toggle('txt-desktop-enabled', desktop);
  let mode = 'toc', bookId = '', generation = 0, controller = null, timer = 0;
  let nextCursor = null, revision = '', query = '', seen = new Set();
  const dialog = $('chapterSelectDialog');
  const input = $('bookSearchInput');
  const status = $('bookSearchStatus');
  const results = $('bookSearchResults');
  function cancelSearch() {
    generation++;
    controller?.abort();
    controller = null;
    clearTimeout(timer);
    $('bookSearchProgress').hidden = true;
  }
  function markText(node, text, needle) {
    node.replaceChildren();
    if (!needle) { node.textContent = text; return; }
    let at = 0, scan = 0, match;
    const folded = text.toLowerCase(), word = needle.toLowerCase();
    const starts = [], ends = [];
    if (folded.length !== text.length) {
      let source = 0;
      for (const char of text) {
        for (let i = 0; i < char.toLowerCase().length; i++) {
          starts.push(source); ends.push(source + char.length);
        }
        source += char.length;
      }
    }
    while ((match = folded.indexOf(word, scan)) !== -1) {
      const start = starts.length ? starts[match] : match;
      const end = ends.length ? ends[match + word.length - 1] : match + word.length;
      scan = match + word.length;
      if (start < at) continue;
      node.append(document.createTextNode(text.slice(at, start)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(start, end);
      node.append(mark);
      at = end;
    }
    node.append(document.createTextNode(text.slice(at)));
  }
  function filterToc() {
    const needle = input.value.trim().toLocaleLowerCase();
    let count = 0;
    const chapters = new Map(readerState.chapters.map(c => [Number(c.index), c]));
    $('chapterSelectList').querySelectorAll('.chapter-select-option').forEach(button => {
      const chapter = chapters.get(Number(button.dataset.chapterIndex));
      const title = chapter?.title || button.textContent;
      const match = !needle || title.toLocaleLowerCase().includes(needle) || String(Number(button.dataset.chapterIndex) + 1) === needle;
      button.hidden = !match;
      if (match) count++;
      markText(button, title, input.value.trim());
    });
    status.textContent = needle ? (count ? `找到 ${count} 个章节` : '没有匹配的章节') : `${readerState.chapters.length} 个章节`;
  }
  function setMode(value) {
    cancelSearch();
    mode = value;
    $('searchTocTab').setAttribute('aria-pressed', String(mode === 'toc'));
    $('searchBodyTab').setAttribute('aria-pressed', String(mode === 'body'));
    input.placeholder = mode === 'toc' ? '搜索章节标题或序号' : '输入正文关键词，至少 2 个字符';
    $('bookSearchSubmit').hidden = mode !== 'body';
    $('chapterSelectList').hidden = mode !== 'toc';
    results.hidden = mode !== 'body';
    $('bookSearchMore').hidden = true;
    if (mode === 'toc') filterToc();
    else {
      results.replaceChildren(); nextCursor = null; seen = new Set();
      status.textContent = '输入关键词后搜索本书正文';
    }
  }
  function openSearch(value) {
    if (bookId !== readerState.currentBookId) {
      bookId = readerState.currentBookId;
      input.value = '';
      results.replaceChildren();
    }
    setMode(value);
  }
  $('chapterSelectBtn').addEventListener('click', () => openSearch('toc'));
  $('searchTocTab').addEventListener('click', () => setMode('toc'));
  $('searchBodyTab').addEventListener('click', () => setMode('body'));
  function handleSearchInput() {
    if (mode === 'toc') filterToc();
    else { cancelSearch(); results.replaceChildren(); nextCursor = null; $('bookSearchMore').hidden = true; status.textContent = '按回车或点击搜索'; }
  }
  input.addEventListener('input', event => { if (!event.isComposing) handleSearchInput(); });
  input.addEventListener('compositionend', handleSearchInput);
  dialog.addEventListener('close', cancelSearch);

  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, signal: controller?.signal,
      headers: { 'X-CSRF-Token': CSRF_TOKEN, ...options.headers } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '搜索失败，请重试');
    return data;
  }
  function addResults(items) {
    items.forEach(item => {
      const key = `${item.chapter}:${item.sentence}`;
      if (seen.has(key)) return;
      seen.add(key);
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'book-search-result';
      const title = document.createElement('strong');
      title.textContent = item.title;
      const excerpt = document.createElement('span');
      markText(excerpt, item.snippet, query);
      button.append(title, excerpt);
      const targetBook = bookId, targetQuery = query;
      button.addEventListener('click', async () => {
        if (readerState.currentBookId !== targetBook) return;
        dialog.close();
        stopListening(false, false);
        try {
          await loadChapter(item.chapter, item.sentence);
          if (readerState.currentBookId !== targetBook) return;
          const active = document.querySelector(`.reader-sentence[data-index="${item.sentence}"]`);
          const paragraph = active?.closest('.reader-paragraph');
          paragraph?.querySelectorAll('.reader-sentence').forEach(span => markText(span, span.textContent, targetQuery));
          active?.scrollIntoView({ block: 'center' });
        } catch (error) { setStatus(error.message); }
      });
      results.append(button);
    });
  }
  async function searchPage(cursor = 0, start = false) {
    const own = generation;
    controller = new AbortController();
    $('bookSearchProgress').hidden = false;
    $('bookSearchMore').hidden = true;
    status.textContent = cursor ? '正在加载更多结果…' : '正在搜索…';
    try {
      if (start) await request(`/api/books/${bookId}/search-index`, { method: 'POST' });
      if (own !== generation) return;
      const params = new URLSearchParams({ q: query, cursor, revision });
      const data = await request(`/api/books/${bookId}/search?${params}`);
      if (own !== generation || !dialog.open) return;
      if (data.status !== 'ready') {
        if (data.status === 'error') throw new Error(data.error);
        status.textContent = data.total ? `首次搜索，正在准备 ${data.completed} / ${data.total} 章…` : '首次搜索，正在准备正文…';
        timer = setTimeout(() => searchPage(0, true), 1500);
        return;
      }
      revision = data.revision;
      addResults(data.results);
      nextCursor = data.next_cursor;
      status.textContent = seen.size ? `已找到 ${seen.size} 个片段${nextCursor !== null ? '，可继续加载' : ''}` : '没有找到匹配内容';
      $('bookSearchMore').hidden = nextCursor === null;
      $('bookSearchProgress').hidden = true;
    } catch (error) {
      if (own !== generation || error.name === 'AbortError') return;
      status.textContent = error.message;
      $('bookSearchProgress').hidden = true;
    }
  }
  $('bookSearchForm').addEventListener('submit', event => {
    event.preventDefault();
    if (mode === 'toc') { filterToc(); return; }
    cancelSearch();
    query = input.value.trim();
    if (query.length < 2 || query.length > 80) { status.textContent = '请输入 2–80 个字符'; return; }
    results.replaceChildren(); seen = new Set(); nextCursor = null; revision = '';
    searchPage(0, true);
  });
  $('bookSearchMore').addEventListener('click', () => { if (nextCursor !== null) searchPage(nextCursor); });

  // The standalone editor notifies this browser's existing reader tabs.
  function latestEdit() { try { return localStorage.getItem('readerTextEdit') || ''; } catch { return ''; } }
  let lastEdit = latestEdit();
  async function refreshEditedBook() {
    const value = latestEdit();
    if (!value || value === lastEdit) return;
    lastEdit = value;
    try {
      const update = JSON.parse(value);
      if (!update.bookId) return;
      cancelSearch();
      if (bookId === update.bookId) {
        if (dialog.open) dialog.close();
        results.replaceChildren(); bookId = ''; nextCursor = null;
      }
      if (readerState.offlineDownloadController?.bookId === update.bookId) readerState.offlineDownloadController.controller.abort();
      if (readerState.currentBookId === update.bookId) {
        stopListening(false);
        clearTimeout(readerState.saveTimer);
      }
      if (readerState.currentBookId === update.bookId) {
        const data = await api(`/api/books/${update.bookId}?inspect=1`);
        if (readerState.currentBookId === update.bookId) await openBook(update.bookId, data.book.progress?.chapter || 0, 0, false);
      } else {
        try {
          await deleteLocalOfflineBook(update.bookId);
          if (update.contentRevision) localStorage.setItem(`readerContentRevision:${update.bookId}`, update.contentRevision);
        } catch { /* Retry when the book is next opened. */ }
      }
      await loadBooks();
    } catch (error) { setStatus(error.message); }
  }
  window.addEventListener('storage', event => { if (event.key === 'readerTextEdit') refreshEditedBook(); });
  window.addEventListener('pageshow', refreshEditedBook);
})();
