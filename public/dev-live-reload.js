(() => {
  if (typeof window !== "undefined" && window.EventSource) {
    const es = new EventSource("/__dev_reload");
    es.onmessage = (event) => {
      if (event.data === "reload") {
        console.log("[Dev Live Reload] ⚡ Rebuild detected, reloading page...");
        window.location.reload();
      }
    };
    es.onerror = () => {
      // Reconnect will automatically happen via EventSource
    };
  }
})();
