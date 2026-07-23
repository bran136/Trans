(() => {
  const colors = { light: "#dfe4fb", dark: "#0e1320" };

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
