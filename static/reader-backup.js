/* Per-book choices; preview never restores anything automatically. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id), root = '/api/reader/backups';
  const csrf = document.querySelector('meta[name="csrf-token"]').content;
  const labels = { source: '原始书籍', reading: '目录、进度与书签', txt_backup: 'TXT 原文备份', audio: '服务器固定音频' };
  const toolNames = { translation: '在线翻译', pdf: 'PDF 翻译', tts: '听书' }, toolLabels = { settings: '工具配置', credentials: '服务凭据' };
  let busy = false, preview = null, estimateTimer = 0, estimateGeneration = 0;
  let unlockedId = '', unlockedPassword = ''; // Memory only; never localStorage or task metadata.
  const status = (text, type = 'info') => window.TransUI.feedback($('backupStatus'), text, type);
  function node(tag, text, className) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (className) e.className = className; return e; }
  function size(bytes) { const n = Math.max(0, Number(bytes) || 0), unit = n >= 1024 ** 3 ? 3 : n >= 1024 ** 2 ? 2 : 1; return `${(n / 1024 ** unit).toFixed(1)} ${['', 'KiB', 'MiB', 'GiB'][unit]}`; }
  async function api(url, options = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), options.method === 'PUT' ? 120000 : 30000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal, headers: { 'X-CSRF-Token': csrf, ...options.headers } });
      const data = await response.json();
      if (!response.ok) { const error = Error(data.error || '操作失败，请重试'); error.passwordRequired = data.password_required === true; throw error; } return data;
    } catch (error) { if (error.passwordRequired) throw error; throw Error(error.name === 'AbortError' ? '请求超时，请刷新查看状态' : error instanceof TypeError ? '网络连接失败，请稍后刷新' : error.message); }
    finally { clearTimeout(timer); }
  }
  const post = (url, data) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  function setBusy(value) {
    busy = value;
    document.querySelectorAll('.backup-panel button, .backup-panel input').forEach(e => {
      if (value) { e.dataset.wasDisabled = String(e.disabled); e.disabled = true; }
      else if ('wasDisabled' in e.dataset) { e.disabled = e.dataset.wasDisabled === 'true'; delete e.dataset.wasDisabled; }
    });
  }
  function setupBackupViewport() {
    const mobile = window.matchMedia('(max-width: 700px)'), style = document.body.style;
    let frame = 0;
    function update() {
      frame = 0;
      if (!mobile.matches) { style.removeProperty('--backup-viewport-height'); return; }
      const viewport = window.visualViewport;
      // Pinch zoom should magnify the page, not rebuild its layout.
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
      const height = Math.floor(Math.min(window.innerHeight, viewport?.height ?? window.innerHeight));
      if (height > 0 && style.getPropertyValue('--backup-viewport-height') !== `${height}px`)
        style.setProperty('--backup-viewport-height', `${height}px`);
    }
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    window.addEventListener('pageshow', schedule);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    mobile.addEventListener('change', schedule);
    update();
  }
  function tab(name) {
    for (const key of ['create', 'files', 'restore']) {
      $(key + 'Panel').hidden = key !== name;
      $(key + 'Tab').setAttribute('aria-selected', String(key === name));
      $(key + 'Tab').tabIndex = key === name ? 0 : -1;
    }
  }
  for (const [index, key] of ['create', 'files', 'restore'].entries()) {
    $(key + 'Tab').addEventListener('click', () => tab(key));
    $(key + 'Tab').addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const keys = ['create', 'files', 'restore'];
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
      tab(keys[next]); $(keys[next] + 'Tab').focus();
    });
  }
  function checkbox(value, title, checked = false, disabled = false, type = 'checkbox', group = '') {
    // Only the box activates the option, matching the other service settings.
    const row = node('div', null, 'backup-option'), input = node('input');
    input.type = type; input.value = value; input.checked = checked; input.disabled = disabled;
    input.setAttribute('aria-label', title); if (group) input.name = group;
    row.append(input, node('span', title)); return row;
  }
  function choices(row) { return [...row.querySelectorAll('.backup-options input:checked')].map(e => e.value); }
  function selections() { return [...$('backupBooks').children].map(row => ({ id: row.dataset.id, items: choices(row) })).filter(row => row.items.length); }
  function toolSelections() { return [...$('backupTools').children].map(row => ({ id: row.dataset.id, items: choices(row) })).filter(row => row.items.length); }
  function renderTools() {
    for (const [id, title] of Object.entries(toolNames)) {
      const row = node('article', null, 'backup-book'), options = node('div', null, 'backup-options'); row.dataset.id = id;
      row.append(node('strong', title));
      for (const [key, label] of Object.entries(toolLabels)) options.append(checkbox(key, label));
      options.addEventListener('change', () => {
        const encrypted = toolSelections().some(tool => tool.items.includes('credentials'));
        $('backupEncryption').hidden = !encrypted;
        if (!encrypted) { $('backupPassword').value = ''; $('backupPasswordAgain').value = ''; }
        estimate();
      });
      row.append(options); $('backupTools').append(row);
    }
  }
  async function passwordPrompt() {
    const dialog = $('backupConfirm'), input = $('restorePassword');
    $('backupConfirmTitle').textContent = '解密备份';
    $('backupConfirmText').textContent = '输入创建这份备份时设置的密码。';
    input.value = ''; input.hidden = false;
    const accepted = await new Promise(resolve => { dialog.returnValue = 'cancel'; dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }); dialog.showModal(); });
    const value = accepted ? input.value : ''; input.value = ''; input.hidden = true;
    if (!accepted) return null;
    if (value.length < 12) throw Error('备份密码至少需要 12 个字符');
    return value;
  }
  async function backupPost(id, data) {
    try { return await post(`${root}/${id}`, { ...data, password: id === unlockedId ? unlockedPassword : '' }); }
    catch (error) {
      if (!error.passwordRequired) throw error;
      const password = await passwordPrompt(); if (password === null) return null;
      unlockedId = id; unlockedPassword = password;
      return post(`${root}/${id}`, { ...data, password });
    }
  }
  function bookHeader(book, options) {
    const head = node('div', null, 'backup-book-head backup-selection-head');
    const available = () => [...options.querySelectorAll('input:not(:disabled)')];
    const toggle = button('全选', () => {
      if (busy) return;
      const inputs = available(), checked = inputs.some(input => !input.checked);
      inputs.forEach(input => { input.checked = checked; });
      options.dispatchEvent(new Event('change'));
    }, 'ghost backup-select-book');
    function update() {
      const inputs = available(), all = inputs.length > 0 && inputs.every(input => input.checked);
      toggle.textContent = all ? '清空' : '全选';
      toggle.setAttribute('aria-label', `${all ? '清空' : '全选'}《${book.title}》的可用项目`);
      toggle.disabled = !inputs.length;
    }
    options.addEventListener('change', update);
    update();
    head.append(node('strong', book.title), toggle);
    return head;
  }
  function estimate() {
    clearTimeout(estimateTimer); const generation = ++estimateGeneration, books = selections(), tools = toolSelections();
    if (!books.length && !tools.length) { $('backupEstimate').textContent = '请选择备份项目'; return; }
    $('backupEstimate').textContent = '正在估算大小…';
    estimateTimer = setTimeout(async () => {
      try {
        const data = await post(root, { action: 'estimate', books, tools });
        if (generation === estimateGeneration) $('backupEstimate').textContent = `${[books.length ? `${books.length} 本书` : '', tools.length ? `${tools.length} 项工具` : ''].filter(Boolean).join(' · ')} · 预计约 ${size(data.size)}（压缩前，实际以生成结果为准）`;
      } catch (error) { if (generation === estimateGeneration) $('backupEstimate').textContent = `大小估算失败：${error.message}`; }
    }, 350);
  }
  function renderBooks(books) {
    const saved = new Map(selections().map(row => [row.id, row.items]));
    $('backupBooks').replaceChildren();
    for (const book of books) {
      const row = node('article', null, 'backup-book'); row.dataset.id = book.id;
      const options = node('div', null, 'backup-options');
      for (const [key, title] of Object.entries(labels)) {
        const disabled = key === 'txt_backup' && !book.has_txt_backup;
        options.append(checkbox(key, title, !disabled && !!saved.get(book.id)?.includes(key), disabled));
      }
      options.addEventListener('change', estimate);
      row.append(bookHeader(book, options), options); $('backupBooks').append(row);
    }
    if (!books.length) $('backupBooks').append(node('p', '书架为空', 'backup-note'));
    estimate();
  }
  function button(text, run, className = 'ghost') { const e = node('button', text, className); e.type = 'button'; e.addEventListener('click', run); return e; }
  function renderFiles(jobs) {
    $('serverBackups').replaceChildren();
    for (const job of jobs) {
      const row = node('article', null, 'backup-book'), head = node('div', null, 'backup-book-head');
      head.append(node('strong', new Date(job.created_at * 1000).toLocaleString()));
      const actions = node('div', null, 'backup-actions');
      if (job.size > 0 && job.status !== 'working') {
        if (job.contents?.length || job.tool_contents?.length) {
          const download = node('a', '下载', 'ghost'); download.href = `${root}/${job.id}/download`; actions.append(download);
        }
        actions.append(button('查看并恢复', () => openBackup(job.id)));
      } else if (job.status === 'working') actions.append(button('查看进度', () => track(job.id)));
      actions.append(button('删除', () => remove(job), 'ghost danger')); head.append(actions); row.append(head);
      const hours = Math.max(0, Math.ceil((job.expires_at * 1000 - Date.now()) / 3600000));
      row.append(node('p', `${job.kind === 'upload' ? '上传文件' : '服务器备份'}${job.encrypted ? ' · 已加密' : ''} · ${size(job.size)} · 约 ${hours} 小时后删除${job.status === 'error' ? ' · ' + job.message : ''}`));
      for (const book of job.contents || []) row.append(node('p', `${book.title} · ${book.items.map(k => labels[k]).join(' / ')}`));
      const toolItems = new Set((job.tool_contents || []).flatMap(tool => tool.items));
      row.append(node('p', job.contents?.length || job.tool_contents?.length
        ? `工具配置：${toolItems.has('settings') ? '有' : '无'} · 服务凭据：${toolItems.has('credentials') ? '有（已加密）' : '无'}`
        : '备份内容待校验'));
      if (!job.contents?.length && !job.tool_contents?.length) row.append(node('p', job.message || '文件尚未校验完成'));
      $('serverBackups').append(row);
    }
    if (!jobs.length) $('serverBackups').append(node('p', '暂无服务器备份', 'backup-note'));
  }
  function renderPreview(job, clearSelectionKey = '') {
    const selected = new Map();
    if (preview?.id === job.id) {
      for (const row of $('restoreBooks').querySelectorAll('[data-selection-key]')) {
        if (row.dataset.selectionKey === clearSelectionKey) continue;
        selected.set(row.dataset.selectionKey, {items: choices(row), audio: row.querySelector('input[type=radio]:checked')?.value});
      }
    }
    const scroll = $('restoreBooks').scrollTop;
    preview = job; $('restoreBooks').replaceChildren(); $('compareBackup').hidden = false;
    $('restoreIntro').textContent = '按卡片分别恢复勾选项目。';
    for (const tool of job.tools || []) renderToolPreview(tool, selected.get('tool-' + tool.id));
    for (const book of job.books || []) {
      const row = node('article', null, 'backup-book'); row.dataset.selectionKey = 'book-' + book.id;
      const saved = selected.get(row.dataset.selectionKey);
      row.append(node('p', `备份 ${book.chapters} 章${book.current ? ` · 现有 ${book.current.chapter_count} 章 · ${book.compatible ? '原书与目录一致' : '原书或目录不同'}` : book.same_title ? ' · 有同名书籍，将作为独立记录恢复' : ' · 书架中不存在，需同时恢复原书'}`));
      const audioStatus = !book.items.includes('audio') ? '备份未包含'
        : !book.current ? '无现有书籍，需同时恢复原书与目录'
        : book.merge_issue ? `无法合并：${book.merge_issue}` : '可合并';
      row.append(node('p', `固定音频：${audioStatus}`));
      const options = node('div', null, 'backup-options');
      for (const [key, title] of Object.entries(labels)) options.append(checkbox(key, title, !!saved?.items.includes(key), !book.items.includes(key)));
      row.prepend(bookHeader(book, options));
      row.append(options);
      const actions = node('div', null, 'backup-actions');
      const audioModes = node('div', null, 'backup-actions'); audioModes.hidden = true;
      audioModes.append(checkbox('merge', '合并固定音频', saved?.audio ? saved.audio === 'merge' && !book.merge_issue : !book.merge_issue, !!book.merge_issue, 'radio', `audio-${book.id}`),
        checkbox('replace', '覆盖固定音频', saved?.audio === 'replace', false, 'radio', `audio-${book.id}`));
      row.append(audioModes); audioModes.hidden = !choices(row).includes('audio');
      options.addEventListener('change', () => { audioModes.hidden = !choices(row).includes('audio'); });
      actions.append(button('恢复本书', () => restoreBook(book, row)));
      row.append(actions); $('restoreBooks').append(row);
    }
    $('restoreBooks').scrollTop = scroll;
  }
  function renderToolPreview(tool, saved) {
    const row = node('article', null, 'backup-book'), options = node('div', null, 'backup-options');
    row.dataset.selectionKey = 'tool-' + tool.id;
    row.append(node('strong', tool.title));
    const descriptions = tool.items.map(item => `${toolLabels[item]}：${tool.changed[item] ? '与当前不同' : '与当前一致'}`);
    row.append(node('p', descriptions.join(' · ')));
    if (tool.items.includes('credentials')) row.append(node('p', `备份含 ${tool.credential_count} 项已配置凭据；恢复时包括覆盖为空的凭据。`));
    const names = { enabled:'启用', base_url:'API 地址', endpoint:'服务地址', model:'模型', temperature:'温度', thinking:'思考模式', reasoning_effort:'推理强度', timeout:'超时（秒）', style:'翻译风格', cache_limit:'缓存上限', provider:'服务商', balance_url:'余额地址', voice_id:'音色', format:'音频格式', style_prompt:'朗读提示', chunk_chars:'单句字符', cache_enabled:'音频缓存', reuse_deepseek:'沿用翻译 API', qps:'最大 QPS', retention_days:'任务保留天数（0 为永久）', enhance_compatibility:'兼容模式', pool_size:'并发 Worker', json_mode:'JSON 模式', ocr:'OCR', no_watermark:'无水印', disable_glossary:'禁用术语提取', translate_table_text:'翻译表格', rich_text:'保留富文本', skip_last_pages:'跳过末尾页数' };
    if (tool.items.includes('settings')) {
      const details = node('details', null, 'backup-tool-details'); details.append(node('summary', '查看备份配置'));
      for (const [section, values] of Object.entries(tool.settings)) {
        details.append(node('p', {deepseek:'DeepSeek',google:'谷歌翻译',reader_tts:'MiMo',pdf:'PDF 翻译'}[section]));
        const list = node('dl');
        for (const [key, value] of Object.entries(values)) list.append(node('dt', names[key] || key), node('dd', typeof value === 'boolean' ? value ? '是' : '否' : String(value || value === 0 ? value : '未配置')));
        details.append(list);
      }
      row.append(details);
    }
    for (const [key, label] of Object.entries(toolLabels)) options.append(checkbox(key, label, !!saved?.items.includes(key), !tool.items.includes(key)));
    row.append(options);
    const actions = node('div', null, 'backup-actions'); actions.append(button('恢复此工具', () => restoreTool(tool, row)));
    row.append(actions); $('restoreBooks').append(row);
  }
  async function restoreTool(tool, row) {
    if (busy) return;
    const items = choices(row); if (!items.length) { status('请选择要恢复的项目', 'error'); return; }
    let message = `${tool.title}：覆盖${items.map(i => toolLabels[i]).join('、')}。未选项目保持不变。`;
    if (tool.id === 'pdf' && items.includes('settings') && tool.settings.pdf.retention_days > 0)
      message += `\n任务保留期限将设为 ${tool.settings.pdf.retention_days} 天，超期历史任务及文件会被清理。`;
    if (tool.id === 'tts') message += '\n请先停止听书。';
    if (!(await confirm('确认恢复工具', message))) return;
    await operation(async () => {
      status('正在恢复工具…', 'pending');
      if (await backupPost(preview.id, {action:'restore_tool', tool:tool.id, items, token:tool.token, confirm:true})) await waitJob(preview.id, true, 'tool-' + tool.id);
      else status('');
    });
  }
  async function confirm(title, text) {
    const dialog = $('backupConfirm'); $('restorePassword').hidden = true; $('restorePassword').value = ''; $('backupConfirmTitle').textContent = title; $('backupConfirmText').textContent = text;
    return new Promise(resolve => { dialog.returnValue = 'cancel'; dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }); dialog.showModal(); });
  }
  async function reload() { const data = await api(root); renderBooks(data.books); renderFiles(data.backups); return data; }
  async function waitJob(id, showPreview = false, clearSelectionKey = '') {
    let job;
    do {
      job = await api(`${root}/${id}`);
      status(job.message || '正在处理…', job.status === 'working' ? 'pending' : job.status === 'error' || job.comparison_warning ? 'error' : 'success');
      $('backupProgress').hidden = job.status !== 'working'; $('backupProgress').value = job.progress || 0;
      if (job.status === 'working') await new Promise(resolve => setTimeout(resolve, 1500));
    } while (job.status === 'working');
    if (showPreview && job.status === 'preview' && job.books) renderPreview(job, clearSelectionKey);
    await reload(); return job;
  }
  async function operation(run) {
    if (busy) return; setBusy(true);
    try { await run(); } catch (error) { status(error.message, 'error'); }
    finally { $('backupProgress').hidden = true; setBusy(false); }
  }
  async function track(id) { await operation(async () => { await waitJob(id); }); }
  async function openBackup(id) {
    await operation(async () => { tab('restore'); status('正在校验并对比备份…', 'pending');
      $('restoreBooks').replaceChildren(); $('compareBackup').hidden = true; preview = null; unlockedId = ''; unlockedPassword = '';
      if (await backupPost(id, { action: 'preview' })) await waitJob(id, true); else status(''); });
  }
  async function remove(job) {
    if (busy || !(await confirm('删除服务器备份', '删除这份备份文件及其服务器记录。书架中的书籍和音频不受影响。'))) return;
    await operation(async () => { status('正在删除备份…', 'pending'); await api(`${root}/${job.id}`, { method: 'DELETE' });
      if (preview?.id === job.id) { preview = null; $('restoreBooks').replaceChildren(); $('compareBackup').hidden = true; }
      await reload(); status('备份已删除', 'success'); });
  }
  async function restoreBook(book, row) {
    if (busy) return;
    const items = choices(row), audio_mode = row.querySelector('input[type="radio"]:checked')?.value || '';
    if (!items.length) { status('请选择要恢复的项目', 'error'); return; }
    if (items.includes('audio') && !audio_mode) { status('无法合并，请明确选择是否覆盖固定音频', 'error'); return; }
    if (!book.current && !items.includes('source')) { status('书架中没有原书，请同时选择原始书籍', 'error'); return; }
    if (items.includes('audio') && !book.compatible && (!items.includes('source') || !items.includes('reading'))) { status('音频与现有正文或目录不一致，请同时选择原书与目录进度书签', 'error'); return; }
    const details = items.map(key => `${labels[key]}：${key === 'audio' ? audio_mode === 'merge' ? '合并' : '覆盖固定记录' : '覆盖'}`).join('\n');
    let impact = '';
    if (book.current && !book.compatible) {
      if (items.includes('source') && !items.includes('reading')) impact = '\n\n原书变化时：重置进度，旧书签与固定标记失效。';
      else if (items.includes('reading') && !items.includes('audio')) impact = '\n\n目录变化时：旧固定标记失效。';
    }
    if (!(await confirm('确认恢复所选项目', `${book.title}\n${details}${impact}`))) return;
    await operation(async () => { status('正在恢复所选项目…', 'pending');
      if (await backupPost(preview.id, { action: 'restore', book_id: book.id, token: book.token, replace: !!book.current, items, audio_mode: audio_mode || 'merge' }))
        await waitJob(preview.id, true, 'book-' + book.id); else status(''); });
  }
  $('createBackup').addEventListener('click', () => operation(async () => {
    const books = selections(), tools = toolSelections(); if (!books.length && !tools.length) throw Error('请选择备份项目');
    const encrypted = tools.some(tool => tool.items.includes('credentials'));
    const password = encrypted ? $('backupPassword').value : '';
    if (encrypted && password.length < 12) throw Error('加密备份密码至少需要 12 个字符');
    if (encrypted && password !== $('backupPasswordAgain').value) throw Error('两次输入的备份密码不一致');
    status('正在创建备份…', 'pending'); const job = await post(root, { kind: 'selected', books, tools, password });
    $('backupPassword').value = ''; $('backupPasswordAgain').value = '';
    const done = await waitJob(job.id); if (done.status === 'ready') tab('files');
  }));
  $('selectAll').addEventListener('click', () => {
    if (busy) return;
    const groups = [$('backupBooks'), $('backupTools')];
    const inputs = groups.flatMap(group => [...group.querySelectorAll('.backup-options input:not(:disabled)')]);
    const value = inputs.some(e => !e.checked);
    inputs.forEach(e => { e.checked = value; });
    groups.forEach(group => group.querySelectorAll('.backup-options').forEach(options => options.dispatchEvent(new Event('change'))));
  });
  $('compareBackup').addEventListener('click', () => operation(async () => { if (!preview) return; status('正在刷新对比…', 'pending'); if (await backupPost(preview.id, { action: 'compare' })) await waitJob(preview.id, true); else status(''); }));
  $('refreshBackup').addEventListener('click', () => operation(async () => { status('正在刷新…', 'pending'); await reload(); status('已刷新', 'success'); }));
  $('backupFile').addEventListener('change', () => operation(async () => {
    const file = $('backupFile').files[0]; if (!file) return;
    preview = null; $('restoreBooks').replaceChildren(); $('compareBackup').hidden = true;
    status('正在上传备份…', 'pending'); const job = await post(root, { kind: 'upload' });
    try {
      $('backupProgress').hidden = false;
      for (let offset = 0; offset < file.size;) {
        const result = await api(`${root}/${job.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Offset': String(offset) }, body: file.slice(offset, offset + 4 * 1024 * 1024) });
        offset = result.offset; $('backupProgress').value = Math.round(offset / file.size * 100);
        status(`正在上传 ${Math.round(offset / file.size * 100)}%`, 'pending');
      }
      unlockedId = ''; unlockedPassword = '';
      if (await backupPost(job.id, { action: 'preview' })) await waitJob(job.id, true);
      else { await reload(); status(''); }
    } finally { $('backupFile').value = ''; }
  }));
  // Backup secrets are not login credentials: avoid password-bearing form submissions.
  $('cancelBackupConfirm').addEventListener('click', () => $('backupConfirm').close('cancel'));
  $('acceptBackupConfirm').addEventListener('click', () => $('backupConfirm').close('confirm'));
  $('restorePassword').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault(); $('backupConfirm').close('confirm');
    }
  });
  setupBackupViewport();
  renderTools();
  operation(async () => {
    status('正在读取备份…', 'pending'); await reload();
    status('');
  });
  window.TransUI.setupScrollFades(document.querySelector('.backup-panel'), '.backup-scroll');
})();
