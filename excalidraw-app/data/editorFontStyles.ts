const FONT_STYLESHEET_TIMEOUT_MS = 8000;
const FONT_FAMILY_POLL_INTERVAL_MS = 50;

const editorFontStylesheets = [
  {
    href: "https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.1.0/style.css",
    fontFamilies: ["LXGW WenKai"],
  },
  {
    href: "https://cdn.jsdelivr.net/npm/@chinese-fonts/xiaolai@3.0.0/dist/Xiaolai/result.css",
    fontFamilies: ["Xiaolai SC"],
  },
] as const;

const requestedStyles = new Map<string, Promise<void>>();

const hasLoadedFontFamily = (fontFamilies: readonly string[]) =>
  Array.from(document.fonts).some((fontFace) =>
    fontFamilies.includes(fontFace.family),
  );

const loadStylesheet = ({
  href,
  fontFamilies,
}: (typeof editorFontStylesheets)[number]) => {
  const existing = requestedStyles.get(href);
  if (existing) return existing;
  const pending = new Promise<void>((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    // Keep rendering the editor with fallback fonts while the CDN responds.
    link.media = "print";
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (pollTimer) clearTimeout(pollTimer);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      requestedStyles.delete(href);
      link.remove();
      resolve();
    };
    const waitForFontFamily = () => {
      if (hasLoadedFontFamily(fontFamilies)) {
        finish();
        return;
      }
      pollTimer = setTimeout(waitForFontFamily, FONT_FAMILY_POLL_INTERVAL_MS);
    };
    timeout = setTimeout(failed, FONT_STYLESHEET_TIMEOUT_MS);
    link.addEventListener(
      "load",
      () => {
        link.media = "all";
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(failed, FONT_STYLESHEET_TIMEOUT_MS);
        // Safari may fetch the stylesheet again when media changes. Waiting
        // for the advertised families also covers its delayed loadingdone.
        waitForFontFamily();
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
