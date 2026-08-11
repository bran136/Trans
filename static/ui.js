(() => {
  const hideTimers = new WeakMap();

  function showScrollbar(target) {
    if (!(target instanceof Element)) return;
    target.classList.add("scrollbar-active");
    const previousTimer = hideTimers.get(target);
    if (previousTimer) window.clearTimeout(previousTimer);
    hideTimers.set(target, window.setTimeout(() => {
      target.classList.remove("scrollbar-active");
      hideTimers.delete(target);
    }, 550));
  }

  document.addEventListener("scroll", (event) => {
    if (event.target === document) {
      showScrollbar(document.documentElement);
      showScrollbar(document.body);
      return;
    }
    showScrollbar(event.target);
  }, true);
})();
