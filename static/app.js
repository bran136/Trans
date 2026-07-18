function storedHistory() {
  try {
    const value = JSON.parse(localStorage.getItem("trans-history") || "[]");
    return Array.isArray(value) ? value.slice(0, 100) : [];
  } catch {
    return [];
  }
}

const state = {
  languages: [],
  engines: [],
  config: null,
  history: storedHistory(),
  translateTimer: null,
  balanceTimer: null,
  balanceRetryTimer: null,
  deepseekBalance: null,
  deepseekBalanceLoadedAt: 0,
  requestId: 0,
  sourceAutoMode: true,
  targetAutoMode: true,
  resultPanelCollapsed: {},
  activeSentence: null,
};

const $ = (id) => document.getElementById(id);
const CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')?.content || "";

function option(label, value, selected = false) {
  const el = document.createElement("option");
  el.value = value;
  el.textContent = label;
  el.selected = selected;
  return el;
}

async function api(path, options = {}) {
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
  return response.json();
}

function renderLanguages() {
  const source = $("sourceLang");
  const target = $("targetLang");
  const previousSource = source.value || "auto";
  const previousTarget = target.value || "zh";
  source.innerHTML = "";
  target.innerHTML = "";
  state.languages.forEach((lang) => {
    source.appendChild(option(lang.name, lang.code, lang.code === previousSource));
    if (lang.code !== "auto") {
      target.appendChild(option(lang.name, lang.code, lang.code === previousTarget));
    }
  });
  if (!target.value) target.value = "zh";
}

function normalizeDetectedLang(code) {
  if (!code) return "";
  if (code === "zh-CN" || code === "zh-TW" || code === "zh-Hans" || code === "zh-Hant") return "zh";
  if (code === "iw") return "he";
  return code.split("-")[0];
}

function sourceForRequest() {
  return state.sourceAutoMode ? "auto" : $("sourceLang").value;
}

function syncTargetForSource(sourceCode) {
  if (!state.targetAutoMode) return;
  const target = sourceCode === "zh" ? "en" : "zh";
  if (sourceCode && sourceCode !== "auto" && $("targetLang").value !== target) {
    $("targetLang").value = target;
  }
}

function guessSourceLang(text) {
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[\u0400-\u04ff]/.test(text)) return "ru";
  if (/[\u0600-\u06ff]/.test(text)) return "ar";
  if (/[\u0e00-\u0e7f]/.test(text)) return "th";
  if (/[A-Za-z]/.test(text)) return "en";
  return "";
}

function updateDetectedSource(results, text) {
  if (!state.sourceAutoMode) return;
  const detected = normalizeDetectedLang(results.find((result) => result.detectedSource)?.detectedSource) || guessSourceLang(text);
  applyDetectedSource(detected);
}

function applyDetectedSource(detected) {
  if (!detected || detected === "auto") return;
  const source = $("sourceLang");
  if ([...source.options].some((option) => option.value === detected)) {
    source.value = detected;
    syncTargetForSource(detected);
  }
}

function renderEngines() {
  const list = $("engineList");
  list.innerHTML = "";
  state.engines.filter((engine) => engine.enabled).forEach((engine) => {
    const label = document.createElement("label");
    label.className = "engine-chip";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = engine.id;
    input.checked = engine.id === "deepseek" || engine.id === "google";
    input.addEventListener("change", () => {
      renderEngineShells();
      scheduleTranslate(0);
    });
    label.appendChild(input);
    const name = document.createElement("span");
    name.textContent = engine.name;
    label.appendChild(name);
    if (engine.id === "deepseek") {
      const balance = document.createElement("span");
      balance.className = "engine-balance";
      balance.id = "deepseekBalance";
      balance.textContent = formatDeepSeekBalance();
      label.appendChild(balance);
    }
    list.appendChild(label);
  });
  if (!list.children.length) {
    list.innerHTML = '<span class="engine-empty">没有启用的翻译引擎</span>';
  }
  window.requestAnimationFrame(renderEngineShells);
}

function formatDeepSeekBalance() {
  const balance = state.deepseekBalance;
  if (!balance) return "(余额查询失败)";
  if (!balance.total_balance || !balance.currency) return "(余额未知)";
  const symbol = balance.currency === "CNY" ? "¥" : `${balance.currency} `;
  return `(${symbol}${balance.total_balance} · ${formatBalanceTime(balance.updated_at)})`;
}

function renderDeepSeekBalance() {
  const el = $("deepseekBalance");
  if (el) el.textContent = formatDeepSeekBalance();
}

function formatBalanceTime(timestamp) {
  if (!timestamp) return "未更新";
  const date = new Date(Number(timestamp) * 1000);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function renderConfig() {
  const c = state.config;
  $("deepseekEnabled").checked = c.deepseek.enabled;
  $("deepseekKey").value = "";
  $("deepseekKey").placeholder = c.deepseek.api_key_configured ? "已配置，留空不修改" : "未配置";
  $("deepseekBaseUrl").value = c.deepseek.base_url;
  $("deepseekBaseUrl").disabled = !c.deepseek.allow_custom_base_url;
  $("deepseekBaseUrl").title = "服务端接口地址只能在服务器 .env 中修改";
  $("deepseekModel").value = c.deepseek.model;
  $("deepseekStyle").innerHTML = "";
  (c.deepseek_styles || []).forEach((style) => {
    $("deepseekStyle").appendChild(option(style.name, style.id, style.id === c.deepseek.style));
  });
  $("deepseekTemperature").value = c.deepseek.temperature;
  $("deepseekThinking").value = c.deepseek.thinking;
  $("deepseekReasoning").value = c.deepseek.reasoning_effort;
  $("deepseekTimeout").value = c.deepseek.timeout;
  $("googleEnabled").checked = c.google.enabled;
  $("googleEndpoint").value = c.google.endpoint;
  $("googleEndpoint").disabled = true;
  $("googleEndpoint").title = "谷歌翻译由浏览器直连固定官方接口";
  $("googleTimeout").value = c.google.timeout;
}

function selectedEngines() {
  return [...document.querySelectorAll("#engineList input:checked")].map((input) => input.value);
}

function setStatus(text) {
  const status = $("statusText");
  status.className = "";
  if (!text || text === "待翻译" || text === "请输入原文") {
    status.textContent = "";
    return;
  }
  if (text === "翻译中") {
    status.className = "status-icon loading";
    status.textContent = "";
    return;
  }
  if (text === "已完成") {
    status.className = "status-icon done";
    status.textContent = "✓";
    return;
  }
  status.textContent = text;
}

function setConfigMessage(text, type = "success") {
  const message = $("configMessage");
  message.textContent = text;
  message.className = `config-message ${type}`;
  message.hidden = false;
}

function clearConfigMessage() {
  const message = $("configMessage");
  message.textContent = "";
  message.className = "config-message";
  message.hidden = true;
}

function renderDeepSeekCacheStatus(cache = {}) {
  const entries = Number(cache.entries || 0);
  const limit = Number(cache.limit || 0);
  $("deepseekCacheStats").textContent = `${entries} / ${limit} 条`;
}

async function loadDeepSeekCacheStatus() {
  try {
    renderDeepSeekCacheStatus(await api("/api/cache"));
  } catch (error) {
    $("deepseekCacheStats").textContent = "读取失败";
  }
}

async function clearDeepSeekCache() {
  if (!window.confirm("确定清空 DeepSeek 本地翻译缓存？清空后相同内容会重新请求 API。")) return;
  $("clearCacheBtn").disabled = true;
  try {
    const data = await api("/api/cache", { method: "DELETE" });
    renderDeepSeekCacheStatus(data);
    setConfigMessage(`已清空 ${data.cleared} 条 DeepSeek 缓存`, "success");
  } catch (error) {
    setConfigMessage(`清空缓存失败：${error.message}`, "error");
  } finally {
    $("clearCacheBtn").disabled = false;
  }
}

async function loadDeepSeekBalance() {
  if (document.hidden) return;
  window.clearTimeout(state.balanceRetryTimer);
  try {
    const data = await api("/api/deepseek/balance");
    state.deepseekBalance = data.balance;
    state.deepseekBalanceLoadedAt = Date.now();
  } catch (error) {
    state.deepseekBalance = null;
    state.balanceRetryTimer = window.setTimeout(loadDeepSeekBalance, 15 * 1000);
  }
  renderDeepSeekBalance();
}

function startBalanceRefresh() {
  window.clearInterval(state.balanceTimer);
  window.clearTimeout(state.balanceRetryTimer);
  loadDeepSeekBalance();
  state.balanceTimer = window.setInterval(loadDeepSeekBalance, 15 * 60 * 1000);
}

function refreshBalanceWhenVisible() {
  if (document.hidden) return;
  if (Date.now() - state.deepseekBalanceLoadedAt >= 15 * 60 * 1000) {
    loadDeepSeekBalance();
  }
}

function renderResults(results) {
  const box = $("results");
  box.classList.remove("empty");
  box.innerHTML = "";
  results.forEach((result, index) => {
    const card = document.createElement("article");
    fillResultCard(card, result, index);
    box.appendChild(card);
  });
}

const SENTENCE_END_MARKS = new Set(["。", ".", "？", "?", "！", "!", "；", ";"]);
const URLISH_CHARS = /[A-Za-z0-9_%/#?=&:+~-]/;
const ABBREVIATION_WORDS = new Set([
  "fig", "figs", "eq", "eqs", "ref", "refs", "no", "nos", "dr", "mr", "mrs", "ms", "prof", "vs", "etc", "e.g", "i.e",
]);

function isDecimalPoint(value, index) {
  return value[index] === "." && /\d/.test(value[index - 1] || "") && /\d/.test(value[index + 1] || "");
}

function tokenAround(value, index) {
  let start = index;
  let end = index + 1;
  while (start > 0 && !/\s/.test(value[start - 1])) start -= 1;
  while (end < value.length && !/\s/.test(value[end])) end += 1;
  return value.slice(start, end);
}

function wordBeforePeriod(value, index) {
  let start = index - 1;
  while (start >= 0 && /[A-Za-z.]/.test(value[start])) start -= 1;
  return value.slice(start + 1, index).toLowerCase();
}

function isAbbreviationPeriod(value, index) {
  return value[index] === "." && ABBREVIATION_WORDS.has(wordBeforePeriod(value, index));
}

function isProtectedUrlPeriod(value, index) {
  if (value[index] !== ".") return false;
  const prev = value[index - 1] || "";
  const next = value[index + 1] || "";
  if (isDecimalPoint(value, index)) return true;
  if (isAbbreviationPeriod(value, index)) return true;
  if (URLISH_CHARS.test(prev) && URLISH_CHARS.test(next)) return true;
  const token = tokenAround(value, index).replace(/^[("'“‘]+|[)"'”’，,]+$/g, "");
  if (/^(https?:\/\/|www\.)/i.test(token) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(token)) {
    return index < value.length - 1 && !/\s/.test(next);
  }
  return false;
}

function trimRange(value, start, end) {
  let left = start;
  let right = end;
  while (left < right && /\s/.test(value[left])) left += 1;
  while (right > left && /\s/.test(value[right - 1])) right -= 1;
  return { start: left, end: right };
}

function newlineRunEnd(value, index) {
  let cursor = index + 1;
  while (cursor < value.length && /[\n\r \t]/.test(value[cursor])) cursor += 1;
  return cursor;
}

function paragraphRanges(value) {
  const text = String(value || "");
  const ranges = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") continue;
    if (index > start) ranges.push({ start, end: index });
    start = newlineRunEnd(text, index);
    index = start - 1;
  }
  if (start < text.length) ranges.push({ start, end: text.length });
  return ranges;
}

function isSentenceEnd(value, index) {
  return SENTENCE_END_MARKS.has(value[index]) && !isProtectedUrlPeriod(value, index);
}

function sentenceRanges(value, paragraph, paragraphIndex) {
  const ranges = [];
  let start = paragraph.start;
  let sentenceIndex = 0;
  for (let index = paragraph.start; index < paragraph.end; index += 1) {
    if (!isSentenceEnd(value, index)) continue;
    const range = trimRange(value, start, index + 1);
    if (range.end > range.start) {
      ranges.push({ ...range, paragraphIndex, sentenceIndex });
      sentenceIndex += 1;
    }
    start = index + 1;
  }
  const tail = trimRange(value, start, paragraph.end);
  if (tail.end > tail.start) ranges.push({ ...tail, paragraphIndex, sentenceIndex });
  return ranges;
}

function buildHighlightRanges(value) {
  const text = String(value || "");
  return paragraphRanges(text).flatMap((paragraph, paragraphIndex) => (
    sentenceRanges(text, paragraph, paragraphIndex)
  ));
}

function renderVisualText(pre, text) {
  const value = String(text || "");
  const ranges = buildHighlightRanges(value);
  pre.replaceChildren();
  let cursor = 0;
  ranges.forEach((range) => {
    if (range.start > cursor) pre.appendChild(document.createTextNode(value.slice(cursor, range.start)));
    const span = document.createElement("span");
    span.className = "visual-sentence";
    span.dataset.paragraphIndex = range.paragraphIndex;
    span.dataset.sentenceIndex = range.sentenceIndex;
    span.textContent = value.slice(range.start, range.end);
    span.addEventListener("click", (event) => {
      event.stopPropagation();
      highlightVisualSentence(Number(span.dataset.paragraphIndex), Number(span.dataset.sentenceIndex), pre);
    });
    pre.appendChild(span);
    cursor = range.end;
  });
  if (cursor < value.length) pre.appendChild(document.createTextNode(value.slice(cursor)));
}

function applyVisualSentenceHighlight(paragraphIndex, sentenceIndex) {
  document.querySelectorAll(".visual-sentence.active").forEach((item) => item.classList.remove("active"));
  if (!Number.isFinite(paragraphIndex) || !Number.isFinite(sentenceIndex)) return;
  document
    .querySelectorAll(`.visual-sentence[data-paragraph-index="${paragraphIndex}"][data-sentence-index="${sentenceIndex}"]`)
    .forEach((item) => {
      item.classList.add("active");
    });
}

function paragraphFallbackRange(value, paragraphIndex) {
  const paragraphs = paragraphRanges(value);
  if (!paragraphs.length) return null;
  const index = Math.max(0, Math.min(paragraphIndex, paragraphs.length - 1));
  const range = trimRange(value, paragraphs[index].start, paragraphs[index].end);
  return range.end > range.start ? range : null;
}

function sourceRangeForVisualSentence(paragraphIndex, sentenceIndex, resultRoot) {
  const sourceValue = $("sourceText").value || "";
  const sourceRanges = buildHighlightRanges(sourceValue);
  const sourceParagraphRanges = sourceRanges.filter((item) => item.paragraphIndex === paragraphIndex);
  const resultSentenceCount = resultRoot
    ? resultRoot.querySelectorAll(`.visual-sentence[data-paragraph-index="${paragraphIndex}"]`).length
    : 0;
  if (sourceParagraphRanges.length && sourceParagraphRanges.length === resultSentenceCount) {
    const exact = sourceParagraphRanges.find((item) => item.sentenceIndex === sentenceIndex);
    if (exact) return exact;
  }
  return paragraphFallbackRange(sourceValue, paragraphIndex) || sourceParagraphRanges[0] || null;
}

function highlightVisualSentence(paragraphIndex, sentenceIndex, resultRoot = null) {
  if (!Number.isFinite(paragraphIndex) || !Number.isFinite(sentenceIndex)) return;
  state.activeSentence = { paragraphIndex, sentenceIndex };
  applyVisualSentenceHighlight(paragraphIndex, sentenceIndex);
  const range = sourceRangeForVisualSentence(paragraphIndex, sentenceIndex, resultRoot);
  if (range) {
    const source = $("sourceText");
    try {
      source.focus({ preventScroll: true });
    } catch {
      source.focus();
    }
    source.setSelectionRange(range.start, range.end);
  }
}

function fillResultCard(card, result, index) {
  card.dataset.engine = result.engine;
  card.className = `result-card ${result.ok === false ? "error" : ""}`;
  if (isResultPanelCollapsed(result.engine, index)) card.classList.add("collapsed");
  const header = document.createElement("div");
  header.className = "result-head";
  header.appendChild(createResultToggle(result.name, result.ok === false ? "失败" : "", card, result.engine));
  if (result.ok) {
    header.appendChild(createCopyButton(result.text));
  }
  const pre = document.createElement("pre");
  if (result.ok === false) {
    pre.textContent = result.error;
  } else {
    renderVisualText(pre, result.text || "");
  }
  card.replaceChildren(header, pre);
  if (state.activeSentence) {
    applyVisualSentenceHighlight(state.activeSentence.paragraphIndex, state.activeSentence.sentenceIndex);
  }
}

function updateResultCard(result, index) {
  const cards = [...$("results").querySelectorAll(".result-card")];
  const card = cards.find((item) => item.dataset.engine === result.engine);
  if (card) fillResultCard(card, result, index);
}

function createResultToggle(name, meta, card, engineId) {
  const button = document.createElement("button");
  button.className = "result-toggle";
  button.type = "button";
  const nameNode = document.createElement("span");
  const metaNode = document.createElement("span");
  nameNode.textContent = name;
  metaNode.textContent = meta;
  button.append(nameNode, metaNode);
  button.addEventListener("click", () => toggleResultPanel(card, engineId));
  return button;
}

function createCopyButton(text) {
  const button = document.createElement("button");
  button.className = "result-copy";
  button.type = "button";
  button.textContent = "复制";
  button.addEventListener("click", async () => {
    await copyText(text);
    showCopyFeedback(button);
  });
  return button;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function showCopyFeedback(button) {
  const original = button.textContent;
  button.textContent = "已复制";
  button.disabled = true;
  window.setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 1200);
}

function isResultPanelCollapsed(engineId, index) {
  if (Object.prototype.hasOwnProperty.call(state.resultPanelCollapsed, engineId)) {
    return state.resultPanelCollapsed[engineId];
  }
  return index > 1;
}

function toggleResultPanel(card, engineId) {
  const collapsed = card.classList.toggle("collapsed");
  state.resultPanelCollapsed[engineId] = collapsed;
}

function renderEngineShells() {
  const engines = selectedEngines();
  const box = $("results");
  box.classList.remove("empty");
  box.innerHTML = "";
  if (!engines.length) {
    setStatus("请选择引擎");
    return;
  }
  engines.forEach((engineId, index) => {
    const card = document.createElement("article");
    fillResultCard(card, {
      engine: engineId,
      name: engineName(engineId),
      text: "",
    }, index);
    box.appendChild(card);
  });
}

function timeoutSignal(seconds) {
  const controller = new AbortController();
  window.setTimeout(() => controller.abort(), Math.max(5, Number(seconds) || 25) * 1000);
  return controller.signal;
}

function googleLang(code) {
  if (code === "auto") return "auto";
  if (code === "zh") return "zh-CN";
  return code;
}

function engineName(engineId) {
  return state.engines.find((engine) => engine.id === engineId)?.name || engineId;
}

async function translateGoogle(text, source, target) {
  const settings = state.config.google;
  const url = new URL(settings.endpoint);
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", googleLang(source));
  url.searchParams.set("tl", googleLang(target));
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);
  const response = await fetch(url, { signal: timeoutSignal(settings.timeout) });
  if (!response.ok) throw new Error(`谷歌翻译请求失败：${response.status}`);
  const data = await response.json();
  const translated = (data[0] || []).map((part) => part[0]).join("").trim();
  if (!translated) throw new Error("谷歌翻译未返回结果");
  return { text: translated, detectedSource: data[2] };
}

async function translateDeepSeek(text, source, target) {
  const data = await api("/api/translate", {
    method: "POST",
    body: JSON.stringify({ engine: "deepseek", text, source, target }),
  });
  return { text: data.text };
}

async function translateWithEngine(engineId, text, source, target) {
  const settings = state.config[engineId];
  if (!settings?.enabled) throw new Error("引擎未启用");
  if (engineId === "google") return translateGoogle(text, source, target);
  if (engineId === "deepseek") return translateDeepSeek(text, source, target);
  throw new Error("未知引擎");
}

function saveHistory(item) {
  state.history = [item, ...state.history.filter((old) => old.text !== item.text)].slice(0, 100);
  localStorage.setItem("trans-history", JSON.stringify(state.history));
  renderHistory();
}

function renderHistory() {
  const list = $("historyList");
  list.innerHTML = "";
  if (!state.history.length) {
    list.innerHTML = '<div class="history-item">暂无历史<span>翻译后会出现在这里</span></div>';
    return;
  }
  state.history.forEach((item) => {
    const btn = document.createElement("button");
    btn.className = "history-item";
    btn.type = "button";
    const title = document.createTextNode(item.targetName);
    const text = document.createElement("span");
    text.textContent = item.text;
    btn.appendChild(title);
    btn.appendChild(text);
    btn.addEventListener("click", () => {
      $("sourceText").value = item.text;
      $("sourceLang").value = item.source;
      $("targetLang").value = item.target;
      state.sourceAutoMode = item.source === "auto";
      state.targetAutoMode = false;
      updateCharCount();
      $("historyDialog").close();
      scheduleTranslate(0);
    });
    list.appendChild(btn);
  });
}

function updateCharCount() {
  $("charCount").textContent = `${$("sourceText").value.length} 字符`;
}

function handleSourceInput() {
  updateCharCount();
  state.activeSentence = null;
  applyVisualSentenceHighlight(null, null);
  if (!$("sourceText").value.trim()) {
    state.sourceAutoMode = true;
    state.targetAutoMode = true;
    $("sourceLang").value = "auto";
    $("targetLang").value = "zh";
  }
  scheduleTranslate();
}

function scheduleTranslate(delay = 500) {
  window.clearTimeout(state.translateTimer);
  state.translateTimer = window.setTimeout(translate, delay);
}

async function translate() {
  const requestId = ++state.requestId;
  const text = $("sourceText").value.trim();
  const engines = selectedEngines();
  state.activeSentence = null;
  applyVisualSentenceHighlight(null, null);
  if (!text) {
    setStatus("待翻译");
    renderEngineShells();
    return;
  }
  if (!engines.length) {
    setStatus("请选择引擎");
    renderEngineShells();
    return;
  }
  setStatus("翻译中");
  if (state.sourceAutoMode) {
    applyDetectedSource(guessSourceLang(text));
  } else {
    syncTargetForSource($("sourceLang").value);
  }
  renderEngineShells();
  try {
    const source = sourceForRequest();
    const target = $("targetLang").value;
    const results = [];
    const tasks = engines.map(async (engineId, index) => {
      let result;
      try {
        const translated = await translateWithEngine(engineId, text, source, target);
        result = {
          engine: engineId,
          name: engineName(engineId),
          ok: true,
          text: translated.text,
          detectedSource: translated.detectedSource,
        };
      } catch (error) {
        const hint = error.name === "AbortError" ? "请求超时" : error.message;
        result = { engine: engineId, name: engineName(engineId), ok: false, error: hint };
      }
      if (requestId === state.requestId) {
        results[index] = result;
        updateDetectedSource([result], text);
        updateResultCard(result, index);
      }
      return result;
    });
    await Promise.all(tasks);
    if (requestId !== state.requestId) return;
    setStatus("已完成");
    const targetName = $("targetLang").selectedOptions[0].textContent;
    saveHistory({ text, source: sourceForRequest(), target, targetName, time: Date.now() });
  } catch (error) {
    if (requestId !== state.requestId) return;
    setStatus(error.message);
  }
}

async function saveConfig() {
  const payload = {
    deepseek: {
      enabled: $("deepseekEnabled").checked,
      api_key: $("deepseekKey").value,
      base_url: state.config.deepseek.allow_custom_base_url
        ? $("deepseekBaseUrl").value
        : state.config.deepseek.base_url,
      model: $("deepseekModel").value,
      style: $("deepseekStyle").value,
      temperature: Number($("deepseekTemperature").value),
      thinking: $("deepseekThinking").value,
      reasoning_effort: $("deepseekReasoning").value,
      timeout: Number($("deepseekTimeout").value),
    },
    google: {
      enabled: $("googleEnabled").checked,
      endpoint: $("googleEndpoint").value,
      timeout: Number($("googleTimeout").value),
    },
  };
  $("saveConfigBtn").disabled = true;
  clearConfigMessage();
  try {
    const data = await api("/api/config", { method: "PUT", body: JSON.stringify(payload) });
    state.config = data.config;
    await bootstrap();
    setConfigMessage("配置已保存", "success");
    setStatus("配置已保存");
    scheduleTranslate(0);
  } catch (error) {
    setConfigMessage(`保存失败：${error.message}`, "error");
    setStatus(error.message);
  } finally {
    $("saveConfigBtn").disabled = false;
  }
}

async function bootstrap() {
  const data = await api("/api/bootstrap");
  state.languages = data.languages;
  state.engines = data.engines;
  state.config = data.config;
  renderLanguages();
  renderEngines();
  renderConfig();
  renderHistory();
  startBalanceRefresh();
}

$("sourceText").addEventListener("input", handleSourceInput);
$("sourceLang").addEventListener("change", () => {
  state.sourceAutoMode = $("sourceLang").value === "auto";
  if (state.sourceAutoMode) {
    state.targetAutoMode = true;
    $("targetLang").value = "zh";
  }
  syncTargetForSource($("sourceLang").value);
  scheduleTranslate(0);
});
$("targetLang").addEventListener("change", () => scheduleTranslate(0));
$("targetLang").addEventListener("change", () => {
  state.targetAutoMode = false;
});
$("sourceText").addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    translate();
  }
});
$("swapBtn").addEventListener("click", () => {
  if ($("sourceLang").value === "auto") return;
  const source = $("sourceLang").value;
  $("sourceLang").value = $("targetLang").value;
  $("targetLang").value = source;
  state.sourceAutoMode = false;
  state.targetAutoMode = false;
  scheduleTranslate(0);
});
$("historyBtn").addEventListener("click", () => $("historyDialog").showModal());
$("closeHistoryBtn").addEventListener("click", () => $("historyDialog").close());
document.addEventListener("visibilitychange", refreshBalanceWhenVisible);
$("settingsBtn").addEventListener("click", () => {
  clearConfigMessage();
  $("deepseekCacheStats").textContent = "正在读取";
  $("settingsDialog").showModal();
  loadDeepSeekCacheStatus();
});
$("settingsDialog").addEventListener("click", (event) => {
  if (event.target.closest(".info-help")) return;
  document.querySelectorAll(".info-help[open]").forEach((help) => {
    help.open = false;
  });
});
$("settingsDialog").addEventListener("toggle", (event) => {
  if (!event.target.matches(".info-help") || !event.target.open) return;
  document.querySelectorAll(".info-help[open]").forEach((help) => {
    if (help !== event.target) help.open = false;
  });
  window.requestAnimationFrame(() => placeHelpBox(event.target));
}, true);

function placeHelpBox(help) {
  help.classList.remove("flip-left");
  const body = help.querySelector("div");
  if (!body) return;
  const rect = body.getBoundingClientRect();
  if (rect.right > window.innerWidth - 16) {
    help.classList.add("flip-left");
  }
}
$("saveConfigBtn").addEventListener("click", saveConfig);
$("clearCacheBtn").addEventListener("click", clearDeepSeekCache);
$("logoutBtn").addEventListener("click", async () => {
  await api("/logout", { method: "POST", body: "{}" });
  window.location.href = "/login";
});

bootstrap().catch((error) => {
  setStatus(error.message);
});
