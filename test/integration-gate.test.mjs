// Wave 4.1 end-to-end integration gate.
//
// Unlike the per-module suites, this file wires the real content-script
// boundary, the real background coordinator (extension/background.js) and the
// real scoped result store (extension/shared/result-store.js on fake-indexeddb)
// into one process, then walks the cross-module matrix from issue #24:
//
//   Tab A (branch-1 done) + Tab B (branch-2 idle/running/stopped) + Tab C
//   (https://example.com, non-Arena), same-tab SPA navigation, Stop during
//   history paging vs Stop after K windows, and anytime AREX_EXPORT_LOG at
//   idle / running / stopped / error / done.
//
// It asserts the *contracts between modules* (scoping, ACK ordering, partial
// lifecycle, diagnostic bundle shape), not the internal behaviour of any one
// module — those stay covered by their own suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';

const source = name => readFileSync(new URL('../extension/' + name, import.meta.url), 'utf8');
const backgroundSource = source('background.js');
const resultStoreSource = source('shared/result-store.js');

const waitUntil = async (predicate, timeoutMs = 2500) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

// Mock of chrome.runtime.Port with directions kept apart, exactly like Chrome:
//   emit(message)      — tab/popup -> extension  (only the extension listener runs)
//   postMessage(msg)   — extension -> tab/popup  (recorded in `sent`, observed by `received`)
//   observe(fn)        — test-side observer for messages the extension sends back
// Sharing one listener list for both directions (as a naive mock does) makes the
// test read its own outbound traffic as if it were the coordinator's replies.
function makePort(name, sender = null) {
  const listeners = [];
  const observers = [];
  const disconnectListeners = [];
  return {
    name,
    sender,
    sent: [],
    onMessage: { addListener(fn) { listeners.push(fn); } },
    onDisconnect: { addListener(fn) { disconnectListeners.push(fn); } },
    observe(fn) { observers.push(fn); },
    postMessage(message) {
      this.sent.push(message);
      for (const fn of observers) fn(message);
    },
    async emit(message) { await Promise.all(listeners.map(fn => fn(message))); },
    disconnect() { for (const fn of disconnectListeners) fn(); },
  };
}

// Boots background.js with a shared in-memory chrome.storage.session, the real
// v2 result store on a fresh IndexedDB, and a controllable tabs layer.
function bootCoordinator({ session = {}, tabs = new Map(), tabUrls = new Map(), indexedDB = new IDBFactory() } = {}) {
  const captured = { onConnect: null, onUpdated: null, onRemoved: null };
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
        async get(key) { if (key == null) return { ...session }; return { [key]: session[key] }; },
        async set(values) { Object.assign(session, values); },
      },
    },
    tabs: {
      onUpdated: { addListener(fn) { captured.onUpdated = fn; } },
      onRemoved: { addListener(fn) { captured.onRemoved = fn; } },
      query: async query => [...tabs.values()].filter(tab =>
        (!query?.url || query.url === tab.url) && (query?.active === undefined || tab.active === query.active)),
      sendMessage(tabId, message, callback) {
        const tab = tabs.get(tabId);
        if (!tab) { callback?.(undefined); return; }
        callback?.(tab.onMessage ? tab.onMessage(message) : undefined);
      },
    },
    scripting: { executeScript: async ({ target, files }) => { injected.push({ target, files }); } },
  };
  const sandbox = { chrome, console, setTimeout, clearTimeout, setInterval, clearInterval, Date, URL, TextEncoder };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.indexedDB = indexedDB;
  vm.createContext(sandbox);
  vm.runInContext(resultStoreSource, sandbox, { filename: 'result-store.js' });
  vm.runInContext(backgroundSource, sandbox, { filename: 'background.js' });

  const openPort = (name, tabId = null, url = null) => {
    const port = makePort(name, tabId === null ? null : { tab: { id: tabId, url: url || tabUrls.get(tabId) } });
    captured.onConnect(port);
    return port;
  };
  return { sandbox, store: sandbox.AREX_RESULT_STORE, captured, chrome, openPort, injected, session };
}

// One content-script "tab": emits the same messages main.js posts and records
// what the coordinator sends back, including ACKs.
function makeContentTab(port, tabId, chatUuid, url) {
  const state = { port, tabId, chatUuid, url, acked: 0, statuses: [] };
  port.observe(message => {
    if (message?.type === 'AREX_RESULT_ACK') state.acked += 1;
    if (message?.type === 'AREX_EXPORT_CANCEL') state.cancelled = true;
    state.statuses.push(message);
  });
  state.hello = () => port.emit({ type: 'AREX_HELLO', tabId, chatUuid, tabUrl: url });
  state.start = options => port.emit({
    type: 'AREX_JOB_START', chatUuid, sourceUrl: url, startedAt: Date.now(), progress: [], options: options || {},
  });
  state.streamResult = async (markdown, { filename = `capture-${chatUuid}.md`, extra = {} } = {}) => {
    const bytes = new TextEncoder().encode(markdown).length;
    const chunks = [];
    for (let i = 0; i < markdown.length; i += 512) chunks.push(markdown.slice(i, i + 512));
    for (let i = 0; i < chunks.length; i += 1) {
      await port.emit({
        type: 'AREX_RESULT_CHUNK', seq: i, total: chunks.length, data: chunks[i],
        bytes, filename, stats: { messages: 2, expandedSpoilers: 3 }, warnings: [], ...extra,
      });
    }
    await port.emit({
      type: 'AREX_RESULT_END', ok: true, filename, bytes, chunks: chunks.length,
      stats: { messages: 2, expandedSpoilers: 3 }, warnings: [], ...extra,
    });
    return { chunks: chunks.length, bytes };
  };
  return state;
}

function attachContentTab(ctx, tabId, chatUuid, url) {
  // openPort registers this exact port object with the coordinator, so ACKs
  // and cancels land on the same instance the test observes.
  return makeContentTab(ctx.openPort('AREX_JOB', tabId, url), tabId, chatUuid, url);
}

const askPopup = async (ctx, message) => {
  const port = ctx.openPort('AREX_POPUP', null);
  await port.emit(message);
  return port;
};

// The most recent AREX_STATUS reply, or null when the port got none at all.
// chrome.tabs.onUpdated(tabId, changeInfo, tab) for an SPA URL change.
const capturedUpdate = (ctx, tabId, url, status = 'complete') =>
  ctx.captured.onUpdated?.(tabId, { url, status }, { id: tabId, url });

const lastStatus = port => {
  for (let i = port.sent.length - 1; i >= 0; i -= 1)
    if (port.sent[i].type === 'AREX_STATUS') return port.sent[i];
  return null;
};

test('tab-scoped isolation: A done, B idle/running/stopped, C non-Arena never mix snapshots', async () => {
  const ctx = bootCoordinator({ tabUrls: new Map([[1, 'https://arena.ai/agent/branch-1'], [2, 'https://arena.ai/agent/branch-2'], [3, 'https://example.com/']]) });
  const tabA = attachContentTab(ctx, 1, 'branch-1', 'https://arena.ai/agent/branch-1');

  // --- Tab A: full export -> done, persisted under (1, branch-1) -------------
  await tabA.hello();
  await tabA.start();
  const markdownA = '# Branch one\n\n## 👤 User\n\nA only\n';
  await tabA.streamResult(markdownA);
  await waitUntil(() => tabA.acked === 1);
  const snapshotA = await ctx.store.loadForTab(1, 'branch-1');
  assert.equal(snapshotA.markdown, markdownA, 'A persisted under its own scope');
  assert.equal(await ctx.store.loadForTab(2, 'branch-2'), null, 'A never leaks into tab B');
  assert.equal(await ctx.store.loadForTab(1, 'branch-2'), null, 'A never leaks into another branch of tab 1');

  // --- Tab B: idle first (popup opened, nothing exported yet) ----------------
  // A tab that never ran an export has no job port, so the popup gets `job: null`
  // — it must not inherit tab A's (or branch-1's) job.
  const popupB = await askPopup(ctx, { type: 'AREX_GET_STATUS', tabId: 2, chatUuid: 'branch-2' });
  assert.equal(lastStatus(popupB)?.job ?? null, null, 'idle tab reports no job');
  const branchOneOnTabOne = await askPopup(ctx, { type: 'AREX_GET_STATUS', tabId: 1, chatUuid: 'branch-2' });
  assert.equal(lastStatus(branchOneOnTabOne)?.job ?? null, null, 'same tab, other branch -> no job');

  // --- Tab B: running --------------------------------------------------------
  const tabB = attachContentTab(ctx, 2, 'branch-2', 'https://arena.ai/agent/branch-2');
  await tabB.hello();
  await tabB.start();
  await tabB.port.emit({ type: 'AREX_PROGRESS', stage: 'process', processedMessages: 1, totalMessages: 2, percent: 50 });
  const runningB = await askPopup(ctx, { type: 'AREX_GET_STATUS', tabId: 2, chatUuid: 'branch-2' });
  assert.equal(lastStatus(runningB).job.status, 'running');

  // --- Tab B: stopped with a partial snapshot --------------------------------
  const partialB = '# Branch two\n\n- Status: Partial export (1/2 messages)\n\n## 👤 User\n\nB partial\n';
  await tabB.streamResult(partialB, {
    filename: 'capture-branch-2-partial.md',
    extra: { partial: true, completedMessages: 1, totalMessages: 2 },
  });
  await waitUntil(() => tabB.acked === 1);
  const snapshotB = await ctx.store.loadForTab(2, 'branch-2');
  assert.equal(snapshotB.markdown, partialB);
  assert.equal(snapshotB.partial, true, 'partial flag survives persistence');
  assert.equal(snapshotB.completedMessages, 1);
  assert.equal(snapshotB.totalMessages, 2);
  assert.equal((await ctx.store.loadForTab(1, 'branch-1')).markdown, markdownA, 'A snapshot untouched by B');

  // --- Tab C: non-Arena tab cannot claim either snapshot ----------------------
  const popupC = await askPopup(ctx, { type: 'AREX_GET_STATUS', tabId: 3, chatUuid: null });
  assert.equal(lastStatus(popupC)?.job ?? null, null, 'non-Arena tab has no job');
  assert.equal(await ctx.store.loadForTab(3, null), null, 'non-Arena tab has no scoped snapshot');

  // One popup opened per tab sees exactly its own branch, in a single pass.
  const perTab = await Promise.all([
    askPopup(ctx, { type: 'AREX_GET_STATUS', tabId: 1, chatUuid: 'branch-1' }),
    askPopup(ctx, { type: 'AREX_GET_STATUS', tabId: 2, chatUuid: 'branch-2' }),
    askPopup(ctx, { type: 'AREX_GET_STATUS', tabId: 3, chatUuid: null }),
  ]);
  // Tab A finished, so its job was moved out of the live map; the scoped
  // IndexedDB snapshot — not the job — is what the popup restores from.
  const jobA = lastStatus(perTab[0])?.job ?? null, jobB = lastStatus(perTab[1])?.job ?? null;
  assert.notEqual(jobA?.status, 'running', 'tab A job is not reported as running');
  assert.equal(jobB?.chatUuid, 'branch-2');
  assert.equal(jobB?.status, 'stopped', 'tab B reports its partial state');
  assert.equal((await ctx.store.loadForTab(1, 'branch-1')).markdown, markdownA, 'A restored from its own scope');
  assert.equal((await ctx.store.loadForTab(2, 'branch-2')).markdown, partialB, 'B restored from its own scope');
  assert.equal(lastStatus(perTab[2])?.job ?? null, null, 'non-Arena tab still has no job');
});

test('same-tab SPA navigation /agent/branch-1 -> /agent/branch-2 aborts and re-scopes', async () => {
  const ctx = bootCoordinator({ tabUrls: new Map([[1, 'https://arena.ai/agent/branch-1']]) });
  const tab = attachContentTab(ctx, 1, 'branch-1', 'https://arena.ai/agent/branch-1');
  await tab.hello();
  await tab.start();
  await tab.port.emit({ type: 'AREX_PROGRESS', stage: 'history', percent: 5 });
  // The SPA router changed the URL; chrome.tabs.onUpdated fires for the same
  // tab with the new branch. The coordinator must cancel the in-flight scan A.
  capturedUpdate(ctx, 1, 'https://arena.ai/agent/branch-2');
  await waitUntil(() => tab.cancelled === true);
  assert.equal(tab.cancelled, true, 'in-flight scan A receives AREX_EXPORT_CANCEL');

  // The coordinator detaches the old branch: a fresh status roundtrip for the
  // new branch must not serve branch-1's job.
  const stale = await askPopup(ctx, { type: 'AREX_GET_STATUS', tabId: 1, chatUuid: 'branch-1' });
  const staleJob = lastStatus(stale).job;
  assert.ok(staleJob === null || staleJob.status !== 'running', 'branch-1 job is not still running');

  // Re-hello on branch-2 starts a clean scope; the old snapshot stays where it was.
  const tab2 = attachContentTab(ctx, 1, 'branch-2', 'https://arena.ai/agent/branch-2');
  await tab2.hello();
  await tab2.start();
  const status = await askPopup(ctx, { type: 'AREX_GET_STATUS', tabId: 1, chatUuid: 'branch-2' });
  assert.equal(lastStatus(status).job.chatUuid, 'branch-2');
  assert.equal(await ctx.store.loadForTab(1, 'branch-2'), null, 'branch-2 starts with no snapshot');
});

test('stop during history paging yields an empty-but-valid partial state, not a ready snapshot', async () => {
  const ctx = bootCoordinator({ tabUrls: new Map([[1, 'https://arena.ai/agent/branch-1']]) });
  const tab = attachContentTab(ctx, 1, 'branch-1', 'https://arena.ai/agent/branch-1');
  await tab.hello();
  await tab.start();
  await tab.port.emit({ type: 'AREX_PROGRESS', stage: 'history', phase: 'page', percent: 3 });
  // The content script aborts before any message was serialized: main.js reports
  // a cancelled job with no partial payload (completedMessages === 0).
  await tab.port.emit({ type: 'AREX_RESULT_END', ok: false, cancelled: true, error: 'Export cancelled.' });
  const status = await askPopup(ctx, { type: 'AREX_GET_STATUS', tabId: 1, chatUuid: 'branch-1' });
  const job = lastStatus(status).job;
  assert.equal(job.status, 'error', 'nothing captured -> cancelled, not a partial file');
  assert.equal(await ctx.store.loadForTab(1, 'branch-1'), null, 'no snapshot was written');
  assert.equal(tab.acked, 0, 'nothing to ACK');
});

test('stop after K windows persists exactly the serialized prefix and ACKs the tab', async () => {
  const ctx = bootCoordinator({ tabUrls: new Map([[1, 'https://arena.ai/agent/branch-1']]) });
  const tab = attachContentTab(ctx, 1, 'branch-1', 'https://arena.ai/agent/branch-1');
  await tab.hello();
  await tab.start();
  const prefix = '# Branch\n\n- Messages: 4\n\n## 👤 User\n\none\n\n## 🤖 Assistant\n\ntwo\n';
  await tab.streamResult(prefix, {
    filename: 'capture-branch-1-partial.md',
    extra: { partial: true, completedMessages: 4, totalMessages: 40 },
  });
  await waitUntil(() => tab.acked === 1);
  const snapshot = await ctx.store.loadForTab(1, 'branch-1');
  assert.equal(snapshot.markdown, prefix, 'the partial document is byte-exact');
  assert.equal(snapshot.completedMessages, 4);
  assert.equal(snapshot.totalMessages, 40);
  assert.equal(snapshot.partial, true);
  // The tab's own AREX_RESULT_END is what carried the partial payload; the
  // coordinator answers the same port with an ACK once the scoped write commits.
  const endMessage = tab.port.sent.find(message => message.type === 'AREX_RESULT_END');
  assert.equal(endMessage, undefined, 'the coordinator never echoes the tab ends message back');
  assert.ok(tab.statuses.some(message => message.type === 'AREX_RESULT_ACK' && message.partial === true),
    'ACK is marked partial');
});

test('anytime AREX_EXPORT_LOG answers at idle, running, stopped, error and done', async () => {
  const ctx = bootCoordinator({ tabUrls: new Map([[1, 'https://arena.ai/agent/branch-1']]) });
  const log = async () => {
    const port = await askPopup(ctx, { type: 'AREX_EXPORT_LOG', tabId: 1, chatUuid: 'branch-1', requestId: 'r-' + Math.random() });
    const reply = [...port.sent].reverse().find(message => message.type === 'AREX_LOG_BUNDLE');
    return { port, reply };
  };

  // idle: no job yet, but the bundle still answers with schema + coord state.
  const idle = await log();
  assert.ok(idle.reply, 'idle log request is answered');
  assert.equal(idle.reply.bundle.schemaVersion, 1);
  assert.equal(idle.reply.bundle.coordinator.status, 'idle');
  // No content script answered, so the bundle is still valid but explicitly
  // flags that tab-side status/profile data is missing.
  assert.equal(typeof idle.reply.bundle.tab.responded, 'boolean');

  // running
  const tab = attachContentTab(ctx, 1, 'branch-1', 'https://arena.ai/agent/branch-1');
  await tab.hello();
  await tab.start();
  await tab.port.emit({ type: 'AREX_PROGRESS', stage: 'process', processedMessages: 2, totalMessages: 10, percent: 20 });
  const running = await log();
  assert.ok(running.reply, 'running scan answers a log request');
  assert.equal(running.reply.bundle.schemaVersion, 1);
  assert.equal(running.reply.bundle.coordinator.status, 'running');
  assert.ok(Array.isArray(running.reply.bundle.progress) && running.reply.bundle.progress.length >= 1,
    'live progress is included');
  assert.equal(running.reply.bundle.toolVersion, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);

  // stopped (partial persisted)
  const partial = '# P\n\n## 🤖 Assistant\n\npartial\n';
  await tab.streamResult(partial, { filename: 'p.md', extra: { partial: true, completedMessages: 2, totalMessages: 10 } });
  await waitUntil(() => tab.acked === 1);
  const stopped = await log();
  assert.equal(stopped.reply.bundle.coordinator.status, 'stopped');
  assert.equal(stopped.reply.bundle.coordinator.resultMeta?.partial, true);
  assert.equal(stopped.reply.bundle.coordinator.resultMeta?.completedMessages, 2);
  assert.equal(stopped.reply.bundle.coordinator.resultMeta?.totalMessages, 10);

  // error on a fresh tab
  const errCtx = bootCoordinator({ tabUrls: new Map([[4, 'https://arena.ai/agent/branch-4']]) });
  const errTab = attachContentTab(errCtx, 4, 'branch-4', 'https://arena.ai/agent/branch-4');
  await errTab.hello();
  await errTab.start();
  await errTab.port.emit({ type: 'AREX_RESULT_END', ok: false, error: 'Transcript not found.' });
  const errPort = await askPopup(errCtx, { type: 'AREX_EXPORT_LOG', tabId: 4, chatUuid: 'branch-4', requestId: 'r-err' });
  const errReply = [...errPort.sent].reverse().find(message => message.type === 'AREX_LOG_BUNDLE');
  assert.equal(errReply.bundle.coordinator.status, 'error');
  assert.match(String(errReply.bundle.coordinator.error || ''), /Transcript not found/);

  // done on a third tab
  const doneCtx = bootCoordinator({ tabUrls: new Map([[5, 'https://arena.ai/agent/branch-5']]) });
  const doneTab = attachContentTab(doneCtx, 5, 'branch-5', 'https://arena.ai/agent/branch-5');
  await doneTab.hello();
  await doneTab.start();
  await doneTab.streamResult('# Done\n\nbody\n', { filename: 'done.md' });
  await waitUntil(() => doneTab.acked === 1);
  const donePort = await askPopup(doneCtx, { type: 'AREX_EXPORT_LOG', tabId: 5, chatUuid: 'branch-5', requestId: 'r-done' });
  const doneReply = [...donePort.sent].reverse().find(message => message.type === 'AREX_LOG_BUNDLE');
  assert.equal(doneReply.bundle.coordinator.status, 'done');
  assert.equal(doneReply.bundle.coordinator.resultMeta?.filename, 'done.md');
});

test('fixture export keeps byte-for-byte parity through the whole windowed pipeline', async () => {
  // The integration gate re-checks the committed snapshot at the topmost level
  // available in Node: full history -> windowed expand/serialize/collapse.
  const { makeEnv, fixtureHtml } = await import('./harness.mjs');
  const expected = readFileSync(new URL('./snapshots/fixture-expected.md', import.meta.url), 'utf8');
  const { AREX } = makeEnv({
    html: fixtureHtml(),
    url: 'https://arena.ai/agent/01a125f9-92b4-7e1a-a13a-b2e1bc5ffd61',
  });
  const normalize = text => text.replace(/^- Exported: .*$/m, '- Exported: <ts>');
  const result = await AREX.processMessagesInWindows(AREX.logEl(), {});
  assert.deepEqual(Buffer.from(normalize(result.markdown)), Buffer.from(expected));
  assert.equal(result.warnings.length, 0, 'a clean fixture exports with no warnings');
});
