const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || "";
let monitorTimer = null;

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.method && !["GET", "HEAD"].includes(options.method.toUpperCase()) ? { "X-CSRF-Token": csrfToken } : {}),
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
  const ttsCache = data.tts_cache || {};
  $("metricPid").textContent = data.pid;
  $("metricUptime").textContent = formatUptime(data.uptime_seconds);
  $("metricAppCpu").textContent = `${data.process.cpu_percent}%`;
  $("metricAppMemory").textContent = `${formatBytes(data.process.rss_bytes)} | ${appMemoryPercent.toFixed(2)}%`;
  $("metricCache").textContent = `${data.cache.entries} / ${data.cache.limit}`;
  $("metricTtsCacheEntries").textContent = `${Number(ttsCache.entries || 0)} 条`;
  $("metricTtsCacheDetail").textContent = `${formatAudioCacheMegabytes(ttsCache.size_bytes)} / ${formatAudioCacheMegabytes(ttsCache.limit_bytes)} MB · ${ttsCache.ttl_days || 0} 天`;
  $("metricSystemCpu").textContent = `${data.system.cpu_percent}%`;
  $("metricSystemMemory").textContent = `${data.system.memory_used_percent}% | ${formatBytes(data.system.memory_available_bytes)} 可用`;
  $("metricLoad").textContent = data.system.load_avg.map((item) => Number(item).toFixed(2)).join(" / ");
  $("metricDisk").textContent = `${data.disk.used_percent}% | ${formatBytes(data.disk.free_bytes)} 可用`;
}

async function loadServiceStatus(showError = true) {
  try {
    renderServiceStatus(await api("/api/status"));
    return true;
  } catch (error) {
    if (showError) setMonitorMessage(`状态获取失败：${error.message}`, "error");
    return false;
  }
}

function startMonitorRefresh() {
  window.clearInterval(monitorTimer);
  loadServiceStatus();
  monitorTimer = window.setInterval(() => loadServiceStatus(false), 5000);
}

function stopMonitorRefresh() {
  window.clearInterval(monitorTimer);
  monitorTimer = null;
}

async function restartService() {
  if (!window.confirm("确定重启后端服务？正在进行的请求会中断。")) return;
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

async function saveAccessPassword() {
  const currentInput = $("currentPassword");
  const newInput = $("newPassword");
  if (!currentInput.value) {
    setMonitorMessage("请输入当前访问密码", "error");
    currentInput.focus();
    return;
  }
  if (newInput.value.length < 12) {
    setMonitorMessage("访问密码至少需要 12 位", "error");
    newInput.focus();
    return;
  }
  if (newInput.value === currentInput.value) {
    setMonitorMessage("新密码不能与当前密码相同", "error");
    newInput.focus();
    return;
  }
  const button = $("savePasswordBtn");
  if (button.disabled) return;
  button.disabled = true;
  try {
    await api("/api/password", {
      method: "PUT",
      body: JSON.stringify({
        current_password: currentInput.value,
        new_password: newInput.value,
      }),
    });
    currentInput.value = "";
    newInput.value = "";
    setMonitorMessage("访问密码已修改，其他浏览器需要重新登录", "success");
  } catch (error) {
    setMonitorMessage(`密码修改失败：${error.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

$("monitorBtn").addEventListener("click", () => {
  clearMonitorMessage();
  $("monitorDialog").showModal();
  startMonitorRefresh();
});

$("closeMonitorBtn").addEventListener("click", () => $("monitorDialog").close());
$("refreshStatusBtn").addEventListener("click", () => loadServiceStatus());
$("restartServiceBtn").addEventListener("click", restartService);
$("savePasswordBtn").addEventListener("click", saveAccessPassword);
[$("currentPassword"), $("newPassword")].forEach((input) => {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveAccessPassword();
  });
});
$("monitorDialog").addEventListener("close", () => {
  stopMonitorRefresh();
  $("currentPassword").value = "";
  $("newPassword").value = "";
});

$("logoutBtn").addEventListener("click", async () => {
  try {
    await api("/logout", { method: "POST", body: "{}" });
    window.location.href = "/login";
  } catch (error) {
    window.alert(`退出失败：${error.message}`);
  }
});
