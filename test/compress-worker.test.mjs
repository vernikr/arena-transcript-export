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
  sandbox.importScripts = (...paths) => {
    for (const path of paths) vm.runInContext(read(path.replace('../', '')), sandbox);
  };
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
  // The popup only ever loads the snapshot scoped to the active Arena tab.
  let lastPopupMessage = null;
  let onPopupMessage = null;
  w.chrome = {
    storage: { local: { set() {} }, sync: { get(defaults, cb) { cb(defaults); }, set() {} } },
    runtime: { sendMessage: async () => {}, connect: () => ({
      onDisconnect: { addListener() {} },
      onMessage: { addListener(listener) { onPopupMessage = listener; } },
      postMessage(message) {
        lastPopupMessage = message;
        if (message.type === 'AREX_HELLO') {
          queueMicrotask(() => onPopupMessage({ type: 'AREX_STATUS', job: null }));
        }
      },
    }) },
    tabs: { query: async () => [{ id: 1, url: 'https://arena.ai/agent/x' }] },
    downloads: { download: async () => { downloads++; return 1; }, onChanged: { addListener() {}, removeListener() {} } },
  };
  const snapshot = { markdown: 'original', filename: 'x.md', stats: { messages: 1, expandedSpoilers: 0 }, warnings: [], createdAt: 1 };
  w.AREX_RESULT_STORE = {
    loadForTab: async (tabId, chatUuid) => (tabId === 1 && chatUuid === 'x' ? snapshot : null),
    loadMetaForTab: async () => ({ filename: 'x.md', partial: false }),
    loadDiagnosticLog: async () => null,
    loadProfile: async () => null,
    load: async () => snapshot,
  };
  class FakeWorker {
    constructor() { this.requests = []; workers.push(this); }
    postMessage(message) {
      this.requests.push(message);
      const mode = message.mode;
      const delay = mode === 'smart' ? 60 : 8;
      if (message.type === 'GET_MARKDOWN') {
        setTimeout(() => {
          if (this.terminated) return;
          const text = mode + ' result';
          this.onmessage({ data: { type: 'MARKDOWN_RESULT', snapshotId: message.snapshotId, requestId: message.requestId, mode, markdown: text } });
        }, delay);
        return;
      }
      if (message.type !== 'GET_MODE') return;
      setTimeout(() => {
        if (this.terminated) return;
        const text = mode + ' result';
        // Mode previews never carry the multi-megabyte Markdown string.
        const result = { bytes: text.length, baselineBytes: 100, savedBytes: 100 - text.length,
          savedRatio: (100 - text.length) / 100, estimatedTokens: 2, stats: { deduplicated: 0, smartCompacted: 0, stubbed: 0 } };
        if (message.includeMarkdown !== false) result.markdown = text;
        this.onmessage({ data: { type: 'MODE_RESULT', snapshotId: message.snapshotId, requestId: message.requestId, result } });
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
  await waitUntil(() => $('#sizeExactValue').textContent, 3000);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].requests.filter(x => x.type === 'INIT_SNAPSHOT').length, 1);
  assert.ok(workers[0].requests.filter(x => x.type === 'GET_MODE').every(x => x.includeMarkdown === false),
    'mode previews request metadata only');
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

test('GET_MODE with includeMarkdown:false omits markdown and GET_MARKDOWN returns it', () => {
  const sent = [], sandbox = { TextEncoder, console, self: { postMessage: message => sent.push(message) } };
  vm.createContext(sandbox);
  sandbox.importScripts = (...paths) => {
    for (const path of paths) vm.runInContext(read(path.replace('../', '')), sandbox);
  };
  vm.runInContext(read('popup/compress-worker.js'), sandbox);
  const send = data => sandbox.self.onmessage({ data });
  const markdown = 'hello мир\n\n**stdout:**\n\n```text\n' + Array.from({ length: 30 }, (_, i) => 'same line ' + i).join('\n') + '\n```\n\n#### second\n\n**stdout:**\n\n```text\n' + Array.from({ length: 30 }, (_, i) => 'same line ' + i).join('\n') + '\n```';
  send({ type: 'INIT_SNAPSHOT', snapshotId: 7, markdown });

  // Request with includeMarkdown:false
  send({ type: 'GET_MODE', snapshotId: 7, requestId: 1, mode: 'lossless', includeMarkdown: false });
  assert.equal(sent.length, 1);
  const metaMsg = sent[0];
  assert.equal(metaMsg.type, 'MODE_RESULT');
  assert.equal(metaMsg.snapshotId, 7);
  assert.equal(metaMsg.requestId, 1);
  assert.equal(metaMsg.mode, 'lossless');
  assert.equal(metaMsg.result.markdown, undefined);
  assert.equal(typeof metaMsg.result.bytes, 'number');
  assert.equal(typeof metaMsg.result.baselineBytes, 'number');
  assert.equal(typeof metaMsg.result.estimatedTokens, 'number');
  assert.equal(typeof metaMsg.result.savedBytes, 'number');
  assert.ok(metaMsg.result.stats && typeof metaMsg.result.stats === 'object');

  // GET_MARKDOWN returns the full markdown
  send({ type: 'GET_MARKDOWN', snapshotId: 7, requestId: 2, mode: 'lossless' });
  assert.equal(sent.length, 2);
  const mdMsg = sent[1];
  assert.equal(mdMsg.type, 'MARKDOWN_RESULT');
  assert.equal(mdMsg.snapshotId, 7);
  assert.equal(mdMsg.requestId, 2);
  assert.equal(mdMsg.mode, 'lossless');
  assert.equal(typeof mdMsg.markdown, 'string');
  assert.match(mdMsg.markdown, /Identical to \[output #1\]/);

  // Default (includeMarkdown not set) still includes markdown for backward compat
  send({ type: 'GET_MODE', snapshotId: 7, requestId: 3, mode: 'smart' });
  assert.equal(sent[2].type, 'MODE_RESULT');
  assert.equal(typeof sent[2].result.markdown, 'string');
});
