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
  assert.equal(log.querySelectorAll('button[aria-expanded="false"]').length, 0);
  assert.equal(log.querySelectorAll('[style*="overflow: clip"]').length, 3);
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
