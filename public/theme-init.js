(() => {
  try {
    const setTheme = (theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
    };
    const storedTheme = window.localStorage.getItem("excalidraw-theme");
    const theme =
      storedTheme === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : storedTheme || "light";

    setTheme(theme);
    window.EXCALIDRAW_ASSET_PATH = [`${window.location.origin}/`];
    window.name = "_excalidraw";
  } catch (error) {
    console.error("Error setting initial application state", error);
  }
})();
