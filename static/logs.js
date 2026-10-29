(() => {
  const lines = document.getElementById("logLines");
  const status = document.getElementById("logStatus");
  const latest = document.getElementById("latestBtn");
  let file = document.body.dataset.logFile;
  let offset = document.body.dataset.logOffset === "" ? null : Number(document.body.dataset.logOffset);
  let controller = null;
  let timer = null;
  let expired = false;
  let follow = true;
  let partial = null;
  let characters = 0;

  function setStatus(text, error = false) {
    status.textContent = text;
    status.dataset.error = String(error);
  }

  function append(text, reset) {
    if (reset) partial = null; // A rotated file starts a new line, retaining this session's display.
    const previousTop = lines.scrollTop;
    let removedHeight = 0;
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i === parts.length - 1 && !parts[i]) break;
      if (!partial) {
        partial = document.createElement("div");
        partial.className = "log-line";
        partial.appendChild(document.createTextNode(""));
        lines.appendChild(partial);
      }
      partial.firstChild.appendData(parts[i]);
      characters += parts[i].length;
      if (i < parts.length - 1) {
        if (partial.firstChild.data.endsWith("\r")) {
          partial.firstChild.deleteData(partial.firstChild.length - 1, 1);
          characters--;
        }
        partial = null;
      }
    }
    // Keep long-running sessions bounded, including exceptionally long single lines.
    while (lines.childElementCount > 2000 || characters > 1024 * 1024) {
      const first = lines.firstElementChild;
      if (first === lines.lastElementChild) {
        const excess = characters - 1024 * 1024;
        first.firstChild.deleteData(0, excess);
        characters -= excess;
        break;
      }
      if (!follow) removedHeight += first.offsetHeight;
      characters -= first.firstChild.length;
      first.remove();
    }
    lines.scrollTop = follow ? lines.scrollHeight : Math.max(0, previousTop - removedHeight);
  }

  function stop() {
    window.clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
  }

  async function poll() {
    if (expired || controller || document.hidden) return;
    const request = new AbortController();
    controller = request;
    const timeout = window.setTimeout(() => request.abort(), 8000);
    let delay = 2000;
    try {
      const query = new URLSearchParams({ file, offset: String(offset ?? 0) });
      if (offset === null) query.set("tail", "1");
      const response = await fetch(`/api/logs?${query}`, { signal: request.signal, cache: "no-store" });
      if (controller !== request) return;
      if (response.status === 401) {
        expired = true;
        throw new Error("登录已失效，请重新登录后刷新本页");
      }
      if (!response.ok) throw new Error("连接失败，5 秒后重试");
      const data = await response.json();
      if (controller !== request) return;
      append(data.text, data.reset);
      file = data.file;
      offset = data.offset;
      setStatus(data.more ? "正在同步…" : `实时追踪 · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`);
      if (data.more) delay = 100;
    } catch (error) {
      if (controller !== request) return;
      setStatus(error.name === "AbortError" ? "连接超时，5 秒后重试" : error.message, true);
      delay = 5000;
    } finally {
      window.clearTimeout(timeout);
      if (controller === request) {
        controller = null;
        if (!expired && !document.hidden) timer = window.setTimeout(poll, delay);
      }
    }
  }

  lines.addEventListener("scroll", () => {
    follow = lines.scrollHeight - lines.scrollTop - lines.clientHeight < 24;
    latest.hidden = follow;
  }, { passive: true });
  latest.addEventListener("click", () => {
    follow = true;
    latest.hidden = true;
    lines.scrollTop = lines.scrollHeight;
  });
  function resume() {
    stop();
    if (!document.hidden) poll();
  }
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("pagehide", stop);
  window.addEventListener("pageshow", (event) => { if (event.persisted) resume(); });
  poll();
})();
