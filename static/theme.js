(() => {
  // Keep the existing key so upgrades retain the reader's chosen theme.
  const key = "readerTheme";
  const root = document.documentElement;
  let theme = "light";
  let memoryOnly = false;

  function savedTheme() {
    // A failed write must not let an older saved value undo the user's choice.
    if (memoryOnly) return theme;
    try { return localStorage.getItem(key) === "dark" ? "dark" : "light"; }
    catch { return theme; }
  }

  function updateButtons() {
    const dark = theme === "dark";
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.setAttribute("aria-pressed", String(dark));
      button.title = dark ? "切换到日间模式" : "切换到夜间模式";
    });
  }

  function apply(value, persist = false) {
    theme = value === "dark" ? "dark" : "light";
    root.classList.toggle("theme-dark", theme === "dark");
    // ui.js owns the composited browser-bar color while a modal is open.
    if (!document.querySelector("dialog:modal")) {
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = theme === "dark" ? "#000000" : "#f6f5f2";
    }
    if (persist) {
      try {
        localStorage.setItem(key, theme);
        memoryOnly = false;
      } catch {
        memoryOnly = true;
      }
    }
    updateButtons();
    window.dispatchEvent(new Event("themechange"));
  }

  // Runs in <head>, before paint, on login, tools, editor and log pages alike.
  apply(savedTheme());
  document.addEventListener("DOMContentLoaded", updateButtons, { once: true });
  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-theme-toggle]")) apply(theme === "dark" ? "light" : "dark", true);
  });
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) apply(savedTheme());
  });
  window.addEventListener("pageshow", () => apply(savedTheme()));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) apply(savedTheme());
  });
})();
