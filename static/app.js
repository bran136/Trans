function storedHistory() {
  try {
    const value = JSON.parse(localStorage.getItem("trans-history") || "[]");
    return window.TransTranslation.normalizeHistory(value);
  } catch {
    return [];
  }
}

const state = {
  languages: [],
  engines: [],
  config: null,
  configRevision: 0,
  history: storedHistory(),
  historyDirty: false,
  historyPending: [],
  historyRevision: 0,
  historyClearing: false,
  composing: false,
  automatic: true,
  currentResults: [],
  resultContext: null,
  balanceTimer: null,
  balanceRetryTimer: null,
  deepseekBalance: null,
  deepseekBalanceLoadedAt: 0,
  sourceAutoMode: true,
  targetAutoMode: true,
  resultPanelCollapsed: {},
  activeSentence: null,
  clearCacheConfirmFocus: null,
  dialogScrollPosition: null,
};

const $ = (id) => document.getElementById(id);
const CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')?.content || "";
const historyStore = window.TransTranslation.createHistoryStore(state.history);
const translationQueue = window.TransTranslation.createQueue(runTranslation, (error) => setStatus(error.message));
try { state.automatic = localStorage.getItem("trans-auto-translate") !== "false"; } catch { /* Optional preference. */ }

function lockTranslationBackground() {
  if (state.dialogScrollPosition) return;
  state.dialogScrollPosition = { x: window.scrollX, y: window.scrollY };
  document.body.style.setProperty("--translation-scroll-top", `${-window.scrollY}px`);
  document.documentElement.classList.add("translation-dialog-open");
}

function unlockTranslationBackground() {
  if (!state.dialogScrollPosition || $("settingsDialog").open || $("historyDialog").open) return;
  const { x, y } = state.dialogScrollPosition;
  document.documentElement.classList.remove("translation-dialog-open");
  document.body.style.removeProperty("--translation-scroll-top");
  state.dialogScrollPosition = null;
  window.scrollTo({ left: x, top: y, behavior: "instant" });
}

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
  if (!state.targetAutoMode && normalizeDetectedLang($("targetLang").value) !== normalizeDetectedLang(sourceCode)) return;
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
    updateCharCount();
  }
}

function renderEngines() {
  const list = $("engineList");
  list.innerHTML = "";
  const engineLinks = {
    deepseek: "https://platform.deepseek.com/usage",
    google: "https://translate.google.com",
  };
  state.engines.filter((engine) => engine.enabled).forEach((engine) => {
    const chip = document.createElement("div");
    chip.className = "engine-chip";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = engine.id;
    input.setAttribute("aria-label", `使用 ${engine.name} 翻译`);
    input.checked = engine.id === "deepseek" || engine.id === "google";
    input.addEventListener("change", () => {
      renderEngineShells();
      scheduleTranslate(0);
    });
    chip.appendChild(input);
    const url = engineLinks[engine.id];
    const name = document.createElement(url ? "a" : "span");
    name.className = "engine-link";
    if (url) {
      name.href = url;
      name.target = "_blank";
      name.rel = "noopener noreferrer";
    }
    name.textContent = engine.name;
    if (engine.id === "deepseek") {
      const balance = document.createElement("span");
      balance.className = "engine-balance";
      balance.id = "deepseekBalance";
      balance.textContent = formatDeepSeekBalance();
      name.appendChild(balance);
    }
    chip.appendChild(name);
    list.appendChild(chip);
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
  const legacyFlashModels = ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-chat", "deepseek-reasoner"];
  $("deepseekModel").value = legacyFlashModels.includes(c.deepseek.model) ? "deepseek-flash" : c.deepseek.model;
  $("deepseekStyle").innerHTML = "";
  (c.deepseek_styles || []).forEach((style) => {
    $("deepseekStyle").appendChild(option(style.name, style.id, style.id === c.deepseek.style));
  });
  $("deepseekTemperature").value = c.deepseek.temperature;
  $("deepseekThinking").value = c.deepseek.thinking;
  $("deepseekReasoning").value = c.deepseek.reasoning_effort;
  $("deepseekTimeout").value = c.deepseek.timeout;
  $("deepseekCacheLimit").value = c.deepseek.cache_limit ?? 5000;
  $("googleEnabled").checked = c.google.enabled;
  const googleEndpoints = c.google.endpoint_options || [];
  const endpointIsPreset = googleEndpoints.includes(c.google.endpoint);
  $("googleEndpointPreset").innerHTML = "";
  googleEndpoints.forEach((endpoint) => {
    $("googleEndpointPreset").appendChild(option(endpoint, endpoint));
  });
  $("googleEndpointPreset").appendChild(option("自定义地址…", "", !endpointIsPreset));
  $("googleEndpointPreset").value = endpointIsPreset ? c.google.endpoint : "";
  $("googleEndpoint").value = c.google.endpoint;
  $("googleEndpoint").hidden = endpointIsPreset;
  $("googleEndpoint").title = "可以选择推荐接口，也可以填写自定义 HTTPS 地址";
  $("googleTimeout").value = c.google.timeout;
}

function selectedEngines() {
  return [...document.querySelectorAll("#engineList input:checked")].map((input) => input.value);
}

function setStatus(text) {
  const status = $("statusText");
  status.className = "";
  if (!text || text === "待翻译" || text === "请输入原文") {
    window.TransUI.feedback(status, "", "info", false);
  } else if (text === "翻译中") {
    window.TransUI.feedback(status, "", "info", false);
    status.className = "status-icon loading";
  } else if (text === "已完成") {
    status.className = "status-icon done";
    window.TransUI.feedback(status, "✓", "info", false);
  } else {
    window.TransUI.feedback(status, text, "info", false);
  }
}

function setConfigMessage(text, type = "success") {
  const message = $("configMessage");
  message.className = `config-message ${type}`;
  window.TransUI.feedback(message, text, type);
}

function clearConfigMessage() {
  const message = $("configMessage");
  message.className = "config-message";
  window.TransUI.feedback(message, "");
}

function renderDeepSeekCacheStatus(cache = {}) {
  const entries = Number(cache.entries || 0);
  $("deepseekCacheStats").textContent = `${entries} 条`;
}

async function loadDeepSeekCacheStatus() {
  try {
    renderDeepSeekCacheStatus(await api("/api/cache"));
  } catch (error) {
    $("deepseekCacheStats").textContent = "读取失败";
  }
}

async function clearDeepSeekCache() {
  if ($("clearCacheBtn").disabled || $("saveConfigBtn").disabled) return;
  const finish = window.TransUI.busyButton($("clearCacheBtn"));
  $("saveConfigBtn").disabled = true;
  setConfigMessage("正在清空缓存…", "pending");
  try {
    const data = await api("/api/cache", { method: "DELETE" });
    renderDeepSeekCacheStatus(data);
    setConfigMessage(`已清空 ${data.cleared} 条 DeepSeek 缓存`, "success");
  } catch (error) {
    setConfigMessage(`清空缓存失败：${error.message}`, "error");
  } finally {
    finish();
    $("saveConfigBtn").disabled = false;
  }
}

function openClearCacheConfirmation() {
  const overlay = $("clearCacheConfirmDialog");
  if (!overlay.hidden) return;
  const settings = $("settingsDialog");
  const form = settings.querySelector(":scope > .settings");
  state.clearCacheConfirmFocus = document.activeElement;
  form.inert = true;
  settings.appendChild(overlay);
  overlay.hidden = false;
  window.setTimeout(() => $("confirmClearCacheBtn").focus(), 0);
}

function closeClearCacheConfirmation() {
  const overlay = $("clearCacheConfirmDialog");
  const previousFocus = state.clearCacheConfirmFocus;
  state.clearCacheConfirmFocus = null;
  $("settingsDialog").querySelector(":scope > .settings").inert = false;
  overlay.hidden = true;
  document.body.appendChild(overlay);
  if (previousFocus?.isConnected) window.setTimeout(() => previousFocus.focus(), 0);
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
  if (!Number.isFinite(paragraphIndex) || !Number.isFinite(sentenceIndex)) {
    $("sourceHighlight").replaceChildren();
    return;
  }
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
  const rawValue = $("sourceText").value || "";
  // Requests trim leading whitespace; map the returned sentence back to the original input.
  const leading = rawValue.length - rawValue.trimStart().length;
  const sourceValue = rawValue.trim();
  const originalRange = range => range ? { ...range, start: range.start + leading, end: range.end + leading } : null;
  const sourceRanges = buildHighlightRanges(sourceValue);
  const sourceParagraphRanges = sourceRanges.filter((item) => item.paragraphIndex === paragraphIndex);
  const resultSentenceCount = resultRoot
    ? resultRoot.querySelectorAll(`.visual-sentence[data-paragraph-index="${paragraphIndex}"]`).length
    : 0;
  if (sourceParagraphRanges.length && sourceParagraphRanges.length === resultSentenceCount) {
    const exact = sourceParagraphRanges.find((item) => item.sentenceIndex === sentenceIndex);
    if (exact) return originalRange(exact);
  }
  return originalRange(paragraphFallbackRange(sourceValue, paragraphIndex) || sourceParagraphRanges[0] || null);
}

function syncSourceHighlight() {
  const source = $("sourceText"), layer = $("sourceHighlight");
  if (!layer.firstChild) return;
  const style = getComputedStyle(source);
  for (const property of ["font", "line-height", "letter-spacing", "word-spacing", "padding", "text-align", "text-indent", "tab-size", "direction", "word-break", "overflow-wrap"]) {
    layer.style.setProperty(property, style.getPropertyValue(property));
  }
  layer.style.width = `${source.clientWidth}px`;
  layer.scrollTop = source.scrollTop;
  layer.scrollLeft = source.scrollLeft;
}

function highlightVisualSentence(paragraphIndex, sentenceIndex, resultRoot = null) {
  if (!Number.isFinite(paragraphIndex) || !Number.isFinite(sentenceIndex)) return;
  state.activeSentence = { paragraphIndex, sentenceIndex };
  applyVisualSentenceHighlight(paragraphIndex, sentenceIndex);
  const range = sourceRangeForVisualSentence(paragraphIndex, sentenceIndex, resultRoot);
  const layer = $("sourceHighlight");
  layer.replaceChildren();
  if (range) {
    const source = $("sourceText");
    // Update the corresponding range without opening the mobile keyboard.
    source.setSelectionRange(range.start, range.end);
    const mark = document.createElement("mark");
    mark.textContent = source.value.slice(range.start, range.end);
    layer.append(document.createTextNode(source.value.slice(0, range.start)), mark,
      document.createTextNode(source.value.slice(range.end) + "\u200b"));
    syncSourceHighlight();
    const bounds = layer.getBoundingClientRect(), target = mark.getBoundingClientRect();
    if (target.top < bounds.top || target.bottom > bounds.bottom) {
      source.scrollTop += target.top - bounds.top - source.clientHeight / 3;
      syncSourceHighlight();
    }
  }
}

function fillResultCard(card, result, index) {
  card.dataset.engine = result.engine;
  card.dataset.outcome = result.ok === true ? "success" : result.ok === false ? "error" : "pending";
  card.className = `result-card ${result.ok === false ? "error" : ""}`;
  if (isResultPanelCollapsed(result.engine, index)) card.classList.add("collapsed");
  const header = document.createElement("div");
  header.className = "result-head";
  header.appendChild(createResultTitle(result.name));
  if (result.ok) {
    if (result.text?.trim()) {
      const count = document.createElement("span");
      count.className = "result-count";
      count.textContent = textCountLabel(result.text, result.target || $("targetLang").value);
      header.appendChild(count);
    }
    header.appendChild(createCopyButton(result.text));
  } else if (result.ok === false) {
    header.appendChild(createRetryButton(result.engine, index));
  }
  header.appendChild(createResultToggle(card, result.engine));
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
  if (card) {
    fillResultCard(card, result, index);
    updateTranslationStatus();
  }
}

function updateTranslationStatus() {
  const cards = [...$("results").querySelectorAll(".result-card")];
  const succeeded = cards.filter((card) => card.dataset.outcome === "success").length;
  if (cards.some((card) => card.dataset.outcome === "pending")) setStatus("翻译中");
  else setStatus(!succeeded ? "翻译失败" : succeeded === cards.length ? "已完成" : "部分翻译失败");
  return succeeded;
}

function createResultTitle(name) {
  const title = document.createElement("div");
  title.className = "result-title";
  title.textContent = name;
  return title;
}

function createResultToggle(card, engineId) {
  const button = document.createElement("button");
  button.className = "result-toggle";
  button.type = "button";
  button.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.5 14.5 12 9l5.5 5.5"></path>
    </svg>
  `;
  button.setAttribute("aria-label", card.classList.contains("collapsed") ? "展开翻译结果" : "折叠翻译结果");
  button.setAttribute("aria-expanded", String(!card.classList.contains("collapsed")));
  button.addEventListener("click", () => toggleResultPanel(card, engineId, button));
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

function createRetryButton(engineId, index) {
  const button = document.createElement("button");
  button.className = "result-copy";
  button.type = "button";
  button.textContent = "重试";
  button.addEventListener("click", () => retryTranslationEngine(engineId, index, button));
  return button;
}

function retryTranslationEngine(engineId) {
  scheduleTranslate(0, true, [engineId]);
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

function toggleResultPanel(card, engineId, button) {
  const collapsed = card.classList.toggle("collapsed");
  state.resultPanelCollapsed[engineId] = collapsed;
  button.setAttribute("aria-label", collapsed ? "展开翻译结果" : "折叠翻译结果");
  button.setAttribute("aria-expanded", String(!collapsed));
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

async function translateGoogleFromClient(text, source, target) {
  const settings = state.config.google;
  const url = new URL(settings.endpoint);
  url.searchParams.set("client", "dict-chrome-ex");
  url.searchParams.set("sl", googleLang(source));
  url.searchParams.set("tl", googleLang(target));
  url.searchParams.set("q", text);
  const response = await fetch(url, { signal: timeoutSignal(settings.timeout) });
  if (!response.ok) throw new Error(`谷歌翻译请求失败：${response.status}`);
  const data = await response.json();
  let translated = "";
  let detectedSource = "";
  if (Array.isArray(data) && typeof data[0] === "string") {
    translated = data[0].trim();
    detectedSource = source === "auto" ? "" : source;
  } else if (Array.isArray(data) && Array.isArray(data[0])) {
    if (typeof data[0][0] === "string") {
      translated = data[0][0].trim();
      detectedSource = typeof data[0][1] === "string" ? data[0][1] : "";
    } else {
      translated = data[0]
        .filter((part) => Array.isArray(part) && part[0] != null)
        .map((part) => part[0])
        .join("")
        .trim();
      detectedSource = typeof data[2] === "string" ? data[2] : "";
    }
  }
  if (!translated) throw new Error("谷歌翻译未返回结果");
  return { text: translated, detectedSource };
}

async function translateGoogle(text, source, target) {
  let serverError;
  try {
    const data = await api("/api/translate", {
      method: "POST",
      body: JSON.stringify({ engine: "google", text, source, target }),
    });
    return { text: data.text, detectedSource: data.detectedSource };
  } catch (error) {
    serverError = error;
  }
  try {
    return await translateGoogleFromClient(text, source, target);
  } catch (error) {
    const clientError = error.name === "AbortError" ? "请求超时" : error.message;
    throw new Error(`谷歌翻译失败：服务器网络：${serverError.message}；客户端网络：${clientError}`);
  }
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

async function saveHistory(item) {
  if (state.historyClearing) return;
  item = window.TransTranslation.normalizeHistory([item])[0];
  if (!item?.results.length) return;
  const revision = state.historyRevision;
  state.history = window.TransTranslation.mergeHistory(state.history, item);
  state.historyPending = window.TransTranslation.mergeHistory(state.historyPending, item);
  const pending = state.historyPending;
  try {
    // Write only new/unsaved records; another tab may have cleared older history.
    const records = await historyStore.save(pending);
    if (revision !== state.historyRevision) return;
    state.history = records;
    const saved = new Set(pending.map(entry => entry.id));
    state.historyPending = state.historyPending.filter(entry => !saved.has(entry.id));
    state.historyDirty = !!state.historyPending.length;
    try { localStorage.removeItem("trans-history"); } catch { /* Saved in IndexedDB. */ }
    window.TransUI.feedback($("historyMessage"), "");
  } catch {
    if (revision !== state.historyRevision) return;
    state.historyDirty = true;
    window.TransUI.feedback($("historyMessage"), "本地历史未能保存，当前记录仅在本页保留；可导出备份。", "error");
  }
  renderHistory();
}

async function loadHistory() {
  const revision = state.historyRevision;
  if (state.historyClearing) return;
  try {
    const items = await historyStore.load();
    if (revision !== state.historyRevision) return;
    if (!state.historyDirty) { state.history = items; window.TransUI.feedback($("historyMessage"), ""); }
    try { localStorage.removeItem("trans-history"); } catch { /* Migration completed. */ }
    renderHistory();
  } catch {
    if (revision === state.historyRevision) window.TransUI.feedback($("historyMessage"), "无法读取持久历史，显示本页已有记录。", "error");
  }
}

async function clearHistory() {
  if (state.historyClearing) return;
  $("clearHistoryConfirmDialog").close();
  state.historyClearing = true;
  state.historyRevision++;
  const finish = window.TransUI.busyButton($("clearHistoryBtn"));
  window.TransUI.feedback($("historyMessage"), "正在清除…", "pending");
  try {
    localStorage.removeItem("trans-history");
    await historyStore.clear();
    state.history = []; state.historyPending = []; state.historyDirty = false;
    $("historySearch").value = "";
    renderHistory();
    window.TransUI.feedback($("historyMessage"), "本地历史已清除", "success");
  } catch {
    window.TransUI.feedback($("historyMessage"), "清除失败，请重试", "error");
  } finally { state.historyClearing = false; finish(); }
}

function renderHistory() {
  const list = $("historyList");
  list.innerHTML = "";
  if (!state.history.length) {
    list.innerHTML = '<div class="history-item">暂无历史<span>翻译后会出现在这里</span></div>';
    return;
  }
  const query = $("historySearch").value.trim().toLocaleLowerCase();
  const entries = state.history.filter((item) => [item.text, item.targetName, ...item.results.map((r) => r.text)]
    .some((text) => text.toLocaleLowerCase().includes(query)));
  if (!entries.length) { list.textContent = "没有匹配的历史记录"; return; }
  entries.forEach((item) => {
    const btn = document.createElement("button");
    btn.className = "history-item";
    btn.type = "button";
    const sourceName = state.languages.find((lang) => lang.code === item.source)?.name || item.source;
    const title = document.createTextNode(`${sourceName} → ${item.targetName}`);
    const text = document.createElement("span");
    text.textContent = item.text.slice(0, 180);
    const meta = document.createElement("span");
    meta.textContent = [item.time ? new Date(item.time).toLocaleString() : "", item.results.length
      ? item.results.map((r) => r.model || r.name).join(" · ") : "旧记录 · 未保存译文"].filter(Boolean).join(" · ");
    btn.append(title, text, meta);
    btn.addEventListener("click", () => {
      $("sourceText").value = item.text;
      $("sourceLang").value = item.source;
      $("targetLang").value = item.target;
      state.sourceAutoMode = item.source === "auto";
      state.targetAutoMode = false;
      translationQueue.cancel();
      state.currentResults = item.results;
      state.resultContext = null;
      state.activeSentence = null;
      applyVisualSentenceHighlight(null, null);
      updateCharCount();
      $("historyDialog").close();
      const box = $("results");
      box.replaceChildren();
      box.classList.toggle("empty", !item.results.length);
      item.results.forEach((result, index) => {
        const card = document.createElement("article");
        fillResultCard(card, result, index);
        box.appendChild(card);
      });
      if (!item.results.length) box.textContent = "此旧记录未保存译文，点击“翻译”可重新翻译。";
      setStatus(item.results.length ? "历史译文" : "待翻译");
    });
    list.appendChild(btn);
  });
}

function textCountLabel(text, language) {
  const code = normalizeDetectedLang(language === "auto" ? guessSourceLang(text) : language);
  if (!code || ["zh", "ja", "ko"].includes(code)) {
    return `${(text.match(/[\p{L}\p{N}]/gu) || []).length} 字`;
  }
  return `${(text.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’\-][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu) || []).length} 词`;
}

function updateCharCount() {
  $("charCount").textContent = textCountLabel($("sourceText").value, sourceForRequest());
}

function handleSourceInput() {
  state.activeSentence = null;
  applyVisualSentenceHighlight(null, null);
  if (!$("sourceText").value.trim()) {
    state.sourceAutoMode = true;
    state.targetAutoMode = true;
    $("sourceLang").value = "auto";
    $("targetLang").value = "zh";
  } else if (state.sourceAutoMode) {
    applyDetectedSource(guessSourceLang($("sourceText").value));
  }
  updateCharCount();
  scheduleTranslate();
}

function scheduleTranslate(delay = 1000, explicit = false, onlyEngines = null) {
  if (!state.config) return;
  if (state.composing || (!state.automatic && !explicit && $("sourceText").value.trim())) {
    translationQueue.cancel();
    setStatus(state.composing ? "输入中" : "待翻译");
    return;
  }
  const text = $("sourceText").value.trim();
  let engines = selectedEngines();
  state.activeSentence = null;
  applyVisualSentenceHighlight(null, null);
  if (!text) {
    translationQueue.cancel();
    state.currentResults = [];
    state.resultContext = null;
    setStatus("待翻译");
    renderEngineShells();
    return;
  }
  if (!engines.length) {
    translationQueue.cancel();
    state.currentResults = [];
    state.resultContext = null;
    setStatus("请选择引擎");
    renderEngineShells();
    return;
  }
  if (state.sourceAutoMode) {
    applyDetectedSource(guessSourceLang(text));
  } else {
    syncTargetForSource($("sourceLang").value);
  }
  const source = sourceForRequest();
  const target = $("targetLang").value;
  const config = JSON.stringify(state.config);
  const context = JSON.stringify([text, source, target, config, state.configRevision]);
  const partial = Boolean(onlyEngines && state.resultContext === context);
  if (partial) engines = onlyEngines;
  const job = { text, source, target, engines, config, context, partial,
    targetName: $("targetLang").selectedOptions[0].textContent,
    key: JSON.stringify([context, engines]) };
  setStatus(delay ? "等待输入完成" : "等待翻译");
  translationQueue.schedule(job, delay);
}

async function runTranslation(job, isCurrent) {
  const historyRevision = state.historyRevision;
  const { text, source, target, engines } = job;
  const settings = JSON.parse(job.config);
  const retainedResults = job.partial ? [...state.currentResults] : [];
  if (!job.partial) { state.currentResults = []; renderEngineShells(); }
  state.resultContext = job.context;
  function restoreResultContext() {
    if (state.resultContext === job.context) return;
    state.currentResults = [...retainedResults];
    renderEngineShells();
    state.resultContext = job.context;
    retainedResults.forEach((result, index) => updateResultCard(result, index));
  }
  setStatus("翻译中");
  const results = await Promise.all(engines.map(async (engineId, index) => {
      let result;
      try {
        const translated = await translateWithEngine(engineId, text, source, target);
        result = {
          engine: engineId,
          name: engineName(engineId),
          ok: true,
          text: translated.text,
          target,
          model: settings[engineId]?.model || "",
          style: settings[engineId]?.style || "",
          detectedSource: translated.detectedSource,
        };
      } catch (error) {
        const hint = error.name === "AbortError" ? "请求超时" : error.message;
        result = { engine: engineId, name: engineName(engineId), ok: false, error: hint };
      }
      if (isCurrent()) {
        restoreResultContext();
        state.currentResults = [...state.currentResults.filter((item) => item.engine !== engineId), result];
        updateDetectedSource(state.currentResults, text);
        updateResultCard(result, index);
      }
      return result;
    }));
    if (!isCurrent()) return;
    restoreResultContext();
    // Also restore results that finished while another input was temporarily current.
    results.forEach((result, index) => {
      state.currentResults = [...state.currentResults.filter((item) => item.engine !== result.engine), result];
      updateResultCard(result, index);
    });
    if (!updateTranslationStatus()) return;
    if (historyRevision === state.historyRevision) await saveHistory({ text, source, target, targetName: job.targetName, time: Date.now(),
      results: state.currentResults.filter((result) => result.ok) });
}

async function saveConfig() {
  if ($("saveConfigBtn").disabled || $("clearCacheBtn").disabled) return;
  if (!$("deepseekCacheLimit").reportValidity()) return;
  translationQueue.cancel();
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
      cache_limit: Number($("deepseekCacheLimit").value),
    },
    google: {
      enabled: $("googleEnabled").checked,
      endpoint: $("googleEndpoint").value,
      timeout: Number($("googleTimeout").value),
    },
  };
  const finish = window.TransUI.busyButton($("saveConfigBtn"));
  $("clearCacheBtn").disabled = true;
  setConfigMessage("正在保存…", "pending");
  try {
    const data = await api("/api/config", { method: "PUT", body: JSON.stringify(payload) });
    state.config = data.config;
    state.configRevision++;
    await bootstrap();
    await loadDeepSeekCacheStatus();
    setConfigMessage("配置已保存", "success");
    scheduleTranslate(0);
  } catch (error) {
    setConfigMessage(`保存失败：${error.message}`, "error");
  } finally {
    finish();
    $("clearCacheBtn").disabled = false;
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
$("sourceText").addEventListener("compositionstart", () => {
  state.composing = true;
  translationQueue.cancel();
});
$("sourceText").addEventListener("compositionend", () => {
  state.composing = false;
  handleSourceInput();
});
$("autoTranslate").checked = state.automatic;
$("autoTranslate").addEventListener("change", () => {
  state.automatic = $("autoTranslate").checked;
  try { localStorage.setItem("trans-auto-translate", String(state.automatic)); } catch { /* Optional preference. */ }
  scheduleTranslate();
});
$("translateBtn").addEventListener("click", () => scheduleTranslate(0, true));
$("sourceText").addEventListener("scroll", syncSourceHighlight, { passive: true });
$("sourceText").addEventListener("focus", () => $("sourceHighlight").replaceChildren());
new ResizeObserver(syncSourceHighlight).observe($("sourceText"));
$("sourceLang").addEventListener("change", () => {
  state.sourceAutoMode = $("sourceLang").value === "auto";
  state.targetAutoMode = true;
  if (state.sourceAutoMode) {
    $("targetLang").value = "zh";
    applyDetectedSource(guessSourceLang($("sourceText").value));
  }
  syncTargetForSource($("sourceLang").value);
  updateCharCount();
  scheduleTranslate(0);
});
$("targetLang").addEventListener("change", () => {
  state.targetAutoMode = false;
  syncTargetForSource($("sourceLang").value);
  scheduleTranslate(0);
});
$("googleEndpointPreset").addEventListener("change", () => {
  const endpoint = $("googleEndpointPreset").value;
  $("googleEndpoint").hidden = Boolean(endpoint);
  if (endpoint) {
    $("googleEndpoint").value = endpoint;
  } else {
    $("googleEndpoint").focus();
  }
});
$("sourceText").addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    if (!event.isComposing) scheduleTranslate(0, true);
  }
});
$("swapBtn").addEventListener("click", () => {
  if ($("sourceLang").value === "auto") return;
  const source = $("sourceLang").value;
  $("sourceLang").value = $("targetLang").value;
  $("targetLang").value = source;
  state.sourceAutoMode = false;
  state.targetAutoMode = false;
  updateCharCount();
  scheduleTranslate(0);
});
window.TransUI.setupScrollFades($("historyDialog"), ".history-list");
$("historyBtn").addEventListener("click", () => {
  lockTranslationBackground();
  $("historyDialog").showModal();
  loadHistory();
});
$("clearHistoryBtn").addEventListener("click", () => {
  if (!state.historyClearing) $("clearHistoryConfirmDialog").showModal();
});
$("cancelClearHistoryBtn").addEventListener("click", () => $("clearHistoryConfirmDialog").close());
$("confirmClearHistoryBtn").addEventListener("click", clearHistory);
$("historySearch").addEventListener("input", renderHistory);
$("exportHistoryBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ version: 1, records: state.history }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `trans-history-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
});
for (const dialog of [$("historyDialog"), $("settingsDialog")]) {
  dialog.addEventListener("close", unlockTranslationBackground);
}
$("closeHistoryBtn").addEventListener("click", () => $("historyDialog").close());
document.addEventListener("visibilitychange", refreshBalanceWhenVisible);
$("settingsBtn").addEventListener("click", () => {
  clearConfigMessage();
  $("deepseekCacheStats").textContent = "正在读取";
  lockTranslationBackground();
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
  const body = help.querySelector("div");
  if (!body) return;
  body.style.removeProperty("--help-shift-x");
  const rect = body.getBoundingClientRect();
  let shift = 0;
  if (rect.right > window.innerWidth - 16) {
    shift -= rect.right - (window.innerWidth - 16);
  }
  if (rect.left + shift < 16) {
    shift += 16 - (rect.left + shift);
  }
  body.style.setProperty("--help-shift-x", Math.round(shift) + "px");
}
$("saveConfigBtn").addEventListener("click", saveConfig);
$("clearCacheBtn").addEventListener("click", openClearCacheConfirmation);
$("cancelClearCacheBtn").addEventListener("click", closeClearCacheConfirmation);
$("confirmClearCacheBtn").addEventListener("click", () => {
  closeClearCacheConfirmation();
  clearDeepSeekCache();
});
$("settingsDialog").addEventListener("cancel", (event) => {
  if ($("clearCacheConfirmDialog").hidden) return;
  event.preventDefault();
  closeClearCacheConfirmation();
});
$("logoutBtn").addEventListener("click", async () => {
  await api("/logout", { method: "POST", body: "{}" });
  window.location.href = "/login";
});

bootstrap().catch((error) => {
  setStatus(error.message);
});
loadHistory();
