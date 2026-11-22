import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = name => readFileSync(new URL('../extension/content/' + name, import.meta.url), 'utf8');

function makePort() {
  const messageListeners = [];
  const disconnectListeners = [];
  return {
    name: 'AREX',
    sent: [],
    onMessage: { addListener(fn) { messageListeners.push(fn); } },
    onDisconnect: { addListener(fn) { disconnectListeners.push(fn); } },
    postMessage(message) { this.sent.push(message); },
    async emit(message) { await Promise.all(messageListeners.map(fn => fn(message))); },
    disconnect() { for (const fn of disconnectListeners) fn(); },
  };
}

function waitUntil(predicate, timeoutMs = 1000) {
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

test('scan survives popup disconnect and restores live progress and completed result', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div role="log"></div></body></html>', {
    url: 'https://arena.ai/agent/reconnect-test',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.TextEncoder = TextEncoder;

  let onConnect;
  window.chrome = {
    runtime: {
      id: 'test-extension',
      onMessage: { addListener() {} },
      onConnect: { addListener(listener) { onConnect = listener; } },
    },
  };

  for (const name of ['selectors.js', 'util.js', 'markdown.js', 'serialize.js', 'loader.js', 'expand.js', 'compress.js']) {
    vm.runInContext(source(name), dom.getInternalVMContext(), { filename: name });
  }
  vm.runInContext(source('main.js'), dom.getInternalVMContext(), { filename: 'main.js' });

  const AREX = window.AREX;
  const log = window.document.querySelector('[role="log"]');
  let finishHistory;
  const historyGate = new Promise(resolve => { finishHistory = resolve; });
  AREX.logEl = () => log;
  AREX.waitFor = async () => log;
  AREX.loadFullHistory = async (_log, { onProgress }) => {
    onProgress({ stage: 'history', phase: 'page', pages: 1, loaded: 25 });
    await historyGate;
    return { stable: true, messages: 25 };
  };
  AREX.expandAllSpoilers = async () => ({ expanded: 4, stuck: [], openedButtons: [] });
  AREX.settle = async () => {};
  AREX.serialize = () => '# Captured transcript';
  AREX.measureMarkdown = markdown => ({ bytes: new TextEncoder().encode(markdown).length });
  AREX.qq = () => [];
  AREX.messages = () => Array.from({ length: 25 }, () => ({}));
  AREX.chatTitle = () => 'Reconnect test';
  AREX.slug = () => 'reconnect-test';
  AREX.stamp = () => '20261122-1654';

  const firstPopup = makePort();
  onConnect(firstPopup);
  void firstPopup.emit({ type: 'AREX_EXPORT_START', options: {} });
  await waitUntil(() => AREX._job.status === 'running' && AREX._job.progress.length > 0);

  firstPopup.disconnect();
  assert.equal(AREX._running, true, 'disconnect must not cancel the page-side scan');

  const secondPopup = makePort();
  onConnect(secondPopup);
  await secondPopup.emit({ type: 'AREX_GET_STATUS' });
  const restoredStatus = secondPopup.sent.find(message => message.type === 'AREX_STATUS');
  assert.equal(restoredStatus.status, 'running');
  assert.ok(restoredStatus.progress.some(event => event.stage === 'history'));

  secondPopup.disconnect();
  finishHistory();
  await waitUntil(() => AREX._job.status === 'done');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(AREX._job.result.filename, 'arena-reconnect-test-20261122-1654.md');

  const reopenedPopup = makePort();
  onConnect(reopenedPopup);
  await reopenedPopup.emit({ type: 'AREX_GET_STATUS' });
  const restoredResult = reopenedPopup.sent.find(message => message.type === 'AREX_RESULT');
  assert.equal(restoredResult.ok, true);
  assert.equal(restoredResult.markdown, '# Captured transcript');

  await reopenedPopup.emit({ type: 'AREX_RESULT_ACK' });
  assert.equal(AREX._job.status, 'saved');
  assert.equal(AREX._job.result, null);

  dom.window.close();
});
