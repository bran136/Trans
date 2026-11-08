/* Translation request scheduling and local result history, without page layout. */
(() => {
  function createQueue(run, onError, clock = globalThis) {
    let latest = null, active = null, pending = null, timer = null;
    async function drain() {
      if (active || !pending) return;
      const job = active = pending;
      pending = null;
      const isCurrent = () => latest?.key === job.key;
      try { await run(job, isCurrent); }
      catch (error) { if (isCurrent()) onError(error); }
      finally { active = null; drain(); }
    }
    return {
      schedule(job, delay = 1000) {
        latest = job;
        pending = null;
        clock.clearTimeout(timer);
        if (active?.key === job.key) { timer = null; return; }
        timer = clock.setTimeout(() => {
          timer = null;
          if (active?.key === job.key) return;
          pending = job;
          drain();
        }, delay);
      },
      cancel() {
        latest = pending = null;
        clock.clearTimeout(timer);
        timer = null;
      },
    };
  }

  function normalizeHistory(records) {
    if (!Array.isArray(records)) return [];
    return records.filter((item) => item && ["text", "source", "target", "targetName"]
      .every((key) => typeof item[key] === "string")).map((item) => ({
      id: typeof item.id === "string" ? item.id : (globalThis.crypto?.randomUUID?.()
        || `${Date.now()}-${Math.random().toString(16).slice(2)}`),
      text: item.text, source: item.source, target: item.target, targetName: item.targetName,
      time: Number.isFinite(item.time) ? item.time : 0,
      results: Array.isArray(item.results) ? item.results.filter((result) => result && result.ok === true
        && ["engine", "name", "text"].every((key) => typeof result[key] === "string")
        && result.text.trim()).map((result) => ({
          engine: result.engine, name: result.name, text: result.text, ok: true, target: item.target,
          model: typeof result.model === "string" ? result.model : "",
          style: typeof result.style === "string" ? result.style : "",
        })) : [],
    })).sort((a, b) => b.time - a.time).slice(0, 100);
  }

  function historyIdentity(item) {
    return JSON.stringify([item.text, item.source, item.target,
      item.results.map(({ engine, model, style }) => [engine, model, style]).sort()]);
  }

  function mergeHistory(records, incoming) {
    const identity = historyIdentity(incoming);
    if (records.some((item) => historyIdentity(item) === identity && item.time > incoming.time)) return records;
    return normalizeHistory([incoming, ...records.filter((item) => historyIdentity(item) !== identity)]);
  }

  function createHistoryStore(legacy) {
    let opening = null;
    function open() {
      if (opening) return opening;
      opening = new Promise((resolve, reject) => {
        let blocked = false;
        const request = indexedDB.open("trans-translation-history", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("entries", { keyPath: "id" });
        request.onerror = () => reject(request.error);
        request.onblocked = () => { blocked = true; reject(new Error("本地历史被其他页面占用")); };
        request.onsuccess = () => {
          const db = request.result;
          if (blocked) { db.close(); return; }
          db.onversionchange = () => { db.close(); opening = null; };
          resolve(db);
        };
      }).catch((error) => { opening = null; throw error; });
      return opening;
    }
    async function update(incoming = null, clear = false) {
      const db = await open();
      return new Promise((resolve, reject) => {
        // Reading and merging in one transaction preserves updates from other tabs.
        const tx = db.transaction("entries", "readwrite");
        const store = tx.objectStore("entries");
        const request = clear ? store.clear() : store.getAll();
        let records;
        request.onsuccess = () => {
          if (clear) { records = []; return; }
          records = normalizeHistory(request.result.length ? request.result : legacy);
          if (incoming) {
            normalizeHistory(Array.isArray(incoming) ? incoming : [incoming]).reverse()
              .forEach((item) => { records = mergeHistory(records, item); });
          }
          if (incoming || (!request.result.length && records.length)) {
            store.clear();
            records.forEach((item) => store.put(item));
          }
        };
        tx.oncomplete = () => { legacy = []; resolve(records); };
        tx.onerror = tx.onabort = () => reject(tx.error || new Error("无法保存本地历史"));
      });
    }
    return { load: () => update(), save: (item) => update(item), clear: () => update(null, true) };
  }

  const api = { createQueue, normalizeHistory, mergeHistory, createHistoryStore };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.TransTranslation = api;
})();
