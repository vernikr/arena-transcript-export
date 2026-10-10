// Small DOM/timing helpers (AREX namespace).
window.AREX = window.AREX || {};

AREX.sleep = ms => new Promise(r => setTimeout(r, ms));

// Wait until `root` produces no mutations for `quietMs` (cap `maxMs`).
AREX.settle = (root, { quietMs = 250, maxMs = 3000 } = {}) =>
  new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; obs.disconnect(); resolve(); } };
    const obs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(finish, quietMs); });
    let t = setTimeout(finish, quietMs);
    obs.observe(root, { childList: true, subtree: true, attributes: true });
    setTimeout(finish, maxMs);
  });

// Wait for `cond()` to hold, polling. Returns true if met within timeout.
AREX.waitFor = async (cond, { timeoutMs = 15000, pollMs = 250 } = {}) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await AREX.sleep(pollMs);
  }
  return !!cond();
};

// Normalized text (nbsp→space, collapsed whitespace). jsdom-safe (no innerText).
// Like AREX.text but joins element boundaries with spaces ("used"+"Bash" -> "used Bash").
AREX.spacedText = el => {
  const walk = n => {
    if (n.nodeType === 3) return n.nodeValue;
    if (n.nodeType !== 1) return '';
    return [...n.childNodes].map(walk).join(' ');
  };
  return walk(el).replace(/\s+/g, ' ').trim();
};

AREX.text = el => (el?.textContent ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

// Spoiler header text = wrapper text minus mounted panel bodies and icons.
AREX.headerText = wrapper => {
  const clone = wrapper.cloneNode(true);
  AREX.qq(AREX.S.PANEL, clone).forEach(p => p.remove());
  clone.querySelectorAll('svg, ' + AREX.S.OPEN_FILE).forEach(s => s.remove());
  return AREX.spacedText(clone);
};

AREX.msgId = m => m.getAttribute(AREX.S.MSG_ID) || '';

AREX.slug = s =>
  String(s).toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'chat';

AREX.stamp = (d = new Date()) =>
  d.getFullYear() +
  String(d.getMonth() + 1).padStart(2, '0') +
  String(d.getDate()).padStart(2, '0') + '-' +
  String(d.getHours()).padStart(2, '0') +
  String(d.getMinutes()).padStart(2, '0');

AREX.chatUuid = () =>
  (typeof location !== 'undefined' && location.pathname.match(/\/agent\/([^/]+)/)?.[1]) || null;

// Titles rendered twice adjacent (button + tooltip with no separator) collapse to X+X -> X.
AREX.dedupeTitle = t => {
  const m = String(t).match(/^(.+?)\1+$/u);
  return (m && m[1].length >= 3 ? m[1] : String(t)).trim();
};

// Branch title: topbar holds it (possibly duplicated in a tooltip); first line only.
AREX.chatTitle = () => {
  const bar = AREX.q('main .absolute.start-0.top-0');
  const t = (bar?.textContent || '').split('\n').map(s => s.trim()).filter(Boolean)[0];
  return (t && AREX.dedupeTitle(t)) || AREX.chatUuid() || 'transcript';
};
