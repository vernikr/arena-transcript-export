import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './harness.mjs';

const { AREX } = makeEnv();

test('dedupeTitle collapses tooltip-duplicated titles', () => {
  assert.equal(AREX.dedupeTitle('Рефакторинг research WorkspaceРефакторинг research Workspace'),
    'Рефакторинг research Workspace');
  assert.equal(AREX.dedupeTitle('abcabc'), 'abc');
  assert.equal(AREX.dedupeTitle('haha'), 'haha');          // 2-char unit: false positive guard
  assert.equal(AREX.dedupeTitle('Обычный заголовок'), 'Обычный заголовок');
});

test('dedupeTitle stays linear on pathological long inputs', () => {
  assert.equal(AREX.dedupeTitle('abcabcabcabc'), 'abc');
  assert.equal(AREX.dedupeTitle('a'.repeat(30)), 'a'.repeat(30)); // 1-char unit kept
  assert.equal(AREX.dedupeTitle('line1line1\nline1line1'), 'line1line1\nline1line1');
  const pathological = 'a'.repeat(5000) + 'b';
  AREX.dedupeTitle(pathological); // warm up the JIT, then time steady state
  const started = performance.now();
  assert.equal(AREX.dedupeTitle(pathological), pathological);
  assert.ok(performance.now() - started < 5, '50 KB pathological title must not backtrack');
});

test('utf8ByteLength matches TextEncoder across Unicode and lone surrogates', () => {
  const units = [0x41, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xd800, 0xdbff, 0xdc00,
    0xdfff, 0xe000, 0xffff, 0x10000, 0x1f600];
  let seed = 12345;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const samples = ['', 'ascii', 'Привет', '中文', '😀', '\ud800', '\udc00', '\ud800\udc00'];
  for (let i = 0; i < 300; i += 1) {
    const length = next() % 40;
    let s = '';
    for (let j = 0; j < length; j += 1) s += String.fromCharCode(units[next() % units.length]);
    samples.push(s);
  }
  for (const s of samples)
    assert.equal(AREX.utf8ByteLength(s), new TextEncoder().encode(s).length, JSON.stringify(s));
  assert.equal(AREX.utf8ByteLength('a😀Ж中'), 1 + 4 + 2 + 3);
});

test('settle ignores streaming prose churn and caller-supplied noise', async () => {
  const { document, AREX } = makeEnv({
    html: '<div role="log"><div data-agent-transcript-message data-chat-message-id="live">' +
      '<div class="prose"><span id="tokens"></span></div><div id="noise"></div></div></div>',
  });
  const log = document.querySelector('[role="log"]');
  const tokens = document.getElementById('tokens');
  const timer = setInterval(() => tokens.appendChild(document.createTextNode(' token ')), 5);
  const started = performance.now();
  try {
    await AREX.settle(log, { quietMs: 40, maxMs: 400, attributes: false });
  } finally {
    clearInterval(timer);
  }
  assert.ok(performance.now() - started < 250, 'streaming tokens must not hold settle to maxMs');

  const noise = document.getElementById('noise');
  const timer2 = setInterval(() => noise.appendChild(document.createElement('span')), 5);
  const started2 = performance.now();
  try {
    await AREX.settle(log, {
      quietMs: 40, maxMs: 400, attributes: false,
      ignorePredicate: record => record.target === noise,
    });
  } finally {
    clearInterval(timer2);
  }
  assert.ok(performance.now() - started2 < 250, 'ignorePredicate must suppress custom churn');
});

test('chatTitle dedupes topbar text, falls back to uuid', () => {
  const env = makeEnv({
    html: '<div class="absolute start-0 top-0 z-20"><span>My BranchMy Branch</span></div>',
    url: 'https://arena.ai/agent/2a6c2b7b-1234',
  });
  assert.equal(env.AREX.chatTitle(), 'My Branch');
  const bare = makeEnv({ html: '' });
  assert.equal(bare.AREX.chatTitle(), 'u-1');
});
