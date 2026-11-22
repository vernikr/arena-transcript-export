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

function setup() {
  const captured = { onConnect: null, onRemoved: null, onUpdated: null };
  const savedSnapshots = [];
  const sessionData = {};
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
        async get(key) { return { [key]: sessionData[key] }; },
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
    setTimeout, clearTimeout, setInterval, clearInterval,
    TextEncoder, URL,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  // Stub the IndexedDB-backed store instead of touching real IndexedDB.
  vm.runInContext(
    'globalThis.AREX_RESULT_STORE = { ' +
      'saved: [], ' +
      'async save(snapshot) { this.saved.push(snapshot); return { filename: snapshot.filename }; }, ' +
      'async load() { return this.saved.at(-1) || null; }, ' +
      'async loadMeta() { const l = this.saved.at(-1); return l ? { filename: l.filename } : null; }, ' +
      'async clear() {} };',
    sandbox,
  );
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
