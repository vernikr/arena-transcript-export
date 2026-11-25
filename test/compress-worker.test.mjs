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

// --- Intermediate Thought condensation ---------------------------------------

function loadWorker() {
  const sent = [], sandbox = { TextEncoder, console, self: { postMessage: message => sent.push(message) } };
  vm.createContext(sandbox);
  sandbox.importScripts = (...paths) => {
    for (const path of paths) vm.runInContext(read(path.replace('../', '')), sandbox);
  };
  vm.runInContext(read('popup/compress-worker.js'), sandbox);
  return { sandbox, sent, send: data => sandbox.self.onmessage({ data }) };
}

const tick = '`';
const USER_TEXT = '## 👤 User\n\nFix the widget.';
const reasoning = Array.from({ length: 8 }, (_, i) => {
  let text = 'step' + i + ':';
  while (text.length < 399) text += ' reasoning';
  return text.slice(0, 399) + '.';
});
const transcript = [
  USER_TEXT,
  `## 🤖 Assistant\n\n#### Thought for 12s\n\n${reasoning.join('\n\n')}\n\n#### Ran commands 1\n\n##### Used Bash 94ms\n\n` +
    `**command:**\n\n${tick.repeat(3)}bash\n$ ls\n${tick.repeat(3)}\n\n**stdout:**\n\n${tick.repeat(3)}text\nfile.txt\n${tick.repeat(3)}\n\nAll done.`,
].join('\n\n');
const MARKER_RE = /_\[\.\.\. condensed \d+ intermediate reasoning blocks \(\d+ chars\) \.\.\.\]_/;
const MARKERS = {
  smart: '_[... condensed 4 intermediate reasoning blocks (1600 chars) ...]_',
  stubs: '_[... condensed 6 intermediate reasoning blocks (2400 chars) ...]_',
};

test('worker condenses long reasoning for Smart and Stubs and ignores the flag for Off and Lossless', () => {
  const { sent, send } = loadWorker();
  send({ type: 'INIT_SNAPSHOT', snapshotId: 1, markdown: transcript });
  const request = (mode, condenseThoughts) => {
    send({ type: 'GET_MODE', snapshotId: 1, requestId: sent.length + 1, mode, ...(condenseThoughts === undefined ? {} : { condenseThoughts }) });
    return sent.at(-1);
  };
  for (const mode of ['smart', 'stubs']) {
    const byDefault = request(mode), on = request(mode, true), off = request(mode, false);
    assert.equal(byDefault.type, 'MODE_RESULT', mode);
    assert.equal(byDefault.condenseThoughts, true, mode + ' defaults to condensing');
    assert.ok(byDefault.result.markdown.includes(MARKERS[mode]), mode);
    assert.equal(byDefault.result.stats.thoughtsCondensed, 1);
    assert.equal(on.condenseThoughts, true);
    assert.equal(on.result.markdown, byDefault.result.markdown);
    assert.equal(off.condenseThoughts, false);
    assert.doesNotMatch(off.result.markdown, MARKER_RE);
    assert.equal(off.result.stats.thoughtsCondensed, 0);
    assert.ok(off.result.bytes > byDefault.result.bytes, mode + ' preview shrinks');
    assert.ok(off.result.estimatedTokens > byDefault.result.estimatedTokens, mode + ' token estimate shrinks');
    assert.equal(byDefault.result.bytes, Buffer.byteLength(byDefault.result.markdown));
    for (const message of [byDefault, off]) {
      assert.ok(message.result.markdown.startsWith(USER_TEXT), mode + ' keeps the User message');
      assert.ok(message.result.markdown.endsWith('All done.'), mode + ' keeps the final answer');
    }
  }
  for (const mode of ['off', 'lossless']) {
    const results = [request(mode), request(mode, true), request(mode, false)];
    for (const message of results) {
      assert.equal(message.condenseThoughts, false, mode + ' reports the flag as ignored');
      assert.doesNotMatch(message.result.markdown, MARKER_RE);
      assert.equal(message.result.stats.thoughtsCondensed, 0);
      assert.equal(message.result.markdown, results[0].result.markdown);
    }
  }
  assert.equal(request('off', true).result.markdown, transcript);
});

test('GET_MARKDOWN returns the same condensed Markdown that GET_MODE measured', () => {
  const { sent, send } = loadWorker();
  send({ type: 'INIT_SNAPSHOT', snapshotId: 3, markdown: transcript });
  send({ type: 'GET_MODE', snapshotId: 3, requestId: 1, mode: 'smart', condenseThoughts: true, includeMarkdown: false });
  send({ type: 'GET_MARKDOWN', snapshotId: 3, requestId: 2, mode: 'smart', condenseThoughts: true });
  send({ type: 'GET_MARKDOWN', snapshotId: 3, requestId: 3, mode: 'smart', condenseThoughts: false });
  send({ type: 'GET_MARKDOWN', snapshotId: 3, requestId: 4, mode: 'lossless', condenseThoughts: true });
  const [meta, on, off, lossless] = sent;
  assert.equal(meta.result.markdown, undefined);
  assert.equal(meta.condenseThoughts, true);
  assert.equal(on.type, 'MARKDOWN_RESULT');
  assert.equal(on.condenseThoughts, true);
  assert.ok(on.markdown.includes(MARKERS.smart));
  assert.equal(Buffer.byteLength(on.markdown), meta.result.bytes, 'the downloaded text is the previewed text');
  assert.equal(off.condenseThoughts, false);
  assert.doesNotMatch(off.markdown, MARKER_RE);
  assert.equal(lossless.condenseThoughts, false);
  assert.doesNotMatch(lossless.markdown, MARKER_RE);
});

test('worker computes each mode once and each mode and toggle combination once', () => {
  const { sandbox, send } = loadWorker();
  vm.runInContext(`globalThis.calls = { compress: 0, condense: 0 };
    const compress = AREX.compressIndex, condense = AREX.applyThoughtCondensation;
    AREX.compressIndex = (...args) => { calls.compress++; return compress(...args); };
    AREX.applyThoughtCondensation = (...args) => { calls.condense++; return condense(...args); };`, sandbox);
  send({ type: 'INIT_SNAPSHOT', snapshotId: 1, markdown: transcript });
  const asks = [
    ['off', undefined], ['off', true], ['lossless', true], ['lossless', false],
    ['smart', true], ['smart', true], ['smart', undefined], ['smart', false],
    ['stubs', true], ['stubs', false], ['stubs', false],
  ];
  asks.forEach(([mode, condenseThoughts], i) => {
    send({ type: 'GET_MODE', snapshotId: 1, requestId: i + 1, mode, includeMarkdown: false, ...(condenseThoughts === undefined ? {} : { condenseThoughts }) });
  });
  assert.equal(sandbox.calls.compress, 4, 'one compression per distinct mode');
  assert.equal(sandbox.calls.condense, 6, 'off:false, lossless:false, smart:true, smart:false, stubs:true, stubs:false');
  send({ type: 'GET_MARKDOWN', snapshotId: 1, requestId: 99, mode: 'smart', condenseThoughts: false });
  assert.equal(sandbox.calls.condense, 6, 'downloads reuse the preview computation');

  send({ type: 'INIT_SNAPSHOT', snapshotId: 2, markdown: transcript });
  send({ type: 'GET_MODE', snapshotId: 2, requestId: 100, mode: 'smart', condenseThoughts: true });
  assert.equal(sandbox.calls.compress, 5);
  assert.equal(sandbox.calls.condense, 7, 'a new snapshot starts with empty caches');
});

// Runs the real popup against the real worker script, bridged like postMessage (cloned, asynchronous).
function setupBridgedPopup({ stored = {}, replyDelay = () => 0 } = {}) {
  const dom = new JSDOM(read('popup/popup.html'), { url: 'chrome-extension://test/popup/popup.html', runScripts: 'outside-only' });
  const w = dom.window, $ = selector => w.document.querySelector(selector);
  const h = { dom, w, $, stored, bridges: [], portMessages: [], blobs: [], downloads: 0 };
  let onPopupMessage = null;
  w.matchMedia = () => ({ matches: false }); w.TextEncoder = TextEncoder;
  w.URL.createObjectURL = value => { h.blobs.push(value); return 'blob:test'; };
  w.URL.revokeObjectURL = () => {};
  w.chrome = {
    storage: { local: { set() {} }, sync: { get(defaults, cb) { cb({ ...defaults, ...stored }); }, set(values) { Object.assign(stored, values); } } },
    runtime: { sendMessage: async () => {}, connect: () => ({
      onDisconnect: { addListener() {} },
      onMessage: { addListener(listener) { onPopupMessage = listener; } },
      postMessage(message) {
        h.portMessages.push(message);
        if (message.type === 'AREX_HELLO') queueMicrotask(() => onPopupMessage({ type: 'AREX_STATUS', job: null }));
      },
    }) },
    tabs: { query: async () => [{ id: 1, url: 'https://arena.ai/agent/x' }] },
    downloads: { download: async () => { h.downloads++; return 1; }, onChanged: { addListener() {}, removeListener() {} } },
  };
  const snapshot = { markdown: transcript, filename: 'x.md', stats: { messages: 2, expandedSpoilers: 0 }, warnings: [], createdAt: 1 };
  w.AREX_RESULT_STORE = {
    loadForTab: async (tabId, chatUuid) => (tabId === 1 && chatUuid === 'x' ? snapshot : null),
    loadMetaForTab: async () => ({ filename: 'x.md', partial: false }),
    loadDiagnosticLog: async () => null,
    loadProfile: async () => null,
    load: async () => snapshot,
  };
  class BridgedWorker {
    constructor() {
      this.requests = []; this.replies = []; this.delivered = [];
      this.worker = loadWorker();
      this.worker.sandbox.self.postMessage = message => {
        const reply = JSON.parse(JSON.stringify(message));
        this.replies.push(reply);
        setTimeout(() => {
          if (this.terminated) return;
          this.delivered.push(reply);
          this.onmessage({ data: reply });
        }, replyDelay(reply));
      };
      h.bridges.push(this);
    }
    postMessage(message) { this.requests.push(message); this.worker.send(JSON.parse(JSON.stringify(message))); }
    terminate() { this.terminated = true; }
  }
  w.Worker = BridgedWorker;
  const ctx = dom.getInternalVMContext();
  vm.runInContext(read('content/compress.js'), ctx);
  w.AREX.compressIndex = () => { throw new Error('unexpected UI-thread compression'); };
  vm.runInContext(read('popup/popup.js'), ctx);

  h.previews = () => h.bridges[0].requests.filter(x => x.type === 'GET_MODE').map(x => [x.mode, x.condenseThoughts, x.includeMarkdown]);
  h.size = () => $('#sizeExactValue').textContent;
  h.toggle = checked => { $('#condenseThoughts').checked = checked; $('#condenseThoughts').dispatchEvent(new w.Event('change', { bubbles: true })); };
  h.readBlob = blob => new Promise(resolve => {
    const reader = new w.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsText(blob);
  });
  return h;
}

test('popup sends the condense choice to the real worker and serves toggles from its cache', async () => {
  const h = setupBridgedPopup({ stored: { compressionMode: 'smart' } });
  const { $, w, bridges, portMessages, stored, previews, size, toggle } = h;
  try {
    await waitUntil(() => size(), 3000);
    assert.equal(bridges.length, 1);
    assert.equal(bridges[0].requests.filter(x => x.type === 'INIT_SNAPSHOT').length, 1);
    assert.deepEqual(previews(), [['smart', true, false]]);
    const condensed = size();
    assert.equal($('#condenseThoughts').checked, true);
    assert.equal($('#condenseThoughts').disabled, false);

    const scans = portMessages.length;
    toggle(false);
    await waitUntil(() => previews().length === 2 && size() && size() !== condensed, 3000);
    assert.deepEqual(previews()[1], ['smart', false, false]);
    assert.equal(stored.condenseThoughts, false, 'the choice is persisted');
    const [condensedReply, fullReply] = bridges[0].replies.filter(x => x.type === 'MODE_RESULT');
    assert.ok(fullReply.result.bytes > condensedReply.result.bytes);
    assert.equal(size(), w.AREX.formatByteCount(fullReply.result.bytes));

    toggle(true);
    await waitUntil(() => size() === condensed, 3000);
    assert.equal(previews().length, 2, 'toggling back is served from the popup cache');
    assert.equal(portMessages.length, scans, 'toggling never rescans the Arena tab');

    $('[data-mode="lossless"]').click();
    await waitUntil(() => previews().length === 3 && size() && size() !== condensed, 3000);
    assert.deepEqual(previews()[2], ['lossless', false, false]);
    assert.equal($('#condenseThoughts').disabled, true, 'Lossless ignores the toggle');
    assert.equal(stored.condenseThoughts, true, 'the saved choice survives a trip through Lossless');
    $('[data-mode="smart"]').click();
    await waitUntil(() => size() === condensed, 3000);
    assert.equal(previews().length, 3);
    assert.equal($('#condenseThoughts').disabled, false);

    $('#export').click();
    await waitUntil(() => h.downloads === 1, 3000);
    const request = bridges[0].requests.find(x => x.type === 'GET_MARKDOWN');
    assert.deepEqual([request.mode, request.condenseThoughts], ['smart', true]);
    const condensedText = await h.readBlob(h.blobs.at(-1));
    assert.ok(condensedText.includes(MARKERS.smart));
    assert.ok(condensedText.startsWith(USER_TEXT));
    assert.ok(condensedText.endsWith('All done.'));
    assert.equal(condensedText, bridges[0].replies.find(x => x.type === 'MARKDOWN_RESULT').markdown);
    assert.equal(portMessages.length, scans, 'downloading never rescans the Arena tab');

    toggle(false);
    await waitUntil(() => size() && size() !== condensed && !$('#export').disabled, 3000);
    $('#export').click();
    await waitUntil(() => h.downloads === 2, 3000);
    const fullRequest = bridges[0].requests.filter(x => x.type === 'GET_MARKDOWN').at(-1);
    assert.deepEqual([fullRequest.mode, fullRequest.condenseThoughts], ['smart', false]);
    const fullText = await h.readBlob(h.blobs.at(-1));
    assert.doesNotMatch(fullText, MARKER_RE);
    assert.ok(fullText.startsWith(USER_TEXT));
    assert.ok(fullText.endsWith('All done.'));
  } finally {
    h.dom.window.close();
  }
});

test('a late worker reply for the previous toggle state never overwrites the current preview', async () => {
  const h = setupBridgedPopup({
    stored: { compressionMode: 'smart' },
    replyDelay: reply => (reply.type === 'MODE_RESULT' && reply.condenseThoughts ? 120 : 0),
  });
  const { $, w, bridges, previews, size, toggle } = h;
  try {
    await waitUntil(() => bridges.length === 1 && previews().length === 1, 3000);
    toggle(false);
    await waitUntil(() => previews().length === 2 && size(), 3000);
    const delivered = flag => bridges[0].delivered.find(x => x.type === 'MODE_RESULT' && x.condenseThoughts === flag);
    assert.ok(delivered(false), 'the unchecked reply arrives first');
    assert.equal(delivered(true), undefined, 'the checked reply is still in flight');
    const fullSize = w.AREX.formatByteCount(delivered(false).result.bytes);
    assert.equal(size(), fullSize);
    assert.equal($('#export').disabled, true, 'Download waits for the superseded request to settle');
    await waitUntil(() => delivered(true) && !$('#export').disabled, 3000);
    assert.equal(size(), fullSize, 'the stale checked reply was ignored');
    toggle(true);
    await waitUntil(() => size() && size() !== fullSize, 3000);
    assert.equal(size(), w.AREX.formatByteCount(delivered(true).result.bytes));
    assert.equal(previews().length, 2, 'the late reply still filled the per-choice cache');
  } finally {
    h.dom.window.close();
  }
});
