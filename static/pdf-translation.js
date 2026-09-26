(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const csrf = document.querySelector('meta[name="csrf-token"]').content;
  // Use a non-editable entry focus, including browser history restoration.
  // Do not steal focus if the user starts interacting before the page finishes loading.
  let interacted = false;
  for (const event of ['pointerdown', 'keydown']) document.addEventListener(event, () => { interacted = true; }, {capture:true});
  window.addEventListener('pagehide', () => { interacted = false; });
  window.addEventListener('pageshow', () => {
    if (!interacted && !document.querySelector('dialog[open]')) $('pdfTitle').focus({preventScroll:true});
  });
  const activeStates = new Set(['queued', 'submitting', 'running', 'fetching', 'unknown']);
  const labels = {queued:'排队中', submitting:'提交中', running:'翻译中', fetching:'保存中', completed:'已完成', failed:'翻译失败', download_failed:'获取失败', unknown:'待核对', interrupted:'已结束', cancelled:'已取消'};
  const languages = new Map([...$('sourceLang').options].map((o) => [o.value, o.text]));
  let config = null, file = null, uploadId = '', uploading = false;
  let page = 1, generation = 0, timer = 0, searchTimer = 0, messageTimer = 0, scrollTop = 0;
  let currentJobs = new Map();
  let retentionDays = 0;
  const boolSettings = ['reuse_deepseek', 'enhance_compatibility', 'ocr', 'no_watermark', 'disable_glossary', 'translate_table_text', 'rich_text'];
  const textSettings = ['endpoint', 'model'];
  const numberSettings = ['qps', 'pool_size', 'retention_days'];
  let healthTimer = 0, healthGeneration = 0;
  const busyJobs = new Set();
  const expanded = new Map();
  const size = (bytes) => bytes < 1048576 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  function randomId() { return [...crypto.getRandomValues(new Uint8Array(16))].map((v) => v.toString(16).padStart(2, '0')).join(''); }
  function message(text, error = false, target = 'pageMessage') {
    const node = $(target);
    node.textContent = text;
    node.dataset.error = String(error);
    node.hidden = !text;
    if (target === 'pageMessage') {
      clearTimeout(messageTimer);
      if (!error) messageTimer = setTimeout(() => { node.hidden = true; }, 7000);
    }
  }
  async function api(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch(url, {...options, signal:controller.signal, headers:{'X-CSRF-Token':csrf, ...(options.body ? {'Content-Type':'application/json'} : {}), ...options.headers}});
      if (response.status === 401) { location.href = '/login'; throw new Error('登录已过期'); }
      const data = await response.json().catch(() => ({error:`服务响应异常（HTTP ${response.status}），请稍后重试`}));
      if (!response.ok || data.error) throw new Error(data.error || '请求失败');
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时，请刷新任务列表核对状态');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function openDialog(id, heading) {
    scrollTop = window.scrollY;
    document.body.style.setProperty('--pdf-scroll-top', `${-scrollTop}px`);
    document.documentElement.classList.add('pdf-modal-open');
    $(id).showModal();
    $(heading).focus({preventScroll:true});
  }
  for (const id of ['settingsDialog', 'confirmDialog', 'aboutDialog']) {
    $(id).addEventListener('close', () => {
      document.documentElement.classList.remove('pdf-modal-open');
      document.body.style.removeProperty('--pdf-scroll-top');
      window.scrollTo(0, scrollTop);
    });
  }
  function confirmAction(title, text) {
    return new Promise((resolve) => {
      $('confirmTitle').textContent = title;
      $('confirmText').textContent = text;
      $('confirmDialog').returnValue = 'cancel';
      $('confirmDialog').addEventListener('close', () => resolve($('confirmDialog').returnValue === 'confirm'), {once:true});
      openDialog('confirmDialog', 'confirmTitle');
    });
  }
  function updateUpload() {
    $('uploadBtn').disabled = uploading || !config?.ready || !file || (!$('outputMono').checked && !$('outputDual').checked);
    $('skip_last_pages').disabled = uploading;
    $('outputMono').disabled = uploading;
    $('outputDual').disabled = uploading;
    $('pdfFile').disabled = uploading;
    $('sourceLang').disabled = uploading;
    $('targetLang').disabled = uploading;
    $('uploadBtn').textContent = uploading ? '正在上传…' : '开始翻译';
  }
  for (const id of ['outputMono', 'outputDual']) $(id).addEventListener('change', updateUpload);
  function setFile(selected) {
    if (uploading) return;
    if (!selected) return;
    if (!selected.name.toLowerCase().endsWith('.pdf') || !selected.size) {
      message('请选择有效的 PDF 文件', true);
      $('pdfFile').value = '';
      file = null;
    } else {
      file = selected;
      uploadId = randomId();
      message('');
    }
    $('fileName').textContent = file ? file.name : '选择 PDF 文件';
    $('fileDetail').textContent = file ? `${size(file.size)} · 点击重新选择` : '点击上传或拖放到这里';
    updateUpload();
  }
  $('pdfFile').addEventListener('change', () => setFile($('pdfFile').files[0]));
  for (const name of ['dragenter', 'dragover']) $('dropZone').addEventListener(name, (event) => { event.preventDefault(); $('dropZone').classList.add('is-dragging'); });
  for (const name of ['dragleave', 'drop']) $('dropZone').addEventListener(name, (event) => { event.preventDefault(); $('dropZone').classList.remove('is-dragging'); });
  $('dropZone').addEventListener('drop', (event) => {
    if (event.dataTransfer.files.length !== 1) { message('一次请选择 PDF 文件', true); return; }
    setFile(event.dataTransfer.files[0]);
  });
  // Native file-input validation does not see files selected through drag and drop.
  $('uploadForm').noValidate = true;
  function upload(body) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/pdf/jobs');
      xhr.setRequestHeader('X-CSRF-Token', csrf);
      xhr.timeout = 0;
      xhr.upload.onprogress = (event) => {
        $('uploadProgress').hidden = false;
        if (event.lengthComputable) $('uploadProgress').value = event.loaded / event.total * 100;
        if (event.lengthComputable && event.loaded === event.total) {
          $('uploadProgress').removeAttribute('value');
          $('uploadBtn').textContent = '正在检查文件…';
        }
      };
      xhr.onload = () => {
        if (xhr.status === 401) { location.href = '/login'; reject(new Error('登录已过期')); return; }
        if (xhr.status === 413) { reject(new Error('上传被服务器拒绝，请检查反向代理或上游的请求大小限制')); return; }
        try {
          let data;
          try { data = JSON.parse(xhr.responseText); }
          catch { throw new Error(`上传服务响应异常（HTTP ${xhr.status}），请刷新任务列表核对`); }
          if (xhr.status < 200 || xhr.status >= 300) throw new Error(data.error || '上传失败');
          resolve(data);
        } catch (error) { reject(error); }
      };
      xhr.onerror = xhr.ontimeout = () => reject(new Error('上传连接中断，请刷新任务列表核对。再次点击上传会核对同一任务，不会重复排队。'));
      xhr.send(body);
    });
  }
  $('uploadForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (uploading || !file || !config?.ready) return;
    if ($('sourceLang').value === $('targetLang').value) { message('原文语言和目标语言不能相同', true); return; }
    if (!$('outputMono').checked && !$('outputDual').checked) { message('请至少选择一种产物', true); return; }
    if (!$('skip_last_pages').reportValidity()) return;
    const body = new FormData();
    body.append('skip_last_pages', $('skip_last_pages').value);
    if ($('outputMono').checked) body.append('outputs', 'mono');
    if ($('outputDual').checked) body.append('outputs', 'dual');
    body.append('file', file);
    body.append('source', $('sourceLang').value);
    body.append('target', $('targetLang').value);
    body.append('upload_id', uploadId);
    uploading = true;
    updateUpload();
    $('uploadProgress').hidden = false;
    $('uploadProgress').value = 0;
    try {
      await upload(body);
      file = null;
      $('pdfFile').value = '';
      $('fileName').textContent = '选择 PDF 文件';
      $('fileDetail').textContent = '点击上传或拖放到这里';
      selectTaskTab('active');
      page = 1;
      $('searchJobs').value = '';
      $('statusFilter').value = '';
      message('已加入队列，关闭页面后仍会继续处理');
      await loadJobs();
    } catch (error) { message(error.message, true); }
    finally { uploading = false; $('uploadProgress').hidden = true; updateUpload(); }
  });
  function applyConfig(next, fill = false) {
    if (config === null) $('skip_last_pages').value = next.skip_last_pages ?? 0;
    config = next;
    $('serviceState').hidden = config.ready;
    $('serviceState').textContent = config.endpoint ? '请在服务配置中完善 DeepSeek 配置' : '请先配置 PDF2zh 服务地址';
    if (fill) {
      for (const key of boolSettings) $(key).checked = config[key];
      for (const key of [...textSettings, ...numberSettings]) $(key).value = config[key];
      for (const key of ['api_key']) {
        $(key).value = '';
        $(key).placeholder = config['has_' + key] ? '已配置，留空不修改' : '未配置，请填写正确的 API Key';
      }
      $('sharedConfigInfo').textContent = `${config.shared_key_available ? '在线翻译 API Key 已配置' : '在线翻译尚未配置 API Key'}${config.shared_official_endpoint ? '' : ' · 请改用独立的 DeepSeek 官方密钥'}`;
      $('ownCredentials').hidden = $('reuse_deepseek').checked;
      $('sharedConfigInfo').hidden = !$('reuse_deepseek').checked;
      $('reasoning').value = config.thinking === 'enabled' ? config.reasoning_effort : 'disabled';
      updateThinking();
    }
    updateUpload();
  }
  function updateThinking() {
    const supported = $('model').value === 'deepseek-v4-pro';
    if (!supported) $('reasoning').value = 'disabled';
    $('reasoning').disabled = !supported;
  }
  $('model').addEventListener('change', updateThinking);
  let helpAnchor = null;
  function closeHelp() {
    if (helpAnchor) {
      helpAnchor.setAttribute('aria-expanded', 'false');
      helpAnchor.removeAttribute('aria-describedby');
    }
    helpAnchor = null;
    $('pdfHelpPopup').hidden = true;
  }
  function placeHelp() {
    if (!helpAnchor || !$('settingsDialog').open) return closeHelp();
    const popup = $('pdfHelpPopup');
    const bounds = $('settingsDialog').getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = Math.max(bounds.left, viewport?.offsetLeft || 0) + 10;
    const right = Math.min(bounds.right, (viewport?.offsetLeft || 0) + (viewport?.width || innerWidth)) - 10;
    const top = Math.max(bounds.top, viewport?.offsetTop || 0) + 10;
    const bottom = Math.min(bounds.bottom, (viewport?.offsetTop || 0) + (viewport?.height || innerHeight)) - 10;
    if (right <= left || bottom <= top) return closeHelp();
    popup.style.width = `${Math.min(300, right - left)}px`;
    popup.style.maxHeight = `${bottom - top}px`;
    popup.style.left = '0px';
    popup.style.top = '0px';
    popup.hidden = false;
    const anchor = helpAnchor.getBoundingClientRect();
    const visible = $('settingsDialog').querySelector('.pdf-settings-scroll').getBoundingClientRect();
    if (anchor.bottom < visible.top || anchor.top > visible.bottom) return closeHelp();
    const rect = popup.getBoundingClientRect();
    let y = anchor.bottom + 8;
    if (y + rect.height > bottom) y = anchor.top - rect.height - 8;
    // Dialog filters can make fixed children relative to the dialog, not the viewport.
    popup.style.left = `${Math.max(left, Math.min(anchor.left, right - rect.width)) - rect.left}px`;
    popup.style.top = `${Math.max(top, Math.min(y, bottom - rect.height)) - rect.top}px`;
  }
  document.querySelectorAll('.pdf-help').forEach((button) => {
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      const closing = helpAnchor === button;
      closeHelp();
      if (closing) return;
      helpAnchor = button;
      button.setAttribute('aria-expanded', 'true');
      button.setAttribute('aria-describedby', 'pdfHelpPopup');
      $('pdfHelpPopup').textContent = button.dataset.help;
      placeHelp();
    });
  });
  $('settingsDialog').addEventListener('click', (event) => {
    if (!event.target.closest('.pdf-help, #pdfHelpPopup')) closeHelp();
  });
  $('settingsDialog').addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && helpAnchor) {
      event.preventDefault(); event.stopPropagation(); closeHelp();
    }
  });
  $('settingsDialog').addEventListener('cancel', (event) => {
    if (helpAnchor) { event.preventDefault(); closeHelp(); }
  });
  $('settingsDialog').addEventListener('close', closeHelp);
  $('settingsDialog').querySelector('.pdf-settings-scroll').addEventListener('scroll', placeHelp);
  window.addEventListener('resize', placeHelp);
  window.visualViewport?.addEventListener('resize', placeHelp);
  window.visualViewport?.addEventListener('scroll', placeHelp);
  async function checkConnection(force = false) {
    clearTimeout(healthTimer);
    const sequence = ++healthGeneration;
    try {
      const result = await api(force ? '/api/pdf/health?refresh=1' : '/api/pdf/health');
      if (sequence !== healthGeneration) return;
      $('connectionState').textContent = result.ok ? `已连接 · PDF2zh ${result.version}` : '未连接';
      $('connectionState').dataset.state = result.ok ? 'connected' : 'disconnected';
      $('connectionState').title = result.ok ? `PDF2zh 服务 v${result.version}` : '请检查服务地址与运行状态';
    } catch {
      if (sequence !== healthGeneration) return;
      $('connectionState').textContent = '未连接'; $('connectionState').dataset.state = 'disconnected';
      $('connectionState').title = '无法获取服务状态，请检查 Trans 与上游连接';
    } finally { if (sequence === healthGeneration && !document.hidden) healthTimer = setTimeout(checkConnection, 30000); }
  }
  $('reuse_deepseek').addEventListener('change', () => { $('ownCredentials').hidden = $('reuse_deepseek').checked; $('sharedConfigInfo').hidden = !$('reuse_deepseek').checked; });
  $('settingsBtn').addEventListener('click', async () => {
    $('settingsBtn').disabled = true;
    try { applyConfig((await api('/api/pdf/config')).config, true); delete $('saveConfig').dataset.retention; message('', false, 'configMessage'); openDialog('settingsDialog', 'settingsTitle'); }
    catch (error) { message(error.message, true); }
    finally { $('settingsBtn').disabled = false; }
  });
  $('closeSettings').addEventListener('click', () => $('settingsDialog').close());
  $('settingsForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if ($('saveConfig').disabled) return;
    const body = {
      thinking: $('reasoning').value === 'disabled' ? 'disabled' : 'enabled',
      reasoning_effort: $('reasoning').value === 'disabled' ? (config.reasoning_effort || 'high') : $('reasoning').value,
      json_mode: false,
    };
    for (const key of boolSettings) body[key] = $(key).checked;
    for (const key of [...textSettings, 'api_key']) body[key] = $(key).value;
    for (const key of numberSettings) body[key] = Number($(key).value);
    if (body.retention_days > 0 && body.retention_days !== config.retention_days) {
      // Keep confirmation within the settings dialog, including the destructive effect on older files.
      const warning = `保存后，结束满 ${body.retention_days} 天的任务记录、上传的原文 PDF 和生成的译文／对照 PDF 将自动删除，现有历史任务也适用。再次点击“保存”确认。`;
      if ($('saveConfig').dataset.retention !== String(body.retention_days)) {
        $('saveConfig').dataset.retention = String(body.retention_days);
        message(warning, true, 'configMessage'); return;
      }
    }
    $('saveConfig').disabled = true;
    try {
      const data = await api('/api/pdf/config', {method:'PUT', body:JSON.stringify(body)});
      applyConfig(data.config, true);
      delete $('saveConfig').dataset.retention;
      message('配置已保存', false, 'configMessage');
      checkConnection();
      await loadJobs();
    } catch (error) { message(error.message, true, 'configMessage'); }
    finally { $('saveConfig').disabled = false; }
  });
  $('testService').addEventListener('click', async () => {
    $('testService').disabled = true;
    message('正在测试连接…', false, 'configMessage');
    try { const result = await api('/api/pdf/health', {method:'POST', body:JSON.stringify({endpoint:$('endpoint').value})}); message(`连接正常 · 服务 v${result.version}`, false, 'configMessage'); }
    catch (error) { message(error.message, true, 'configMessage'); }
    finally { $('testService').disabled = false; }
  });
  $('aboutBtn').addEventListener('click', () => openDialog('aboutDialog', 'aboutTitle'));
  $('closeAbout').addEventListener('click', () => $('aboutDialog').close());
  function node(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function jobCard(job) {
    const card = node('article', 'pdf-job');
    card.dataset.id = job.id;
    const head = node('div', 'pdf-job-head');
    const status = node('span', 'pdf-job-state', labels[job.status] || job.status);
    status.dataset.state = job.status;
    const badges = node('div', 'pdf-job-badges');
    badges.append(status);
    head.append(node('h3', '', job.filename), badges);
    card.append(head, node('p', 'pdf-job-meta', `${languages.get(job.source) || job.source} → ${languages.get(job.target) || job.target} · ${job.pages} 页 · ${size(job.input_bytes)}`));
    const percent = !job.poll_warning && typeof job.progress === 'number' && activeStates.has(job.status) ? ` · ${Math.round(job.progress)}%` : '';
    if (job.status !== 'completed') card.append(node('p', 'pdf-job-phase', (job.poll_warning ? '上次状态：' : '') + (job.delete_requested ? `${job.phase} · 结束后删除` : job.phase) + percent));
    if (job.poll_warning) card.append(node('p', 'pdf-job-sync-warning', job.poll_warning));
    if (activeStates.has(job.status) && job.status !== 'unknown') {
      const bar = node('progress', '');
      bar.max = 100;
      bar.setAttribute('aria-label', job.status === 'submitting' ? '发送到翻译服务的进度' : '任务进度');
      if (!job.poll_warning && typeof job.progress === 'number') bar.value = job.progress;
      card.append(bar);
    }
    const detail = node('details', 'pdf-task-details');
    detail.dataset.job = job.id;
    detail.open = expanded.has(job.id) ? expanded.get(job.id) : activeStates.has(job.status);
    detail.append(node('summary', '', '任务详情'));
    const grid = node('dl', 'pdf-detail-grid');
    const date = (value) => value ? new Date(value * 1000).toLocaleString('zh-CN', {hour12:false}) : '—';
    const seconds = Math.max(0, Math.floor(((job.finished || Date.now() / 1000) - (job.submitted || job.created))));
    const duration = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
    for (const [label, value] of [
      ['引擎 / 模型', `pdf2zh_next / ${job.model}`], ['语言', `${languages.get(job.source) || job.source} → ${languages.get(job.target) || job.target}`],
      ['页数 / 文件大小', `${job.pages} 页 / ${size(job.input_bytes)}`], ['每秒请求数', String(job.qps)],
      ['创建时间', date(job.created)], ['开始时间', date(job.submitted)],
      [job.finished ? '完成时间' : '当前状态', job.finished ? date(job.finished) : labels[job.status]],
      ['产物', (job.outputs || ['mono', 'dual']).map((kind) => kind === 'mono' ? '译文 PDF' : '左右对照 PDF').join('、')],
      [job.finished ? '总耗时' : job.submitted ? '已历时' : '等待时间', duration],
    ]) {
      const pair = node('div', ''); pair.append(node('dt', '', label), node('dd', '', value)); grid.append(pair);
    }
    const settings = job.settings || {};
    const toggle = (key, invert = false) => typeof settings[key] === 'boolean' ?
      ((invert ? !settings[key] : settings[key]) ? '开启' : '关闭') : '未记录';
    let thinking = '未记录';
    if (settings.thinking) {
      thinking = settings.thinking === 'enabled' && job.model === 'deepseek-v4-pro' ?
        ({high:'高', max:'最高'}[settings.reasoning_effort] || '开启') : '关闭';
    }
    for (const [label, value] of [
      ['API Key 来源', typeof settings.reuse_deepseek === 'boolean' ? (settings.reuse_deepseek ? '沿用在线翻译' : '独立配置') : '未记录'],
      ['思考强度', thinking],
      ['并发 Worker', settings.pool_size === 0 ? `跟随 QPS（${job.qps}）` : String(settings.pool_size ?? '未记录')],
      ['跳过末尾页数', String(settings.skip_last_pages ?? '未记录')],
      ['OCR 兼容模式', toggle('ocr')], ['无水印模式', toggle('no_watermark')],
      ['自动术语提取', toggle('disable_glossary', true)], ['翻译表格文本', toggle('translate_table_text')],
      ['保留富文本样式', toggle('rich_text')], ['增强 PDF 兼容性', toggle('enhance_compatibility')],
    ]) {
      const pair = node('div', ''); pair.append(node('dt', '', label), node('dd', '', value)); grid.append(pair);
    }
    detail.append(grid);
    card.append(detail);
    if (!activeStates.has(job.status)) {
      let text = '永久保留';
      let expires = 0;
      if (retentionDays > 0) {
        expires = job.finished ? (job.finished + retentionDays * 86400) * 1000 : 0;
        const remaining = expires - Date.now();
        text = !expires ? '结束时间缺失，暂不自动删除' : remaining <= 0 ? '已到保留期限，等待自动删除' :
          remaining >= 86400000 ? `约 ${Math.ceil(remaining / 86400000)} 天后自动删除` :
          remaining >= 3600000 ? `约 ${Math.ceil(remaining / 3600000)} 小时后自动删除` :
          `约 ${Math.max(1, Math.ceil(remaining / 60000))} 分钟后自动删除`;
      }
      const retention = node('span', 'pdf-retention', text);
      if (expires) retention.title = `到期时间：${new Date(expires).toLocaleString('zh-CN', {hour12:false})}；到期后由后台清理`;
      badges.prepend(retention);
    }
    const hasOutputs = ['mono', 'dual'].some((kind) => job.files[kind]);
    const actions = node('div', hasOutputs ? 'pdf-job-actions pdf-result-actions' : 'pdf-job-actions');
    for (const [kind, label] of [['mono', '译文'], ['dual', '左右对照']]) {
      if (!job.files[kind]) continue;
      const output = node('div', 'pdf-output-row');
      const heading = node('span', 'pdf-output-label', label);
      const controls = node('div', 'pdf-output-controls');
      const link = node('a', 'ghost pdf-download pdf-result-download');
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4');
      icon.append(path);
      link.append(icon, node('span', '', '下载'));
      link.setAttribute('aria-label', '下载' + label);
      link.title = size(job.files[kind].bytes);
      link.href = job.files[kind].url;
      link.setAttribute('download', '');
      const preview = node('a', 'ghost pdf-result-preview');
      const eye = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      eye.setAttribute('viewBox', '0 0 24 24'); eye.setAttribute('aria-hidden', 'true');
      const outline = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      outline.setAttribute('d', 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z');
      const pupil = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      pupil.setAttribute('cx', '12'); pupil.setAttribute('cy', '12'); pupil.setAttribute('r', '3');
      eye.append(outline, pupil); preview.append(eye, node('span', '', '预览'));
      preview.href = job.files[kind].url + '?preview=1';
      preview.target = '_blank'; preview.rel = 'noopener noreferrer';
      preview.setAttribute('aria-label', '预览' + label);
      controls.append(link, preview); output.append(heading, node('span', 'pdf-output-size', size(job.files[kind].bytes)), controls); actions.append(output);
    }
    const button = (action, label) => {
      const control = node('button', action === 'delete' ? 'danger-btn pdf-delete' : 'ghost', label);
      control.type = 'button'; control.dataset.action = action; control.dataset.id = job.id;
      control.disabled = busyJobs.has(job.id);
      actions.append(control);
      return control;
    };
    if (activeStates.has(job.status) && job.upstream_url) {
      const link = node('a', 'ghost pdf-download', '打开上游');
      link.href = job.upstream_url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      actions.append(link);
    }
    if (activeStates.has(job.status)) {
      const cancel = button('cancel', '取消');
      if (!['queued', 'unknown'].includes(job.status)) {
        cancel.disabled = true;
        cancel.title = '上游不提供停止接口，已开始的任务需等待结束';
        actions.append(node('span', 'pdf-note', '已提交上游，暂不支持中途取消'));
      }
    }
    if (!job.delete_requested && (['download_failed', 'unknown'].includes(job.status) || (job.status === 'completed' && (job.outputs || ['mono', 'dual']).some((kind) => !job.files[kind])))) button('retry_download', '取回结果');
    if (!activeStates.has(job.status) && !job.delete_requested) button('delete', '删除');
    card.append(actions);
    return card;
  }
  async function loadJobs() {
    clearTimeout(timer);
    const sequence = ++generation;
    let delay = 30000;
    try {
      const params = new URLSearchParams({q:$('searchJobs').value.trim(), status:$('statusFilter').value, page:String(page), scope:'history'});
      const data = await api('/api/pdf/jobs?' + params);
      if (sequence !== generation) return;
      if (page > 1 && !data.jobs.length) { page = Math.max(1, Math.ceil(data.total / 20)); return loadJobs(); }
      retentionDays = Number(data.retention_days ?? config?.retention_days) || 0;
      currentJobs = new Map([...data.active_jobs, ...data.jobs].map((job) => [job.id, job]));
      for (const [id, rows, empty] of [['activeJobs', data.active_jobs, '暂无进行中的任务'], ['historyJobs', data.jobs, $('searchJobs').value || $('statusFilter').value ? '没有符合条件的任务' : '暂无历史任务']]) {
        const markup = node('div', '');
        for (const job of rows) markup.append(jobCard(job));
        if (!rows.length) markup.append(node('div', 'pdf-empty', empty));
        if ($(id).innerHTML !== markup.innerHTML) {
          const focus = document.activeElement?.closest('[data-action], summary');
          const focusId = focus?.dataset.id || focus?.closest('details')?.dataset.job;
          const focusAction = focus?.dataset.action;
          const inside = focus && $(id).contains(focus);
          $(id).replaceChildren(...markup.childNodes);
          if (inside && focusId) $(id).querySelector(focusAction ? `[data-id="${focusId}"][data-action="${focusAction}"]` : `details[data-job="${focusId}"] summary`)?.focus({preventScroll:true});
        }
      }
      $('activeCount').textContent = data.active_jobs.length;
      $('historyCount').textContent = data.total;
      $('pagination').hidden = data.total <= 20;
      $('pageInfo').textContent = `${page} / ${Math.max(1, Math.ceil(data.total / 20))}`;
      $('prevPage').disabled = page <= 1;
      $('nextPage').disabled = page * 20 >= data.total;
      delay = data.active_jobs.length ? 3000 : 30000;
    } catch (error) { if (sequence === generation) message(error.message, true); delay = 15000; }
    finally { if (sequence === generation && !document.hidden) timer = setTimeout(loadJobs, delay); }
  }
  function selectTaskTab(name) {
    for (const key of ['active', 'history']) {
      const selected = key === name;
      $(key + 'Tab').setAttribute('aria-selected', String(selected));
      $(key + 'Tab').tabIndex = selected ? 0 : -1;
      $(key + 'Panel').hidden = !selected;
    }
    $('jobs').scrollTop = 0;
  }
  for (const name of ['active', 'history']) {
    $(name + 'Tab').addEventListener('click', () => selectTaskTab(name));
    $(name + 'Tab').addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'active' : event.key === 'End' ? 'history' : name === 'active' ? 'history' : 'active';
      selectTaskTab(next); $(next + 'Tab').focus();
    });
  }
  $('jobs').addEventListener('toggle', (event) => {
    if (event.target.matches('details[data-job]') && event.target.isConnected) expanded.set(event.target.dataset.job, event.target.open);
  }, true);
  $('jobs').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    const job = currentJobs.get(button.dataset.id);
    const action = button.dataset.action;
    if (!job || busyJobs.has(job.id)) return;
    busyJobs.add(job.id);
    button.disabled = true;
    try {
      if (action === 'delete') {
        if (!await confirmAction('删除任务与文件？', '将删除此任务记录、上传原文和已生成结果，无法恢复。上游副本需单独清理。')) return;
      }
      if (action === 'cancel' && job.status === 'unknown' && !await confirmAction('核对后取消任务？', '请先打开上游，确认任务未创建或已经结束。取消只结束 Trans 的跟踪并恢复队列，保留原文件，不会停止上游任务，也不会重新翻译。')) return;
      if (action === 'retry_download' && job.status === 'unknown' && !await confirmAction('确认结果已生成完整？', '请先确认上游已结束且所选 PDF 已完整生成。此操作只取回文件，不会重新翻译。')) return;
      if (action === 'delete') await api('/api/pdf/jobs/' + job.id, {method:'DELETE'});
      else await api('/api/pdf/jobs/' + job.id + '/action', {method:'POST', body:JSON.stringify({action})});
      message(action === 'delete' ? '已处理删除请求；上游副本需单独清理' : action === 'retry_download' ? '正在取回结果，不会重新翻译' : '操作已完成');
    } catch (error) { message(error.message, true); }
    finally { busyJobs.delete(job.id); await loadJobs(); }
  });
  $('searchJobs').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { page = 1; loadJobs(); }, 300); });
  $('statusFilter').addEventListener('change', () => { page = 1; loadJobs(); });
  $('refreshBtn').addEventListener('click', loadJobs);
  $('prevPage').addEventListener('click', () => { if (page > 1) { page--; loadJobs(); } });
  $('nextPage').addEventListener('click', () => { page++; loadJobs(); });
  document.addEventListener('visibilitychange', () => { clearTimeout(timer); clearTimeout(healthTimer); if (!document.hidden) { loadJobs(); checkConnection(); } });
  window.addEventListener('pageshow', (event) => { if (event.persisted) { loadJobs(); checkConnection(); } });
  (async () => { applyConfig((await api('/api/pdf/config')).config); checkConnection(true); await loadJobs(); })().catch((error) => message(error.message, true));
})();
