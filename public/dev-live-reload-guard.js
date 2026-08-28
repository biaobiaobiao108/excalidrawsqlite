(() => {
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = function (url) {
    if (/ws:\/\/localhost:.+?\/sockjs-node/.test(url)) {
      console.info(
        "[!!!] Live reload is disabled via VITE_APP_DEV_DISABLE_LIVE_RELOAD [!!!]",
      );
      return undefined;
    }
    return new NativeWebSocket(url);
  };
})();
