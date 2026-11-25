import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './harness.mjs';

const message = id => `<div data-agent-transcript-message data-chat-message-id="${id}">${id}</div>`;

test('no sentinel or loading UI exits after one short quiet probe', async () => {
  const { AREX, document } = makeEnv({ html: `<div role="log">${message('one')}</div>` });
  const events = [], start = Date.now();
  const result = await AREX.loadFullHistory(document.querySelector('[role=log]'), { quietMs: 10, onProgress: p => events.push(p) });
  assert.equal(result.stable, true); assert.equal(result.pages, 0);
  assert.equal(result.stopReason, 'no_marker_probe');
  assert.equal(events.filter(e => e.phase === 'settle').length, 0);
  assert.ok(Date.now() - start < 600);
});

test('observes sentinel-triggered pagination and exits when boundary unmounts', async () => {
  const { AREX, document } = makeEnv({ html: `<div role="log"><div data-earlier-messages-boundary><div data-earlier-messages-sentinel></div></div>${message('new')}</div>` });
  const log = document.querySelector('[role=log]');
  const sentinel = log.querySelector('[data-earlier-messages-sentinel]');
  let scrolls = 0;
  sentinel.scrollIntoView = () => {
    if (++scrolls !== 1) return;
    setTimeout(() => {
      const m = document.createElement('div'); m.setAttribute('data-agent-transcript-message', ''); m.setAttribute('data-chat-message-id', 'old');
      log.prepend(m); log.querySelector('[data-earlier-messages-boundary]').remove();
    }, 10);
  };
  const result = await AREX.loadFullHistory(log, { detectMs: 200, quickMs: 200 });
  assert.equal(result.stable, true); assert.equal(result.pages, 1); assert.equal(result.messages, 2); assert.ok(scrolls);
  assert.equal(result.stopReason, 'complete');
});

test('a still-mounted sentinel or hung spinner never reports a complete history', async () => {
  for (const [html, reason] of [
    [`<div role="log"><div data-earlier-messages-boundary><div data-earlier-messages-sentinel></div></div>${message('x')}</div>`, 'sentinel_stagnant'],
    [`<div role="log"><div role="status">Loading earlier messages</div>${message('x')}</div>`, 'spinner_timeout'],
  ]) {
    const { AREX, document } = makeEnv({ html });
    const result = await AREX.loadFullHistory(document.querySelector('[role=log]'), { quickMs: 10, detectMs: 10, spinnerGoneMs: 10 });
    assert.equal(result.stable, false);
    assert.equal(result.stopReason, reason);
  }
});

test('legacy paginated DOM without markers retains quiet-round fallback', async () => {
  const { AREX, document } = makeEnv({ html: `<div role="log">${message('new')}</div>` });
  const log = document.querySelector('[role=log]'); let calls = 0;
  Object.defineProperty(log, 'scrollTop', { set() {
    if (++calls > 2) return;
    const spinner = document.createElement('div'); spinner.setAttribute('role', 'status'); spinner.textContent = 'Loading earlier messages'; log.prepend(spinner);
    setTimeout(() => { spinner.remove(); const m = document.createElement('div'); m.setAttribute('data-agent-transcript-message', ''); m.setAttribute('data-chat-message-id', 'old' + calls); log.prepend(m); }, 10);
  } });
  const result = await AREX.loadFullHistory(log, { quietMs: 10, quickMs: 40, detectMs: 40 });
  assert.equal(result.pages, 2); assert.equal(result.messages, 3); assert.equal(result.stable, true); assert.ok(calls >= 4);
  assert.equal(result.stopReason, 'no_marker_probe');
});

test('mutation wait disconnects promptly on cancellation', async () => {
  const { AREX, document, window } = makeEnv();
  AREX._abortController = new window.AbortController();
  const waiting = AREX.waitForDomChange(document.querySelector('[role=log]'), () => false, { timeoutMs: 10000 });
  AREX._abortController.abort();
  await assert.rejects(waiting, error => error.name === 'AbortError');
});

test('stagnant sentinel re-arms scroll when scrollTop is pinned at 0', async () => {
  const { AREX, document } = makeEnv({
    html: `<div role="log"><div data-earlier-messages-boundary><div data-earlier-messages-sentinel></div></div>${message('new')}</div>`,
  });
  const log = document.querySelector('[role=log]');
  const sentinel = log.querySelector('[data-earlier-messages-sentinel]');
  const boundary = log.querySelector('[data-earlier-messages-boundary]');
  const tops = [], scrollEvents = [];
  let armed = false, wakeUps = 0, scrollIntoViews = 0;
  // overflow-anchor keeps scrollTop at 0; an IntersectionObserver only fires
  // again after a real transition out of the 200px rootMargin and back.
  Object.defineProperty(log, 'scrollTop', {
    configurable: true,
    get() { return 0; },
    set(v) { tops.push(v); if (v > 0) armed = true; },
  });
  log.addEventListener('scroll', () => scrollEvents.push(log.scrollTop));
  sentinel.scrollIntoView = () => {
    scrollIntoViews += 1;
    if (!armed) return;
    armed = false; wakeUps += 1;
    setTimeout(() => {
      const m = document.createElement('div');
      m.setAttribute('data-agent-transcript-message', '');
      m.setAttribute('data-chat-message-id', 'old');
      log.prepend(m);
      boundary.remove();
    }, 5);
  };
  const result = await AREX.loadFullHistory(log, { quietMs: 10, quickMs: 10, detectMs: 20, stagnantTarget: 3 });
  assert.ok(tops.some(v => v > 0), 'nudge must leave the 200px rootMargin');
  assert.ok(scrollEvents.length >= 2, 'fresh scroll events must be dispatched');
  assert.ok(scrollIntoViews >= 2, 'sentinel must be scrolled into view again');
  assert.equal(wakeUps, 1, 'throttled observer woke exactly once');
  assert.equal(result.pages, 1);
  assert.equal(result.messages, 2);
  assert.equal(result.stable, true);
  assert.equal(result.stopReason, 'complete');
});

test('permanently failing retry button stops at maxRetries with retry_exhausted', async () => {
  const { AREX, document } = makeEnv({
    html: `<div role="log">${message('m1')}<button id="retry">Load earlier messages</button></div>`,
  });
  const log = document.querySelector('[role=log]');
  let clicks = 0;
  log.querySelector('#retry').addEventListener('click', () => { clicks += 1; });
  const events = [];
  const result = await AREX.loadFullHistory(log, {
    quietMs: 5, quickMs: 5, detectMs: 5, spinnerGoneMs: 10,
    maxRetries: 3, maxRounds: 50, stagnantTarget: 1,
    onProgress: p => events.push(p),
  });
  assert.equal(clicks, 3, 'no 250-round click storm');
  assert.equal(result.stable, false);
  assert.equal(result.stopReason, 'retry_exhausted');
  assert.equal(result.pages, 0);
  assert.equal(result.messages, 1);
  assert.ok(events.some(e => e.phase === 'stop' && e.stopReason === 'retry_exhausted'));
});

test('a successful page resets the consecutive retry counter', async () => {
  const { AREX, document } = makeEnv({
    html: `<div role="log">${message('m1')}<button id="retry">Load earlier messages</button></div>`,
  });
  const log = document.querySelector('[role=log]');
  const button = log.querySelector('#retry');
  let clicks = 0;
  button.addEventListener('click', () => {
    clicks += 1;
    if (clicks < 3) return; // two consecutive failures, then a good page
    button.remove();
    const m = document.createElement('div');
    m.setAttribute('data-agent-transcript-message', '');
    m.setAttribute('data-chat-message-id', 'm0');
    log.prepend(m);
  });
  const result = await AREX.loadFullHistory(log, { quietMs: 5, quickMs: 5, detectMs: 10, stagnantTarget: 1, maxRetries: 3 });
  assert.equal(clicks, 3);
  assert.equal(result.pages, 1);
  assert.equal(result.messages, 2);
  assert.equal(result.stable, true);
  assert.notEqual(result.stopReason, 'retry_exhausted');
});

test('exhausting maxRounds reports max_rounds and keeps the legacy result shape', async () => {
  const { AREX, document } = makeEnv({
    html: `<div role="log">${message('m1')}<button id="retry">Load earlier messages</button></div>`,
  });
  const log = document.querySelector('[role=log]');
  log.querySelector('#retry').addEventListener('click', () => {});
  const result = await AREX.loadFullHistory(log, { quietMs: 5, quickMs: 5, detectMs: 5, maxRounds: 2 });
  assert.equal(result.stopReason, 'max_rounds');
  assert.equal(result.stable, false);
  assert.equal(result.pages, 0);
  assert.deepEqual(
    ['messages', 'stable', 'pages'].map(k => typeof result[k]),
    ['number', 'boolean', 'number'],
  );
});

test('hot checks never inspect buttons or status notices inside message cards', async () => {
  const spoilers = Array.from({ length: 300 }, (_, i) => `<button aria-expanded="false">spoiler ${i}</button>`).join('');
  const { AREX, document } = makeEnv({
    html: `<div role="log"><div class="max-w-3xl"><div data-agent-transcript-message data-chat-message-id="m1">
      <div class="prose" id="stream">thinking</div>
      ${spoilers}
      <button>Load earlier messages</button>
      <div role="status">Loading earlier messages</div>
    </div></div></div>`,
  });
  const log = document.querySelector('[role=log]');
  const card = log.querySelector('[data-agent-transcript-message]');
  let textReads = 0;
  for (const el of [...card.querySelectorAll('button'), card.querySelector('[role="status"]')]) {
    Object.defineProperty(el, 'textContent', {
      configurable: true,
      get() { textReads += 1; return 'Load earlier messages'; },
      set() {},
    });
  }
  const queried = [];
  const qq = AREX.qq, qsa = log.querySelectorAll.bind(log), qs = log.querySelector.bind(log);
  AREX.qq = (sel, root) => { queried.push(sel); return qq(sel, root); };
  log.querySelectorAll = sel => { queried.push(sel); return qsa(sel); };
  log.querySelector = sel => { queried.push(sel); return qs(sel); };

  // Continuous streaming churn forces many MutationObserver callbacks while
  // the loader waits: this is exactly where the old code scanned O(N) buttons.
  const prose = document.getElementById('stream');
  let ticks = 0;
  const timer = setInterval(() => {
    prose.appendChild(document.createTextNode(' …'));
    if (++ticks >= 30) clearInterval(timer);
  }, 2);
  const events = [];
  const result = await AREX.loadFullHistory(log, {
    quietMs: 80, quickMs: 80, detectMs: 80, spinnerGoneMs: 20, stagnantTarget: 1,
    onProgress: p => events.push(p),
  });
  clearInterval(timer);
  assert.ok(ticks >= 10, 'the hot path was exercised');
  assert.equal(textReads, 0, 'no text read on any button/status inside a message card');
  assert.equal(queried.some(sel => /button/i.test(sel)), false, 'no full-DOM button selector on the log');
  assert.equal(events.filter(e => e.phase === 'retry').length, 0, 'card-internal retry lookalike was not clicked');
  assert.equal(events.filter(e => e.phase === 'loading').length, 0, 'card-internal status notice was not treated as a spinner');
  assert.equal(result.stable, true);
  assert.equal(result.messages, 1);
  assert.equal(result.stopReason, 'no_marker_probe');
});
