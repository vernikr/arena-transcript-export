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
  for (const name of ['selectors.js', 'util.js', 'markdown.js', 'serialize.js', 'loader.js', 'expand.js', 'compress.js', 'profile.js']) {
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

test('reconnects and resends an unacknowledged result after the scan has finished', async () => {
  const dom = makeDom();
  const chromeMock = installChromeMock(dom.window);
  const AREX = loadContentScripts(dom);
  stubFastExport(AREX, dom.window.document.querySelector('[role="log"]'));
  await AREX.runExport();
  assert.equal(AREX._running, false);
  assert.ok(AREX._job.result, 'unacknowledged result must remain available');
  const previous = chromeMock.jobPort;
  previous.disconnect();
  await waitUntil(() => chromeMock.jobPort !== previous, 2500);
  const resumed = chromeMock.jobPort;
  await waitUntil(() => resumed.sent.some(m => m.type === 'AREX_RESULT_END'), 2500);
  assert.ok(resumed.sent.some(m => m.type === 'AREX_JOB_START' && m.resumed));
  assert.equal(resumed.sent.filter(m => m.type === 'AREX_RESULT_CHUNK').map(m => m.data).join(''), '# Captured transcript\n\nCaptured message\n');
  assert.equal(resumed.sent.find(m => m.type === 'AREX_RESULT_END').bytes, new TextEncoder().encode('# Captured transcript\n\nCaptured message\n').length);
  await resumed.emit({ type: 'AREX_RESULT_ACK' });
  assert.equal(AREX._job.result, null);
  dom.window.close();
});

test('initial connection failure retries and transfers the finished result', async () => {
  const dom = makeDom();
  const chromeMock = installChromeMock(dom.window);
  const original = dom.window.chrome.runtime.connect;
  let attempts = 0;
  dom.window.chrome.runtime.connect = args => {
    if (++attempts === 1) throw new Error('worker unavailable');
    return original(args);
  };
  const AREX = loadContentScripts(dom);
  stubFastExport(AREX, dom.window.document.querySelector('[role="log"]'));
  await AREX.runExport();
  assert.ok(AREX._job.result);
  await waitUntil(() => chromeMock.jobPort?.sent.some(m => m.type === 'AREX_RESULT_END'), 2500);
  assert.ok(attempts >= 2);
  assert.ok(chromeMock.jobPort.sent.some(m => m.type === 'AREX_JOB_START' && m.resumed));
  await chromeMock.jobPort.emit({ type: 'AREX_RESULT_ACK' });
  assert.equal(AREX._job.result, null);
  dom.window.close();
});

test('an error produced while disconnected is sent after reconnection', async () => {
  const dom = makeDom();
  const chromeMock = installChromeMock(dom.window);
  const original = dom.window.chrome.runtime.connect;
  let attempts = 0;
  dom.window.chrome.runtime.connect = args => {
    if (++attempts === 1) throw new Error('worker unavailable');
    return original(args);
  };
  const AREX = loadContentScripts(dom);
  const log = dom.window.document.querySelector('[role="log"]');
  stubFastExport(AREX, log, { onLoadFullHistory: async () => { throw new Error('History unavailable'); } });
  await assert.rejects(AREX.runExport(), /History unavailable/);
  await waitUntil(() => chromeMock.jobPort?.sent.some(m => m.type === 'AREX_RESULT_END'), 2500);
  const end = chromeMock.jobPort.sent.find(m => m.type === 'AREX_RESULT_END');
  assert.equal(end.ok, false); assert.match(end.error, /History unavailable/);
  assert.equal(AREX._job.errorDelivered, true);
  dom.window.close();
});

test('stopping after two serialized messages delivers a partial result after spoiler cleanup', async () => {
  const dom = makeDom();
  const chromeMock = installChromeMock(dom.window);
  const AREX = loadContentScripts(dom);
  const log = dom.window.document.querySelector('[role="log"]');
  for (let i = 1; i <= 5; i += 1) {
    const message = dom.window.document.createElement('div');
    message.setAttribute('data-agent-transcript-message', '');
    message.setAttribute('data-chat-message-id', `m${i}`);
    log.append(message);
  }
  AREX.logEl = () => log;
  AREX.waitFor = async () => log;
  AREX.loadFullHistory = async () => ({ stable: true, messages: 5, pages: 0 });
  AREX.chatTitle = () => 'Partial test';
  AREX.slug = () => 'partial-test';
  AREX.stamp = () => '20261125-1200';
  AREX.serializeHeader = () => '# Captured transcript';
  let thirdStarted;
  let thirdHasStarted = false;
  const thirdStart = new Promise(resolve => { thirdStarted = () => { thirdHasStarted = true; resolve(); }; });
  let continueThird;
  const continuePromise = new Promise(resolve => { continueThird = resolve; });
  let serialized = 0;
  AREX.serializeMessageAsync = async message => {
    serialized += 1;
    if (serialized === 3) {
      thirdStarted();
      await continuePromise;
      AREX.throwIfAborted();
    }
    return `Message ${message.getAttribute('data-chat-message-id')}`;
  };
  const opened = { isConnected: true, getAttribute: () => 'true', click() {} };
  let cleanup = false;
  AREX.expandAllSpoilers = async (_log, { openedButtons }) => {
    openedButtons.push(opened);
    return { expanded: 1, stuck: [] };
  };
  AREX.collapseOpenedSpoilers = async (_buttons, { onProgress }) => {
    cleanup = true;
    onProgress?.({ closed: 1, total: 1 });
    return { closed: 1 };
  };

  let response;
  chromeMock.messageListener({ type: 'AREX_EXPORT_START', options: {} }, null, value => { response = value; });
  assert.equal(response.ok, true);
  try { await waitUntil(() => thirdHasStarted || AREX._job.status === 'error'); }
  catch { assert.fail(`third serialize timeout: status=${AREX._job.status}, error=${AREX._job.error}, progress=${JSON.stringify(AREX._job.progress)}`); }
  assert.equal(AREX._job.status, 'running', AREX._job.error || 'third serialization was never reached');
  chromeMock.messageListener({ type: 'AREX_EXPORT_CANCEL' }, null, value => assert.equal(value.ok, true));
  continueThird();
  await waitUntil(() => AREX._job.status === 'done' || AREX._job.status === 'error');
  assert.equal(AREX._job.status, 'done', AREX._job.error || 'partial export did not finish');

  assert.equal(cleanup, true);
  assert.equal(AREX._job.result.partial, true);
  assert.equal(AREX._job.result.completedMessages, 2);
  assert.match(AREX._job.result.markdown, /Status: Partial export \(stopped at 2\/5 messages\)/);
  assert.match(AREX._job.result.markdown, /Message m1[\s\S]*Message m2/);
  assert.doesNotMatch(AREX._job.result.markdown, /Message m3/);
  const end = chromeMock.jobPort.sent.find(message => message.type === 'AREX_RESULT_END');
  assert.equal(end.ok, true);
  assert.equal(end.partial, true);
  assert.equal(end.completedMessages, 2);
  assert.ok(chromeMock.jobPort.sent.some(message => message.type === 'AREX_PROGRESS' && message.stage === 'cleanup'));
  dom.window.close();
});

test('AREX_DUMP_LOG returns a live profiler snapshot while history loading is blocked', async () => {
  const dom = makeDom();
  const chromeMock = installChromeMock(dom.window);
  const AREX = loadContentScripts(dom);
  const log = dom.window.document.querySelector('[role="log"]');
  stubFastExport(AREX, log);
  let enterHistory;
  const inHistory = new Promise(resolve => { enterHistory = resolve; });
  let finishHistory;
  const finish = new Promise(resolve => { finishHistory = resolve; });
  AREX.loadFullHistory = async (_log, { onProgress }) => {
    onProgress({ stage: 'history', phase: 'page', pages: 1 });
    enterHistory();
    await finish;
    return { stable: true, messages: 1, pages: 0 };
  };
  const running = AREX.runExport();
  await inHistory;
  let runtimeReply;
  chromeMock.messageListener({ type: 'AREX_DUMP_LOG' }, null, value => { runtimeReply = value; });
  assert.equal(runtimeReply.ok, true);
  assert.equal(runtimeReply.status, 'running');
  assert.equal(runtimeReply.profile.profileVersion, 2);
  assert.equal(runtimeReply.profile.outcome, 'running');
  assert.ok(runtimeReply.progress.some(event => event.stage === 'history'));

  await chromeMock.jobPort.emit({ type: 'AREX_DUMP_LOG', requestId: 'log-1' });
  const portReply = chromeMock.jobPort.sent.find(message => message.type === 'AREX_DUMP_LOG_RESULT');
  assert.equal(portReply.requestId, 'log-1');
  assert.equal(portReply.profile.profileVersion, 2);
  finishHistory();
  await running;
  dom.window.close();
});

test('streaming tail remount by stable id and newly appended message do not abort the initial snapshot', async () => {
  const dom = makeDom();
  const AREX = loadContentScripts(dom);
  const log = dom.window.document.querySelector('[role="log"]');
  const addMessage = (id, text) => {
    const message = dom.window.document.createElement('div');
    message.setAttribute('data-agent-transcript-message', '');
    message.setAttribute('data-chat-message-id', id);
    message.textContent = text;
    log.append(message);
    return message;
  };
  addMessage('first', 'first');
  const tail = addMessage('tail', 'old tail');
  AREX.serializeHeader = () => '# Header';
  AREX.expandAllSpoilers = async () => ({ expanded: 0, stuck: [] });
  AREX.yieldToMain = async () => {};
  let didReplace = false;
  AREX.serializeMessageAsync = async message => {
    if (!didReplace) {
      didReplace = true;
      const replacement = dom.window.document.createElement('div');
      replacement.setAttribute('data-agent-transcript-message', '');
      replacement.setAttribute('data-chat-message-id', 'tail');
      replacement.textContent = 'remounted tail';
      tail.replaceWith(replacement);
      addMessage('new-turn', 'newly appended');
    }
    return message.textContent;
  };
  const result = await AREX.processMessagesInWindows(log, { includeToolActivity: false }, { windowSize: 1 });
  assert.match(result.markdown, /remounted tail/);
  assert.equal(result.totalMessages, 2);
  assert.ok(result.warnings.some(warning => /New messages appeared during export/.test(warning)));
  dom.window.close();
});

test('large chunk transfer yields cooperatively, reports saving progress and keeps heartbeat until ACK', async () => {
  const dom = makeDom();
  const chromeMock = installChromeMock(dom.window);
  const AREX = loadContentScripts(dom);
  const log = dom.window.document.querySelector('[role="log"]');
  stubFastExport(AREX, log);
  const largeSegment = 'x'.repeat(2 * 2 * 1024 * 1024 + 37);
  AREX.serializeMessageAsync = async () => largeSegment;
  let yields = 0;
  AREX.yieldToMain = async () => { yields += 1; };
  await AREX.runExport();
  const chunks = chromeMock.jobPort.sent.filter(message => message.type === 'AREX_RESULT_CHUNK');
  assert.equal(chunks.length, 3);
  assert.equal(yields, 1);
  assert.ok(chromeMock.jobPort.sent.some(message => message.type === 'AREX_PROGRESS' && message.stage === 'saving' && message.sentChunks === 2));
  assert.ok(AREX._heartbeatTimer, 'heartbeat remains live while the result awaits durable ACK');
  await chromeMock.jobPort.emit({ type: 'AREX_RESULT_ACK' });
  assert.equal(AREX._heartbeatTimer, null);
  dom.window.close();
});
