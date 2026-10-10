// UI-theme probe: service worker cannot run matchMedia, so page contexts report the
// color scheme and cache it for the toolbar icon swap (see background.js).
(() => {
  const mq = self.matchMedia('(prefers-color-scheme: dark)');
  const report = () => {
    const theme = mq.matches ? 'dark' : 'light';
    chrome.storage.local.set({ theme });
    chrome.runtime.sendMessage({ arexTheme: theme }).catch(() => { });
  };
  report();
  if (mq.addEventListener) mq.addEventListener('change', report);
  else if (mq.addListener) mq.addListener(report);
})();
