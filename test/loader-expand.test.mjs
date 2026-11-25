import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './harness.mjs';

const MSG = id => `<div data-agent-transcript-message data-chat-message-id="${id}">msg ${id}</div>`;

// Emulates Arena: scrolling to top prepends an older page (with a brief loader),
// until hasMore is exhausted.
function pagedLog(pages) {
  const { document, AREX } = makeEnv({
    html: `<div role="log"><div class="max-w-3xl">${pages.at(-1).map(MSG).join('')}</div></div>`,
  });
  const log = document.querySelector('[role="log"]');
  const list = log.firstElementChild;
  let remaining = pages.slice(0, -1);
  Object.defineProperty(log, 'scrollTop', {
    configurable: true,
    get() { return 0; },
    set() {
      if (!remaining.length) return;
      const page = remaining.pop();
      const loader = document.createElement('div');
      loader.setAttribute('role', 'status');
      loader.textContent = 'Loading earlier messages';
      list.prepend(loader);
      setTimeout(() => {
        loader.remove();
        list.prepend(...page.map(id => {
          const d = document.createElement('div');
          d.setAttribute('data-agent-transcript-message', 'true');
          d.setAttribute('data-chat-message-id', id);
          return d;
        }));
      }, 30);
    },
  });
  return { AREX, log, document };
}

test('loader pulls all earlier pages then reports stable', async () => {
  const { AREX, log } = pagedLog([['m1', 'm2'], ['m3'], ['m4', 'm5', 'm6']]);
  const r = await AREX.loadFullHistory(log, { roundTimeoutMs: 1500 });
  assert.equal(r.messages, 6);
  assert.equal(r.stable, true);
  const first = AREX.messages(log)[0];
  assert.equal(AREX.msgId(first), 'm1');
  // order: m1..m6 (join: vm-realm arrays are not === to node-realm arrays)
  assert.equal(AREX.messages(log).map(m => AREX.msgId(m)).join(','), 'm1,m2,m3,m4,m5,m6');
});

test('loader stops quickly on single-page branches', async () => {
  const { AREX, log } = pagedLog([['only1', 'only2']]);
  const r = await AREX.loadFullHistory(log, { roundTimeoutMs: 300 });
  assert.equal(r.messages, 2);
  assert.equal(r.stable, true);
});

test('loader ignores unrelated status notices inside transcript messages', async () => {
  const { document, AREX } = makeEnv({
    html: `<div role="log"><div class="max-w-3xl">
      <div data-agent-transcript-message data-chat-message-id="notice">
        <div role="status">The agent reached the tool-call limit for this turn. Send a message to continue where it left off.</div>
      </div>
    </div></div>`,
  });
  const phases = [];
  const r = await AREX.loadFullHistory(document.querySelector('[role="log"]'), {
    quickMs: 5, detectMs: 5, spinnerGoneMs: 10, maxRounds: 2,
    onProgress: p => phases.push(p.phase),
  });
  assert.equal(r.stable, true);
  assert.equal(r.messages, 1);
  assert.equal(phases.includes('loading'), false);
});

test('loader clicks the "Load earlier messages" retry button', async () => {
  const { document, AREX } = makeEnv({
    html: `<div role="log"><div class="max-w-3xl">${MSG('a1')}</div><button>Load earlier messages</button></div>`,
  });
  const log = document.querySelector('[role="log"]');
  log.querySelector('button').addEventListener('click', e => {
    e.currentTarget.remove(); // retry button disappears once used
    const d = document.createElement('div');
    d.setAttribute('data-agent-transcript-message', 'true');
    d.setAttribute('data-chat-message-id', 'a0');
    log.firstElementChild.prepend(d);
  });
  const r = await AREX.loadFullHistory(log, { roundTimeoutMs: 400 });
  assert.equal(r.messages, 2);
  assert.equal(AREX.msgId(AREX.messages(log)[0]), 'a0');
});

// Emulates Arena spoilers: click mounts the panel; groups mount nested collapsed items.
function spoilerLog() {
  const { document, AREX } = makeEnv({
    html: `<div role="log"><div data-agent-transcript-message data-chat-message-id="s1">
      <div id="group-wrap"><button id="group" aria-expanded="false">Ran commands 2</button></div>
    </div></div>`,
  });
  const log = document.querySelector('[role="log"]');
  const mount = (btn, html, wireLeaves) => btn.addEventListener('click', () => {
    if (btn.getAttribute('aria-expanded') === 'true') {
      btn.setAttribute('aria-expanded', 'false');
      btn.parentElement.querySelector(':scope > [style*="overflow: clip"]')?.remove();
      return;
    }
    btn.setAttribute('aria-expanded', 'true');
    const panel = document.createElement('div');
    panel.setAttribute('style', 'overflow: clip; height: auto; opacity: 1');
    panel.innerHTML = html;
    btn.parentElement.append(panel);
    // React: newly mounted nested spoilers are interactive right away.
    panel.querySelectorAll('button.leaf').forEach(b => mount(b, '<div><span>command</span><pre>$ true</pre></div>', false));
  });
  mount(document.getElementById('group'),
    '<div><button class="leaf" aria-expanded="false">used Bash 1ms</button></div>' +
    '<div><button class="leaf" aria-expanded="false">used Bash 2ms</button></div>');
  return { AREX, log, document };
}

test('expander clicks nested spoilers until none remain', async () => {
  const { AREX, log } = spoilerLog();
  const r = await AREX.expandAllSpoilers(log);
  assert.equal(r.expanded, 3); // group + 2 nested
  assert.equal(r.stuck.length, 0);
  assert.equal(r.openedButtons.length, 3);
  assert.equal(log.querySelectorAll('button[aria-expanded="false"]').length, 0);
  assert.equal(log.querySelectorAll('[style*="overflow: clip"]').length, 3);
});

test('collapses exporter-opened spoilers after serialization and releases nested panels', async () => {
  const { AREX, log } = spoilerLog();
  const result = await AREX.expandAllSpoilers(log);
  assert.equal(log.querySelectorAll('[style*="overflow: clip"]').length, 3);

  const progress = [];
  const cleanup = await AREX.collapseOpenedSpoilers(result.openedButtons, {
    onProgress: event => progress.push(event),
    batchSize: 2,
  });

  // One group click unmounts both nested children; they are pruned, not clicked.
  assert.equal(cleanup.closed, 1);
  assert.equal(cleanup.pruned, 2);
  assert.equal(cleanup.total, 3);
  assert.equal(progress.at(-1).pruned, 2);
  assert.equal(log.querySelectorAll('button[aria-expanded="true"]').length, 0);
  assert.equal(log.querySelectorAll('[style*="overflow: clip"]').length, 0);
  assert.equal(log.querySelector('#group').getAttribute('aria-expanded'), 'false');
  assert.ok(progress.length >= 2);
});

// Full group + many children, with a click counter per control so we can prove
// cleanup removes the subtree with a single DOM click.
function nestedGroupLog(childCount) {
  const children = Array.from({ length: childCount }, (_, i) =>
    '<div><button class="leaf" aria-expanded="false">used Bash ' + (i + 1) + 'ms</button></div>').join('');
  const { document, AREX } = makeEnv({
    html: '<div role="log"><div data-agent-transcript-message data-chat-message-id="grp">' +
      '<div id="group-wrap"><button id="group" aria-expanded="false">Ran commands ' + childCount + '</button></div></div></div>',
  });
  const log = document.querySelector('[role="log"]');
  const clicks = new Map();
  const mount = (button, html, key) => button.addEventListener('click', () => {
    clicks.set(key, (clicks.get(key) || 0) + 1);
    if (button.getAttribute('aria-expanded') === 'true') {
      button.setAttribute('aria-expanded', 'false');
      button.parentElement.querySelector(':scope > [style*="overflow: clip"]')?.remove();
      return;
    }
    button.setAttribute('aria-expanded', 'true');
    const panel = document.createElement('div');
    panel.setAttribute('style', 'overflow: clip; height: auto; opacity: 1');
    panel.innerHTML = html;
    button.parentElement.append(panel);
    panel.querySelectorAll('button.leaf').forEach((leaf, i) => mount(leaf, '<pre>$ true</pre>', 'leaf-' + i));
  });
  mount(document.getElementById('group'), children, 'group');
  return { AREX, log, clicks };
}

const totalClicks = clicks => [...clicks.values()].reduce((n, count) => n + count, 0);

test('collapses a group of 1 parent + 80 children in one click with zero leaked panels', async () => {
  const { AREX, log, clicks } = nestedGroupLog(80);
  const expanded = await AREX.expandAllSpoilers(log);
  assert.equal(expanded.expanded, 81);
  assert.equal(expanded.openedButtons.length, 81);
  assert.equal(log.querySelectorAll('button[aria-expanded="false"]').length, 0);
  const clicksAfterExpand = totalClicks(clicks);
  assert.equal(clicksAfterExpand, 81);

  const progress = [];
  const cleanup = await AREX.collapseOpenedSpoilers(expanded.openedButtons, {
    onProgress: event => progress.push(event), batchSize: 25,
  });

  assert.equal(cleanup.closed, 1);
  assert.equal(cleanup.pruned, 80);
  assert.equal(cleanup.total, 81);
  assert.equal(totalClicks(clicks), clicksAfterExpand + 1);
  assert.equal(progress.at(-1).closed, 1);
  assert.equal(progress.at(-1).pruned, 80);
  assert.equal(log.querySelectorAll('button[aria-expanded="true"]').length, 0);
  assert.equal(log.querySelectorAll('[style*="overflow: clip"]').length, 0);
});

test('expander records capped stuck-spoiler diagnostics', async () => {
  const buttons = Array.from({ length: 5 }, (_, i) =>
    '<button aria-expanded="false">frozen ' + (i + 1) + '</button>').join('');
  const { document, AREX } = makeEnv({
    html: '<div role="log"><div data-agent-transcript-message data-chat-message-id="frozen-turn">' + buttons + '</div></div>',
  });
  const result = await AREX.expandAllSpoilers(document.querySelector('[role="log"]'), {
    maxPasses: 2, stuckSampleLimit: 2,
  });
  assert.equal(result.stuck.length, 5);
  assert.equal(result.stuckSamples.length, 2);
  assert.equal(result.stuckSamples[0].messageId, 'frozen-turn');
  assert.match(result.stuckSamples[0].header, /frozen 1/);
});

test('expander opens large batches incrementally and yields between them', async () => {
  const buttons = Array.from({ length: 25 }, (_, i) =>
    `<button aria-expanded="false">item ${i + 1}</button>`).join('');
  const { document, AREX } = makeEnv({ html: `<div role="log"><div data-agent-transcript-message data-chat-message-id="batch">${buttons}</div></div>` });
  const log = document.querySelector('[role="log"]');
  log.querySelectorAll('button').forEach(button => button.addEventListener('click', () => button.setAttribute('aria-expanded', 'true')));
  const progress = [];
  let yields = 0;
  const sleep = AREX.sleep;
  AREX.sleep = async ms => { if (ms === 0) yields++; return sleep(ms); };

  const result = await AREX.expandAllSpoilers(log, { batchSize: 10, onProgress: p => progress.push(p) });
  const batches = progress.filter(p => p.phase === 'click');

  assert.equal(result.expanded, 25);
  assert.equal(result.stuck.length, 0);
  assert.equal(yields, 3);
  assert.equal(batches.map(p => p.openedThisPass).join(','), '10,20,25');
  assert.equal(batches.map(p => p.expanded).join(','), '10,20,25');
  assert.equal(batches.map(p => p.total).join(','), '25,25,25');
});

test('expander handles hundreds of spoilers in 25-item batches and closes them afterward', async () => {
  const buttons = Array.from({ length: 500 }, (_, i) =>
    '<button aria-expanded="false">item ' + i + '</button>').join('');
  const { document, AREX } = makeEnv({
    html: '<div role="log"><div data-agent-transcript-message data-chat-message-id="large">' + buttons + '</div></div>',
  });
  const log = document.querySelector('[role="log"]');
  log.querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
    button.setAttribute('aria-expanded', button.getAttribute('aria-expanded') === 'true' ? 'false' : 'true');
  }));
  const phases = [];
  const expanded = await AREX.expandAllSpoilers(log, { onProgress: event => phases.push(event) });
  assert.equal(expanded.expanded, 500);
  assert.equal(expanded.openedButtons.length, 500);
  assert.equal(phases.filter(event => event.phase === 'click').length, 20);
  assert.equal(log.querySelectorAll('button[aria-expanded="true"]').length, 500);

  const cleanup = await AREX.collapseOpenedSpoilers(expanded.openedButtons);
  assert.equal(cleanup.closed, 500);
  assert.equal(log.querySelectorAll('button[aria-expanded="true"]').length, 0);
});

test('expander reports stuck (non-expandable) buttons instead of looping', async () => {
  const { document, AREX } = makeEnv({
    html: `<div role="log"><div data-agent-transcript-message data-chat-message-id="x1">
      <div><button aria-expanded="false">frozen</button></div>
    </div></div>`,
  });
  const r = await AREX.expandAllSpoilers(document.querySelector('[role="log"]'));
  assert.equal(r.stuck.length, 1);
});

test('expander aborts if the page unloads messages mid-run', async () => {
  const { document, AREX } = makeEnv({
    html: `<div role="log">${MSG('d1')}${MSG('d2')}
      <div><button aria-expanded="false">S</button></div></div>`,
  });
  const log = document.querySelector('[role="log"]');
  log.querySelector('button').addEventListener('click', () => log.querySelector('[data-chat-message-id="d2"]').remove());
  await assert.rejects(() => AREX.expandAllSpoilers(log), /unloaded messages/);
});
