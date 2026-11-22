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
