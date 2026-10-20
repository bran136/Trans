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
      throw Object.assign(new Error(data.error || `请求失败：${response.status}`), { code: data.code });
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
  $("metricTtsCacheEntries").textContent = `${Number(ttsCache.entries || 0)}句 ｜ 固 ${formatAudioCacheMegabytes(ttsCache.fixed_disk_size_bytes ?? ttsCache.pinned_disk_size_bytes ?? ttsCache.pinned_size_bytes)}M`;
  $("metricTtsCacheDetail").textContent = `缓 ${formatAudioCacheMegabytes(ttsCache.cache_disk_size_bytes ?? ttsCache.disk_size_bytes ?? ttsCache.size_bytes)}/${formatAudioCacheMegabytes(ttsCache.limit_bytes)} M · ${ttsCache.ttl_days || 0}天`;
  if (ttsCache.ready === false) {
    $("metricTtsCacheEntries").textContent = ttsCache.refreshing ? "统计中…" : "待统计";
    $("metricTtsCacheDetail").textContent = `上限 ${formatAudioCacheMegabytes(ttsCache.limit_bytes)} M · ${ttsCache.ttl_days || 0}天`;
  }
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
    setMonitorMessage("正在重启，恢复后自动刷新", "success");
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
const clientPreviewObserver = new ResizeObserver(() => {
  const container = $("loginClients");
  const heading = container.children[2]?.querySelector(".login-client-head strong");
  if (!heading || !$("securityDialog").open) return;
  // Keep the third title's first line halfway into the 24px bottom fade.
  const box = heading.getBoundingClientRect();
  const style = getComputedStyle(heading);
  const center = box.top - container.getBoundingClientRect().top + container.scrollTop
    + parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2;
  const height = `${Math.ceil(center + 12)}px`;
  if (container.style.getPropertyValue("--clients-preview-height") !== height) {
    container.style.setProperty("--clients-preview-height", height);
  }
});

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
  clientPreviewObserver.disconnect();
  container.style.removeProperty("--clients-preview-height");
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
    return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }) : "未知";
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
    [["登录", client.created_at], ["活动", client.last_seen]].forEach(([label, seconds]) => {
      const span = document.createElement("span");
      span.className = "login-client-time";
      span.textContent = `${label}：${formatTime(seconds)}`;
      if (seconds != null && Number.isFinite(Number(seconds))) {
        span.title = `${label}：${new Date(Number(seconds) * 1000).toLocaleString("zh-CN", { hour12: false })}`;
      }
      meta.appendChild(span);
    });
    card.append(head, meta);
    container.appendChild(card);
  });
  [...container.children].slice(0, 3).forEach(card => clientPreviewObserver.observe(card));
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
    ? `密码登录时验证动态验证码，剩余 ${securityState.recovery_remaining} 个恢复码。`
    : "使用验证器生成动态验证码，为密码登录增加一层保护。";
  $("setupMfaBtn").hidden = enabled;
  $("recoveryMfaBtn").hidden = !enabled;
  $("disableMfaBtn").hidden = !enabled;
  $("closeSecurityBtn").disabled = securityBusy;
  $("refreshClientsBtn").disabled = securityBusy || !securityState;
  $("savePasswordBtn").disabled = securityBusy || !securityState;
  $("managePasskeysBtn").disabled = securityBusy || !securityState;
  const passkeyCount = securityState?.passkeys?.length || 0;
  $("passkeySummary").textContent = passkeyCount
    ? `已添加 ${passkeyCount} 个，可使用设备验证快速登录。`
    : "使用设备指纹、人脸或锁屏密码快速登录。";
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

let passkeyAction = null;
let passkeyMethod = "password";
let passkeyOptions = null;
let passkeyController = null;

function renderPasskeys() {
  const list = $("passkeyList");
  list.replaceChildren();
  const supported = window.TransPasskeys.supported();
  const limit = securityState?.passkey_limit || 10;
  const count = securityState?.passkeys?.length || 0;
  $("addPasskeyBtn").disabled = securityBusy || !supported || count >= limit;
  $("passkeysHint").textContent = supported
    ? `已添加 ${count} / ${limit} 个，最多支持 ${limit} 个通行密钥。验证由设备完成。`
    : `最多支持 ${limit} 个通行密钥。添加和使用需要 HTTPS 域名，以及支持的浏览器和设备锁屏。`;
  const keys = securityState?.passkeys || [];
  if (!keys.length) {
    const empty = document.createElement("p");
    empty.className = "security-hint";
    empty.textContent = "尚未添加通行密钥";
    list.appendChild(empty);
  }
  const formatTime = value => new Date(value * 1000).toLocaleString("zh-CN", { hour12: false });
  keys.forEach(key => {
    const item = document.createElement("div");
    item.className = "passkey-item";
    const detail = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = key.name;
    const meta = document.createElement("small");
    meta.textContent = `添加于 ${formatTime(key.created_at)}`;
    const used = document.createElement("small");
    used.textContent = key.last_used_at ? `最近使用 ${formatTime(key.last_used_at)}` : "尚未用于登录";
    detail.append(name, meta, used);
    const remove = document.createElement("button");
    remove.className = "danger-btn passkey-delete";
    remove.textContent = "删除";
    remove.type = "button";
    remove.disabled = securityBusy;
    remove.addEventListener("click", () => openPasskeyAuth(key));
    item.append(detail, remove);
    list.appendChild(item);
  });
}

function passkeyRecentlyVerified() {
  return Number(securityState?.passkey_verified_until || 0) > Date.now() / 1000;
}

function renderPasskeyAuth() {
  const deleting = Boolean(passkeyAction);
  const verified = Boolean(passkeyOptions) || passkeyRecentlyVerified();
  const choosing = !deleting && !verified && Boolean(securityState?.enabled);
  if (!securityState?.enabled) passkeyMethod = "password";
  $("passkeyAuthTitle").textContent = deleting ? "删除通行密钥" : verified ? "添加通行密钥" : "验证身份";
  $("passkeyAuthHint").textContent = deleting
    ? `确认删除“${passkeyAction.name}”？删除后不能再用它登录，已登录设备不受影响。`
    : verified ? "身份验证 10 分钟内有效。填写名称后，按设备提示添加密钥。"
      : choosing ? "密码或验证码任选一种，验证后 10 分钟内可添加通行密钥。"
        : "请验证当前密码，验证后 10 分钟内可添加通行密钥。";
  $("passkeyAuthMethods").hidden = !choosing;
  $("passkeyAuthForm").hidden = deleting || verified;
  $("passkeyNameForm").hidden = deleting || !verified;
  $("confirmPasskeyBtn").setAttribute("form", !deleting && verified ? "passkeyNameForm" : "passkeyAuthForm");
  for (const [id, method] of [["passkeyUsePasswordBtn", "password"], ["passkeyUseCodeBtn", "code"]]) {
    $(id).setAttribute("aria-pressed", String(passkeyMethod === method));
    $(id).disabled = securityBusy;
  }
  for (const [id, hidden] of [["passkeyNameField", deleting || !verified],
    ["passkeyPasswordField", deleting || verified || passkeyMethod !== "password"],
    ["passkeyCodeField", deleting || verified || passkeyMethod !== "code"]]) {
    $(id).hidden = hidden;
    const input = $(id).querySelector("input");
    input.required = !hidden;
    input.disabled = hidden || securityBusy;
  }
  $("confirmPasskeyBtn").textContent = securityBusy ? "正在处理…" : deleting
    ? "确认删除" : verified ? (passkeyOptions ? "添加密钥" : "重试") : "验证并继续";
  $("confirmPasskeyBtn").className = deleting ? "danger-btn" : "primary";
  $("confirmPasskeyBtn").disabled = securityBusy;
  $("closePasskeyAuthBtn").disabled = securityBusy;
}

async function preparePasskeyOptions() {
  try {
    passkeyOptions = await api("/api/security/passkeys/register/options", { method: "POST", body: "{}" });
  } catch (error) {
    if (error.code === "passkey_reauth_required") securityState.passkey_verified_until = 0;
    throw error;
  }
}

async function openPasskeyAuth(key = null) {
  if (securityBusy || !$("passkeysDialog").open) return;
  passkeyAction = key;
  passkeyMethod = "password";
  passkeyOptions = null;
  $("passkeyAuthForm").reset();
  $("passkeyNameForm").reset();
  securityMessage("", "success", "passkeyAuthMessage");
  renderPasskeyAuth();
  $("passkeyAuthDialog").showModal();
  $("passkeyAuthTitle").focus({ preventScroll: true });
  if (!key && passkeyRecentlyVerified()) {
    securityBusy = true;
    renderPasskeyAuth();
    try { await preparePasskeyOptions(); }
    catch (error) { securityMessage(error.message, "error", "passkeyAuthMessage"); }
    finally { securityBusy = false; renderPasskeyAuth(); }
  }
}

$("managePasskeysBtn").addEventListener("click", () => {
  if (securityBusy || !securityState) return;
  securityMessage("", "success", "passkeysMessage");
  renderPasskeys();
  $("passkeysDialog").showModal();
  $("passkeysDialogTitle").focus({ preventScroll: true });
});
$("closePasskeysBtn").addEventListener("click", () => $("passkeysDialog").close());
$("addPasskeyBtn").addEventListener("click", () => openPasskeyAuth());
$("closePasskeyAuthBtn").addEventListener("click", () => $("passkeyAuthDialog").close());
$("passkeyAuthDialog").addEventListener("cancel", event => {
  if (securityBusy) event.preventDefault();
});
$("passkeyAuthDialog").addEventListener("close", () => {
  passkeyController?.abort();
  passkeyOptions = null;
  passkeyAction = null;
  $("passkeyAuthForm").reset();
  $("passkeyNameForm").reset();
});
for (const [id, method] of [["passkeyUsePasswordBtn", "password"], ["passkeyUseCodeBtn", "code"]]) {
  $(id).addEventListener("click", () => {
    if (securityBusy) return;
    passkeyMethod = method;
    $("passkeyPassword").value = "";
    $("passkeyCode").value = "";
    securityMessage("", "success", "passkeyAuthMessage");
    renderPasskeyAuth();
  });
}
async function submitPasskeyAction(event) {
  event.preventDefault();
  if (!securityBusy && !passkeyAction && (passkeyOptions || !$("passkeyNameField").hidden)
      && !passkeyRecentlyVerified()) {
    passkeyOptions = null;
    renderPasskeyAuth();
    securityMessage("身份验证已过期，请重新验证", "error", "passkeyAuthMessage");
    return;
  }
  if (securityBusy || !event.currentTarget.reportValidity()) return;
  const deleting = Boolean(passkeyAction);
  securityBusy = true;
  renderSecurityState();
  renderPasskeyAuth();
  securityMessage("", "success", "passkeyAuthMessage");
  let creatingCredential = false;
  try {
    let data;
    if (deleting) {
      data = await api("/api/security/passkeys/delete", {
        method: "POST", body: JSON.stringify({ id: passkeyAction.id }),
      });
    } else if (passkeyOptions) {
      // Options are prepared before the click, preserving Safari's user gesture.
      passkeyController = new AbortController();
      creatingCredential = true;
      const credential = await window.TransPasskeys.create(passkeyOptions, passkeyController.signal);
      creatingCredential = false;
      passkeyOptions = null;
      data = await api("/api/security/passkeys/register/verify", {
        method: "POST", body: JSON.stringify({ credential, name: $("passkeyName").value }),
      });
    } else {
      if (!passkeyRecentlyVerified()) {
        securityState = await api("/api/security/passkeys/reauthenticate", {
          method: "POST", body: JSON.stringify({ method: passkeyMethod,
            current_password: $("passkeyPassword").value, code: $("passkeyCode").value }),
        });
        $("passkeyPassword").value = "";
        $("passkeyCode").value = "";
      }
      await preparePasskeyOptions();
      $("passkeyAuthTitle").focus({ preventScroll: true });
      return;
    }
    securityState = data;
    $("passkeyAuthDialog").close();
    securityMessage(deleting ? "通行密钥已删除" : "通行密钥已添加", "success", "passkeysMessage");
  } catch (error) {
    if (creatingCredential) {
      // Best effort only: diagnostics must never block retries or include secrets.
      void api("/api/security/passkeys/register/diagnostic", {
        method: "POST", body: JSON.stringify({ error: error.name || "Error" }), timeout: 5000,
      }).catch(() => {});
    }
    if (error.code === "passkey_reauth_required") {
      securityState.passkey_verified_until = 0;
      passkeyOptions = null;
    }
    securityMessage(window.TransPasskeys.message(error), "error", "passkeyAuthMessage");
  } finally {
    securityBusy = false;
    passkeyController = null;
    renderSecurityState();
    renderPasskeyAuth();
    renderPasskeys();
  }
}
$("passkeyAuthForm").addEventListener("submit", submitPasskeyAction);
$("passkeyNameForm").addEventListener("submit", submitPasskeyAction);
window.TransUI.setupScrollFades($("passkeysDialog"), ".passkey-list");
window.addEventListener("pagehide", () => passkeyController?.abort());

window.TransUI.setupScrollFades($("securityDialog"), ".login-clients");

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
