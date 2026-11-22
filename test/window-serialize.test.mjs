import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeEnv, fixtureHtml } from './harness.mjs';

const normalize = md => md.trim().replace(/^- Exported: .*$/m, '- Exported: <ts>');

test('zero-clone synchronous and windowed serialization match the existing fixture snapshot', async () => {
  const { AREX, window } = makeEnv({ html: fixtureHtml(), url: 'https://arena.ai/agent/01a125f9-92b4-7e1a-a13a-b2e1bc5ffd61' });
  const expected = readFileSync(new URL('./snapshots/fixture-expected.md', import.meta.url), 'utf8').trim();
  window.Node.prototype.cloneNode = () => { throw new Error('DOM clone is forbidden'); };
  const sync = AREX.serialize(AREX.logEl());
  assert.equal(normalize(sync), expected);
  // The saved fixture is static: its collapsed controls cannot mount new DOM.
  const progress = [];
  const result = await AREX.processMessagesInWindows(AREX.logEl(), {}, { onProgress: p => progress.push(p) });
  assert.equal(normalize(result.markdown), expected);
  assert.equal(result.totalMessages, 9);
  assert.equal(progress.filter(e => e.stage === 'process' && e.processedMessages === 9).at(-1).percent, 100);
});

function windowEnv(count = 9) {
  const html = `<div role="log">${Array.from({ length: count }, (_, i) => `<div data-agent-transcript-message data-chat-message-id="${i}"><div><button aria-expanded="false">Tool ${i}</button></div></div>`).join('')}</div>`;
  const env = makeEnv({ html }); const { document } = env; const log = document.querySelector('[role=log]');
  let maxOpen = 0;
  for (const button of log.querySelectorAll('button')) button.addEventListener('click', () => {
    const opening = button.getAttribute('aria-expanded') === 'false';
    button.setAttribute('aria-expanded', String(opening));
    if (opening) {
      const panel = document.createElement('div'); panel.setAttribute('style', 'overflow: clip'); panel.innerHTML = '<pre>output</pre>'; button.parentElement.append(panel);
    } else button.parentElement.querySelector('[style*="overflow: clip"]')?.remove();
    maxOpen = Math.max(maxOpen, log.querySelectorAll('button[aria-expanded=true]').length);
  });
  return { ...env, log, maxOpen: () => maxOpen };
}

test('windows cap live panels, retain pre-existing state, and serialize each message in order', async () => {
  const { AREX, log, maxOpen } = windowEnv();
  // One panel was open before export; it must remain open afterwards.
  log.querySelector('button').click();
  const phases = [];
  const result = await AREX.processMessagesInWindows(log, {}, { windowSize: 4, onProgress: p => phases.push(p) });
  assert.equal(result.expandedSpoilers, 8); assert.equal(result.leftCollapsed, 0);
  assert.equal((result.markdown.match(/```text\noutput\n```/g) || []).length, 9);
  assert.ok(maxOpen() <= 5, `opened too many: ${maxOpen()}`); // 4 in window + one originally open
  assert.equal(log.querySelectorAll('button[aria-expanded=true]').length, 1);
  assert.equal(log.querySelectorAll('[style*="overflow: clip"]').length, 1);
  assert.ok(phases.some(p => p.stage === 'process' && p.processedMessages === 9 && p.percent === 100));
});

test('cancellation thrown during expansion still closes already opened panels', async () => {
  const { AREX, log } = windowEnv(3);
  AREX._abortController = new log.ownerDocument.defaultView.AbortController();
  log.querySelector('button').addEventListener('click', () => AREX._abortController.abort(), { once: true });
  await assert.rejects(AREX.processMessagesInWindows(log, {}, { onProgress: () => AREX.throwIfAborted() }), error => error.name === 'AbortError');
  assert.equal(log.querySelectorAll('button[aria-expanded=true]').length, 0);
  assert.equal(log.querySelectorAll('[style*="overflow: clip"]').length, 0);
});

test('asynchronous walker yields within a single message and matches synchronous output', async () => {
  const { AREX, log } = windowEnv(1); log.querySelector('button').click();
  let yields = 0; AREX.yieldToMain = async () => { yields++; };
  const message = AREX.messages(log)[0];
  const expected = AREX.serializeMessage(message);
  const actual = await AREX.serializeMessageAsync(message, {}, 0);
  assert.equal(actual, expected); assert.ok(yields > 1);
});
