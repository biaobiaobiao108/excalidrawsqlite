// define `EXCALIDRAW_ASSET_PATH` as a SSOT
/**
 * Custom vite plugin for making the app's font assets same-origin in the
 * self-hosted container build.
 *
 * @returns {import("vite").PluginOption}
 */
module.exports.woff2BrowserPlugin = () => {
  let isDev;

  return {
    name: "woff2BrowserPlugin",
    enforce: "pre",
    config(_, { command }) {
      isDev = command === "serve";
    },
    transform(code, id) {
      if (!isDev && id.endsWith("excalidraw-app/index.html")) {
        return code.replace(
          "<!-- PLACEHOLDER:EXCALIDRAW_APP_FONTS -->",
          `<script>
        window.EXCALIDRAW_ASSET_PATH = ["/"];
      </script>

      <!-- Preload the critical local UI font to avoid swap on init -->
      <link
        rel="preload"
        href="/fonts/Assistant/Assistant-SemiBold.woff2"
        as="font"
        type="font/woff2"
        crossorigin="anonymous"
      />
    `,
        );
      }
    },
  };
};
