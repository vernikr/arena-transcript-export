import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';

const backgroundSource = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const resultStoreSource = readFileSync(new URL('../extension/shared/result-store.js', import.meta.url), 'utf8');

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

function createMockResultStore() {
  return {
    saved: [],
    savedScopes: [],
    savedLogs: [],
    async saveForScope(scope, snapshot, options = {}) {
      const entry = { scope: { ...scope }, snapshot: { ...snapshot }, options: { ...options } };
      this.saved.push(snapshot);
      this.savedScopes.push(entry);
      return {
        filename: snapshot.filename,
        bytes: snapshot.bytes,
        stats: snapshot.stats,
        warnings: snapshot.warnings || [],
        createdAt: snapshot.createdAt,
        tabId: scope?.tabId ?? snapshot.tabId ?? null,
        chatUuid: scope?.chatUuid ?? snapshot.chatUuid ?? null,
        sourceUrl: snapshot.sourceUrl || null,
        partial: Boolean(options.partial),
        completedMessages: snapshot.completedMessages ?? null,
        totalMessages: snapshot.totalMessages ?? null,
      };
    },
    async saveDiagnosticLog(scope, logBundle) {
      const record = { scope: { ...scope }, log: { ...logBundle } };
      this.savedLogs.push(record);
      return record;
    },
    async save(snapshot) { this.saved.push(snapshot); return { filename: snapshot.filename }; },
    async load() { return this.saved.at(-1) || null; },
    async loadMeta() { const latest = this.saved.at(-1); return latest ? { filename: latest.filename } : null; },
    async clear() {},
  };
}

function setup({ initialSession = {}, sessionGet, resultStore, useRealResultStore = false, omitTextEncoder = false, clock, delayedDisconnects } = {}) {
  const captured = { onConnect: null, onRemoved: null, onUpdated: null };
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
    URL,
    ...(omitTextEncoder ? {} : { TextEncoder }),
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  if (useRealResultStore) {
    sandbox.indexedDB = new IDBFactory();
    vm.runInContext(resultStoreSource, sandbox, { filename: 'result-store.js' });
  } else {
    sandbox.AREX_RESULT_STORE = resultStore || createMockResultStore();
  }
  vm.runInContext(backgroundSource, sandbox, { filename: 'background.js' });
  return {
    captured,
    store: sandbox.AREX_RESULT_STORE,
    savedSnapshots: sandbox.AREX_RESULT_STORE.saved,
    sessionData,
    injected,
    chrome,
  };
}

test('job port → popup relay: progress, chunked result persisted to IndexedDB, ACK back to tab', async () => {
  const { captured, store, savedSnapshots, sessionData } = setup();
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

  await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 1, totalChunks: 2, data: ' world' });
  await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 0, totalChunks: 2, data: '# Hello' });
  assert.ok(popup.sent.some(m => m.type === 'AREX_PROGRESS' && m.stage === 'saving' && m.receivedChunks === 2 && m.totalChunks === 2));
  await content.emit({ type: 'AREX_RESULT_END', ok: true, filename: 'arena-x.md', stats: { messages: 3, expandedSpoilers: 2 }, warnings: [], bytes: 13, createdAt: 111 });

  await waitUntil(() => savedSnapshots.length === 1);
  assert.equal(savedSnapshots[0].markdown, '# Hello world', 'chunks are reassembled in order');
  assert.equal(savedSnapshots[0].filename, 'arena-x.md');
  assert.equal(savedSnapshots[0].tabId, 7);
  assert.equal(savedSnapshots[0].chatUuid, 'abc123');
  assert.equal(savedSnapshots[0].sourceUrl, 'https://arena.ai/agent/abc123');
  assert.deepEqual(store.savedScopes[0].scope, { tabId: 7, chatUuid: 'abc123' });
  assert.equal(store.savedScopes[0].options.partial, false);
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

test('128 Mi code-unit guard allows >64 Mi exports and rejects >128 Mi transfers even if later chunks arrive', async () => {
  // 1) 70 Mi chars (> old 64 Mi limit, <= new 128 Mi limit) succeeds cleanly.
  {
    const { captured, savedSnapshots } = setup();
    const content = makePort('AREX_JOB', { tab: { id: 80 } }); captured.onConnect(content);
    await content.emit({ type: 'AREX_JOB_START', chatUuid: 'big-70m', sourceUrl: 'https://arena.ai/agent/big-70m' });
    const chunk35M = 'a'.repeat(35 * 1024 * 1024);
    await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 0, totalChunks: 2, data: chunk35M });
    await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 1, totalChunks: 2, data: chunk35M });
    await content.emit({ type: 'AREX_RESULT_END', ok: true, filename: 'large.md', bytes: 70 * 1024 * 1024 });
    await waitUntil(() => savedSnapshots.length === 1);
    assert.equal(savedSnapshots[0].bytes, 70 * 1024 * 1024);
    assert.ok(content.sent.some(m => m.type === 'AREX_RESULT_ACK'));
  }

  // 2) >128 Mi chars fails immediately and ignores trailing chunks / end.
  {
    const { captured, savedSnapshots } = setup();
    const content = makePort('AREX_JOB', { tab: { id: 81 } }); captured.onConnect(content);
    const popup = makePort('AREX_POPUP'); captured.onConnect(popup); await popup.emit({ type: 'AREX_HELLO', tabId: 81 });
    await content.emit({ type: 'AREX_JOB_START' });
    const chunk64M = 'x'.repeat(64 * 1024 * 1024);
    await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 0, data: chunk64M });
    await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 1, data: chunk64M + 'x' });
    await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 2, data: 'partial' });
    await content.emit({ type: 'AREX_RESULT_END', ok: true, bytes: 7 });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(savedSnapshots.length, 0); assert.equal(content.sent.some(m => m.type === 'AREX_RESULT_ACK'), false);
    assert.ok(popup.sent.some(m => m.job?.status === 'error' && /too large/i.test(m.job.error)));
  }
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

test('UTF-16 surrogate pair split across chunks is assembled before byte verification without TextEncoder', async () => {
  const { captured, savedSnapshots } = setup({ omitTextEncoder: true });
  const content = makePort('AREX_JOB', { tab: { id: 92 } }); captured.onConnect(content);
  await content.emit({ type: 'AREX_JOB_START' });
  await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 0, data: 'text \ud83c' });
  await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 1, data: '\udf0d — кириллица — \ud83d' });
  await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 2, data: '\ude80 + lone:\ud800!' });
  const expected = 'text 🌍 — кириллица — 🚀 + lone:\ud800!';
  const expectedBytes = Buffer.byteLength(expected, 'utf8');
  await content.emit({ type: 'AREX_RESULT_END', ok: true, bytes: expectedBytes });
  await waitUntil(() => savedSnapshots.length === 1);
  assert.equal(savedSnapshots[0].markdown, expected);
  assert.equal(savedSnapshots[0].bytes, expectedBytes);
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

test('SPA /agent/A -> /agent/B navigation aborts in-flight scan A and never serves A status to B', async () => {
  const { captured, savedSnapshots, chrome } = setup();
  const cancelMessages = [];
  chrome.tabs.sendMessage = (tabId, message, cb) => {
    if (message?.type === 'AREX_EXPORT_CANCEL') cancelMessages.push(tabId);
    cb?.(message?.type === 'AREX_PING' ? { ok: true, featureVersion: '0.4.1' } : undefined);
  };

  const watchingA = makePort('AREX_POPUP');
  captured.onConnect(watchingA);
  await watchingA.emit({ type: 'AREX_HELLO', tabId: 15, chatUuid: 'branch-a', tabUrl: 'https://arena.ai/agent/branch-a' });

  // Same-branch query-string updates do NOT abort the active scan.
  const content = makePort('AREX_JOB', { tab: { id: 15 } });
  captured.onConnect(content);
  await content.emit({ type: 'AREX_JOB_START', chatUuid: 'branch-a', sourceUrl: 'https://arena.ai/agent/branch-a' });
  captured.onUpdated(15, { url: 'https://arena.ai/agent/branch-a?panel=files' });
  assert.equal(content.sent.some(m => m.type === 'AREX_EXPORT_CANCEL'), false);

  // Client-side SPA switch to /agent/branch-b aborts scan A immediately.
  captured.onUpdated(15, { url: 'https://arena.ai/agent/branch-b' });
  assert.ok(content.sent.some(m => m.type === 'AREX_EXPORT_CANCEL'), 'content port receives cancel signal');
  assert.ok(cancelMessages.includes(15), 'tabs.sendMessage also receives cancel');
  assert.ok(watchingA.sent.some(m =>
    m.type === 'AREX_STATUS' &&
    m.job?.status === 'error' &&
    /different Arena conversation/i.test(m.job?.error || '')
  ));
  watchingA.disconnect();

  // Trailing chunks or end messages from A on the reused SPA port are ignored.
  await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 0, data: '# stale A' });
  await content.emit({ type: 'AREX_RESULT_END', ok: true, filename: 'stale-a.md', bytes: 9 });
  await new Promise(r => setTimeout(r, 15));
  assert.equal(savedSnapshots.length, 0);

  // Opening the popup on /agent/branch-b starts completely clean (even without chatUuid, and with chatUuid).
  const popupB1 = makePort('AREX_POPUP');
  captured.onConnect(popupB1);
  await popupB1.emit({ type: 'AREX_HELLO', tabId: 15 });
  assert.equal(popupB1.sent.find(m => m.type === 'AREX_STATUS').job, null);
  popupB1.disconnect();

  const popupB2 = makePort('AREX_POPUP');
  captured.onConnect(popupB2);
  await popupB2.emit({ type: 'AREX_HELLO', tabId: 15, chatUuid: 'branch-b', tabUrl: 'https://arena.ai/agent/branch-b' });
  assert.equal(popupB2.sent.find(m => m.type === 'AREX_STATUS').job, null);
  await popupB2.emit({ type: 'AREX_GET_STATUS', tabId: 15, chatUuid: 'branch-b', tabUrl: 'https://arena.ai/agent/branch-b' });
  assert.equal(popupB2.sent.at(-1).job, null);

  // Starting a new export for branch-b on the same SPA port succeeds cleanly.
  await content.emit({ type: 'AREX_JOB_START', chatUuid: 'branch-b', sourceUrl: 'https://arena.ai/agent/branch-b' });
  await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 0, data: '# Branch B' });
  await content.emit({ type: 'AREX_RESULT_END', ok: true, filename: 'branch-b.md', bytes: 10 });
  await waitUntil(() => savedSnapshots.length === 1);
  assert.equal(savedSnapshots[0].chatUuid, 'branch-b');
  assert.equal(savedSnapshots[0].markdown, '# Branch B');
});

test('finished job is detached on SPA branch switch via onUpdated or AREX_HELLO tabUrl validation', async () => {
  const { captured, savedSnapshots } = setup();
  const content = makePort('AREX_JOB', { tab: { id: 16 } });
  captured.onConnect(content);
  await content.emit({ type: 'AREX_JOB_START', chatUuid: 'conv-1', sourceUrl: 'https://arena.ai/agent/conv-1' });
  await content.emit({ type: 'AREX_RESULT_END', ok: true, markdown: '# Conv 1', filename: 'conv-1.md', bytes: 8 });
  await waitUntil(() => savedSnapshots.length === 1);

  // Even before tabs.onUpdated fires, AREX_HELLO with conv-2's URL detaches conv-1's job.
  const popup = makePort('AREX_POPUP');
  captured.onConnect(popup);
  await popup.emit({ type: 'AREX_HELLO', tabId: 16, tabUrl: 'https://arena.ai/agent/conv-2' });
  assert.equal(popup.sent.find(m => m.type === 'AREX_STATUS').job, null);
});

test('Tab A vs Tab B status & real IndexedDB result-store v2 isolation', async () => {
  const { captured, store } = setup({ useRealResultStore: true });

  const popupA = makePort('AREX_POPUP'); captured.onConnect(popupA);
  const popupB = makePort('AREX_POPUP'); captured.onConnect(popupB);
  await popupA.emit({ type: 'AREX_HELLO', tabId: 1, chatUuid: 'branch-a', tabUrl: 'https://arena.ai/agent/branch-a' });
  await popupB.emit({ type: 'AREX_HELLO', tabId: 2, chatUuid: 'branch-b', tabUrl: 'https://arena.ai/agent/branch-b' });

  const contentA = makePort('AREX_JOB', { tab: { id: 1 } }); captured.onConnect(contentA);
  await contentA.emit({ type: 'AREX_JOB_START', chatUuid: 'branch-a', sourceUrl: 'https://arena.ai/agent/branch-a' });
  await contentA.emit({ type: 'AREX_PROGRESS', stage: 'process', processedMessages: 3, totalMessages: 4, percent: 75 });
  await contentA.emit({
    type: 'AREX_RESULT_END',
    ok: true,
    markdown: '# Transcript A',
    filename: 'arena-a.md',
    stats: { messages: 4, expandedSpoilers: 1 },
    bytes: 14,
    profile: { profileVersion: 1, durationMs: 420, outcome: 'done' },
  });

  await waitUntil(() => contentA.sent.some(m => m.type === 'AREX_RESULT_ACK'));
  assert.ok(popupA.sent.some(m => m.type === 'AREX_STATUS' && m.job?.status === 'done' && m.job?.chatUuid === 'branch-a'));
  assert.equal(popupB.sent.filter(m => m.type === 'AREX_PROGRESS').length, 0, 'Tab B never sees Tab A progress');
  assert.equal(popupB.sent.filter(m => m.type === 'AREX_STATUS' && m.job !== null).length, 0, 'Tab B never sees Tab A status');

  assert.equal((await store.loadForTab(1, 'branch-a'))?.markdown, '# Transcript A');
  assert.equal(await store.loadForTab(2, 'branch-b'), null, 'Tab B scoped store remains clean');
  assert.equal(await store.loadForTab(1, 'branch-b'), null, 'Same-tab branch switch never leaks branch-a');
});

test('stopping an export with partial chunks transitions job to stopped, persists scoped partial snapshot, and ACKs tab', async () => {
  const { captured, store } = setup({ useRealResultStore: true });

  const popup = makePort('AREX_POPUP'); captured.onConnect(popup);
  await popup.emit({ type: 'AREX_HELLO', tabId: 33, chatUuid: 'partial-branch', tabUrl: 'https://arena.ai/agent/partial-branch' });

  const content = makePort('AREX_JOB', { tab: { id: 33 } }); captured.onConnect(content);
  await content.emit({ type: 'AREX_JOB_START', chatUuid: 'partial-branch', sourceUrl: 'https://arena.ai/agent/partial-branch' });
  await popup.emit({ type: 'AREX_EXPORT_CANCEL', tabId: 33 });
  assert.ok(content.sent.some(m => m.type === 'AREX_EXPORT_CANCEL'));

  const part0 = '# Arena Transcript (Partial)\n\n';
  const part1 = '## Message 1\nHello\n\n## Message 2\nWorld\n';
  const fullPartial = part0 + part1;
  await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 1, totalChunks: 2, data: part1 });
  await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 0, totalChunks: 2, data: part0 });
  await content.emit({
    type: 'AREX_RESULT_END',
    ok: true,
    outcome: 'partial',
    partial: true,
    completedMessages: 2,
    totalMessages: 9,
    filename: 'arena-partial-branch-partial.md',
    stats: { messages: 2, expandedSpoilers: 4 },
    warnings: ['Stopped after 2/9 messages.'],
    bytes: Buffer.byteLength(fullPartial, 'utf8'),
    profile: { profileVersion: 2, outcome: 'cancelled_partial', durationMs: 912.4 },
  });

  await waitUntil(() => content.sent.some(m => m.type === 'AREX_RESULT_ACK'));
  const ack = content.sent.find(m => m.type === 'AREX_RESULT_ACK');
  assert.equal(ack.partial, true);

  const stoppedMsg = popup.sent.findLast(m => m.type === 'AREX_STATUS');
  assert.equal(stoppedMsg.job.status, 'stopped');
  assert.equal(stoppedMsg.job.error, null);
  assert.equal(stoppedMsg.job.resultMeta.partial, true);
  assert.equal(stoppedMsg.job.resultMeta.completedMessages, 2);
  assert.equal(stoppedMsg.job.resultMeta.totalMessages, 9);

  const savedSnap = await store.loadForTab(33, 'partial-branch');
  const savedMeta = await store.loadMetaForTab(33, 'partial-branch');
  assert.equal(savedSnap.markdown, fullPartial);
  assert.equal(savedSnap.partial, true);
  assert.equal(savedMeta.partial, true);
  assert.equal(savedMeta.completedMessages, 2);
  assert.equal(savedMeta.totalMessages, 9);
});

test('AREX_EXPORT_LOG merges live v2 profiler snapshot and coordinator chunk state across running and finalizing states', async () => {
  let releaseSave;
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  const baseStore = createMockResultStore();
  const origSaveForScope = baseStore.saveForScope.bind(baseStore);
  baseStore.saveForScope = async (...args) => { await saveGate; return origSaveForScope(...args); };

  const { captured, store, chrome } = setup({ resultStore: baseStore });
  const liveSnapshot = {
    profileVersion: 2,
    tool: 'arena-transcript-export',
    chatUuid: 'live-chat',
    durationMs: 3450.5,
    outcome: 'running',
    inFlight: { span: { name: 'expand', elapsedMs: 620 }, cursor: { stage: 'process', windowIndex: 3 } },
  };
  chrome.tabs.sendMessage = (_tabId, msg, cb) => {
    if (msg?.type === 'AREX_DUMP_LOG') {
      cb({
        ok: true,
        status: 'running',
        progress: [
          { stage: 'history', pages: 3, loaded: 60 },
          { stage: 'process', processedMessages: 12, totalMessages: 20, percent: 60 },
        ],
        profile: liveSnapshot,
      });
      return;
    }
    cb?.();
  };

  const popup = makePort('AREX_POPUP'); captured.onConnect(popup);
  await popup.emit({ type: 'AREX_HELLO', tabId: 50, chatUuid: 'live-chat', tabUrl: 'https://arena.ai/agent/live-chat' });

  // 1) Idle log export works before any job starts.
  chrome.tabs.sendMessage = (_tabId, _msg, cb) => cb?.(undefined);
  await popup.emit({ type: 'AREX_EXPORT_LOG', tabId: 50, requestId: 'req-idle' });
  const idleReply = popup.sent.find(m => m.type === 'AREX_LOG_BUNDLE' && m.requestId === 'req-idle');
  assert.equal(idleReply.ok, true);
  assert.equal(idleReply.bundle.coordinator.status, 'idle');

  // 2) Live running log export merges content snapshot + coordinator chunk telemetry.
  chrome.tabs.sendMessage = (_tabId, msg, cb) => {
    if (msg?.type === 'AREX_DUMP_LOG') {
      cb({
        ok: true,
        status: 'running',
        progress: [
          { stage: 'history', pages: 3, loaded: 60 },
          { stage: 'process', processedMessages: 12, totalMessages: 20, percent: 60 },
        ],
        profile: liveSnapshot,
      });
      return;
    }
    cb?.();
  };
  const content = makePort('AREX_JOB', { tab: { id: 50 } }); captured.onConnect(content);
  await content.emit({ type: 'AREX_JOB_START', chatUuid: 'live-chat', sourceUrl: 'https://arena.ai/agent/live-chat' });
  await content.emit({ type: 'AREX_PROGRESS', stage: 'process', processedMessages: 8, totalMessages: 20, percent: 40 });
  await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 0, totalChunks: 2, data: 'hello ' });

  await popup.emit({ type: 'AREX_EXPORT_LOG', tabId: 50, requestId: 'req-running' });
  const runReply = popup.sent.find(m => m.type === 'AREX_LOG_BUNDLE' && m.requestId === 'req-running');
  assert.equal(runReply.ok, true);
  assert.equal(runReply.timedOut, false);
  assert.equal(runReply.bundle.tab.responded, true);
  assert.equal(runReply.bundle.profile.profileVersion, 2);
  assert.equal(runReply.bundle.coordinator.status, 'running');
  assert.equal(runReply.bundle.coordinator.receivedChunks, 1);
  assert.equal(runReply.bundle.coordinator.totalChunks, 2);
  assert.equal(runReply.bundle.coordinator.receivedChars, 6);
  assert.equal(store.savedLogs.length >= 2, true);

  // 3) Finalizing state (while IndexedDB commit is in flight) preserves transfer stats.
  await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 1, totalChunks: 2, data: 'world' });
  await content.emit({
    type: 'AREX_RESULT_END',
    ok: true,
    filename: 'live.md',
    bytes: 11,
    profile: { profileVersion: 1, durationMs: 4000, outcome: 'done' },
  });
  await popup.emit({ type: 'AREX_EXPORT_LOG', tabId: 50, requestId: 'req-finalizing' });
  const finReply = popup.sent.find(m => m.type === 'AREX_LOG_BUNDLE' && m.requestId === 'req-finalizing');
  assert.equal(finReply.bundle.status, 'finalizing');
  assert.equal(finReply.bundle.coordinator.finalizing, true);
  assert.equal(finReply.bundle.coordinator.receivedChunks, 2);
  assert.equal(finReply.bundle.coordinator.receivedChars, 11);

  releaseSave();
  await waitUntil(() => content.sent.some(m => m.type === 'AREX_RESULT_ACK'));
});

test('AREX_EXPORT_LOG falls back within <= 1.3 s when the Arena tab main thread is completely frozen', async () => {
  const { captured, store, chrome } = setup({ useRealResultStore: true });
  // Simulate a completely wedged main thread: tabs.sendMessage never calls its callback,
  // and AREX_JOB port never answers AREX_DUMP_LOG.
  chrome.tabs.sendMessage = () => {};

  const content = makePort('AREX_JOB', { tab: { id: 77 } }); captured.onConnect(content);
  await content.emit({ type: 'AREX_JOB_START', chatUuid: 'frozen-chat', sourceUrl: 'https://arena.ai/agent/frozen-chat' });
  await content.emit({ type: 'AREX_PROGRESS', stage: 'process', processedMessages: 99, totalMessages: 100, percent: 99 });
  await content.emit({ type: 'AREX_RESULT_CHUNK', seq: 0, totalChunks: 3, data: 'chunk-zero' });

  const popup = makePort('AREX_POPUP'); captured.onConnect(popup);
  await popup.emit({ type: 'AREX_HELLO', tabId: 77, chatUuid: 'frozen-chat', tabUrl: 'https://arena.ai/agent/frozen-chat' });

  const t0 = Date.now();
  await popup.emit({ type: 'AREX_EXPORT_LOG', tabId: 77, requestId: 'wedged-1' });
  const elapsedMs = Date.now() - t0;

  const logReply = popup.sent.find(m => m.type === 'AREX_LOG_BUNDLE' && m.requestId === 'wedged-1');
  assert.ok(logReply, 'AREX_LOG_BUNDLE reply emitted');
  assert.ok(elapsedMs <= 1300, `Expected <= 1300 ms fallback, got ${elapsedMs} ms`);
  assert.equal(logReply.timedOut, true);
  assert.equal(logReply.bundle.tab.responded, false);
  assert.equal(logReply.bundle.tab.timedOut, true);
  assert.match(logReply.bundle.tab.notice, /1200 ms/);
  assert.equal(logReply.bundle.coordinator.status, 'running');
  assert.equal(logReply.bundle.coordinator.receivedChunks, 1);
  assert.equal(logReply.bundle.coordinator.receivedChars, 10);
  assert.ok(logReply.bundle.progress.some(p => p.processedMessages === 99));

  const persisted = await store.loadDiagnosticLog(77, 'frozen-chat');
  assert.equal(persisted.tab.timedOut, true);
  assert.equal(persisted.coordinator.receivedChunks, 1);
});

test('AREX_EXPORT_LOG resolves via AREX_JOB port when tabs.sendMessage returns undefined, and throttles session writes', async () => {
  let sessionWrites = 0;
  const sessionData = {};
  const base = setup();
  base.chrome.storage.session.set = async obj => { sessionWrites += 1; Object.assign(sessionData, obj); };

  const content = makePort('AREX_JOB', { tab: { id: 88 } });
  const origPost = content.postMessage.bind(content);
  content.postMessage = message => {
    origPost(message);
    if (message?.type === 'AREX_DUMP_LOG') {
      queueMicrotask(() => {
        void content.emit({
          type: 'AREX_DUMP_LOG_RESULT',
          requestId: message.requestId,
          ok: true,
          status: 'running',
          progress: [{ stage: 'process', processedMessages: 5, totalMessages: 10, percent: 50 }],
          profile: { profileVersion: 2, outcome: 'running', durationMs: 500 },
        });
      });
    }
  };
  base.captured.onConnect(content);
  await content.emit({ type: 'AREX_JOB_START', chatUuid: 'port-log', sourceUrl: 'https://arena.ai/agent/port-log' });
  const writesAfterStart = sessionWrites;
  for (let i = 1; i <= 15; i += 1) {
    await content.emit({ type: 'AREX_PROGRESS', stage: 'process', processedMessages: i, totalMessages: 20, percent: i * 5 });
  }
  assert.equal(sessionWrites, writesAfterStart, 'burst progress events are throttled instead of writing synchronously on each tick');

  const popup = makePort('AREX_POPUP');
  base.captured.onConnect(popup);
  await popup.emit({ type: 'AREX_HELLO', tabId: 88, chatUuid: 'port-log', tabUrl: 'https://arena.ai/agent/port-log' });
  await popup.emit({ type: 'AREX_EXPORT_LOG', tabId: 88, requestId: 'port-1' });

  const reply = popup.sent.find(m => m.type === 'AREX_LOG_BUNDLE' && m.requestId === 'port-1');
  assert.equal(reply.ok, true);
  assert.equal(reply.timedOut, false);
  assert.equal(reply.bundle.tab.via, 'jobPort');
  assert.equal(reply.bundle.profile.profileVersion, 2);
});

