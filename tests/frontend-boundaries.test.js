/* Exercise real page functions with isolated DOM/request doubles, without a server. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createFeedback } = require('../static/ui-feedback');
const { createQueue } = require('../static/translation-state');
const settle = () => new Promise(resolve => setImmediate(resolve));
function code(file, start, end) {
  const source = fs.readFileSync(path.join(__dirname, '../static', file), 'utf8');
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert(from >= 0 && to > from);
  return source.slice(from, to);
}
function dom() {
  const nodes = new Map();
  return id => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { dataset: {}, textContent: '', hidden: true, disabled: false, className: '',
        close() {}, setAttribute() {}, removeAttribute() {},
        classList: { add: k => classes.add(k), remove: k => classes.delete(k), contains: k => classes.has(k) } });
    }
    return nodes.get(id);
  };
}
function clock() {
  const timers = new Map(); let serial = 0;
  return { timers, setTimeout(fn) { timers.set(++serial, fn); return serial; }, clearTimeout(id) { timers.delete(id); },
    setInterval() {}, clearInterval() {} };
}

test('empty local downloads need no server counts, but unindexed audio stays unverified', async () => {
  let keys = [];
  const db = { transaction() {
    const transaction = { objectStore: () => ({
      getAllKeys() { const request = {}; queueMicrotask(() => { request.result = keys; request.onsuccess(); }); return request; },
      openCursor() { const request = {}; queueMicrotask(() => { request.result = null; request.onsuccess(); }); return request; },
    }) };
    queueMicrotask(() => queueMicrotask(() => transaction.oncomplete()));
    return transaction;
  } };
  const context = vm.createContext({ readerState: { books: [{ id: 'new-book' }] },
    openTtsOfflineDb: async () => db, statisticsBookAudio: () => null,
    TTS_OFFLINE_PACK_STORE: 'packs', TTS_OFFLINE_PACK_META_STORE: 'metadata' });
  vm.runInContext(code('reader.js', 'async function localAudioStatistics(', 'async function refreshAudioStatistics('), context);
  let result = (await context.localAudioStatistics({})).get('new-book');
  assert.equal(result.unknown, false); assert.equal(result.coverage_percent, 0);
  keys = ['new-book:pack'];
  result = (await context.localAudioStatistics({})).get('new-book');
  assert.equal(result.unknown, true); assert.equal(result.size_known, false);
});

test('PDF initial network failure retries and clears its own error after recovery', async () => {
  const $ = dom(), time = clock();
  $('searchJobs').value = ''; $('statusFilter').value = '';
  let available = false, checks = 0;
  const feedback = createFeedback(time);
  const context = vm.createContext({ $, ...time, URLSearchParams, document: { hidden: false },
    window: { TransUI: feedback }, config: null, page: 1, timer: 0, generation: 0, retentionDays: 0,
    currentJobs: new Map(), node: () => ({ innerHTML: '', childNodes: [], append() {} }),
    api: async url => {
      if (!available) throw Error('网络连接失败');
      return url === '/api/pdf/config' ? { config: { ready: true } } : { jobs: [], active_jobs: [], total: 0 };
    }, checkConnection: () => { checks++; },
    message(text, error, target = 'pageMessage', type, source = '') {
      $(target).dataset.source = source; feedback.feedback($(target), text, error ? 'error' : type);
    },
  });
  for (const id of ['activeJobs', 'historyJobs']) $(id).innerHTML = '';
  context.applyConfig = config => { context.config = config; };
  vm.runInContext(code('pdf-translation.js', '  async function loadJobs(', '  function selectTaskTab('), context);
  await context.loadJobs();
  assert.equal($('jobsMessage').dataset.feedback, 'error'); assert.equal(time.timers.size, 1);
  assert.equal(context.config, null);
  available = true; await context.loadJobs();
  assert.equal(context.config.ready, true); assert.equal(checks, 1);
  assert.equal($('jobsMessage').textContent, ''); assert.equal(time.timers.size, 1);
});

test('import completion stays visible without scheduling expiry across polling', async () => {
  const $ = dom(), time = clock(), notices = [];
  let now = 100000;
  const state = { importJobs: [{ id: 'book', status: 'parsing' }], localImportJobs: [], dismissedImportJobs: new Set() };
  $('manageDialog').open = true;
  const context = vm.createContext({ $, readerState: state, window: time, Date: { now: () => now },
    api: async () => ({ jobs: [{ id: 'book', status: 'done', updated_at: 99 }] }),
    renderImportJobs() {}, loadBooks: async () => {}, activeImportCount: () => 0,
    setUploadMessage: (...args) => notices.push(args),
  });
  vm.runInContext(code('reader.js', 'async function loadImportJobs()', 'function startImportPolling()'), context);
  await context.loadImportJobs();
  assert.deepEqual(notices, [['导入完成', 'success', 0]]);
  now = 3600000; await context.loadImportJobs();
  assert.equal(state.importJobs[0].status, 'done'); assert.equal(notices.length, 1);
  $('uploadForm').classList.toggle = () => {};
  $('uploadMessage').textContent = '导入完成'; $('uploadMessage').dataset.feedback = 'success';
  context.escapeHtml = String;
  vm.runInContext(code('reader.js', 'function statusText(job)', 'async function loadImportJobs()'), context);
  context.renderImportJobs();
  assert.equal($('importJobs').hidden, false);
  assert.match($('importJobs').innerHTML, /导入完成/);
  assert.equal(time.timers.size, 0);
  $('manageDialog').open = false;
  context.renderImportJobs();
  assert.equal($('importJobs').hidden, true);
  $('manageDialog').open = true;
  await context.loadImportJobs();
  context.renderImportJobs();
  assert.equal($('importJobs').hidden, true);
  assert.equal(notices.length, 1);
  state.importJobs.push({ id: 'active', status: 'parsing' });
  context.renderImportJobs();
  assert.equal($('importJobs').hidden, false);
});

test('progress conflicts remain visible and a late old-book response cannot affect another book', async () => {
  const $ = dom(), time = clock();
  const session = { bookId: 'a', writer: 'writer-a', version: 0, sequence: 0, acknowledged: 0 };
  const state = { currentBookId: 'a', currentChapter: 0, progressSentence: 0, progressSession: session,
    currentBook: {}, progressRequests: new Map(), lastProgressKey: '' };
  let calls = 0;
  const context = vm.createContext({ $, readerState: state, AbortController, setStatus() {},
    window: { ...time, TransUI: createFeedback(time) },
    api: async () => { calls++; throw Object.assign(Error('其他页面已更新进度，请重新打开本书后继续同步'), { code: 'progress_conflict' }); } });
  vm.runInContext(code('reader.js', 'function renderProgressNotice()', 'const PLAYBACK_DIAGNOSTIC_KEY'), context);
  const snapshot = { bookId: 'a', chapter: 0, sentence: 0, percent: 0, contentRevision: 'r', progressSession: session };
  await context.saveProgress(snapshot);
  assert.equal(session.blocked, true);
  assert.equal($('readerProgressMessage').hidden, false);
  assert.match($('readerProgressMessage').textContent, /最新进度/);
  assert.equal($('readerProgressNotice').hidden, false);
  let jump;
  context.openBook = async (...args) => { jump = args; };
  await context.resumeLatestProgress();
  assert.deepEqual(jump, ['a', 0, 0, false, true]);
  assert.equal($('resumeLatestProgressBtn').disabled, false);
  await context.saveProgress(snapshot); assert.equal(calls, 1);
  state.progressSession = { ...session, blocked: false, message: '' };
  context.renderProgressNotice(); assert.equal($('readerProgressMessage').hidden, true);
  let reject;
  context.api = () => new Promise((_, no) => { reject = no; });
  const saving = context.saveProgress({ ...snapshot, progressSession: state.progressSession });
  state.currentBookId = 'b'; state.progressSession = { bookId: 'b' };
  reject(Object.assign(Error('过期响应'), { code: 'progress_conflict' }));
  await saving;
  assert.equal($('readerProgressMessage').hidden, true);
  assert.equal(state.progressSession.blocked, undefined);
});

test('explicit progress recovery uses the server position instead of a stale shelf position', async () => {
  const $ = dom(), time = clock();
  const state = { navigationRequest: 0, progressRequests: new Map(), books: [{ id: 'a', progress: { chapter: 1, sentence: 2 } }] };
  let position;
  const context = vm.createContext({ $, readerState: state, window: time,
    flushPendingProgress() {}, stopListening() {}, setStatus() {}, renderProgressNotice() {},
    prepareReadingOffsets() {}, renderBooks() {}, renderChapterSelect() {}, showReadingView() {},
    api: async () => ({ book: { id: 'a', progress_version: 12, progress: { chapter: 4, sentence: 7 } }, chapters: [] }),
    loadChapter: async (...args) => { position = args; },
  });
  vm.runInContext(code('reader.js', 'async function openBook(', 'function syncReaderNavigation('), context);
  await context.openBook('a', 0, 0, false, true);
  assert.deepEqual(position, [4, 7]);
  assert.equal(state.progressSession.version, 12);
  assert.equal(state.progressSession.blocked, false);
});

test('same text after saving credentials cannot reuse the old in-flight request', async () => {
  const $ = dom(), time = clock(), calls = [], rendered = [], releases = [];
  $('sourceText').value = 'Hello'; $('sourceLang').value = 'en';
  $('targetLang').value = 'zh'; $('targetLang').selectedOptions = [{ textContent: '中文' }];
  const queue = createQueue(async (job, current) => {
    calls.push(job.key); await new Promise(resolve => releases.push(resolve));
    if (current()) rendered.push(job.key);
  }, assert.fail, time);
  const state = { config: { deepseek: { api_key_configured: true } }, configRevision: 0, automatic: true };
  const context = vm.createContext({ $, state, translationQueue: queue,
    selectedEngines: () => ['deepseek'], sourceForRequest: () => 'en',
    applyVisualSentenceHighlight() {}, syncTargetForSource() {}, setStatus() {} });
  vm.runInContext(code('app.js', 'function scheduleTranslate(', 'async function runTranslation('), context);
  const fire = () => { const pending = [...time.timers.values()]; time.timers.clear(); pending.forEach(fn => fn()); };
  context.scheduleTranslate(0); fire();
  queue.cancel(); state.configRevision++;
  context.scheduleTranslate(0); fire();
  releases.shift()(); await settle();
  assert.equal(calls.length, 2); assert.notEqual(calls[0], calls[1]);
  releases.shift()(); await settle();
  assert.deepEqual(rendered, [calls[1]]);
});

test('reusing an active translation after viewing history does not mix historical results', async () => {
  let resolveTranslation, saved, shells = 0;
  const state = { currentResults: [], resultContext: null };
  const context = vm.createContext({ state,
    translateWithEngine: () => new Promise(resolve => { resolveTranslation = resolve; }),
    engineName: id => id, renderEngineShells: () => { shells++; }, setStatus() {},
    updateDetectedSource() {}, updateResultCard() {}, updateTranslationStatus: () => 1,
    saveHistory: async entry => { saved = entry; },
  });
  vm.runInContext(code('app.js', 'async function runTranslation(', 'async function saveConfig()'), context);
  const task = context.runTranslation({ text: 'New source', source: 'en', target: 'zh',
    targetName: '中文', engines: ['google'], config: '{}', context: 'new', partial: false }, () => true);
  state.currentResults = [{ engine: 'deepseek', text: 'Old historical translation', ok: true }];
  state.resultContext = null;
  resolveTranslation({ text: '新的译文' }); await task;
  assert.deepEqual(Array.from(saved.results, result => result.engine), ['google']);
  assert.equal(state.resultContext, 'new'); assert.equal(shells, 2);
});

test('an outstanding monitor refresh cannot replace the restart progress message', async () => {
  const $ = dom(), time = clock(); let resolveStatus;
  const context = vm.createContext({ $, Date, monitorRequestId: 0, monitorAppliedRequestId: 0, monitorTimer: null,
    window: { ...time, TransUI: createFeedback(time) }, renderServiceStatus() {},
    api: async url => {
      if (url === '/api/status') return new Promise(resolve => { resolveStatus = resolve; });
      if (url === '/api/restart') return { pid: 1, started: 1 };
      if (url === '/api/ready') return { pid: 2, started: 2 };
      throw Error('Unexpected request');
    } });
  vm.runInContext(code('home.js', 'function setMonitorMessage(', 'function renderServiceStatus(')
    + code('home.js', 'async function loadServiceStatus(', 'function openRestartConfirmation(')
    + code('home.js', 'function setRestartBusy(', 'let homeScrollPosition'), context);
  const refreshing = context.loadServiceStatus(true, true);
  await context.restartService();
  resolveStatus({}); await refreshing;
  assert.match($('monitorMessage').textContent, /正在重启/);
  assert.equal($('refreshStatusBtn').disabled, true);
  const poll = [...time.timers.values()][0]; time.timers.clear(); await poll();
  assert.equal($('monitorMessage').textContent, '服务已恢复');
  assert.equal($('refreshStatusBtn').disabled, false);
});

test('clearing source text also clears results in manual translation mode', () => {
  const $ = dom(); $('sourceText').value = '  ';
  let cancelled = false, cleared = false;
  const state = { config: {}, automatic: false, currentResults: [{ text: '旧译文' }], resultContext: 'old' };
  const context = vm.createContext({ $, state, selectedEngines: () => ['deepseek'],
    translationQueue: { cancel() { cancelled = true; }, schedule: assert.fail },
    applyVisualSentenceHighlight() {}, setStatus() {}, renderEngineShells() { cleared = true; } });
  vm.runInContext(code('app.js', 'function scheduleTranslate(', 'async function runTranslation('), context);
  context.scheduleTranslate();
  assert.equal(cancelled, true); assert.equal(cleared, true);
  assert.equal(state.currentResults.length, 0); assert.equal(state.resultContext, null);
});

test('bookmark writes cannot overlap and refresh again if a newer read saw an old list', async () => {
  const $ = dom(), buttons = [{ disabled: false }, { disabled: false }];
  let completeWrite, calls = [];
  const context = vm.createContext({ $, bookmarkBusy: false, generation: 0, bookId: 'a', mode: 'bookmarks',
    bookmarks: [], readerState: { currentBookId: 'a' }, dialog: { open: true }, status: {}, renderBookmarks() {},
    results: { replaceChildren() {}, querySelectorAll: () => buttons },
    api: async (_, options) => {
      calls.push(options.method || 'GET');
      if (options.method) return new Promise(resolve => { completeWrite = resolve; });
      return { bookmarks: [] };
    } });
  vm.runInContext(code('reader-tools.js', '  async function loadBookmarks(', '  function renderBookmarks('), context);
  const writing = context.loadBookmarks({ method: 'DELETE' });
  assert.equal(buttons.every(button => button.disabled), true);
  await context.loadBookmarks({ method: 'POST' });
  assert.deepEqual(calls, ['DELETE']);
  await context.loadBookmarks();
  completeWrite({ bookmarks: [] }); await writing; await settle();
  assert.deepEqual(calls, ['DELETE', 'GET', 'GET']);
  assert.equal(buttons.every(button => !button.disabled), true);
});

test('bookmarks follow the selected sentence independently of viewport progress', () => {
  const state = { currentBook: { content_revision: 'r1' },
    currentChapter: 0, currentSentence: 38, progressSentence: 42 };
  const context = vm.createContext({ readerState: state });
  vm.runInContext(code('reader-tools.js', '  function currentBookmarkPosition()', "  $('addBookmarkBtn').addEventListener"), context);
  assert.equal(context.currentBookmarkPosition().sentence, 38);
  state.progressSentence = 46; // Scrolling changes reading progress, not the selected sentence.
  assert.equal(context.currentBookmarkPosition().sentence, 38);
  state.currentSentence = 45; // Selecting another sentence changes the bookmark target.
  assert.equal(context.currentBookmarkPosition().sentence, 45);
  assert.equal(state.progressSentence, 46);
  state.reading = true; state.currentSentence = 47;
  assert.equal(context.currentBookmarkPosition().sentence, 47);
  state.currentChapter = 1; state.currentSentence = 0;
  assert.equal(context.currentBookmarkPosition().chapter, 1);
  assert.equal(context.currentBookmarkPosition().sentence, 0);
});


test('backup completion preserves unavailable choices after list replacement', () => {
  const available = { disabled: false, dataset: {} }, unavailable = { disabled: true, dataset: {} };
  let controls = [available, unavailable];
  const context = vm.createContext({ busy: false, document: { querySelectorAll: () => controls } });
  vm.runInContext(code('reader-backup.js', '  function setBusy(', '  function tab('), context);
  context.setBusy(true);
  assert.equal(available.disabled, true);
  const replacement = { disabled: true, dataset: {} };
  controls.push(replacement);
  context.setBusy(false);
  assert.equal(available.disabled, false);
  assert.equal(unavailable.disabled, true);
  assert.equal(replacement.disabled, true);
});

test('backup refresh and entry do not reopen a remembered preview or switch tabs', async () => {
  const $ = dom(); let reloads = 0, previews = 0, refresh, entry;
  const context = vm.createContext({ $, root: '/api/reader/backups',
    api: async () => ({ status: 'preview', books: [] }), status() {},
    reload: async () => { reloads++; }, renderPreview: () => { previews++; },
    tab: () => assert.fail('Refresh must preserve the current tab'),
    sessionStorage: { getItem: () => assert.fail('Entry must not load a previous backup') },
    operation: run => { entry = run(); return entry; },
  });
  vm.runInContext(code('reader-backup.js', '  async function waitJob(', '  async function operation('), context);
  await context.waitJob('old-task'); assert.equal(previews, 0);
  await context.waitJob('chosen-backup', true); assert.equal(previews, 1);
  reloads = 0;
  $('refreshBackup').addEventListener = (_, listener) => { refresh = listener; };
  vm.runInContext(code('reader-backup.js', "  $('refreshBackup').addEventListener", "  $('backupFile').addEventListener"), context);
  await refresh(); assert.equal(reloads, 1); assert.equal(previews, 1);
  vm.runInContext(code('reader-backup.js', "  operation(async () => {\n    status('正在读取备份…'", '  window.TransUI.setupScrollFades'), context);
  await entry; assert.equal(reloads, 2); assert.equal(previews, 1);
});

test('backup select all includes tools and notifies credential encryption controls', () => {
  const $ = dom(); let click, changes = 0;
  const books = [{checked:false}], tools = [{checked:false}, {checked:true}];
  for (const [id, inputs] of [['backupBooks',books], ['backupTools',tools]]) {
    $(id).querySelectorAll = selector => selector.includes('input') ? inputs : [{dispatchEvent:() => { changes++; }}];
  }
  $('selectAll').addEventListener = (_, listener) => { click = listener; };
  const context = vm.createContext({ $, busy:false, Event:class {} });
  vm.runInContext(code('reader-backup.js', "  $('selectAll').addEventListener", "  $('compareBackup').addEventListener"), context);
  click(); assert.equal([...books,...tools].every(input=>input.checked), true); assert.equal(changes, 2);
  click(); assert.equal([...books,...tools].some(input=>input.checked), false); assert.equal(changes, 4);
  context.busy = true; click(); assert.equal(changes, 4);
});

test('backup viewport follows browser bars and refresh without reflowing pinch zoom or desktop', () => {
  const events = {}, viewportEvents = {}, values = new Map();
  const mobile = {matches:true, addEventListener:(_, fn) => { events.media=fn; }};
  const viewport = {height:720.8, scale:1, addEventListener:(name, fn) => { viewportEvents[name]=fn; }};
  let callback, frames=0;
  const win = {innerHeight:800, visualViewport:viewport, matchMedia:()=>mobile,
    addEventListener:(name, fn)=>{ events[name]=fn; },
    requestAnimationFrame:fn=>{ callback=fn; return ++frames; }};
  const style = {setProperty:(k,v)=>values.set(k,v), getPropertyValue:k=>values.get(k), removeProperty:k=>values.delete(k)};
  const context = vm.createContext({window:win, document:{body:{style}}});
  vm.runInContext(code('reader-backup.js', '  function setupBackupViewport(', '  function tab('), context);
  context.setupBackupViewport();
  const height = () => values.get('--backup-viewport-height');
  assert.equal(height(),'720px');
  // A reload can expose the address bar while innerHeight still reports the larger viewport.
  viewport.height=640; events.pageshow(); viewportEvents.resize();
  assert.equal(frames,1); callback(); assert.equal(height(),'640px');
  viewport.scale=2; viewport.height=320; viewportEvents.resize(); callback(); assert.equal(height(),'640px');
  viewport.scale=1; viewport.height=800; win.innerHeight=760;
  events.resize(); callback(); assert.equal(height(),'760px');
  mobile.matches=false; events.media(); callback(); assert.equal(height(),undefined);
  mobile.matches=true; win.visualViewport=null; win.innerHeight=600;
  events.media(); callback(); assert.equal(height(),'600px');
});

test('credential backup refuses missing or mismatched passwords before sending a request', async () => {
  const $ = dom(); let listener, action, calls = [], tabs = [];
  $('createBackup').addEventListener = (_, run) => { listener = run; };
  const context = vm.createContext({ $, root: '/backups', status() {}, selections: () => [],
    toolSelections: () => [{id:'tts', items:['credentials']}], operation: run => { action = run(); },
    post: async (_, data) => { calls.push(data); return {id:'new'}; },
    waitJob: async () => ({status:'ready'}), tab: name => tabs.push(name) });
  vm.runInContext(code('reader-backup.js', "  $('createBackup').addEventListener", "  $('selectAll').addEventListener"), context);
  $('backupPassword').value = ''; listener(); await assert.rejects(action, /至少/);
  $('backupPassword').value = 'password-for-test'; $('backupPasswordAgain').value = 'different';
  listener(); await assert.rejects(action, /不一致/); assert.equal(calls.length, 0);
  $('backupPasswordAgain').value = 'password-for-test'; listener(); await action;
  assert.equal(calls.length, 1); assert.equal(calls[0].password, 'password-for-test');
  assert.equal($('backupPassword').value, ''); assert.equal($('backupPasswordAgain').value, '');
  assert.deepEqual(tabs, ['files']);
});

test('encrypted restore prompts only for the selected backup and cancellation sends no password', async () => {
  let calls = [], prompts = 0, answer = 'test-backup-password';
  const context = vm.createContext({ root: '/backups', unlockedId:'', unlockedPassword:'',
    post: async (url, data) => {
      calls.push({url,data});
      if (!data.password) { const e = Error('password required'); e.passwordRequired = true; throw e; }
      return {status:'working'};
    }, passwordPrompt: async () => { prompts++; return answer; } });
  vm.runInContext(code('reader-backup.js', '  async function backupPost(', '  function bookHeader('), context);
  await context.backupPost('a', {action:'preview'});
  await context.backupPost('a', {action:'compare'});
  assert.equal(prompts, 1); assert.equal(calls.length, 3);
  answer = null;
  assert.equal(await context.backupPost('b', {action:'preview'}), null);
  assert.equal(prompts, 2); assert.equal(calls.length, 4);
  assert.equal(calls.at(-1).data.password, '');
});

test('restoring one card preserves other books, tool choices and scroll position', () => {
  const $ = dom(), root = $('restoreBooks');
  const old = [
    {dataset:{selectionKey:'book-a'}, items:['source'], querySelector:()=>null},
    {dataset:{selectionKey:'book-b'}, items:['source','reading'], querySelector:()=>({value:'merge'})},
    {dataset:{selectionKey:'tool-tts'}, items:['credentials'], querySelector:()=>null},
  ];
  root.querySelectorAll = () => old; root.scrollTop = 88; root.children=[];
  root.replaceChildren = () => { root.children=[]; root.scrollTop=0; };
  root.append = child => root.children.push(child);
  const element = (_, text, className) => ({text,className,dataset:{},children:[],
    append(...children) { this.children.push(...children); }, prepend(child) { this.children.unshift(child); }, addEventListener() {} });
  let toolSelection;
  const context = vm.createContext({ $, preview:{id:'same'}, labels:{source:'原书',reading:'目录'},
    choices: row => row.items || [], node:element, bookHeader:()=>element(), button:()=>element(),
    checkbox:(key, title, checked) => ({key,checked}),
    renderToolPreview:(_, saved) => { toolSelection=saved; }, restoreBook() {} });
  vm.runInContext(code('reader-backup.js','  function renderPreview(', '  function renderToolPreview('),context);
  const book = id => ({id, title:id, chapters:1, items:['source','reading'], current:{chapter_count:1},compatible:true});
  context.renderPreview({id:'same', tools:[{id:'tts'}], books:[book('a'),book('b')]},'book-a');
  const options = row => row.children.find(child=>child.className==='backup-options').children;
  assert.equal(options(root.children[0]).some(option=>option.checked),false);
  assert.equal(options(root.children[1]).every(option=>option.checked),true);
  assert.deepEqual(toolSelection.items,['credentials']);
  assert.equal(root.scrollTop,88);
});
