// Registers the service worker so the site can be installed and work offline for
// brief moments. Loaded on every page, right after progress.js.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
