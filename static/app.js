const state = {
  languages: [],
  engines: [],
  config: null,
  history: JSON.parse(localStorage.getItem("trans-history") || "[]"),
  translateTimer: null,
  monitorTimer: null,
  balanceTimer: null,
  deepseekBalance: null,
  deepseekBalanceLoadedAt: 0,
  requestId: 0,
  sourceAutoMode: true,
  targetAutoMode: true,
  resultPanelCollapsed: {},
};

const $ = (id) => document.getElementById(id);

function option(label, value, selected = false) {
  const el = document.createElement("option");
  el.value = value;
  el.textContent = label;
  el.selected = selected;
  return el;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
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
  $("appPassword").value = c.app_password || "";
  $("deepseekEnabled").checked = c.deepseek.enabled;
  $("deepseekKey").value = "";
  $("deepseekKey").placeholder = c.deepseek.api_key_configured ? "已配置，留空不修改" : "未配置";
  $("deepseekBaseUrl").value = c.deepseek.base_url;
  $("deepseekBaseUrl").disabled = !c.deepseek.allow_custom_base_url;
  $("deepseekBaseUrl").title = c.deepseek.allow_custom_base_url
    ? "可在服务器 .env 中关闭自定义地址"
    : "服务器 .env 中 ALLOW_CUSTOM_DEEPSEEK_BASE_URL=false，前端不可修改";
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

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
}

function formatUptime(seconds) {
  const total = Number(seconds) || 0;
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}天 ${hours}小时`;
  if (hours) return `${hours}小时 ${minutes}分`;
  return `${minutes}分`;
}

function setMonitorMessage(text, type = "success") {
  const message = $("monitorMessage");
  message.textContent = text;
  message.className = `config-message ${type}`;
  message.hidden = false;
}

function clearMonitorMessage() {
  const message = $("monitorMessage");
  message.textContent = "";
  message.className = "config-message";
  message.hidden = true;
}

function renderServiceStatus(data) {
  const appMemoryPercent = data.system.memory_total_bytes
    ? data.process.rss_bytes / data.system.memory_total_bytes * 100
    : 0;
  $("metricPid").textContent = data.pid;
  $("metricUptime").textContent = formatUptime(data.uptime_seconds);
  $("metricAppCpu").textContent = `${data.process.cpu_percent}%`;
  $("metricAppMemory").textContent = `${formatBytes(data.process.rss_bytes)} | ${appMemoryPercent.toFixed(2)}%`;
  $("metricCache").textContent = `${data.cache.entries} / ${data.cache.limit}`;
  $("metricSystemCpu").textContent = `${data.system.cpu_percent}%`;
  $("metricSystemMemory").textContent = `${data.system.memory_used_percent}% | ${formatBytes(data.system.memory_available_bytes)} 可用`;
  $("metricLoad").textContent = data.system.load_avg.map((item) => Number(item).toFixed(2)).join(" / ");
  $("metricDisk").textContent = `${data.disk.used_percent}% | ${formatBytes(data.disk.free_bytes)} 可用`;
}

async function loadServiceStatus(showError = true) {
  try {
    const data = await api("/api/status");
    renderServiceStatus(data);
    return true;
  } catch (error) {
    if (showError) setMonitorMessage(`状态获取失败：${error.message}`, "error");
    return false;
  }
}

function startMonitorRefresh() {
  window.clearInterval(state.monitorTimer);
  loadServiceStatus();
  state.monitorTimer = window.setInterval(() => loadServiceStatus(false), 5000);
}

function stopMonitorRefresh() {
  window.clearInterval(state.monitorTimer);
  state.monitorTimer = null;
}

async function loadDeepSeekBalance() {
  if (document.hidden) return;
  try {
    const data = await api("/api/deepseek/balance");
    state.deepseekBalance = data.balance;
    state.deepseekBalanceLoadedAt = Date.now();
  } catch (error) {
    state.deepseekBalance = null;
  }
  renderDeepSeekBalance();
}

function startBalanceRefresh() {
  window.clearInterval(state.balanceTimer);
  loadDeepSeekBalance();
  state.balanceTimer = window.setInterval(loadDeepSeekBalance, 15 * 60 * 1000);
}

function refreshBalanceWhenVisible() {
  if (document.hidden) return;
  if (Date.now() - state.deepseekBalanceLoadedAt >= 15 * 60 * 1000) {
    loadDeepSeekBalance();
  }
}

async function clearServerCache() {
  if (!window.confirm("确定清空 DeepSeek 本地翻译缓存？清空后相同内容会重新请求 API。")) return;
  $("clearCacheBtn").disabled = true;
  try {
    const data = await api("/api/cache", { method: "DELETE" });
    setMonitorMessage(`已清空 ${data.cleared} 条缓存`, "success");
    await loadServiceStatus(false);
  } catch (error) {
    setMonitorMessage(`清空失败：${error.message}`, "error");
  } finally {
    $("clearCacheBtn").disabled = false;
  }
}

async function restartService() {
  if (!window.confirm("确定重启后端服务？正在进行的翻译请求会中断。")) return;
  $("restartServiceBtn").disabled = true;
  try {
    await api("/api/restart", { method: "POST", body: "{}" });
    setMonitorMessage("服务正在重启，稍后自动刷新状态", "success");
    stopMonitorRefresh();
    window.setTimeout(async function poll() {
      if (await loadServiceStatus(false)) {
        setMonitorMessage("服务已恢复", "success");
        $("restartServiceBtn").disabled = false;
        startMonitorRefresh();
        return;
      }
      window.setTimeout(poll, 1000);
    }, 1200);
  } catch (error) {
    setMonitorMessage(`重启失败：${error.message}`, "error");
    $("restartServiceBtn").disabled = false;
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
  pre.textContent = result.ok === false ? result.error : (result.text || "");
  card.replaceChildren(header, pre);
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
  button.innerHTML = `<span>${name}</span><span>${meta}</span>`;
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
    app_password: $("appPassword").value,
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
$("monitorBtn").addEventListener("click", () => {
  clearMonitorMessage();
  $("monitorDialog").showModal();
  startMonitorRefresh();
});
$("closeMonitorBtn").addEventListener("click", () => {
  $("monitorDialog").close();
  stopMonitorRefresh();
});
$("refreshStatusBtn").addEventListener("click", () => loadServiceStatus());
$("clearCacheBtn").addEventListener("click", clearServerCache);
$("restartServiceBtn").addEventListener("click", restartService);
$("monitorDialog").addEventListener("close", stopMonitorRefresh);
document.addEventListener("visibilitychange", refreshBalanceWhenVisible);
$("settingsBtn").addEventListener("click", () => {
  clearConfigMessage();
  $("settingsDialog").showModal();
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
$("logoutBtn").addEventListener("click", async () => {
  await api("/logout", { method: "POST", body: "{}" });
  window.location.href = "/login";
});

bootstrap().catch((error) => {
  setStatus(error.message);
});
