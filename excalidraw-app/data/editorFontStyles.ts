const editorFontStylesheets = [
  "https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.1.0/style.css",
  "https://cdn.jsdelivr.net/npm/@chinese-fonts/xiaolai@3.0.0/dist/Xiaolai/result.css",
];

const requestedStyles = new Map<string, Promise<void>>();

const loadStylesheet = (href: string) => {
  const existing = requestedStyles.get(href);
  if (existing) return existing;
  const pending = new Promise<void>((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    // Keep rendering the editor with fallback fonts while the CDN responds.
    link.media = "print";
    const failed = () => {
      clearTimeout(timeout);
      requestedStyles.delete(href);
      link.remove();
      resolve();
    };
    const timeout = setTimeout(failed, 8000);
    link.addEventListener(
      "load",
      () => {
        clearTimeout(timeout);
        link.media = "all";
        resolve();
      },
      { once: true },
    );
    link.addEventListener("error", failed, { once: true });
    document.head.append(link);
  });
  requestedStyles.set(href, pending);
  return pending;
};

export const loadEditorFontStyles = () =>
  Promise.all(editorFontStylesheets.map(loadStylesheet));
