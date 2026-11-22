import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './harness.mjs';

const message = id => `<div data-agent-transcript-message data-chat-message-id="${id}">${id}</div>`;

test('no sentinel or loading UI exits after one short quiet probe', async () => {
  const { AREX, document } = makeEnv({ html: `<div role="log">${message('one')}</div>` });
  const events = [], start = Date.now();
  const result = await AREX.loadFullHistory(document.querySelector('[role=log]'), { quietMs: 10, onProgress: p => events.push(p) });
  assert.equal(result.stable, true); assert.equal(result.pages, 0);
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
});

test('a still-mounted sentinel or hung spinner never reports a complete history', async () => {
  for (const html of [
    `<div role="log"><div data-earlier-messages-boundary><div data-earlier-messages-sentinel></div></div>${message('x')}</div>`,
    `<div role="log"><div role="status">Loading earlier messages</div>${message('x')}</div>`,
  ]) {
    const { AREX, document } = makeEnv({ html });
    const result = await AREX.loadFullHistory(document.querySelector('[role=log]'), { quickMs: 10, detectMs: 10, spinnerGoneMs: 10 });
    assert.equal(result.stable, false);
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
});

test('mutation wait disconnects promptly on cancellation', async () => {
  const { AREX, document, window } = makeEnv();
  AREX._abortController = new window.AbortController();
  const waiting = AREX.waitForDomChange(document.querySelector('[role=log]'), () => false, { timeoutMs: 10000 });
  AREX._abortController.abort();
  await assert.rejects(waiting, error => error.name === 'AbortError');
});
