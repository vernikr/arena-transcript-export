// Theme-adaptive toolbar icon. MV3 service workers have no matchMedia, so the theme is probed
// by window contexts (content script on arena.ai pages, popup on open) and bridged here via
// runtime messages + chrome.storage.local (the cached value also survives browser restarts).
const SETS = {
  light: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  dark: { 16: 'icons/icon16-dark.png', 32: 'icons/icon32-dark.png', 48: 'icons/icon48-dark.png', 128: 'icons/icon128-dark.png' },
};
const apply = theme =>
  chrome.action.setIcon({ path: SETS[theme === 'dark' ? 'dark' : 'light'] }).catch(() => { });

chrome.runtime.onMessage.addListener(m => { if (m?.arexTheme) apply(m.arexTheme); });
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.theme) apply(c.theme.newValue); });
const restore = () => chrome.storage.local.get('theme').then(v => v.theme && apply(v.theme));
chrome.runtime.onStartup.addListener(restore);
chrome.runtime.onInstalled.addListener(restore);
restore();
