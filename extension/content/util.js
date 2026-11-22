// Small DOM/timing helpers (AREX namespace).
window.AREX = window.AREX || {};

AREX.sleep = ms => new Promise(r => setTimeout(r, ms));

// Wait for quiet DOM changes, with an absolute cap. Windowed processing can
// ignore attribute-only animation churn; both timers are always released.
AREX.settle = (root, { quietMs = 250, maxMs = 3000, attributes = true } = {}) =>
  new Promise(resolve => {
    let done = false, quietTimer, maxTimer;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(quietTimer); clearTimeout(maxTimer); obs.disconnect(); resolve();
    };
    const obs = new MutationObserver(() => { clearTimeout(quietTimer); quietTimer = setTimeout(finish, quietMs); });
    obs.observe(root, { childList: true, subtree: true, attributes });
    quietTimer = setTimeout(finish, quietMs);
    maxTimer = setTimeout(finish, maxMs);
  });

// Yield without background-tab timer clamping when scheduler/MessageChannel is available.
AREX.yieldToMain = () => {
  if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
  if (typeof MessageChannel !== 'undefined') return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(null);
  });
  return AREX.sleep(0);
};

// Mutation-driven wait; subscribe before checking so synchronous scroll/click
// changes cannot be missed. Cancellation disconnects the observer immediately.
AREX.waitForDomChange = (root, cond, { timeoutMs = 2500, signal = AREX._abortController?.signal } = {}) =>
  new Promise((resolve, reject) => {
    let timer, done = false;
    const finish = (value, error) => {
      if (done) return;
      done = true; clearTimeout(timer); observer.disconnect();
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => { const error = new Error('Export cancelled.'); error.name = 'AbortError'; finish(false, error); };
    const check = () => { try { if (cond()) finish(true); } catch (error) { finish(false, error); } };
    const observer = new MutationObserver(check);
    observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true,
      attributeFilter: ['role', 'data-earlier-messages-sentinel', 'data-earlier-messages-boundary', 'data-chat-message-id'] });
    timer = setTimeout(() => { try { finish(Boolean(cond())); } catch (error) { finish(false, error); } }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else check();
  });

// Wait for `cond()` to hold, polling. Returns true if met within timeout.
// Aborts (throws an AbortError) as soon as AREX._abortController signals cancellation.
AREX.waitFor = async (cond, { timeoutMs = 15000, pollMs = 250 } = {}) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    AREX.throwIfAborted?.();
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

// Read text without cloning a potentially enormous mounted spoiler subtree.
// Removed descendants do not contribute separator spaces, matching clone+remove.
AREX.filteredText = (root, { skip = () => false, spaced = false } = {}) => {
  const walk = node => {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1) return '';
    const pieces = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1 && skip(child)) continue;
      pieces.push(walk(child));
    }
    return pieces.join(spaced ? ' ' : '');
  };
  return walk(root);
};
AREX.headerText = wrapper => AREX.filteredText(wrapper, {
  spaced: true,
  skip: el => el.matches(AREX.S.PANEL) || el.tagName === 'svg' || el.tagName === 'SVG' || el.matches(AREX.S.OPEN_FILE),
}).replace(/\s+/g, ' ').trim();

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
