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

test('progress percent counts messages and known spoilers as separate work units', async () => {
  const { AREX, log } = windowEnv(4);
  const events = [];
  await AREX.processMessagesInWindows(log, {}, { windowSize: 4, onProgress: event => events.push(event) });

  const opening = events.find(event => event.phase === 'expand');
  const firstSerialized = events.find(event => event.processedMessages === 1 && !event.phase);
  const last = events.at(-1);
  assert.equal(opening.processedMessages, 0);
  assert.equal(opening.expandedSpoilers, 4);
  assert.equal(opening.totalSpoilers, 4);
  assert.equal(opening.percent, 50); // four opened spoilers out of four messages + four spoilers
  assert.equal(firstSerialized.percent, 63); // then one message unit is completed
  assert.equal(last.percent, 100);
});

test('progress discovers nested spoilers without regressing the percentage', async () => {
  const { AREX, document } = makeEnv({
    html: `<div role="log"><div data-agent-transcript-message data-chat-message-id="nested">
      <div><button id="group" aria-expanded="false">group</button></div>
    </div></div>`,
  });
  const log = document.querySelector('[role="log"]');
  const group = document.querySelector('#group');
  group.addEventListener('click', () => {
    if (group.getAttribute('aria-expanded') === 'true') {
      group.setAttribute('aria-expanded', 'false');
      group.parentElement.querySelector(':scope > [style*="overflow: clip"]')?.remove();
      return;
    }
    group.setAttribute('aria-expanded', 'true');
    const panel = document.createElement('div');
    panel.setAttribute('style', 'overflow: clip; height: auto; opacity: 1');
    panel.innerHTML = '<button aria-expanded="false">leaf one</button><button aria-expanded="false">leaf two</button>';
    panel.querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
      button.setAttribute('aria-expanded', button.getAttribute('aria-expanded') === 'false' ? 'true' : 'false');
    }));
    group.parentElement.append(panel);
  });
  AREX.settle = async () => {};
  AREX.yieldToMain = async () => {};
  const events = [];

  await AREX.processMessagesInWindows(log, {}, { onProgress: event => events.push(event) });

  const expansionEvents = events.filter(event => event.phase === 'expand');
  const passEvents = expansionEvents.filter(event => event.expansionPhase === 'settle');
  assert.equal(passEvents[0].expandedSpoilers, 1);
  assert.equal(passEvents[0].totalSpoilers, 3); // the group reveals two nested spoilers
  assert.ok(passEvents[0].percent > 0 && passEvents[0].percent <= 100);
  assert.ok(expansionEvents.some(event => event.expandedSpoilers === 3 && event.percent === 75));
  assert.ok(events.every((event, index) => index === 0 || event.percent >= events[index - 1].percent));
  assert.equal(events.at(-1).percent, 100);
});

test('cancellation thrown during expansion still closes already opened panels', async () => {
  const { AREX, log } = windowEnv(3);
  AREX._abortController = new log.ownerDocument.defaultView.AbortController();
  log.querySelector('button').addEventListener('click', () => AREX._abortController.abort(), { once: true });
  await assert.rejects(AREX.processMessagesInWindows(log, {}, { onProgress: () => AREX.throwIfAborted() }), error => error.name === 'AbortError');
  assert.equal(log.querySelectorAll('button[aria-expanded=true]').length, 0);
  assert.equal(log.querySelectorAll('[style*="overflow: clip"]').length, 0);
});

// Builds one assistant message whose expanded panel holds `count` synthetic
// spoiler rows, so the DOM walk itself (not a single <pre>) is the workload.
function largeNodeEnv(count = 5000) {
  const rows = Array.from({ length: count }, (_, i) =>
    `<div><span>row ${i}</span><svg width="8" height="8"></svg></div>`).join('');
  const html = `<div role="log"><div data-agent-transcript-message data-chat-message-id="big">`
    + '<div><button aria-expanded="true">Ran commands</button></div>'
    + `<div style="overflow: clip"><pre>command</pre>${rows}</div></div></div>`;
  const env = makeEnv({ html });
  return { ...env, message: env.AREX.messages(env.document.querySelector('[role=log]'))[0] };
}

test('asynchronous walker yields within a single message and matches synchronous output', async () => {
  const { AREX, log } = windowEnv(1); log.querySelector('button').click();
  const message = AREX.messages(log)[0];
  const expected = AREX.serializeMessage(message);
  const actual = await AREX.serializeMessageAsync(message, {}, 0);
  assert.equal(actual, expected);
  // Checkpoints are amortised by 64 visited nodes: a five-element message may
  // finish inside a single budget window, so only the big walk asserts yields.
  const big = largeNodeEnv(1300); // > 3,900 visited elements -> several checkpoints
  let yields = 0; big.AREX.yieldToMain = async () => { yields++; };
  const bigExpected = big.AREX.serializeMessage(big.message);
  const bigActual = await big.AREX.serializeMessageAsync(big.message, {}, 0);
  assert.equal(bigActual, bigExpected);
  assert.ok(yields > 1, `expected cooperative yields, got ${yields}`);
});

test('cooperative walker yields on a ~64-node cadence inside one 5,000-node message', async () => {
  // 2,500 leaf rows = 5,001 elements plus their text nodes.
  const { AREX, message } = largeNodeEnv(2500);
  const checkpoints = [];
  AREX.yieldToMain = async () => { checkpoints.push(true); };
  const expected = AREX.serializeMessage(message);
  const actual = await AREX.serializeMessageAsync(message, {}, 0);
  assert.equal(actual, expected);
  // ~5,001 visited elements / 64 per checkpoint ~= 78 potential yields; the
  // bound proves the walk yields in amortised batches, never once per node.
  assert.ok(checkpoints.length >= 30, `too few yields: ${checkpoints.length}`);
  assert.ok(checkpoints.length <= 120, `yielded too often: ${checkpoints.length}`);
});

test('synchronous serialization visits the DOM without generators, clones or clock reads', () => {
  const { AREX, dom } = makeEnv({ html: fixtureHtml(), url: 'https://arena.ai/agent/01a125f9-92b4-7e1a-a13a-b2e1bc5ffd61' });
  dom.window.Node.prototype.cloneNode = () => { throw new Error('DOM clone is forbidden'); };
  const perf = dom.window.performance;
  const original = perf.now.bind(perf);
  let clockReads = 0;
  perf.now = () => { clockReads++; return original(); };
  const md = AREX.serialize(AREX.logEl());
  perf.now = original;
  assert.match(md, /^- Messages: 9$/m);
  assert.equal(clockReads, 0, 'the synchronous walker must not read the clock');
  dom.window.close();
});

test('serializeHeader stays byte-identical unless partial metadata is requested', () => {
  const { AREX, dom } = makeEnv({ url: 'https://arena.ai/agent/01a125f9-92b4-7e1a-a13a-b2e1bc5ffd61' });
  const stamp = line => line.replace(/^- Exported: .*$/m, '- Exported: <ts>');
  const plain = stamp(AREX.serializeHeader(9));
  assert.equal(plain, stamp(AREX.serializeHeader(9, {})));
  assert.equal(plain, stamp(AREX.serializeHeader(9, { partial: false, totalMessages: null })));
  assert.equal(plain.split('\n').at(0).startsWith('# '), true);
  assert.match(plain, /^- Messages: 9$/m);
  assert.match(plain, /^---$/m);
  assert.equal(plain.endsWith('\n'), false);
  const partial = stamp(AREX.serializeHeader(4, { partial: true, totalMessages: 12 }));
  assert.match(partial, /^- Messages: 4$/m);
  assert.match(partial, /^- Status: Partial export \(4\/12 messages\)$/m);
  // Everything else is identical apart from the inserted status line.
  const plainFour = stamp(AREX.serializeHeader(4));
  assert.deepEqual(partial.split('\n').filter(line => !line.startsWith('- Status:')), plainFour.split('\n'));
  assert.match(AREX.serializeHeader(4, { partial: true }), /\(4\/\? messages\)/);
  dom.window.close();
});

test('file chip badge extraction handles nested chrome in one pass', () => {
  const { AREX, document } = makeEnv();
  const { fileChip } = AREX._serializeInternals;
  const host = document.createElement('div');
  host.innerHTML = '<div role="button">'
    + '<span class="select-none">7</span>'
    + '<span><svg width="8" height="8"></svg><span>report.sh</span></span>'
    + '<span>SHELLSCRIPT</span>'
    + '<button aria-label="Open file"><span>SHOULD NOT APPEAR</span></button>'
    + '<pre>ignored preview</pre></div>';
  const chip = fileChip(host.firstElementChild);
  assert.deepEqual({ name: chip.name, lang: chip.lang }, { name: 'report.sh', lang: 'SHELLSCRIPT' });
});

test('footer rows are detected per <time> ancestor chain only', () => {
  const { AREX, document } = makeEnv();
  const { footerSet, footerOf } = AREX._serializeInternals;
  const message = document.createElement('div');
  message.innerHTML = `
    <div class="content"><div class="row"><span>answer</span><time>4:49 PM</time></div></div>
    <div class="actions"><button aria-label="Copy">copy</button></div>
    <div class="footer"><div class="meta"><button aria-label="Copy">copy</button></div>
      <span class="timing"><time>4:50 PM</time></span></div>
    <div class="card"><button aria-expanded="true">tool</button><time>4:51 PM</time>
      <button aria-label="Copy">copy</button></div>`;
  const footers = footerSet(message);
  const footer = message.querySelector('.footer');
  const card = message.querySelector('.card');
  const content = message.querySelector('.content');
  assert.equal(footers.has(footer), true);
  // A Copy button without <time> is not a footer; content markers disqualify.
  assert.equal(footers.has(content), false);
  assert.equal(footers.has(card), false);
  assert.equal(footers.has(message), false);
  // Exact footerOf parity for the same candidate nodes.
  for (const el of [footer, card, content, message])
    assert.equal(footers.has(el), footerOf(el) === el, el.className || 'message');
});

test('footerSet matches the legacy per-node predicate on randomized structures', () => {
  const { AREX, document } = makeEnv();
  const { footerSet, footerOf } = AREX._serializeInternals;
  // The pre-#22 semantics scanned every ancestor of every <time> with footerOf.
  const legacy = message => {
    const found = new Set();
    for (const time of message.querySelectorAll('time'))
      for (let node = time; node && node !== message; node = node.parentElement)
        if (footerOf(node)) found.add(node);
    return found;
  };
  let seed = 42;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const maybe = (chance, make) => { if (random() < chance) make(); };
  const build = (depth = 0) => {
    const el = document.createElement(['div', 'span', 'section', 'p'][Math.floor(random() * 4)]);
    maybe(0.12, () => { const time = document.createElement('time'); time.textContent = '4:49 PM'; el.append(time); });
    maybe(0.10, () => { const copy = document.createElement('button'); copy.setAttribute('aria-label', 'Copy'); el.append(copy); });
    maybe(0.06, () => { const toggle = document.createElement('button'); toggle.setAttribute('aria-expanded', 'true'); el.append(toggle); });
    maybe(0.05, () => el.append(document.createElement('pre')));
    maybe(0.05, () => { const prose = document.createElement('div'); prose.className = 'prose'; el.append(prose); });
    if (depth < 4) for (let i = 0, n = Math.floor(random() * 4); i < n; i += 1) el.append(build(depth + 1));
    return el;
  };
  let checked = 0;
  for (let i = 0; i < 120; i += 1) {
    const message = build();
    const expected = legacy(message);
    const actual = footerSet(message);
    for (const el of [message, ...message.querySelectorAll('*')]) {
      checked += 1;
      assert.equal(actual.has(el), expected.has(el), message.outerHTML.slice(0, 300));
    }
  }
  assert.ok(checked > 1000, `too few elements checked: ${checked}`);
});
