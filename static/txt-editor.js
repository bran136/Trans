(() => {
  const get = id => document.getElementById(id);
  const desktop = matchMedia('(hover: hover) and (pointer: fine)').matches
    && !/Android|iPhone|iPad|iPod/.test(navigator.userAgent)
    && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  document.body.classList.toggle('reader-dark', document.documentElement.classList.contains('reader-dark-root'));
  if (!desktop) { get('txtEditorUnavailable').hidden = false; return; }
  get('txtEditorPage').hidden = false;
  const bookId = document.body.dataset.bookId;
  const textarea = get('txtEditorContent'), save = get('txtEditorSave'), status = get('txtEditorStatus');
  let chapters = [], hasBackup = false;
  let editVersion = 0, composing = false;
  let originalText = '', pendingParse = false, leaseHeld = false, leaseUntil = 0, heartbeat;
  const editorToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  let revision = '', dirty = false, saving = false, maxChars = 3000000, maxBytes = 50 * 1024 * 1024, timer;
  const csrf = document.querySelector('meta[name="csrf-token"]').content;
  function message(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
  async function request(options = {}, suffix = 'text') {
    const response = await fetch(`/api/books/${bookId}/${suffix}`, { ...options,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'X-Editor-Token': editorToken, ...options.headers } });
    const data = await response.json().catch(() => ({ error: response.status === 413 ? '服务器或反向代理拒绝了过大的请求，请检查请求大小限制；当前文字尚未保存' : '服务器响应异常，请稍后重试' }));
    if (!response.ok) {
      const detail = data.code === 'editor_lock_lost'
        ? '本书正在其他页面编辑，或本页编辑锁已过期。\n请退出后重新打开。'
        : data.error || '请求失败，请稍后重试';
      if (data.code === 'editor_lock_lost') loseLease(detail);
      const error = new Error(detail); error.code = data.code; throw error;
    }
    return data;
  }
  async function returnToEditor() {
    textarea.readOnly = true;
    await releaseLease();
    location.href = `/reader?editBook=${encodeURIComponent(bookId)}`;
  }
  function loseLease(reason) {
    leaseHeld = false; clearInterval(heartbeat);
    textarea.readOnly = true; save.disabled = true;
    get('txtEditorBackup').disabled = true; get('txtEditorDeleteBackup').disabled = true;
    message(reason || '编辑锁已失效，请先保留当前文字，再重新进入编辑页面', true);
  }
  async function lease(action) {
    const data = await request({ method: 'POST', body: JSON.stringify({ action, token: editorToken }) }, 'edit-lease');
    leaseHeld = true; leaseUntil = Date.now() + data.expires_in * 1000;
    return data;
  }
  async function releaseLease() {
    clearInterval(heartbeat);
    if (!leaseHeld) return;
    leaseHeld = false;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 2000);
    try { await request({ method: 'POST', keepalive: true, signal: controller.signal, body: JSON.stringify({ action: 'release', token: editorToken }) }, 'edit-lease'); } catch { /* Lease also expires after lost connections. */ }
    finally { clearTimeout(timeout); }
  }
  function startHeartbeat() {
    clearInterval(heartbeat);
    heartbeat = setInterval(async () => {
      if (!leaseHeld || saving) return;
      try { await lease('renew'); }
      catch (error) {
        if (error.code === 'editor_lock_lost' || Date.now() >= leaseUntil) loseLease();
        else message('连接暂时中断，修改仍保留在本页；保存前会重新确认编辑权限', true);
      }
    }, 30000);
  }
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || !leaseHeld || saving) return;
    try { await lease('renew'); }
    catch (error) { if (error.code === 'editor_lock_lost' || Date.now() >= leaseUntil) loseLease(); }
  });
  window.addEventListener('pagehide', () => {
    clearInterval(heartbeat);
    if (!leaseHeld) return;
    const body = new URLSearchParams({ action: 'release', token: editorToken, csrf_token: csrf });
    navigator.sendBeacon(`/api/books/${bookId}/edit-lease`, body);
    leaseHeld = false;
  });
  window.addEventListener('pageshow', async event => {
    if (!event.persisted) return;
    textarea.readOnly = true;
    try {
      await lease('acquire');
      const data = await request();
      if (data.revision !== revision) { await releaseLease(); loseLease('离开期间原文已更新，请先保留当前文字，再重新打开'); return; }
      pendingParse = data.pending_parse; textarea.readOnly = false; updateTools(data); count(); startHeartbeat();
    } catch (error) { loseLease(error.message); }
  });
  function updateTools(data) {
    chapters = data.chapters || [];
    if ('has_backup' in data) hasBackup = data.has_backup;
    if ('backup_time' in data) {
      const time = get('txtEditorBackupTime');
      time.hidden = !data.backup_time;
      if (data.backup_time) {
        const date = new Date(data.backup_time * 1000);
        time.dateTime = date.toISOString();
        time.textContent = `备份：${date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`;
        time.title = '备份生成时间（本机时区）';
      } else { time.textContent = ''; time.removeAttribute('datetime'); }
    }
    if ('pending_parse' in data) pendingParse = data.pending_parse;
    renderToc();
    get('txtEditorBackup').disabled = !hasBackup || !leaseHeld;
    get('txtEditorDownload').hidden = !hasBackup;
    get('txtEditorDeleteBackup').hidden = !hasBackup;
    get('txtEditorDeleteBackup').disabled = !leaseHeld;
  }
  function jumpChapter(target) {
    if (saving || textarea.disabled || !leaseHeld) return;
    // Match existing chapter anchors in the current text, including unsaved edits.
    const normalize = line => line.replace(/[ \t\f\v]+/g, ' ').trim();
    const wanted = new Set(chapters.slice(0, target + 1).map(c => normalize(c.anchor)));
    const locations = new Map();
    const lines = /[^\n]*(?:\n|$)/g;
    const text = textarea.value;
    let match;
    while ((match = lines.exec(text)) && match[0]) {
      const key = normalize(match[0]);
      if (wanted.has(key)) {
        if (!locations.has(key)) locations.set(key, []);
        locations.get(key).push(match.index);
      }
    }
    let position = -1;
    for (let i = 0; i <= target; i++) {
      const candidates = locations.get(normalize(chapters[i].anchor)) || [];
      const next = candidates.find(offset => offset > position);
      if (next !== undefined) position = next;
      else if (i === target) { message('该章节开头已修改或删除，请保存解析后刷新目录', true); return; }
    }
    get('txtEditorChapter').querySelectorAll('button').forEach(button => button.setAttribute('aria-current', String(Number(button.dataset.index) === target)));
    reveal(position, position, true);
  }
  function reveal(position, end, chapter = false) {
    textarea.focus();
    textarea.setSelectionRange(position, end);
    // Measure using the same native textarea layout. A div can accumulate
    // different wrapping/line-height rounding over thousands of lines.
    const mirror = document.createElement('textarea');
    const style = getComputedStyle(textarea);
    for (const key of style) mirror.style.setProperty(key, style.getPropertyValue(key));
    Object.assign(mirror.style, {
      position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden',
      width: `${textarea.clientWidth}px`, height: '0', minHeight: '0', maxHeight: 'none',
      boxSizing: 'border-box', border: '0', overflow: 'hidden', scrollbarGutter: 'auto',
      flex: 'none', margin: '0', transition: 'none',
    });
    mirror.tabIndex = -1;
    mirror.setAttribute('aria-hidden', 'true');
    mirror.wrap = textarea.wrap;
    mirror.value = textarea.value.slice(0, position) + '丨';
    document.body.append(mirror);
    const lineTop = mirror.scrollHeight - parseFloat(style.paddingBottom) - parseFloat(style.lineHeight);
    mirror.remove();
    textarea.scrollTop = Math.max(0, lineTop - (chapter ? parseFloat(style.paddingTop) : textarea.clientHeight / 3));
  }
  function renderToc() {
    const list = get('txtEditorChapter'), needle = get('txtTocFilter').value.trim().toLocaleLowerCase();
    const fragment = document.createDocumentFragment();
    chapters.forEach((chapter, index) => {
      if (needle && !chapter.title.toLocaleLowerCase().includes(needle) && String(index + 1) !== needle) return;
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.index = index;
      button.textContent = `${index + 1}. ${chapter.title}`;
      button.addEventListener('click', () => jumpChapter(index)); fragment.append(button);
    });
    list.replaceChildren(fragment);
    if (!list.children.length) list.textContent = '没有匹配的章节';
  }
  get('txtTocFilter').addEventListener('input', renderToc);
  const workspace = get('txtEditorWorkspace'), divider = get('txtEditorDivider');
  function sidebarWidth(width, persist = false) {
    const max = Math.max(160, Math.min(480, workspace.clientWidth - 300));
    width = Math.round(Math.min(max, Math.max(160, width)));
    workspace.style.setProperty('--toc-width', `${width}px`);
    divider.setAttribute('aria-valuenow', width); divider.setAttribute('aria-valuemax', max);
    try { if (persist) localStorage.setItem('txtEditorSidebarWidth', width); } catch { /* Optional preference. */ }
  }
  try { sidebarWidth(Number(localStorage.getItem('txtEditorSidebarWidth')) || 240); } catch { sidebarWidth(240); }
  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); divider.setPointerCapture(event.pointerId);
  });
  divider.addEventListener('pointermove', event => {
    if (divider.hasPointerCapture(event.pointerId)) sidebarWidth(event.clientX - workspace.getBoundingClientRect().left);
  });
  divider.addEventListener('pointerup', event => {
    sidebarWidth(Number(divider.getAttribute('aria-valuenow')), true);
    if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
  });
  divider.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); sidebarWidth(Number(divider.getAttribute('aria-valuenow')) + (event.key === 'ArrowLeft' ? -20 : 20), true);
  });
  window.addEventListener('resize', () => sidebarWidth(Number(divider.getAttribute('aria-valuenow'))));

  let findTimer, findCache = null;
  const findInput = get('txtFind'), findStatus = get('txtFindStatus');
  function findState(direction = 0) {
    const needle = findInput.value;
    if (!needle) return { total: 0, current: 0, target: -1, index: 0 };
    // Sparse checkpoints bound retained offsets; cursor movement scans at most
    // 256 matches instead of repeatedly scanning the entire book.
    if (!findCache || findCache.version !== editVersion || findCache.needle !== needle) {
      const text = textarea.value, checkpoints = [];
      let at = 0, total = 0, last = -1;
      while ((at = text.indexOf(needle, at)) !== -1) {
        if (total % 256 === 0) checkpoints.push(at);
        total++; last = at; at += needle.length;
      }
      findCache = { version: editVersion, needle, text, checkpoints, total, last };
    }
    const { text, checkpoints, total, last } = findCache;
    const start = textarea.selectionStart, end = textarea.selectionEnd;
    function atIndex(index) {
      if (index < 1 || index > total) return -1;
      const block = Math.floor((index - 1) / 256);
      let at = checkpoints[block];
      for (let i = block * 256 + 1; i < index; i++) at = text.indexOf(needle, at + needle.length);
      return at;
    }
    function lowerBound(position) {
      if (!total || position > last) return total + 1;
      let lo = 0, hi = checkpoints.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (checkpoints[mid] <= position) lo = mid + 1; else hi = mid; }
      const block = Math.max(0, lo - 1);
      let at = checkpoints[block], index = block * 256 + 1;
      while (at < position) { at = text.indexOf(needle, at + needle.length); index++; }
      return index;
    }
    const first = lowerBound(start);
    const current = total && atIndex(first) === start && end === start + needle.length ? first : 0;
    let index = 0;
    if (total && direction > 0) { index = lowerBound(end); if (index > total) index = 1; }
    if (total && direction < 0) { index = first - 1; if (index < 1) index = total; }
    return { total, current, target: atIndex(index), index };
  }
  function findCount() {
    if (composing || document.hidden) return;
    if (!findInput.value) { findCache = null; findStatus.textContent = ''; findStatus.removeAttribute('title'); return; }
    const state = findState();
    findStatus.textContent = `${state.current}/${state.total}`;
    findStatus.title = state.total ? (state.current ? `当前第 ${state.current} 处，共 ${state.total} 处` : `共 ${state.total} 处，点击上一个或下一个定位`) : '未找到匹配文字';
  }
  function showFind() {
    findInput.focus(); findInput.select(); findCount();
  }
  function findNext(backward = false) {
    if (saving || textarea.disabled || !findInput.value || !leaseHeld) return;
    const state = findState(backward ? -1 : 1);
    if (state.target >= 0) reveal(state.target, state.target + findInput.value.length);
    findStatus.textContent = `${state.index}/${state.total}`;
    findStatus.title = state.total ? `当前第 ${state.index} 处，共 ${state.total} 处` : '未找到匹配文字';
  }
  textarea.addEventListener('select', () => {
    if (!composing && findInput.value) { clearTimeout(findTimer); findTimer = setTimeout(findCount, 150); }
  });
  findInput.addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(findCount, 200); });
  findInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); findNext(event.shiftKey); } });
  get('txtFindNext').addEventListener('click', () => findNext());
  get('txtFindPrev').addEventListener('click', () => findNext(true));
  function replace(all) {
    if (saving || textarea.disabled || !findInput.value || !leaseHeld) return;
    const needle = findInput.value, replacement = get('txtReplace').value, text = textarea.value;
    if (!all && text.slice(textarea.selectionStart, textarea.selectionEnd) !== needle) { findNext(); return; }
    let result, count = 1;
    if (all) {
      let at = 0; count = 0;
      while ((at = text.indexOf(needle, at)) !== -1) { count++; at += needle.length; }
      if (!count) { findCount(); return; }
      if (text.length + count * (replacement.length - needle.length) > maxChars) { message('替换后超过字符上限，未修改', true); return; }
      result = text.split(needle).join(replacement);
    } else {
      if (text.length + replacement.length - needle.length > maxChars) { message('替换后超过字符上限，未修改', true); return; }
      result = text.slice(0, textarea.selectionStart) + replacement + text.slice(textarea.selectionEnd);
    }
    const start = textarea.selectionStart;
    textarea.value = result;
    textarea.dispatchEvent(new Event('input'));
    reveal(all ? 0 : start, all ? 0 : start + replacement.length);
    findCount(); message(`已替换 ${count} 处，保存后生效`);
  }
  get('txtReplaceOne').addEventListener('click', () => replace(false));
  get('txtReplaceAll').addEventListener('click', () => replace(true));
  get('txtEditorBackup').addEventListener('click', () => get('txtEditorRestore').showModal());
  get('txtEditorRestoreCancel').addEventListener('click', () => get('txtEditorRestore').close());
  get('txtEditorRestoreConfirm').addEventListener('click', async () => {
    if (saving || !leaseHeld) return;
    get('txtEditorRestore').close();
    saving = true; stopPreview(); textarea.readOnly = true; save.disabled = true;
    get('txtEditorBack').disabled = true; get('txtEditorBackup').disabled = true;
    get('txtEditorProgress').hidden = false;
    message('正在读取原文备份…');
    try {
      await lease('renew');
      const data = await request({}, 'text-backup');
      textarea.value = data.text; editVersion++; findCache = null; dirty = true; updateTools(data); findCount(); schedulePreview();
      message('已载入备份，确认内容后点击“保存并解析”恢复书籍');
    } catch (error) { message(error.message, true); }
    finally {
      saving = false; textarea.readOnly = !leaseHeld;
      get('txtEditorBackup').disabled = !hasBackup || !leaseHeld;
      get('txtEditorBack').disabled = false;
      get('txtEditorProgress').hidden = true; count();
      if (dirty && leaseHeld) schedulePreview();
    }
  });
  let previewWorker = null, previewTimer, previewBusy = false, previewJobVersion = -1;
  function stopPreview() {
    clearTimeout(previewTimer); previewWorker?.terminate(); previewWorker = null; previewBusy = false;
  }
  function clearPreview() {
    stopPreview();
    get('txtEditorChangesList').replaceChildren(); get('txtEditorChanges').hidden = true;
  }
  function renderPreview(data, version) {
    if (!data.changes) return;
    const list = get('txtEditorChangesList'); list.replaceChildren();
    get('txtEditorChanges').hidden = !data.total;
    get('txtEditorChangesSummary').textContent = `未保存修改 · ${data.merged ? '大范围差异，已合并展示' : `${data.total} 处${data.total > 80 ? '（展示前 80 处）' : ''}`} · 绿色新增 / 红色删除`;
    const fragment = document.createDocumentFragment();
    data.changes.forEach((change, index) => {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'txt-change';
      row.append(document.createTextNode(`${index + 1}. ${change.before}`));
      for (const [tag, value] of [['del', change.removed], ['ins', change.added]]) {
        if (!value) continue;
        const node = document.createElement(tag); node.textContent = value.trim() ? value : value.replace(/\n/g, '↵\n').replace(/\t/g, '⇥').replace(/ /g, '·'); row.append(node);
      }
      row.append(document.createTextNode(change.after + (change.clipped ? ' …（长变更仅显示部分）' : '')));
      row.addEventListener('click', () => { if (editVersion === version) reveal(change.start, change.end); });
      const undo = document.createElement('button'); undo.type = 'button'; undo.className = 'txt-change-undo';
      undo.textContent = '撤销'; undo.setAttribute('aria-label', `撤销第 ${index + 1} 处修改`);
      undo.addEventListener('click', () => {
        if (saving || composing || textarea.disabled || !leaseHeld) return;
        if (editVersion !== version) { message('修改记录正在更新，请稍后再撤销'); return; }
        const restored = originalText.slice(change.oldStart, change.oldEnd);
        textarea.setRangeText(restored, change.start, change.end, 'select');
        textarea.dispatchEvent(new Event('input'));
        dirty = textarea.value !== originalText;
        if (!dirty) clearPreview();
        count(); findCount();
        message(dirty ? '已撤销这处修改，其余修改保留' : (pendingParse ? '已撤销全部未保存修改，原文仍待解析' : '已撤销全部未保存修改'));
      });
      const container = document.createElement('div'); container.className = 'txt-change-row';
      container.append(row, undo); fragment.append(container);
    });
    list.append(fragment);
  }
  function schedulePreview() {
    clearTimeout(previewTimer);
    if (composing || document.hidden || saving || !leaseHeld) return;
    previewTimer = setTimeout(() => {
      if (previewBusy || composing || document.hidden || saving || !leaseHeld) return;
      const snapshot = textarea.value;
      if (snapshot === originalText) { clearPreview(); return; }
      const first = !previewWorker;
      if (first) {
        const worker = previewWorker = new Worker(document.body.dataset.deltaWorker);
        worker.onmessage = ({ data }) => {
          if (previewWorker !== worker) return;
          previewBusy = false;
          if (previewJobVersion !== editVersion) { schedulePreview(); return; }
          renderPreview(data, previewJobVersion);
        };
        worker.onerror = () => { if (previewWorker === worker) stopPreview(); };
      }
      previewBusy = true; previewJobVersion = editVersion;
      previewWorker.postMessage({ ...(first ? { original: originalText } : {}), text: snapshot, preview: true });
    }, 400);
  }
  textarea.addEventListener('compositionstart', () => { composing = true; clearTimeout(previewTimer); clearTimeout(findTimer); });
  textarea.addEventListener('compositionend', () => { composing = false; schedulePreview(); clearTimeout(findTimer); findTimer = setTimeout(findCount, 800); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopPreview(); clearTimeout(findTimer); findCache = null; }
    else if (dirty) { schedulePreview(); findTimer = setTimeout(findCount, 800); }
  });
  window.addEventListener('pagehide', () => { stopPreview(); clearTimeout(findTimer); findCache = null; });
  get('txtEditorDeleteBackup').addEventListener('click', () => { if (!saving && leaseHeld) get('txtEditorDeleteConfirm').showModal(); });
  get('txtEditorDeleteCancel').addEventListener('click', () => get('txtEditorDeleteConfirm').close());
  get('txtEditorDeleteYes').addEventListener('click', async () => {
    if (saving || !leaseHeld) return;
    get('txtEditorDeleteConfirm').close(); saving = true; textarea.readOnly = true; count();
    get('txtEditorBack').disabled = true; get('txtEditorBackup').disabled = true;
    try {
      await lease('renew');
      await request({ method: 'DELETE' }, 'text-backup');
      hasBackup = false; get('txtEditorDownload').hidden = true; get('txtEditorDeleteBackup').hidden = true;
      get('txtEditorBackupTime').hidden = true; get('txtEditorBackupTime').textContent = ''; get('txtEditorBackupTime').removeAttribute('datetime');
      message('原文备份已删除，当前书籍未改变');
    } catch (error) { message(error.message, true); }
    finally {
      saving = false; textarea.readOnly = !leaseHeld; get('txtEditorBack').disabled = false;
      get('txtEditorBackup').disabled = !hasBackup || !leaseHeld; count();
    }
  });
  function count() {
    const length = textarea.textLength;
    get('txtEditorCount').textContent = `${length.toLocaleString()} 字符`;
    save.disabled = saving || !leaseHeld || (!dirty && !pendingParse) || length > maxChars;
    if (length > maxChars) message(`正文超过 ${maxChars.toLocaleString()} 字符，需缩短后才能保存`, true);
  }
  textarea.addEventListener('input', () => {
    editVersion++; findCache = null; dirty = true; schedulePreview();
    clearTimeout(findTimer); if (findInput.value && !composing) findTimer = setTimeout(findCount, 800);
    save.disabled = saving || !leaseHeld;
    message('有未保存的修改');
    clearTimeout(timer); timer = setTimeout(count, 250);
  });
  function prepareDelta(text, parse) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(document.body.dataset.deltaWorker);
      worker.onmessage = ({ data }) => {
        worker.terminate();
        if (data.error) reject(new Error(data.error)); else resolve(data);
      };
      worker.onerror = () => { worker.terminate(); reject(new Error('差异计算失败，请刷新前先保留当前文字')); };
      worker.postMessage({ original: originalText, text, revision, maxBytes, parse });
    });
  }
  async function saveText(parse = false) {
    if (saving || (!dirty && !(parse && pendingParse)) || textarea.disabled || !leaseHeld) return;
    const text = textarea.value;
    if (!text.trim() || text.length > maxChars) { message('正文为空或超过字符上限，未保存', true); return; }
    saving = true; stopPreview(); clearTimeout(findTimer); save.disabled = true; textarea.readOnly = true;
    get('txtEditorBackup').disabled = true;
    get('txtEditorBack').disabled = true; get('txtEditorProgress').hidden = false;
    message('正在计算修改内容并压缩…');
    try {
      await lease('renew');
      const delta = await prepareDelta(text, parse);
      if (delta.unchanged && !(parse && pendingParse)) { dirty = false; clearPreview(); message(pendingParse ? '原文已保存，尚未解析' : '正文没有变化，无需保存'); return; }
      message(parse ? '正在上传修改并完整解析，请稍候…' : '正在压缩上传并保存原文…');
      const data = delta.unchanged
        ? await request({ method: 'PUT', body: JSON.stringify({ revision, parse: true, reparse_current: true }) })
        : await request({ method: 'PUT', body: delta.body,
          headers: { 'Content-Type': 'application/vnd.trans.txt-delta+json', 'Content-Encoding': 'gzip' } });
      originalText = text;
      revision = data.revision; dirty = false; updateTools(data);
      clearPreview();
      message(data.parsed ? `已保存并重新解析 · ${data.book.chapter_count} 个章节` : '原文已保存到服务器，尚未解析；阅读内容将在解析后更新');
      if (data.parsed) try { localStorage.setItem('readerTextEdit', JSON.stringify({ bookId, revision, contentRevision: data.book.content_revision, time: Date.now() })); } catch { /* Server save has succeeded. */ }
    } catch (error) { message(error.message, true); }
    finally {
      saving = false; textarea.readOnly = !leaseHeld;
      get('txtEditorBackup').disabled = !hasBackup || !leaseHeld;
      get('txtEditorBack').disabled = false; get('txtEditorProgress').hidden = true;
      if (dirty && leaseHeld) schedulePreview();
      count();
    }
  }
  save.addEventListener('click', () => saveText(true));
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && ['f', 'h'].includes(event.key.toLowerCase()) && !document.querySelector('dialog[open]')) { event.preventDefault(); showFind(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!composing && !document.querySelector('dialog[open]')) saveText(false); }
  });
  get('txtEditorBack').addEventListener('click', () => {
    if (dirty) { get('txtEditorLeave').showModal(); return; }
    returnToEditor();
  });
  get('txtEditorStay').addEventListener('click', () => get('txtEditorLeave').close());
  get('txtEditorDiscard').addEventListener('click', () => { dirty = false; returnToEditor(); });
  window.addEventListener('beforeunload', event => {
    if (dirty || saving) { event.preventDefault(); event.returnValue = ''; }
  });
  async function loadEditor() {
    get('txtEditorRetry').disabled = true;
    try {
      await lease('acquire'); startHeartbeat();
      const data = await request();
      revision = data.revision; maxChars = data.max_chars; maxBytes = data.max_bytes || 50 * 1024 * 1024; updateTools(data);
      get('txtEditorTitle').textContent = data.title;
      textarea.value = data.text; originalText = textarea.value; textarea.disabled = false; textarea.readOnly = false;
      get('txtEditorPage').hidden = false; get('txtEditorLocked').hidden = true;
      message(pendingParse ? '原文有已保存但未解析的修改，请点击“保存并解析”更新阅读内容' : 'Ctrl / ⌘ + S 仅保存；“保存并解析”更新阅读内容'); count();
    } catch (error) {
      await releaseLease();
      get('txtEditorPage').hidden = true; get('txtEditorLocked').hidden = false;
      get('txtEditorLockMessage').textContent = error.message;
    } finally { get('txtEditorProgress').hidden = true; get('txtEditorRetry').disabled = false; }
  }
  get('txtEditorRetry').addEventListener('click', loadEditor);
  loadEditor();
})();
