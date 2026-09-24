(() => {
  const colors = { light: "#f6f5f2", dark: "#191a1c" };

  function applyReaderDocumentTheme(dark) {
    document.documentElement.classList.toggle("reader-dark-root", dark);
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = dark ? colors.dark : colors.light;
  }

  window.applyReaderDocumentTheme = applyReaderDocumentTheme;
  let dark = false;
  try {
    dark = window.localStorage.getItem("readerTheme") === "dark";
  } catch {
    // Storage can be unavailable in private or restricted browsing contexts.
  }
  applyReaderDocumentTheme(dark);
})();
