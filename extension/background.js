// Theme-adaptive toolbar icon. Manifest icons are static, so the action icon is swapped
// on (prefers-color-scheme) changes — same signal the popup uses for its own theme.
const SETS = {
  light: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  dark: { 16: 'icons/icon16-dark.png', 32: 'icons/icon32-dark.png', 48: 'icons/icon48-dark.png', 128: 'icons/icon128-dark.png' },
};
const mq = self.matchMedia('(prefers-color-scheme: dark)');
const apply = () =>
  chrome.action.setIcon({ path: SETS[mq.matches ? 'dark' : 'light'] }).catch(() => { });
if (mq.addEventListener) mq.addEventListener('change', apply);
else if (mq.addListener) mq.addListener(apply); // legacy MediaQueryList API
apply();
