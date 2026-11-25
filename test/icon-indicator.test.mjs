import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const wait = () => new Promise(resolve => setTimeout(resolve, 10));
const event = () => { const fns = []; return { addListener(fn) { fns.push(fn); }, emit(...args) { return Promise.all(fns.map(fn => fn(...args))); } }; };
function port(name, tabId) {
  return { name, sender: tabId == null ? undefined : { tab: { id: tabId } }, onMessage: event(), onDisconnect: event(), postMessage() {}, disconnect() { return this.onDisconnect.emit(); } };
}
function setup(session = {}) {
  const intervals = new Map(), calls = [], requests = [], rectDraws = [];
  let timerId = 0;
  const runtime = { onMessage: event(), onConnect: event(), onStartup: event(), onInstalled: event(), getURL: p => p };
  const changes = event();
  const onUpdated = event();
  const action = Object.fromEntries(['setIcon', 'setBadgeText', 'setBadgeBackgroundColor', 'setTitle'].map(name => [name, async arg => { calls.push({ name, arg }); }]));
  const chrome = {
    runtime, action,
    storage: { local: { get: async () => ({}) }, session: { get: async k => ({ [k]: session[k] }), set: async v => Object.assign(session, v) }, onChanged: changes },
    tabs: { onRemoved: event(), onUpdated, sendMessage(_id, _m, cb) { cb?.(); } },
    scripting: { executeScript: async () => {} },
  };
  class OffscreenCanvas {
    constructor(size) { this.size = size; }
    getContext() {
      const size = this.size;
      return {
        drawImage() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
        fillRect(...args) { rectDraws.push({ size, args }); },
        getImageData() { return { width: size, height: size }; },
      };
    }
  }
  const sandbox = { chrome, console, TextEncoder, URL, OffscreenCanvas, setTimeout, clearTimeout,
    setInterval(fn, ms) { const id = ++timerId; intervals.set(id, { fn, ms }); return id; },
    clearInterval(id) { intervals.delete(id); },
    fetch: async p => { requests.push(p); return { ok: true, blob: async () => p }; },
    createImageBitmap: async blob => ({ blob }),
    AREX_RESULT_STORE: { save: async () => {} },
  };
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  const last = name => calls.filter(c => c.name === name).at(-1)?.arg;
  const connect = async (name, tabId) => { const p = port(name, tabId); await runtime.onConnect.emit(p); return p; };
  return { runtime, changes, onUpdated, intervals, calls, requests, rectDraws, last, connect, session };
}

test('idle → running with progress → unseen ready → popup clears; themes and icon cache', async () => {
  const h = setup(); await wait();
  assert.equal(h.last('setBadgeText').text, '');
  assert.equal(h.last('setIcon').path[16], 'icons/icon16.png');
  const content = await h.connect('AREX_JOB', 1);
  await content.onMessage.emit({ type: 'AREX_JOB_START' }); await wait();
  assert.equal(h.intervals.size, 1); assert.equal([...h.intervals.values()][0].ms, 180);
  assert.equal(h.last('setBadgeText').text, '1/3');
  assert.equal(h.last('setIcon').imageData[16].width, 16);
  await content.onMessage.emit({ type: 'AREX_PROGRESS', stage: 'history', phase: 'page', pages: 4, loaded: 80 }); await wait();
  assert.equal(h.last('setBadgeText').text, 'p4');
  assert.match(h.last('setTitle').title, /Loading history: 80 msgs/);
  await content.onMessage.emit({ type: 'AREX_PROGRESS', stage: 'process', processedMessages: 12, totalMessages: 18, expandedSpoilers: 7, totalSpoilers: 20, percent: 64 }); await wait();
  assert.equal(h.last('setBadgeText').text, '64%');
  assert.match(h.last('setTitle').title, /Scanning 64% \(12\/18 msgs · 7\/20 spoilers\)/);
  [...h.intervals.values()][0].fn(); await wait();
  assert.equal(h.requests.filter(p => p === 'icons/icon16.png').length, 1);
  await h.changes.emit({ theme: { newValue: 'dark' } }, 'local'); await wait();
  assert.ok(h.requests.includes('icons/icon16-dark.png'));
  await content.onMessage.emit({ type: 'AREX_RESULT_END', ok: true, markdown: 'a'.repeat(1420000), bytes: 1420000 }); await wait();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.last('setBadgeText').text, '✓');
  assert.equal(h.last('setBadgeBackgroundColor').color, '#188038');
  assert.match(h.last('setTitle').title, /Ready to download \(1.42 MB\)/);
  assert.equal(h.session.arexJobs[0].unseen, true);
  const popup = await h.connect('AREX_POPUP'); await popup.onMessage.emit({ type: 'AREX_HELLO', tabId: 1 }); await wait();
  assert.equal(h.last('setBadgeText').text, '');
  assert.equal(h.last('setIcon').path[16], 'icons/icon16-dark.png');
  assert.equal(h.session.arexJobs[0].unseen, false);
});

test('multiple jobs keep one timer; unseen error survives a running job and popup clears it', async () => {
  const h = setup(); await wait();
  const a = await h.connect('AREX_JOB', 1), b = await h.connect('AREX_JOB', 2);
  await a.onMessage.emit({ type: 'AREX_JOB_START' }); await b.onMessage.emit({ type: 'AREX_JOB_START' }); await wait();
  assert.equal(h.intervals.size, 1);
  await a.onMessage.emit({ type: 'AREX_RESULT_END', ok: false, error: 'Network failure' }); await wait();
  assert.equal(h.intervals.size, 1); assert.notEqual(h.last('setBadgeText').text, '!');
  await b.onMessage.emit({ type: 'AREX_RESULT_END', ok: true, markdown: 'ok' }); await wait();
  assert.equal(h.intervals.size, 0); assert.equal(h.last('setBadgeText').text, '!');
  assert.equal(h.last('setBadgeBackgroundColor').color, '#d93025'); assert.match(h.last('setTitle').title, /Network failure/);
  const popup = await h.connect('AREX_POPUP'); await popup.onMessage.emit({ type: 'AREX_HELLO' }); await wait();
  assert.equal(h.last('setBadgeText').text, '');
});

test('completion while popup is open and cancellation do not produce unseen badges', async () => {
  const h = setup(); await wait();
  const popup = await h.connect('AREX_POPUP'); await popup.onMessage.emit({ type: 'AREX_HELLO', tabId: 1 });
  const a = await h.connect('AREX_JOB', 1); await a.onMessage.emit({ type: 'AREX_JOB_START' });
  await a.onMessage.emit({ type: 'AREX_RESULT_END', ok: true, markdown: 'ok' }); await wait();
  assert.equal(h.last('setBadgeText').text, '');
  await popup.disconnect();
  const b = await h.connect('AREX_JOB', 2); await b.onMessage.emit({ type: 'AREX_JOB_START' });
  await b.onMessage.emit({ type: 'AREX_RESULT_END', ok: false, error: 'Export cancelled.' }); await wait();
  assert.equal(h.last('setBadgeText').text, ''); assert.equal(h.intervals.size, 0);
});

test('restores unseen notifications and stale jobs from session', async () => {
  const session = { arexJobs: [{ tabId: 3, status: 'done', unseen: true, progress: [], updatedAt: Date.now(), resultMeta: { bytes: 100 } }] };
  const h = setup(session); await wait(); assert.equal(h.last('setBadgeText').text, '✓');
  const popup = await h.connect('AREX_POPUP'); await wait(); assert.equal(h.last('setBadgeText').text, '');
  assert.equal(session.arexJobs[0].unseen, false);
  const stale = setup({ arexJobs: [{ tabId: 4, status: 'running', progress: [], updatedAt: Date.now() - 60000 }] });
  await wait(); assert.equal(stale.last('setBadgeText').text, '!'); assert.equal(stale.intervals.size, 0);
});

test('window completion does not regress to 75% during final serialization', async () => {
  const h = setup(); await wait();
  const job = await h.connect('AREX_JOB', 31);
  await job.onMessage.emit({ type: 'AREX_JOB_START' });
  await job.onMessage.emit({ type: 'AREX_PROGRESS', stage: 'process', processedMessages: 4, totalMessages: 4, percent: 100 });
  await job.onMessage.emit({ type: 'AREX_PROGRESS', stage: 'serialize', phase: 'done', bytes: 100 }); await wait();
  assert.equal(h.last('setBadgeText').text, '100%');
  assert.match(h.last('setTitle').title, /Saving snapshot/);
  await job.onMessage.emit({ type: 'AREX_RESULT_END', ok: true, markdown: 'ok' });
});

test('stopped partial result renders distinct amber pause indicator (not red !) and chunk saving progress', async () => {
  const h = setup(); await wait();
  const job = await h.connect('AREX_JOB', 41);
  await job.onMessage.emit({ type: 'AREX_JOB_START', chatUuid: 'branch-p', sourceUrl: 'https://arena.ai/agent/branch-p' });
  await job.onMessage.emit({ type: 'AREX_RESULT_CHUNK', seq: 0, totalChunks: 2, data: 'x'.repeat(600) }); await wait();
  assert.equal(h.last('setBadgeText').text, '99%');
  assert.match(h.last('setTitle').title, /Saving snapshot \(1\/2 chunks\)/);

  await job.onMessage.emit({ type: 'AREX_RESULT_CHUNK', seq: 1, totalChunks: 2, data: 'y'.repeat(650) });
  await job.onMessage.emit({
    type: 'AREX_RESULT_END',
    ok: true,
    outcome: 'partial',
    partial: true,
    completedMessages: 4,
    totalMessages: 10,
    bytes: 1250,
  });
  await wait();

  assert.equal(h.intervals.size, 0);
  assert.equal(h.last('setBadgeText').text, '‖');
  assert.equal(h.last('setBadgeBackgroundColor').color, '#e37400');
  assert.match(h.last('setTitle').title, /Stopped · partial snapshot ready \(4\/10 msgs · 1\.3 KB\)/);
  assert.ok(h.rectDraws.length >= 4, 'draws pause bars on 16px and 32px icon canvases');

  const popup = await h.connect('AREX_POPUP');
  await popup.onMessage.emit({ type: 'AREX_HELLO', tabId: 41 });
  await wait();
  assert.equal(h.last('setBadgeText').text, '');
});

test('SPA /agent/A -> /agent/B navigation stops spinner and keeps unseen abort notification until popup opens', async () => {
  const h = setup(); await wait();
  const job = await h.connect('AREX_JOB', 51);
  await job.onMessage.emit({ type: 'AREX_JOB_START', chatUuid: 'branch-a', sourceUrl: 'https://arena.ai/agent/branch-a' });
  await wait();
  assert.equal(h.intervals.size, 1);

  await h.onUpdated.emit(51, { url: 'https://arena.ai/agent/branch-b' });
  await wait();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.last('setBadgeText').text, '!');
  assert.match(h.last('setTitle').title, /different Arena conversation/);

  const popup = await h.connect('AREX_POPUP');
  await popup.onMessage.emit({ type: 'AREX_HELLO', tabId: 51, chatUuid: 'branch-b', tabUrl: 'https://arena.ai/agent/branch-b' });
  await wait();
  assert.equal(h.last('setBadgeText').text, '');
});
