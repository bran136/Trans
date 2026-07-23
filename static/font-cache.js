(() => {
  const cacheName = "reader-font-assets-v1";
  const fontUrl = "/static/fonts/YShiWritten-Regular.woff2?v=943d3985";
  const loadedFontIds = window.readerLoadedFontIds instanceof Set
    ? window.readerLoadedFontIds
    : new Set();
  window.readerLoadedFontIds = loadedFontIds;

  async function activateRequiredTitleFont() {
    if (typeof FontFace !== "function" || !document.fonts?.add) return false;
    const cache = "caches" in window
      ? await window.caches.open(cacheName).catch(() => null)
      : null;
    const request = new Request(new URL(fontUrl, window.location.href).href, {
      credentials: "same-origin",
    });
    let response = cache
      ? await cache.match(request, { ignoreVary: true }).catch(() => null)
      : null;
    if (!response?.ok) {
      response = await fetch(fontUrl, {
        cache: "default",
        credentials: "same-origin",
        mode: "same-origin",
      });
      if (!response.ok) return false;
      if (cache) await cache.put(request, response.clone()).catch(() => {});
    }
    if (!response?.ok) return false;
    const family = document.body.classList.contains("reader-body")
      ? "ReaderYShiWritten"
      : "AppYShiWritten";
    const face = new FontFace(family, await response.arrayBuffer(), {
      style: "normal",
      weight: "400",
    });
    await face.load();
    document.fonts.add(face);
    loadedFontIds.add("yshi-written");
    return true;
  }

  window.readerRequiredFontPromise = activateRequiredTitleFont().catch(() => false);
})();
