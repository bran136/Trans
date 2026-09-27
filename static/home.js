const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || "";
let monitorTimer = null;
let monitorRequestId = 0;
let monitorAppliedRequestId = 0;

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const { timeout = 12000, ...requestOptions } = options;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, {
      ...requestOptions,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options.method && !["GET", "HEAD"].includes(options.method.toUpperCase()) ? { "X-CSRF-Token": csrfToken } : {}),
        ...(options.headers || {}),
      },
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `请求失败：${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时，请稍后刷新状态");
    throw error;
  } finally { window.clearTimeout(timer); }
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
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`;
}

function formatAudioCacheMegabytes(bytes) {
  const value = (Number(bytes) || 0) / 1024 / 1024;
  if (!value) return "0";
  return value.toFixed(value >= 10 ? 0 : 1);
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

function setMonitorMessage(text, type = "success", source = "") {
  const message = $("monitorMessage");
  message.dataset.source = source;
  message.textContent = text;
  message.className = `config-message ${type}`;
  message.hidden = false;
}

function clearMonitorMessage() {
  const message = $("monitorMessage");
  delete message.dataset.source;
  message.textContent = "";
  message.className = "config-message";
  message.hidden = true;
}

function renderServiceStatus(data) {
  const appMemoryPercent = data.system.memory_total_bytes
    ? data.process.rss_bytes / data.system.memory_total_bytes * 100
    : 0;
  const ttsCache = data.tts_cache || {};
  $("metricPid").textContent = data.pid;
  $("metricUptime").textContent = formatUptime(data.uptime_seconds);
  $("metricAppCpu").textContent = `${data.process.cpu_percent}%`;
  $("metricAppMemory").textContent = `${formatBytes(data.process.rss_bytes)} | ${appMemoryPercent.toFixed(2)}%`;
  $("metricCache").textContent = `${data.cache.entries} / ${data.cache.limit}`;
  $("metricTtsCacheEntries").textContent = `${Number(ttsCache.entries || 0)} 句`;
  $("metricTtsCacheDetail").textContent = `缓 ${formatAudioCacheMegabytes(ttsCache.cache_disk_size_bytes ?? ttsCache.disk_size_bytes ?? ttsCache.size_bytes)}/${formatAudioCacheMegabytes(ttsCache.limit_bytes)} M · ${ttsCache.ttl_days || 0}天 | 固 ${formatAudioCacheMegabytes(ttsCache.fixed_disk_size_bytes ?? ttsCache.pinned_disk_size_bytes ?? ttsCache.pinned_size_bytes)} M`;
  $("metricSystemCpu").textContent = `${data.system.cpu_percent}%`;
  $("metricSystemMemory").textContent = `${data.system.memory_used_percent}% | ${formatBytes(data.system.memory_available_bytes)} 可用`;
  $("metricLoad").textContent = data.system.load_avg.map((item) => Number(item).toFixed(2)).join(" / ");
  $("metricDisk").textContent = `${data.disk.used_percent}% | ${formatBytes(data.disk.free_bytes)} 可用`;
}

async function loadServiceStatus(showError = true) {
  const requestId = ++monitorRequestId;
  try {
    const data = await api("/api/status");
    if (requestId < monitorAppliedRequestId) return false;
    monitorAppliedRequestId = requestId;
    renderServiceStatus(data);
    if ($("monitorMessage").dataset.source === "status") clearMonitorMessage();
    return true;
  } catch (error) {
    if (requestId < monitorAppliedRequestId) return false;
    monitorAppliedRequestId = requestId;
    if (showError) setMonitorMessage(`状态获取失败：${error.message}`, "error", "status");
    return false;
  }
}

function startMonitorRefresh() {
  stopMonitorRefresh();
  loadServiceStatus();
  monitorTimer = window.setInterval(() => loadServiceStatus(false), 5000);
}

function stopMonitorRefresh() {
  window.clearInterval(monitorTimer);
  monitorTimer = null;
  // Ignore outstanding requests after closing the dialog or starting a restart.
  monitorAppliedRequestId = ++monitorRequestId;
}

function openRestartConfirmation() {
  if ($("restartServiceBtn").disabled) return;
  $("restartConfirmDialog").showModal();
  window.setTimeout(() => $("confirmRestartBtn").focus(), 0);
}

async function restartService() {
  if ($("restartServiceBtn").disabled) return;
  $("restartConfirmDialog").close();
  $("restartServiceBtn").disabled = true;
  try {
    const previous = await api("/api/restart", { method: "POST", body: "{}" });
    setMonitorMessage("服务正在重启，恢复后自动刷新状态", "success");
    stopMonitorRefresh();
    const deadline = Date.now() + 90000;
    window.setTimeout(async function poll() {
      try {
        const ready = await api("/api/ready", { timeout: 2500 });
        if (ready.pid !== previous.pid || ready.started !== previous.started) {
          setMonitorMessage("服务已恢复", "success");
          $("restartServiceBtn").disabled = false;
          if ($("monitorDialog").open) startMonitorRefresh();
          return;
        }
      } catch (_) { /* The listener can be unavailable while the process restarts. */ }
      if (Date.now() >= deadline) {
        setMonitorMessage("尚未确认服务恢复，请刷新页面或检查服务日志", "error");
        $("restartServiceBtn").disabled = false;
        return;
      }
      window.setTimeout(poll, 1000);
    }, 600);
  } catch (error) {
    setMonitorMessage(`重启失败：${error.message}`, "error");
    $("restartServiceBtn").disabled = false;
  }
}

$("monitorBtn").addEventListener("click", () => {
  clearMonitorMessage();
  $("monitorDialog").showModal();
  startMonitorRefresh();
});

$("closeMonitorBtn").addEventListener("click", () => $("monitorDialog").close());
$("refreshStatusBtn").addEventListener("click", () => loadServiceStatus());
$("restartServiceBtn").addEventListener("click", openRestartConfirmation);
$("cancelRestartBtn").addEventListener("click", () => $("restartConfirmDialog").close());
$("confirmRestartBtn").addEventListener("click", restartService);
$("monitorDialog").addEventListener("close", () => {
  stopMonitorRefresh();
});

$("logoutBtn").addEventListener("click", async () => {
  try {
    await api("/logout", { method: "POST", body: "{}" });
    window.location.href = "/login";
  } catch (error) {
    await window.TransUI.message("退出失败", error.message);
  }
});

let aboutScrollY = 0;
$("aboutBtn").addEventListener("click", () => {
  aboutScrollY = window.scrollY;
  document.body.style.setProperty("--about-scroll-top", `${-aboutScrollY}px`);
  document.documentElement.classList.add("home-about-open");
  $("homeAboutDialog").showModal();
  $("homeAboutTitle").focus({ preventScroll: true });
});
$("closeAboutBtn").addEventListener("click", () => $("homeAboutDialog").close());
$("homeAboutDialog").addEventListener("close", () => {
  document.documentElement.classList.remove("home-about-open");
  document.body.style.removeProperty("--about-scroll-top");
  window.scrollTo(0, aboutScrollY);
});

let securityState = null;
let securityBusy = false;
let securityScrollY = 0;
let mfaAction = "setup";
let mfaStep = "password";
let clientListRevision = 0;

function securityMessage(text = "", type = "success", id = "securityMessage") {
  const node = $(id);
  node.textContent = text;
  node.className = `config-message ${type}`;
  node.hidden = !text;
}

function recoveryRecentlyVerified() {
  return Number(securityState?.recovery_verified_until || 0) * 1000 > Date.now();
}

function renderLoginClients() {
  const revision = ++clientListRevision;
  const container = $("loginClients");
  container.replaceChildren();
  const clients = securityState?.clients;
  if (!Array.isArray(clients) || !clients.length) {
    const hint = document.createElement("p");
    hint.className = "security-hint";
    hint.textContent = !securityState ? "正在读取…" : "暂无已登录设备";
    container.appendChild(hint);
    return;
  }
  const formatTime = (seconds) => {
    if (seconds == null) return "未知";
    const date = new Date(Number(seconds) * 1000);
    return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "未知";
  };
  const locations = new Map();
  clients.forEach((client) => {
    const card = document.createElement("div");
    card.className = "login-client";
    const head = document.createElement("div");
    head.className = "login-client-head";
    const title = document.createElement("strong");
    title.textContent = `${client.browser} · ${client.platform}`;
    head.appendChild(title);
    const actions = document.createElement("div");
    actions.className = "login-client-actions";
    if (client.current) {
      const badge = document.createElement("span");
      badge.className = "security-status enabled";
      badge.textContent = "当前客户端";
      actions.appendChild(badge);
    }
    const logout = document.createElement("button");
    logout.type = "button";
    logout.className = "danger-btn login-client-logout";
    logout.textContent = "退出";
    logout.title = client.current ? "退出当前客户端" : "退出此客户端";
    logout.disabled = securityBusy || !client.id;
    logout.addEventListener("click", () => logoutClient(client));
    actions.appendChild(logout);
    head.appendChild(actions);
    const meta = document.createElement("div");
    meta.className = "login-client-meta";
    const location = document.createElement("span");
    location.className = "login-client-location";
    location.textContent = `查询地区中（${client.ip}）`;
    if (!locations.has(client.ip)) locations.set(client.ip, []);
    locations.get(client.ip).push(location);
    meta.appendChild(location);
    [`登录：${formatTime(client.created_at)}`, `活动：${formatTime(client.last_seen)}`].forEach((text) => {
      const span = document.createElement("span");
      span.textContent = text;
      meta.appendChild(span);
    });
    card.append(head, meta);
    if (client.user_agent) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "浏览器详情";
      const agent = document.createElement("p");
      agent.textContent = client.user_agent;
      details.append(summary, agent);
      card.appendChild(details);
    }
    container.appendChild(card);
  });
  // Location is optional enrichment: do not hold up settings or authentication.
  const queue = [...locations];
  async function locateNext() {
    while (queue.length && revision === clientListRevision && $("securityDialog").open) {
      const [ip, nodes] = queue.shift();
      let label = "未知地区";
      try {
        const data = await api(`/api/security/client-location?ip=${encodeURIComponent(ip)}`, { timeout: 8000 });
        if (typeof data.location === "string" && data.location) label = data.location;
      } catch (_) { /* A failed lookup must leave the IP and other controls usable. */ }
      if (revision !== clientListRevision || !$("securityDialog").open) return;
      nodes.forEach((node) => { node.textContent = `${label}（${ip}）`; });
    }
  }
  locateNext();
  locateNext();
}

async function logoutClient(client) {
  if (securityBusy || !securityState || !client.id) return;
  securityBusy = true;
  renderSecurityState();
  securityMessage();
  try {
    const data = await api(`/api/security/clients/${encodeURIComponent(client.id)}`, { method: "DELETE" });
    if (data.signed_out_current) {
      clientListRevision += 1;
      window.location.replace("/login");
      return;
    }
    securityState = data;
    renderLoginClients();
    securityMessage("该客户端已退出");
  } catch (error) {
    securityMessage(`退出失败：${error.message}`, "error");
  } finally {
    securityBusy = false;
    renderSecurityState();
  }
}

function renderSecurityState() {
  const enabled = Boolean(securityState?.enabled);
  $("mfaStatus").textContent = securityState ? (enabled ? "已启用" : "未启用") : "正在读取";
  $("mfaStatus").classList.toggle("enabled", enabled);
  $("mfaSummary").textContent = enabled
    ? `登录时验证动态验证码，剩余 ${securityState.recovery_remaining} 个恢复码。`
    : "使用验证器生成动态验证码，为密码登录增加一层保护。";
  $("setupMfaBtn").hidden = enabled;
  $("recoveryMfaBtn").hidden = !enabled;
  $("disableMfaBtn").hidden = !enabled;
  $("closeSecurityBtn").disabled = securityBusy;
  $("refreshClientsBtn").disabled = securityBusy || !securityState;
  $("savePasswordBtn").disabled = securityBusy || !securityState;
  document.querySelectorAll("#securityDialog .security-actions button").forEach((button) => {
    button.disabled = securityBusy || !securityState;
  });
  document.querySelectorAll("#loginClients .login-client-logout").forEach((button, index) => {
    button.disabled = securityBusy || !securityState?.clients?.[index]?.id;
  });
  if ($("mfaDialog").open) renderMfaDialog();
}

function renderMfaDialog() {
  const binding = mfaStep === "bind";
  const codes = mfaStep === "codes";
  const changingPassword = mfaAction === "password";
  const recovered = recoveryRecentlyVerified();
  $("mfaDialogTitle").textContent = codes ? "保存恢复码" : {
    setup: "绑定验证器", recovery: "重新生成恢复码", disable: "关闭双重验证", password: "验证身份",
  }[mfaAction];
  $("mfaDialogHint").textContent = codes
    ? (mfaAction === "setup" ? "2FA 双重验证已启用，请保存下方恢复码。" : "旧恢复码已失效，请保存下方新恢复码。") : binding
    ? "输入验证器中的 6 位验证码，完成绑定。" : {
      setup: "请先验证当前访问密码。",
      recovery: "验证身份后生成新的恢复码，旧恢复码将全部失效。",
      disable: "验证身份后关闭双重验证，此后仅使用密码登录。",
      password: "请输入验证器中的动态验证码或一条恢复码，确认修改访问密码。",
    }[mfaAction];
  $("mfaForm").hidden = codes;
  $("mfaPasswordField").hidden = binding || changingPassword;
  $("mfaPassword").required = !binding && !codes && !changingPassword;
  $("mfaSetup").hidden = !binding;
  $("mfaCodeField").hidden = !binding && mfaAction === "setup";
  $("mfaCodeLabel").textContent = binding ? "6 位验证码" : "验证码或恢复码";
  $("mfaCode").required = !codes && (binding || (mfaAction !== "setup" && !recovered));
  $("mfaCode").inputMode = binding ? "numeric" : "text";
  $("mfaCode").placeholder = !binding && recovered ? "恢复码验证后 5 分钟内可留空" : "";
  $("confirmMfaBtn").textContent = binding ? "确认启用" : {
    setup: "验证密码", recovery: "验证并重新生成", disable: "验证并关闭", password: "验证并修改",
  }[mfaAction];
  $("confirmMfaBtn").className = mfaAction === "disable" ? "danger-btn" : "primary";
  $("restartMfaBtn").hidden = !binding;
  $("recoveryPanel").hidden = !codes;
  ["confirmMfaBtn", "restartMfaBtn", "closeMfaBtn"].forEach((id) => { $(id).disabled = securityBusy; });
}

function clearMfaDialog() {
  mfaStep = "password";
  $("mfaForm").reset();
  $("mfaQr").removeAttribute("src");
  $("mfaSecret").textContent = "";
  $("recoveryCodes").textContent = "";
  securityMessage("", "success", "mfaMessage");
}

function openMfaDialog(action) {
  if (securityBusy || !securityState || $("mfaDialog").open) return;
  clearMfaDialog();
  mfaAction = action;
  renderMfaDialog();
  $("mfaDialog").showModal();
  $("mfaDialogTitle").focus({ preventScroll: true });
}

async function changeSecurity(event) {
  event.preventDefault();
  if (securityBusy || !securityState || mfaStep === "codes") return;
  if (mfaAction === "password") return submitAccessPassword($("mfaCode").value);
  const action = mfaStep === "bind" ? "enable" : mfaAction;
  securityBusy = true;
  renderSecurityState();
  securityMessage("", "success", "mfaMessage");
  try {
    const data = await api("/api/security", {
      method: "POST",
      body: JSON.stringify({ action, current_password: $("mfaPassword").value, code: $("mfaCode").value }),
    });
    if (action === "setup") {
      mfaStep = "bind";
      $("mfaQr").src = data.qr;
      $("mfaSecret").textContent = data.secret;
      $("mfaCode").value = "";
    } else {
      securityState = data;
      renderLoginClients();
      clearMfaDialog();
      const codes = data.recovery_codes || [];
      if (codes.length) {
        mfaStep = "codes";
        $("recoveryCodes").textContent = codes.join("\n");
      } else {
        $("mfaDialog").close();
      }
      securityMessage(action === "disable" ? "双重验证已关闭，其他客户端已退出" : action === "enable"
        ? "2FA 已启用，其他客户端已退出" : "恢复码已更新，其他客户端已退出");
    }
    $("mfaDialogTitle").focus({ preventScroll: true });
  } catch (error) {
    securityMessage(error.message, "error", "mfaMessage");
  } finally {
    securityBusy = false;
    renderSecurityState();
  }
}

function saveAccessPassword(event) {
  event.preventDefault();
  if (securityBusy || !securityState || $("mfaDialog").open) return;
  if (!$("passwordForm").reportValidity()) return;
  securityMessage();
  if (securityState.enabled) {
    openMfaDialog("password");
    return;
  }
  return submitAccessPassword();
}

async function submitAccessPassword(code = "") {
  if (securityBusy || !securityState) return;
  const verifying = $("mfaDialog").open && mfaAction === "password";
  const messageId = verifying ? "mfaMessage" : "securityMessage";
  securityBusy = true;
  renderSecurityState();
  securityMessage("", "success", messageId);
  try {
    securityState = await api("/api/password", {
      method: "PUT",
      body: JSON.stringify({ current_password: $("currentPassword").value,
        new_password: $("newPassword").value, code }),
    });
    renderLoginClients();
    $("passwordForm").reset();
    if (verifying) {
      clearMfaDialog();
      $("mfaDialog").close();
    }
    securityMessage("访问密码已修改，其他浏览器需要重新登录");
  } catch (error) {
    securityMessage(error.message, "error", messageId);
  } finally {
    securityBusy = false;
    renderSecurityState();
  }
}

$("settingsBtn").addEventListener("click", async () => {
  if ($("securityDialog").open) return;
  securityScrollY = window.scrollY;
  document.body.style.setProperty("--about-scroll-top", `${-securityScrollY}px`);
  document.documentElement.classList.add("home-about-open");
  securityState = null;
  securityBusy = true;
  securityMessage();
  renderSecurityState();
  renderLoginClients();
  $("securityDialog").showModal();
  $("securityTitle").focus({ preventScroll: true });
  try {
    securityState = await api("/api/security");
    renderLoginClients();
  } catch (error) {
    securityMessage(`设置读取失败：${error.message}`, "error");
    $("loginClients").textContent = "读取失败，请重新打开设置";
  } finally {
    securityBusy = false;
    renderSecurityState();
    if (!securityState) $("mfaStatus").textContent = "读取失败";
  }
});
$("refreshClientsBtn").addEventListener("click", async () => {
  if (securityBusy || !securityState) return;
  securityBusy = true;
  renderSecurityState();
  securityMessage();
  try {
    securityState = await api("/api/security");
    renderLoginClients();
  } catch (error) {
    securityMessage(`刷新失败：${error.message}`, "error");
  } finally {
    securityBusy = false;
    renderSecurityState();
  }
});
$("closeSecurityBtn").addEventListener("click", () => {
  if (!securityBusy) $("securityDialog").close();
});
$("securityDialog").addEventListener("cancel", (event) => {
  if (securityBusy) event.preventDefault();
});
$("securityDialog").addEventListener("close", () => {
  clientListRevision += 1;
  $("passwordForm").reset();
  clearMfaDialog();
  document.documentElement.classList.remove("home-about-open");
  document.body.style.removeProperty("--about-scroll-top");
  window.scrollTo(0, securityScrollY);
});
$("closeMfaBtn").addEventListener("click", () => {
  if (!securityBusy) $("mfaDialog").close();
});
$("mfaDialog").addEventListener("cancel", (event) => {
  if (securityBusy) event.preventDefault();
});
$("mfaDialog").addEventListener("close", () => {
  clearMfaDialog();
  if ($("securityDialog").open) $("securityTitle").focus({ preventScroll: true });
});
$("mfaForm").addEventListener("submit", changeSecurity);
$("restartMfaBtn").addEventListener("click", () => {
  clearMfaDialog();
  renderMfaDialog();
  $("mfaDialogTitle").focus({ preventScroll: true });
});
$("setupMfaBtn").addEventListener("click", () => openMfaDialog("setup"));
$("recoveryMfaBtn").addEventListener("click", () => openMfaDialog("recovery"));
$("disableMfaBtn").addEventListener("click", () => openMfaDialog("disable"));
function setAccessPasswordVisible(id, visible) {
  $(id).type = visible ? "text" : "password";
  const button = $(`${id}Toggle`);
  const label = `${visible ? "隐藏" : "显示"}${id === "currentPassword" ? "当前密码" : "新密码"}`;
  button.setAttribute("aria-pressed", String(visible));
  button.setAttribute("aria-label", label);
  button.title = label;
}
["currentPassword", "newPassword"].forEach((id) => {
  $(`${id}Toggle`).addEventListener("click", () => setAccessPasswordVisible(id, $(id).type === "password"));
});
$("passwordForm").addEventListener("reset", () => {
  ["currentPassword", "newPassword"].forEach((id) => setAccessPasswordVisible(id, false));
});
$("passwordForm").addEventListener("submit", saveAccessPassword);
$("copyRecoveryBtn").addEventListener("click", async () => {
  const codes = $("recoveryCodes").textContent;
  const button = $("copyRecoveryBtn");
  if (!codes || button.disabled || mfaStep !== "codes") return;
  button.disabled = true;
  let message = "恢复码已复制";
  let type = "success";
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(codes);
    } else {
      const field = document.createElement("textarea");
      field.value = codes;
      field.readOnly = true;
      field.style.cssText = "position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;font-size:16px;";
      $("mfaDialog").appendChild(field);
      try {
        field.focus({ preventScroll: true });
        field.select();
        if (!document.execCommand("copy")) throw new Error("Copy unavailable");
      } finally {
        field.remove();
        button.focus({ preventScroll: true });
      }
    }
  } catch (_) {
    message = "复制失败，请手动选择恢复码复制或下载";
    type = "error";
  } finally {
    button.disabled = false;
  }
  if ($("mfaDialog").open && mfaStep === "codes" && $("recoveryCodes").textContent === codes) {
    securityMessage(message, type, "mfaMessage");
  }
});
$("downloadRecoveryBtn").addEventListener("click", () => {
  const blob = new Blob(["Trans 一次性恢复码\n每个恢复码仅可使用一次，请与访问密码分开保管。\n\n" + $("recoveryCodes").textContent + "\n"], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "Trans-recovery-codes.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
});
