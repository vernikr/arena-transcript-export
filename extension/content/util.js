// Small DOM/timing helpers (AREX namespace).
window.AREX = window.AREX || {};

AREX.sleep = ms => new Promise(r => setTimeout(r, ms));

// Streaming token appends and animation timers mutate the message body forever
// on an active branch. They are not what `settle` waits for: only structural
// changes that can mount/unmount a spoiler (or any non-streaming subtree)
// should postpone the quiet timer. Both timers are always released.
AREX._isStreamingMutation = record => {
  const el = record.target.nodeType === 1 ? record.target : record.target.parentElement;
  if (!el) return true;
  if (el.closest(AREX.S.LOADER) || el.closest('[aria-live], [role="status"], .animate-pulse')) return true;
  const prose = el.closest(AREX.S.PROSE);
  if (!prose) return false;
  if (record.type === 'characterData' || record.type === 'attributes') return true;
  const nodes = [...record.addedNodes, ...record.removedNodes];
  // Text-only prose churn (tokens, cursor, syntax highlighting) is streamed
  // content; element/panel mounts still count as real DOM work.
  return nodes.length > 0 && nodes.every(node =>
    node.nodeType === 3 || (node.nodeType === 1 &&
      !node.matches(AREX.S.EXPANDABLE) && !node.matches(AREX.S.PANEL) &&
      !node.querySelector?.(AREX.S.EXPANDABLE) && !node.querySelector?.(AREX.S.PANEL))
  );
};

// Wait for quiet DOM changes, with an absolute cap. `ignorePredicate` can add
// caller-specific filters (the built-in streaming filter always applies).
AREX.settle = (root, { quietMs = 250, maxMs = 3000, attributes = true, ignorePredicate } = {}) =>
  new Promise(resolve => {
    let done = false, quietTimer, maxTimer;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(quietTimer); clearTimeout(maxTimer); obs.disconnect(); resolve();
    };
    const ignored = record =>
      (typeof ignorePredicate === 'function' && ignorePredicate(record, root) === true) ||
      AREX._isStreamingMutation(record) === true;
    const obs = new MutationObserver(records => {
      if (records.every(ignored)) return;
      clearTimeout(quietTimer); quietTimer = setTimeout(finish, quietMs);
    });
    obs.observe(root, { childList: true, subtree: true, attributes, characterData: true });
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
// KMP prefix function finds the shortest period in O(N), with no regex backtracking.
// As with the previous `/^(.+?)\1+$/u`, a unit shorter than 3 chars is kept as-is.
AREX.dedupeTitle = t => {
  const s = String(t ?? '');
  const n = s.length;
  if (n < 6) return s.trim();
  // `.` in the old regex did not match JS line terminators.
  for (let i = 0; i < n; i += 1) {
    const c = s.charCodeAt(i);
    if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) return s.trim();
  }
  const pi = new Uint32Array(n);
  for (let i = 1; i < n; i += 1) {
    let j = pi[i - 1];
    while (j > 0 && s.charCodeAt(i) !== s.charCodeAt(j)) j = pi[j - 1];
    if (s.charCodeAt(i) === s.charCodeAt(j)) j += 1;
    pi[i] = j;
  }
  const period = n - pi[n - 1];
  const unit = period < n && n % period === 0 ? s.slice(0, period) : '';
  return (unit.length >= 3 ? unit : s).trim();
};

// Exact UTF-8 byte count without allocating an encoded copy. Unpaired
// surrogates become U+FFFD (3 bytes), exactly like TextEncoder.encode().
AREX.utf8ByteLength = value => {
  const s = String(value ?? '');
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i += 1; }
      else bytes += 3; // lone high surrogate -> U+FFFD
    } else bytes += 3; // lone low surrogate -> U+FFFD, BMP -> 3 bytes
  }
  return bytes;
};

// Branch title: topbar holds it (possibly duplicated in a tooltip); first line only.
AREX.chatTitle = () => {
  const bar = AREX.q('main .absolute.start-0.top-0');
  const t = (bar?.textContent || '').split('\n').map(s => s.trim()).filter(Boolean)[0];
  return (t && AREX.dedupeTitle(t)) || AREX.chatUuid() || 'transcript';
};
