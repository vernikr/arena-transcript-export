import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const read = path => readFileSync(new URL('../extension/' + path, import.meta.url), 'utf8');
const waitUntil = async (condition, ms = 1000) => {
  const deadline = Date.now() + ms;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 5)); }
};

test('worker builds one index per snapshot and caches each mode', () => {
  const sent = [], sandbox = { TextEncoder, console, self: { postMessage: message => sent.push(message) } };
  vm.createContext(sandbox);
  sandbox.importScripts = () => vm.runInContext(read('content/compress.js'), sandbox);
  vm.runInContext(read('popup/compress-worker.js'), sandbox);
  vm.runInContext(`globalThis.calls = { index: 0, compress: 0 }; const build = AREX.buildMarkdownIndex, compress = AREX.compressIndex;
    AREX.buildMarkdownIndex = (...args) => { calls.index++; return build(...args); };
    AREX.compressIndex = (...args) => { calls.compress++; return compress(...args); };`, sandbox);
  const send = data => sandbox.self.onmessage({ data });
  send({ type: 'INIT_SNAPSHOT', snapshotId: 1, markdown: 'hello мир' });
  for (const [requestId, mode] of [[1, 'off'], [2, 'smart'], [3, 'smart'], [4, 'stubs']])
    send({ type: 'GET_MODE', snapshotId: 1, requestId, mode });
  assert.equal(sandbox.calls.index, 1); assert.equal(sandbox.calls.compress, 3);
  assert.equal(sent.length, 4); assert.equal(sent[2].result.markdown, 'hello мир');
  send({ type: 'GET_MODE', snapshotId: 0, requestId: 5, mode: 'off' });
  assert.equal(sent.at(-1).type, 'MODE_ERROR');
  send({ type: 'INIT_SNAPSHOT', snapshotId: 2, markdown: 'new' });
  send({ type: 'GET_MODE', snapshotId: 2, requestId: 6, mode: 'smart' });
  assert.equal(sandbox.calls.index, 2); assert.equal(sandbox.calls.compress, 4);
  assert.equal(sent.at(-1).result.markdown, 'new');
});

test('popup ignores stale worker replies, caches modes and downloads the selected preview', async () => {
  const dom = new JSDOM(read('popup/popup.html'), { url: 'chrome-extension://test/popup/popup.html', runScripts: 'outside-only' });
  const w = dom.window, $ = selector => w.document.querySelector(selector), workers = [];
  w.matchMedia = () => ({ matches: false }); w.TextEncoder = TextEncoder;
  let downloads = 0, blob;
  w.URL.createObjectURL = value => { blob = value; return 'blob:test'; };
  w.URL.revokeObjectURL = () => {};
  w.chrome = {
    storage: { local: { set() {} }, sync: { get(defaults, cb) { cb(defaults); }, set() {} } },
    runtime: { sendMessage: async () => {}, connect: () => ({ onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {} }) },
    tabs: { query: async () => [] }, downloads: { download: async () => { downloads++; return 1; } },
  };
  w.AREX_RESULT_STORE = { load: async () => ({ markdown: 'original', filename: 'x.md', stats: { messages: 1, expandedSpoilers: 0 }, warnings: [] }) };
  class FakeWorker {
    constructor() { this.requests = []; workers.push(this); }
    postMessage(message) {
      this.requests.push(message);
      if (message.type !== 'GET_MODE') return;
      const mode = message.mode;
      const delay = mode === 'smart' ? 60 : 8;
      setTimeout(() => {
        if (this.terminated) return;
        const text = mode + ' result';
        this.onmessage({ data: { type: 'MODE_RESULT', snapshotId: message.snapshotId, requestId: message.requestId,
          result: { markdown: text, bytes: text.length, baselineBytes: 100, savedBytes: 100 - text.length,
            savedRatio: (100 - text.length) / 100, estimatedTokens: 2, stats: { deduplicated: 0, smartCompacted: 0, stubbed: 0 } } } });
      }, delay);
    }
    terminate() { this.terminated = true; }
  }
  w.Worker = FakeWorker;
  const ctx = dom.getInternalVMContext();
  vm.runInContext(read('content/compress.js'), ctx);
  // Fail loudly if the popup performs compression on the UI thread.
  w.AREX.compressIndex = () => { throw new Error('unexpected UI-thread compression'); };
  w.AREX.compressMarkdown = () => { throw new Error('unexpected recompression on download'); };
  vm.runInContext(read('popup/popup.js'), ctx);
  await waitUntil(() => $('#sizeExactValue').textContent);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].requests.filter(x => x.type === 'INIT_SNAPSHOT').length, 1);
  $('[data-mode="smart"]').click();
  assert.equal($('#export').disabled, true);
  $('[data-mode="stubs"]').click();
  await waitUntil(() => $('#sizeExactValue').textContent === '12 B'); // "stubs result"
  await new Promise(r => setTimeout(r, 75)); // older Smart reply must not overwrite Stubs
  assert.equal($('#sizeExactValue').textContent, '12 B');
  assert.equal($('#export').disabled, false);
  $('#export').click(); await waitUntil(() => downloads === 1);
  const reader = new w.FileReader(); const text = await new Promise(resolve => { reader.onload = () => resolve(reader.result); reader.readAsText(blob); });
  assert.equal(text, 'stubs result');
  const count = workers[0].requests.length;
  $('[data-mode="smart"]').click(); await waitUntil(() => $('#sizeExactValue').textContent === '12 B');
  assert.equal(workers[0].requests.length, count, 'previously computed mode should be cached');
  dom.window.close();
});
