import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';

const source = readFileSync(new URL('../extension/shared/result-store.js', import.meta.url), 'utf8');
function makeStore(indexedDB) {
  const context = vm.createContext({ indexedDB, TextEncoder, Date });
  vm.runInContext(source, context);
  return context.AREX_RESULT_STORE;
}

function makeSnapshot(overrides = {}) {
  return {
    markdown: '# Hello\n',
    filename: 'export.md',
    stats: { messages: 1, expandedSpoilers: 0 },
    warnings: [],
    createdAt: 1234,
    ...overrides,
  };
}

async function seedV1Database(indexedDB, { latest, meta, profile } = {}) {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('arena-transcript-export', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('snapshots', 'readwrite');
    const store = tx.objectStore('snapshots');
    if (latest !== undefined) store.put(latest, 'latest');
    if (meta !== undefined) store.put(meta, 'latest-meta');
    if (profile !== undefined) store.put(profile, 'latest-profile');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

test('IndexedDB-backed snapshot and metadata survive a fresh context, and clear atomically', async () => {
  const indexedDB = new IDBFactory();
  const background = makeStore(indexedDB), popup = makeStore(indexedDB);
  const markdown = '# Заголовок 🌍\n' + 'data\n'.repeat(10000);
  const snapshot = { markdown, filename: 'full.md', stats: { messages: 3, expandedSpoilers: 8 }, warnings: ['warning'], tabId: 7, chatUuid: 'abc', sourceUrl: 'https://arena.ai/agent/abc', createdAt: 1234 };
  await background.save(snapshot);
  const restored = await popup.load(), meta = await popup.loadMeta();
  assert.equal(restored.markdown, markdown); assert.equal(restored.filename, 'full.md');
  assert.equal(meta.bytes, new TextEncoder().encode(markdown).length); assert.equal(meta.tabId, 7);
  assert.equal(meta.stats.messages, 3); assert.equal(meta.sourceUrl, snapshot.sourceUrl);
  assert.equal('markdown' in meta, false);
  await popup.clear();
  assert.equal(await background.load(), undefined); assert.equal(await background.loadMeta(), null);
});

test('save rejects if IndexedDB is unavailable and remains retryable', async () => {
  const store = makeStore(undefined);
  await assert.rejects(store.save({ markdown: 'x' }), /IndexedDB is unavailable/);
  await assert.rejects(store.save({ markdown: 'x' }), /IndexedDB is unavailable/);
});

test('multi-tab isolation: tab 1 vs tab 2 scoped snapshots do not leak', async () => {
  const indexedDB = new IDBFactory();
  const store = makeStore(indexedDB);
  await store.saveForScope({ tabId: 1, chatUuid: 'branch-a' }, makeSnapshot({ markdown: '# A', filename: 'a.md' }));

  // Acceptance: querying (tabId:2, chatUuid:'branch-b') returns null when only (1,'branch-a') saved.
  assert.equal(await store.loadForTab(2, 'branch-b'), null);
  assert.equal(await store.loadMetaForTab(2, 'branch-b'), null);

  await store.saveForScope({ tabId: 2, chatUuid: 'branch-b' }, makeSnapshot({ markdown: '# B', filename: 'b.md' }));
  assert.equal((await store.loadForTab(1, 'branch-a')).markdown, '# A');
  assert.equal((await store.loadForTab(2, 'branch-b')).markdown, '# B');
  assert.equal((await store.loadMetaForTab(2, 'branch-b')).chatUuid, 'branch-b');
  // Tab records are isolated: tab 1's tab-scoped record is branch-a, not branch-b.
  assert.equal((await store.loadMetaForTab(1, 'branch-a')).chatUuid, 'branch-a');
});

test('same-tab SPA branch switch: tab key never leaks old branch, chat fallback works', async () => {
  const indexedDB = new IDBFactory();
  const store = makeStore(indexedDB);
  await store.saveForScope({ tabId: 1, chatUuid: 'chat-a' }, makeSnapshot({ markdown: '# A', chatUuid: 'chat-a' }));
  await store.saveForScope({ tabId: 1, chatUuid: 'chat-b' }, makeSnapshot({ markdown: '# B', chatUuid: 'chat-b' }));

  // Same tab now on branch-b: must return branch-b, never branch-a from tab:1.
  const tabNow = await store.loadForTab(1, 'chat-b');
  assert.equal(tabNow.markdown, '# B');

  // Asking for branch-a on tab 1 must not return stale tab:1 (which is branch-b),
  // but should fall back to chat:chat-a if present.
  const fallback = await store.loadForTab(1, 'chat-a');
  assert.equal(fallback.markdown, '# A');

  // Meta also follows same rules.
  const metaB = await store.loadMetaForTab(1, 'chat-b');
  assert.equal(metaB.chatUuid, 'chat-b');
  const metaA = await store.loadMetaForTab(1, 'chat-a');
  assert.equal(metaA.chatUuid, 'chat-a');
});

test('partial snapshot metadata flags and counts are persisted', async () => {
  const indexedDB = new IDBFactory();
  const store = makeStore(indexedDB);
  const snapshot = makeSnapshot({
    markdown: '# partial',
    stats: { messages: 5, expandedSpoilers: 2 },
    completedMessages: 5,
    totalMessages: 12,
  });
  const meta = await store.saveForScope({ tabId: 3, chatUuid: 'chat-p' }, snapshot, { partial: true, profile: { profileVersion: 1 } });
  assert.equal(meta.partial, true);
  assert.equal(meta.completedMessages, 5);
  assert.equal(meta.totalMessages, 12);

  const loadedMeta = await store.loadMetaForTab(3, 'chat-p');
  assert.equal(loadedMeta.partial, true);
  assert.equal(loadedMeta.completedMessages, 5);
  assert.equal(loadedMeta.totalMessages, 12);
  assert.equal((await store.loadForTab(3, 'chat-p')).markdown, '# partial');

  // Full snapshot defaults partial to false.
  await store.saveForScope({ tabId: 4, chatUuid: 'chat-f' }, makeSnapshot({ markdown: '# full' }));
  assert.equal((await store.loadMetaForTab(4, 'chat-f')).partial, false);
});

test('diagnostic log storage is independent of markdown snapshots', async () => {
  const indexedDB = new IDBFactory();
  const store = makeStore(indexedDB);
  const logBundle = { events: [{ t: 1, name: 'start' }], profileVersion: 1 };

  await store.saveDiagnosticLog({ tabId: 9, chatUuid: 'chat-log' }, logBundle);
  assert.deepEqual(await store.loadDiagnosticLog(9, 'chat-log'), logBundle);
  // No snapshot required.
  assert.equal(await store.loadForTab(9, 'chat-log'), null);

  // Snapshot save does not clobber diagnostic log, and log save does not clobber snapshot.
  await store.saveForScope({ tabId: 9, chatUuid: 'chat-log' }, makeSnapshot({ markdown: '# kept' }));
  assert.deepEqual(await store.loadDiagnosticLog(9, 'chat-log'), logBundle);
  await store.saveDiagnosticLog({ tabId: 9, chatUuid: 'chat-log' }, { events: [{ t: 2 }] });
  assert.equal((await store.loadForTab(9, 'chat-log')).markdown, '# kept');
  assert.deepEqual(await store.loadDiagnosticLog(9, 'chat-log'), { events: [{ t: 2 }] });
});

test('v1-to-v2 DB upgrade migrates legacy latest snapshot/meta/profile', async () => {
  const indexedDB = new IDBFactory();
  const markdown = '# migrated';
  const legacy = { markdown, filename: 'legacy.md', stats: { messages: 2, expandedSpoilers: 1 }, warnings: ['w'], tabId: 11, chatUuid: 'legacy-chat', sourceUrl: 'https://arena.ai/agent/legacy-chat', createdAt: 555 };
  const legacyMeta = { filename: 'legacy.md', stats: { messages: 2, expandedSpoilers: 1 }, warnings: ['w'], createdAt: 555, bytes: 9, tabId: 11, chatUuid: 'legacy-chat', sourceUrl: 'https://arena.ai/agent/legacy-chat' };
  const legacyProfile = { profileVersion: 1, totalMs: 123 };
  await seedV1Database(indexedDB, { latest: legacy, meta: legacyMeta, profile: legacyProfile });

  const store = makeStore(indexedDB);
  const loaded = await store.load();
  const meta = await store.loadMeta();
  const profile = await store.loadProfile();
  assert.equal(loaded.markdown, markdown);
  assert.equal(loaded.filename, 'legacy.md');
  assert.equal(meta.filename, 'legacy.md');
  assert.equal(meta.chatUuid, 'legacy-chat');
  assert.deepEqual(profile, legacyProfile);
});

test('LRU eviction caps scoped snapshots at 8 and logs at 16', async () => {
  const indexedDB = new IDBFactory();
  const store = makeStore(indexedDB);

  for (let i = 1; i <= 9; i++) {
    await store.saveForScope({ tabId: i, chatUuid: `chat-${i}` }, makeSnapshot({ markdown: `# ${i}`, filename: `${i}.md` }));
  }
  // Oldest (tab 1) should be evicted, newest 8 should remain.
  assert.equal(await store.loadForTab(1, 'chat-1'), null);
  for (let i = 2; i <= 9; i++) {
    const snap = await store.loadForTab(i, `chat-${i}`);
    assert.ok(snap, `expected snapshot for tab ${i}`);
    assert.equal(snap.markdown, `# ${i}`);
  }

  for (let i = 1; i <= 17; i++) {
    await store.saveDiagnosticLog({ tabId: i, chatUuid: `chat-${i}` }, { seq: i });
  }
  assert.equal(await store.loadDiagnosticLog(1, 'chat-1'), null);
  for (let i = 2; i <= 17; i++) {
    assert.deepEqual(await store.loadDiagnosticLog(i, `chat-${i}`), { seq: i });
  }
});
