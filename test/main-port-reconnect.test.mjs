import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = name => readFileSync(new URL('../extension/content/' + name, import.meta.url), 'utf8');

function makePort(name) {
  const messageListeners = [];
  const disconnectListeners = [];
  return {
    name,
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
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for export state.'));
      setTimeout(check, 5);
    };
    check();
  });
}

function makeDom() {
  const dom = new JSDOM('<!doctype html><html><body><div role="log"></div></body></html>', {
    url: 'https://arena.ai/agent/reconnect-test',
    runScripts: 'outside-only',
  });
  dom.window.TextEncoder = TextEncoder;
  dom.window.DOMException = DOMException;
  return dom;
}

function loadContentScripts(dom) {
  for (const name of ['selectors.js', 'util.js', 'markdown.js', 'serialize.js', 'loader.js', 'expand.js', 'compress.js']) {
    vm.runInContext(source(name), dom.getInternalVMContext(), { filename: name });
  }
  vm.runInContext(source('main.js'), dom.getInternalVMContext(), { filename: 'main.js' });
  return dom.window.AREX;
}

function stubFastExport(AREX, log, { onLoadFullHistory } = {}) {
  AREX.logEl = () => log;
  AREX.waitFor = async () => log;
  AREX.loadFullHistory = onLoadFullHistory || (async (_log, { onProgress }) => {
    onProgress({ stage: 'history', phase: 'page', pages: 1, loaded: 25 });
    return { stable: true, messages: 25 };
  });
  AREX.expandAllSpoilers = async (_log, { onProgress }) => {
    onProgress({ stage: 'expand', phase: 'click', pass: 1, openedThisPass: 1, total: 1, expanded: 1 });
    return { expanded: 4, stuck: [], openedButtons: [{ isConnected: true, getAttribute: () => 'true', click() {} }] };
  };
  AREX.settle = async () => {};
  const message = log.ownerDocument.createElement('div');
  message.setAttribute('data-agent-transcript-message', '');
  log.append(message);
  AREX.serializeHeader = () => '# Captured transcript';
  AREX.serializeMessageAsync = async () => 'Captured message';
  AREX.measureMarkdown = markdown => ({ bytes: new TextEncoder().encode(markdown).length });
  AREX.qq = () => [];
  AREX.messages = () => [message];
  AREX.chatTitle = () => 'Reconnect test';
  AREX.slug = () => 'reconnect-test';
  AREX.stamp = () => '20261122-1654';
  AREX.collapseOpenedSpoilers = async () => ({ closed: 1 });
}

function installChromeMock(window) {
  const state = { messageListener: null, jobPort: null };
  window.chrome = {
    runtime: {
      id: 'test-extension',
      onMessage: { addListener(listener) { state.messageListener = listener; } },
      onConnect: { addListener() { } },
      connect({ name }) {
        assert.equal(name, 'AREX_JOB');
        state.jobPort = makePort('AREX_JOB');
        return state.jobPort;
      },
    },
  };
  return state;
}

test('export streams progress and chunked result to the background job port and releases it on ACK', async () => {
  const dom = makeDom();
  const chromeMock = installChromeMock(dom.window);
  const AREX = loadContentScripts(dom);
  const log = dom.window.document.querySelector('[role="log"]');
  stubFastExport(AREX, log);

  let response;
  chromeMock.messageListener({ type: 'AREX_EXPORT_START', options: {} }, null, r => { response = r; });
  assert.equal(response.ok, true);

  await waitUntil(() => AREX._job.status === 'done');
  const jobPort = chromeMock.jobPort;
  assert.ok(jobPort, 'content script must open an AREX_JOB port');
  assert.equal(jobPort.sent.find(m => m.type === 'AREX_JOB_START').chatUuid, 'reconnect-test');
  assert.ok(jobPort.sent.some(m => m.type === 'AREX_PROGRESS' && m.stage === 'history'));
  const chunks = jobPort.sent.filter(m => m.type === 'AREX_RESULT_CHUNK');
  assert.equal(chunks.map(c => c.data).join(''), '# Captured transcript\n\nCaptured message\n');
  const end = jobPort.sent.find(m => m.type === 'AREX_RESULT_END');
  assert.equal(end.ok, true);
  assert.equal(end.filename, 'arena-reconnect-test-20261122-1654.md');

  // Content keeps the result until the background confirms durable persistence.
  assert.equal(AREX._job.status, 'done');
  assert.equal(AREX._job.result.filename, end.filename);
  await jobPort.emit({ type: 'AREX_RESULT_ACK' });
  assert.equal(AREX._job.status, 'saved');
  assert.equal(AREX._job.result, null);

  dom.window.close();
});

test('AREX_EXPORT_CANCEL aborts the run, collapses opened spoilers and reports a cancelled result', async () => {
  const dom = makeDom();
  const chromeMock = installChromeMock(dom.window);
  const AREX = loadContentScripts(dom);
  const log = dom.window.document.querySelector('[role="log"]');
  let collapseCalled = false;
  AREX.collapseOpenedSpoilers = async () => { collapseCalled = true; return { closed: 0 }; };
  stubFastExport(AREX, log);
  // History resolves instantly; the expand phase blocks until the abort lands,
  // leaving one opened spoiler behind that the finally block must collapse.
  const fakeButton = { isConnected: true, getAttribute: () => 'true', click() {} };
  AREX.expandAllSpoilers = async () => {
    await new Promise(resolve => {
      const check = () => {
        if (AREX._abortController?.signal.aborted) return resolve();
        setTimeout(check, 5);
      };
      check();
    });
    return { expanded: 1, stuck: [], openedButtons: [fakeButton] };
  };
  // stubFastExport installed its own collapse stub; re-apply ours.
  AREX.collapseOpenedSpoilers = async () => { collapseCalled = true; return { closed: 1 }; };

  let response;
  chromeMock.messageListener({ type: 'AREX_EXPORT_START', options: {} }, null, r => { response = r; });
  assert.equal(response.ok, true);
  // Wait until the export is inside the expand phase so the cancel lands mid-run.
  await waitUntil(() => AREX._job.progress.some(p => p.stage === 'history'));
  await waitUntil(() => AREX._running === true);

  chromeMock.messageListener({ type: 'AREX_EXPORT_CANCEL' }, null, r => { assert.equal(r.ok, true); });

  await waitUntil(() => AREX._job.status === 'error');
  assert.match(AREX._job.error, /cancelled/i);
  assert.equal(collapseCalled, true);
  const jobPort = chromeMock.jobPort;
  const end = jobPort.sent.find(m => m.type === 'AREX_RESULT_END');
  assert.equal(end.ok, false);
  assert.match(end.error, /cancelled/i);

  dom.window.close();
});
