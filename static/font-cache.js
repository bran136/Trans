(() => {
  const cacheName = "reader-font-assets-v1";
  const fontUrl = "/static/fonts/YShiWritten-Regular.woff2?v=943d3985";

  async function activateRequiredTitleFont() {
    if (typeof FontFace !== "function" || !document.fonts?.add) return;
    const cache = "caches" in window
      ? await window.caches.open(cacheName).catch(() => null)
      : null;
    let response = cache ? await cache.match(fontUrl).catch(() => null) : null;
    if (!response?.ok) {
      response = await fetch(fontUrl, {
        cache: "default",
        credentials: "same-origin",
        mode: "same-origin",
      });
      if (!response.ok) return;
      if (cache) await cache.put(fontUrl, response.clone()).catch(() => {});
    }
    if (!response?.ok) return;
    const face = new FontFace("AppYShiWritten", await response.arrayBuffer(), {
      style: "normal",
      weight: "400",
    });
    await face.load();
    document.fonts.add(face);
  }

  activateRequiredTitleFont().catch(() => {});
})();
