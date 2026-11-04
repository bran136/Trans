/* Book search and editor handoff are separate from playback scheduling. */
(() => {
  const desktop = matchMedia('(hover: hover) and (pointer: fine)').matches
    && !/Android|iPhone|iPad|iPod/.test(navigator.userAgent)
    && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  document.body.classList.toggle('txt-desktop-enabled', desktop);
  let mode = 'toc', bookId = '', generation = 0, controller = null, timer = 0;
  let nextCursor = null, revision = '', query = '', seen = new Set();
  let bookmarks = [], bookmarkBusy = false;
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
    $('bookmarksTab').setAttribute('aria-pressed', String(mode === 'bookmarks'));
    $('bookmarkActions').hidden = mode !== 'bookmarks';
    input.placeholder = mode === 'toc' ? '搜索章节标题或序号' : mode === 'bookmarks' ? '搜索书签内容' : '输入正文关键词，至少 2 个字符';
    $('bookSearchSubmit').hidden = mode !== 'body';
    $('chapterSelectList').hidden = mode !== 'toc';
    results.hidden = mode === 'toc';
    $('bookSearchMore').hidden = true;
    if (mode === 'toc') filterToc();
    else if (mode === 'bookmarks') loadBookmarks();
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
  $('chapterSelectBtn').addEventListener('click', () => updateProgressFromScroll(false), true);
  $('searchTocTab').addEventListener('click', () => setMode('toc'));
  $('searchBodyTab').addEventListener('click', () => setMode('body'));
  $('bookmarksTab').addEventListener('click', () => setMode('bookmarks'));
  function handleSearchInput() {
    if (mode === 'toc') filterToc();
    else if (mode === 'bookmarks') renderBookmarks();
    else { cancelSearch(); results.replaceChildren(); nextCursor = null; $('bookSearchMore').hidden = true; status.textContent = '按回车或点击搜索'; }
  }
  input.addEventListener('input', event => { if (!event.isComposing) handleSearchInput(); });
  input.addEventListener('compositionend', handleSearchInput);
  dialog.addEventListener('close', cancelSearch);

  async function loadBookmarks(options = {}) {
    const mutating = Boolean(options.method);
    if (mutating && bookmarkBusy) return;
    if (mutating) {
      bookmarkBusy = true;
      $('addBookmarkBtn').disabled = true;
      results.querySelectorAll('.bookmark-row .danger').forEach(button => { button.disabled = true; });
    }
    const own = ++generation, targetBook = bookId;
    if (!options.method) { bookmarks = []; results.replaceChildren(); }
    $('exportBookmarksBtn').disabled = true;
    status.textContent = '正在读取书签…';
    try {
      const data = await api(`/api/books/${targetBook}/bookmarks`, options);
      if (own !== generation || targetBook !== readerState.currentBookId || !dialog.open) return;
      bookmarks = data.bookmarks;
      renderBookmarks();
      if (options.method === 'POST' && data.duplicate) status.textContent = '当前位置已有书签，未重复添加';
    } catch (error) { if (own === generation) status.textContent = error.message; }
    finally {
      if (mutating) {
        bookmarkBusy = false;
        $('addBookmarkBtn').disabled = false;
        results.querySelectorAll('.bookmark-row .danger').forEach(button => { button.disabled = false; });
        // A newer tab/read request may have observed the list before this write finished.
        if (own !== generation && targetBook === readerState.currentBookId && mode === 'bookmarks' && dialog.open) loadBookmarks();
      }
    }
  }
  function renderBookmarks() {
    results.replaceChildren();
    $('exportBookmarksBtn').disabled = !bookmarks.length;
    const needle = input.value.trim().toLocaleLowerCase();
    const visible = bookmarks.filter(item => `${item.title}\n${item.quote}`.toLocaleLowerCase().includes(needle));
    status.textContent = bookmarks.length ? `${visible.length} 个书签` : '还没有书签，可保存正文中当前高亮的句子';
    visible.forEach(item => {
      const row = document.createElement('div'); row.className = 'bookmark-row';
      const jump = document.createElement('button'); jump.type = 'button'; jump.className = 'book-search-result';
      jump.disabled = item.stale;
      const title = document.createElement('strong'); title.textContent = item.title;
      const quote = document.createElement('span'); markText(quote, item.quote, input.value.trim());
      const info = document.createElement('small'); info.textContent = item.stale
        ? '正文已更新，请重新添加；原文片段仍保留' : `第 ${item.sentence + 1} 句 · ${new Date(item.created_at * 1000).toLocaleString()}`;
      jump.append(title, quote, info);
      const targetBook = bookId;
      jump.addEventListener('click', async () => {
        if (targetBook !== readerState.currentBookId) return;
        jump.disabled = true;
        stopListening(false, false);
        try {
          if (await loadChapter(item.chapter, item.sentence, item.content_revision)) dialog.close();
        } catch (error) {
          if (targetBook === readerState.currentBookId && mode === 'bookmarks' && dialog.open) status.textContent = error.message;
        } finally { jump.disabled = item.stale; }
      });
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger'; remove.textContent = '删除';
      remove.disabled = bookmarkBusy;
      remove.addEventListener('click', async () => {
        if (targetBook !== readerState.currentBookId) return;
        remove.disabled = true;
        await loadBookmarks({ method: 'DELETE', body: JSON.stringify({ id: item.id }) });
        remove.disabled = false;
      });
      row.append(jump, remove); results.append(row);
    });
  }
  function currentBookmarkPosition() {
    return {
      chapter: readerState.currentChapter,
      sentence: readerState.currentSentence,
      content_revision: readerState.currentBook?.content_revision || '',
    };
  }
  $('addBookmarkBtn').addEventListener('click', async () => {
    const button = $('addBookmarkBtn'); button.disabled = true;
    try {
      await loadBookmarks({ method: 'POST', body: JSON.stringify(currentBookmarkPosition()) });
    } finally { button.disabled = false; }
  });
  $('exportBookmarksBtn').addEventListener('click', () => {
    const text = bookmarks.map(item => `## ${item.title}\n\n${item.quote}\n`).join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'Trans-书签.md'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });

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
    if (mode === 'bookmarks') { renderBookmarks(); return; }
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
        readerState.saveTimer = null;
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
