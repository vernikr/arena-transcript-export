import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const backgroundSource = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

function makePort(name, sender) {
  const messageListeners = [];
  const disconnectListeners = [];
  return {
    name,
    sender,
    sent: [],
    onMessage: { addListener(fn) { messageListeners.push(fn); } },
    onDisconnect: { addListener(fn) { disconnectListeners.push(fn); } },
    postMessage(message) { this.sent.push(message); },
    async emit(message) { await Promise.all(messageListeners.map(fn => fn(message))); },
    disconnect() { for (const fn of disconnectListeners) fn(); },
  };
}

function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for condition.'));
      setTimeout(check, 5);
    };
    check();
  });
}

function setup({ initialSession = {}, sessionGet, resultStore, clock, delayedDisconnects } = {}) {
  const captured = { onConnect: null, onRemoved: null, onUpdated: null };
  const savedSnapshots = [];
  const sessionData = initialSession;
  const injected = [];
  const chrome = {
    action: { setIcon: async () => {}, setBadgeText: async () => {}, setTitle: async () => {} },
    runtime: {
      lastError: null,
      onMessage: { addListener() {} },
      onConnect: { addListener(fn) { captured.onConnect = fn; } },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      getURL: path => 'chrome-extension://test/' + path,
    },
    storage: {
      local: { get: async () => ({}), set() {} },
      onChanged: { addListener() {} },
      session: {
        async set(obj) { Object.assign(sessionData, obj); },
        async get(key) { if (sessionGet) return sessionGet(key); return { [key]: sessionData[key] }; },
      },
    },
    tabs: {
      onRemoved: { addListener(fn) { captured.onRemoved = fn; } },
      onUpdated: { addListener(fn) { captured.onUpdated = fn; } },
      sendMessage(_tabId, _message, callback) { callback?.(); },
      query: async () => [],
    },
    scripting: { executeScript: async ({ files }) => { injected.push(files); } },
  };
  const sandbox = {
    chrome,
    console,
    setTimeout: (fn, delay) => {
      if (delay === 6000 && delayedDisconnects) { delayedDisconnects.push(fn); return { unref() {} }; }
      return setTimeout(fn, delay);
    }, clearTimeout, setInterval, clearInterval,
    Date: clock ? class extends Date { static now() { return clock.now; } } : Date,
    TextEncoder, URL,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  // A controllable store lets lifecycle tests delay or fail the durable commit.
  sandbox.AREX_RESULT_STORE = resultStore || {
    saved: [],
    async save(snapshot) { this.saved.push(snapshot); return { filename: snapshot.filename }; },
    async load() { return this.saved.at(-1) || null; },
    async loadMeta() { const latest = this.saved.at(-1); return latest ? { filename: latest.filename } : null; },
    async clear() {},
  };
  vm.runInContext(backgroundSource, sandbox, { filename: 'background.js' });
  return { captured, savedSnapshots: sandbox.AREX_RESULT_STORE.saved, sessionData, injected, chrome };
}

test('job port → popup relay: progress, chunked result persisted to IndexedDB, ACK back to tab', async () => {
  const { captured, savedSnapshots, sessionData } = setup();
  assert.equal(typeof captured.onConnect, 'function');

  const popup = makePort('AREX_POPUP');
  captured.onConnect(popup);
  await popup.emit({ type: 'AREX_HELLO', tabId: 7 });
  const initialStatus = popup.sent.find(m => m.type === 'AREX_STATUS');
  assert.equal(initialStatus.job, null, 'no job tracked for the tab yet');

  const content = makePort('AREX_JOB', { tab: { id: 7 } });
  captured.onConnect(content);
  await content.emit({ type: 'AREX_JOB_START', chatUuid: 'abc123', sourceUrl: 'https://arena.ai/agent/abc123', startedAt: Date.now(), progress: [] });
  assert.ok(popup.sent.some(m => m.type === 'AREX_STATUS' && m.job?.status === 'running'));

  await content.emit({ type: 'AREX_PROGRESS', stage: 'history', phase: 'page', pages: 2, loaded: 40 });
  assert.ok(popup.sent.some(m => m.type === 'AREX_PROGRESS' && m.stage === 'history' && m.tabId === 7));

  await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 1, data: ' world' });
  await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 0, data: '# Hello' });
  await content.emit({ type: 'AREX_RESULT_END', ok: true, filename: 'arena-x.md', stats: { messages: 3, expandedSpoilers: 2 }, warnings: [], bytes: 13, createdAt: 111 });

  await waitUntil(() => savedSnapshots.length === 1);
  assert.equal(savedSnapshots[0].markdown, '# Hello world', 'chunks are reassembled in order');
  assert.equal(savedSnapshots[0].filename, 'arena-x.md');
  assert.equal(savedSnapshots[0].tabId, 7);
  assert.equal(savedSnapshots[0].chatUuid, 'abc123');
  assert.equal(savedSnapshots[0].sourceUrl, 'https://arena.ai/agent/abc123');
  assert.ok(content.sent.some(m => m.type === 'AREX_RESULT_ACK'), 'content tab is told to release its result');
  assert.ok(popup.sent.some(m => m.type === 'AREX_STATUS' && m.job?.status === 'done'));
  await waitUntil(() => Array.isArray(sessionData.arexJobs) && sessionData.arexJobs.some(j => j.status === 'done'));
});

test('popup cancel is forwarded to the tab job port', async () => {
  const { captured } = setup();
  const content = makePort('AREX_JOB', { tab: { id: 9 } });
  captured.onConnect(content);
  await content.emit({ type: 'AREX_JOB_START', chatUuid: null, sourceUrl: 'https://arena.ai/agent/x', startedAt: Date.now(), progress: [] });

  const popup = makePort('AREX_POPUP');
  captured.onConnect(popup);
  await popup.emit({ type: 'AREX_HELLO', tabId: 9 });
  await popup.emit({ type: 'AREX_EXPORT_CANCEL', tabId: 9 });
  assert.ok(content.sent.some(m => m.type === 'AREX_EXPORT_CANCEL'));
});

test('content failure ends the job with an error visible to popups', async () => {
  const { captured } = setup();
  const popup = makePort('AREX_POPUP');
  captured.onConnect(popup);
  const content = makePort('AREX_JOB', { tab: { id: 11 } });
  captured.onConnect(content);
  await popup.emit({ type: 'AREX_HELLO', tabId: 11 });
  await content.emit({ type: 'AREX_JOB_START', chatUuid: null, sourceUrl: 'https://arena.ai/agent/y', startedAt: Date.now(), progress: [] });
  await content.emit({ type: 'AREX_RESULT_END', ok: false, error: 'Export cancelled.' });
  assert.ok(popup.sent.some(m => m.type === 'AREX_STATUS' && m.job?.status === 'error' && /cancelled/i.test(m.job?.error || '')));
});

test('closing a tab mid-run marks the job as failed instead of leaving it running forever', async () => {
  const { captured } = setup();
  const popup = makePort('AREX_POPUP');
  captured.onConnect(popup);
  const content = makePort('AREX_JOB', { tab: { id: 13 } });
  captured.onConnect(content);
  await popup.emit({ type: 'AREX_HELLO', tabId: 13 });
  await content.emit({ type: 'AREX_JOB_START', chatUuid: null, sourceUrl: 'https://arena.ai/agent/z', startedAt: Date.now(), progress: [] });
  captured.onRemoved(13);
  assert.ok(popup.sent.some(m => m.type === 'AREX_STATUS' && m.job?.status === 'error' && /closed/i.test(m.job?.error || '')));
});

test('export start injects content scripts when the tab has none', async () => {
  const { captured, injected, chrome } = setup();
  chrome.tabs.sendMessage = (_tabId, message, callback) => {
    if (message?.type === 'AREX_PING') { callback(null); return; } // no receiver → not ready
    callback?.();
  };
  const popup = makePort('AREX_POPUP');
  captured.onConnect(popup);
  await popup.emit({ type: 'AREX_EXPORT_START', tabId: 21, options: { includeToolActivity: true } });
  await waitUntil(() => injected.length === 1);
  assert.ok(injected[0].includes('content/main.js'));
});

test('closed popup: progress continues, durable save precedes ACK, reopen restores ready state', async () => {
  let releaseSave;
  const gate = new Promise(resolve => { releaseSave = resolve; });
  const store = { saved: [], async save(snapshot) { await gate; this.saved.push(snapshot); }, async load() { return this.saved.at(-1); } };
  const { captured, sessionData, chrome } = setup({ resultStore: store });
  chrome.tabs.sendMessage = (_tabId, message, cb) => cb?.(message.type === 'AREX_PING' ? { ok: true, featureVersion: '0.4.1' } : undefined);
  const popup = makePort('AREX_POPUP'); captured.onConnect(popup);
  await popup.emit({ type: 'AREX_HELLO', tabId: 42 });
  await popup.emit({ type: 'AREX_EXPORT_START', tabId: 42, options: {} });
  popup.disconnect();
  const content = makePort('AREX_JOB', { tab: { id: 42 } }); captured.onConnect(content);
  await content.emit({ type: 'AREX_JOB_START', chatUuid: 'x', sourceUrl: 'https://arena.ai/agent/x' });
  await content.emit({ type: 'AREX_PROGRESS', stage: 'process', processedMessages: 2, totalMessages: 3, percent: 67 });
  await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 0, data: '# ready 🌍' });
  await content.emit({ type: 'AREX_RESULT_END', ok: true, filename: 'ready.md', bytes: new TextEncoder().encode('# ready 🌍').length });
  assert.equal(store.saved.length, 0); assert.equal(content.sent.some(m => m.type === 'AREX_RESULT_ACK'), false);
  releaseSave(); await waitUntil(() => content.sent.some(m => m.type === 'AREX_RESULT_ACK'));
  assert.equal((await store.load()).markdown, '# ready 🌍');
  assert.equal(sessionData.arexJobs[0].status, 'done');
  const reopened = makePort('AREX_POPUP'); captured.onConnect(reopened);
  await reopened.emit({ type: 'AREX_HELLO', tabId: 42 });
  const status = reopened.sent.find(m => m.type === 'AREX_STATUS');
  assert.equal(status.job.status, 'done'); assert.equal(status.job.resultMeta.filename, 'ready.md');
  assert.ok(status.job.progress.some(e => e.processedMessages === 2));
});

test('popup waits for asynchronous session restoration before returning status', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const stored = { arexJobs: [{ tabId: 55, status: 'done', progress: [], updatedAt: Date.now(), resultMeta: { filename: 'saved.md' } }] };
  const { captured } = setup({ sessionGet: async () => { await gate; return stored; } });
  const popup = makePort('AREX_POPUP'); captured.onConnect(popup);
  const hello = popup.emit({ type: 'AREX_HELLO', tabId: 55 });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(popup.sent.some(m => m.type === 'AREX_STATUS'), false);
  release(); await hello;
  assert.equal(popup.sent.find(m => m.type === 'AREX_STATUS').job.resultMeta.filename, 'saved.md');
});

test('missing, duplicate and mismatched chunks fail without saving or ACK', async () => {
  for (const chunks of [
    [{ seq: 1, data: 'tail' }],
    [{ seq: 0, data: 'one' }, { seq: 0, data: 'replacement' }],
    [{ seq: 0, data: 'one' }],
  ]) {
    const { captured, savedSnapshots } = setup();
    const content = makePort('AREX_JOB', { tab: { id: 62 } }); captured.onConnect(content);
    const popup = makePort('AREX_POPUP'); captured.onConnect(popup); await popup.emit({ type: 'AREX_HELLO', tabId: 62 });
    await content.emit({ type: 'AREX_JOB_START' });
    for (const chunk of chunks) await content.emit({ type: 'AREX_RESULT_CHUNK', ...chunk });
    await content.emit({ type: 'AREX_RESULT_END', ok: true, bytes: 999 });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(savedSnapshots.length, 0); assert.equal(content.sent.some(m => m.type === 'AREX_RESULT_ACK'), false);
    assert.ok(popup.sent.some(m => m.type === 'AREX_STATUS' && m.job?.status === 'error'));
  }
});

test('failed IndexedDB save leaves recoverable result and metadata in memory without ACK', async () => {
  const resultStore = { saved: [], async save() { throw new Error('quota exceeded'); } };
  const { captured } = setup({ resultStore });
  const content = makePort('AREX_JOB', { tab: { id: 72 } }); captured.onConnect(content);
  const popup = makePort('AREX_POPUP'); captured.onConnect(popup); await popup.emit({ type: 'AREX_HELLO', tabId: 72 });
  await content.emit({ type: 'AREX_JOB_START' });
  await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 0, data: 'recover me' });
  await content.emit({ type: 'AREX_RESULT_END', ok: true, filename: 'recover.md', stats: { messages: 5, expandedSpoilers: 3 }, bytes: 10 });
  await waitUntil(() => popup.sent.some(m => m.type === 'AREX_STATUS' && m.job?.status === 'error'));
  assert.equal(content.sent.some(m => m.type === 'AREX_RESULT_ACK'), false);
  await popup.emit({ type: 'AREX_GET_INMEMORY_RESULT', tabId: 72 });
  const result = popup.sent.find(m => m.type === 'AREX_INMEMORY_RESULT');
  assert.equal(result.markdown, 'recover me'); assert.equal(result.filename, 'recover.md'); assert.equal(result.stats.messages, 5);
});

test('oversized transfer remains failed even if later chunks and end arrive', async () => {
  const { captured, savedSnapshots } = setup();
  const content = makePort('AREX_JOB', { tab: { id: 81 } }); captured.onConnect(content);
  const popup = makePort('AREX_POPUP'); captured.onConnect(popup); await popup.emit({ type: 'AREX_HELLO', tabId: 81 });
  await content.emit({ type: 'AREX_JOB_START' });
  await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 0, data: 'x'.repeat(64 * 1024 * 1024 + 1) });
  await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 1, data: 'partial' });
  await content.emit({ type: 'AREX_RESULT_END', ok: true, bytes: 7 });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(savedSnapshots.length, 0); assert.equal(content.sent.some(m => m.type === 'AREX_RESULT_ACK'), false);
  assert.ok(popup.sent.some(m => m.job?.status === 'error' && /too large/i.test(m.job.error)));
});

test('a popup that disconnects during restore is not subscribed afterwards', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const { captured } = setup({ sessionGet: async () => { await gate; return { arexJobs: [] }; } });
  const popup = makePort('AREX_POPUP'); captured.onConnect(popup);
  const hello = popup.emit({ type: 'AREX_HELLO', tabId: 95 });
  popup.disconnect(); release(); await hello;
  assert.equal(popup.sent.length, 0);
  const content = makePort('AREX_JOB', { tab: { id: 95 } }); captured.onConnect(content);
  await content.emit({ type: 'AREX_JOB_START' });
  assert.equal(popup.sent.length, 0);
});

test('UTF-16 surrogate pair split across chunks is assembled before byte verification', async () => {
  const { captured, savedSnapshots } = setup();
  const content = makePort('AREX_JOB', { tab: { id: 92 } }); captured.onConnect(content);
  await content.emit({ type: 'AREX_JOB_START' });
  await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 0, data: 'text \ud83c' });
  await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 1, data: '\udf0d' });
  await content.emit({ type: 'AREX_RESULT_END', ok: true, bytes: new TextEncoder().encode('text 🌍').length });
  await waitUntil(() => savedSnapshots.length === 1);
  assert.equal(savedSnapshots[0].markdown, 'text 🌍');
  assert.ok(content.sent.some(m => m.type === 'AREX_RESULT_ACK'));
});

test('stale port disconnection does not fail a newer job connection', async () => {
  const clock = { now: 100 }, delayed = [];
  const { captured } = setup({ clock, delayedDisconnects: delayed });
  const popup = makePort('AREX_POPUP'); captured.onConnect(popup); await popup.emit({ type: 'AREX_HELLO', tabId: 101 });
  const first = makePort('AREX_JOB', { tab: { id: 101 } }); captured.onConnect(first); await first.emit({ type: 'AREX_JOB_START' });
  const second = makePort('AREX_JOB', { tab: { id: 101 } }); captured.onConnect(second); await second.emit({ type: 'AREX_JOB_START', resumed: true });
  clock.now += 10000; first.disconnect();
  assert.equal(delayed.length, 0);
  assert.equal(popup.sent.some(m => m.job?.status === 'error'), false);
  await second.emit({ type: 'AREX_PROGRESS', stage: 'history', loaded: 3 });
  assert.ok(popup.sent.some(m => m.type === 'AREX_PROGRESS' && m.loaded === 3));
});

test('a disconnected job with no reconnection eventually fails instead of spinning forever', async () => {
  const clock = { now: 100 }, delayed = [];
  const { captured } = setup({ clock, delayedDisconnects: delayed });
  const popup = makePort('AREX_POPUP'); captured.onConnect(popup); await popup.emit({ type: 'AREX_HELLO', tabId: 102 });
  const content = makePort('AREX_JOB', { tab: { id: 102 } }); captured.onConnect(content); await content.emit({ type: 'AREX_JOB_START' });
  content.disconnect(); assert.equal(delayed.length, 1);
  clock.now += 6000; delayed[0]();
  assert.ok(popup.sent.some(m => m.job?.status === 'error' && /lost contact/i.test(m.job.error)));
});
