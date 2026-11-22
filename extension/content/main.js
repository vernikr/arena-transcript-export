// Orchestrator + chrome.runtime wiring (page module: AREX_EXPORT_START → markdown).
// The export is owned by this tab; progress and the final Markdown are streamed
// to the background coordinator (AREX_JOB port), which persists the snapshot to
// IndexedDB even when the popup is closed.
window.AREX = window.AREX || {};

AREX._jobPort = null;
AREX._jobPortRetries = 0;
AREX._heartbeatTimer = null;
AREX._running = false;
AREX._abortController = null;
AREX._job = {
  status: 'idle',
  progress: [],
  result: null,
  error: null,
  startedAt: null,
  updatedAt: null,
};

const JOB_CHUNK_CHARS = 2 * 1024 * 1024; // ~2 MB of UTF-16 code units per Port message

function isAbortError(error) {
  return error?.name === 'AbortError' || /abort/i.test(String(error?.message || ''));
}

AREX.throwIfAborted = function () {
  const signal = AREX._abortController?.signal;
  if (signal?.aborted) {
    const error = new Error('Export cancelled.');
    error.name = 'AbortError';
    throw error;
  }
};

function postJob(message) {
  try { AREX._jobPort?.postMessage(message); return true; } catch { return false; }
}

function ensureJobPort() {
  if (AREX._jobPort) return AREX._jobPort;
  if (typeof chrome === 'undefined' || !chrome.runtime?.connect) return null;
  let port = null;
  try { port = chrome.runtime.connect({ name: 'AREX_JOB' }); } catch { return null; }
  AREX._jobPort = port;
  port.onMessage.addListener(msg => {
    if (msg?.type === 'AREX_EXPORT_CANCEL') {
      AREX._abortController?.abort(new DOMException('Export cancelled.', 'AbortError'));
      return;
    }
    if (msg?.type === 'AREX_RESULT_ACK') {
      // Background durably stored the snapshot and the tab can release its copy.
      AREX._job.result = null;
      AREX._job.status = 'saved';
      AREX._job.updatedAt = Date.now();
      return;
    }
  });
  port.onDisconnect.addListener(() => {
    if (AREX._jobPort === port) AREX._jobPort = null;
    // Service worker restart or crash: keep the export alive and re-attach.
    if (AREX._running && AREX._jobPortRetries < 5) {
      AREX._jobPortRetries += 1;
      setTimeout(() => {
        if (!AREX._running) return;
        const reconnected = ensureJobPort();
        if (reconnected) {
          postJob({
            type: 'AREX_JOB_START',
            chatUuid: AREX.chatUuid?.() || null,
            sourceUrl: location.href,
            startedAt: AREX._job.startedAt || Date.now(),
            progress: AREX._job.progress,
            options: {},
            resumed: true,
          });
        }
      }, 1000);
    }
  });
  return port;
}

function startHeartbeat() {
  stopHeartbeat();
  AREX._heartbeatTimer = setInterval(() => {
    if (AREX._running) postJob({ type: 'AREX_HEARTBEAT' });
  }, 20000);
}

function stopHeartbeat() {
  if (AREX._heartbeatTimer) clearInterval(AREX._heartbeatTimer);
  AREX._heartbeatTimer = null;
}

AREX.runExport = async function (options = {}) {
  if (AREX._running) throw new Error('Export is already running in this tab.');
  AREX._running = true;
  AREX._jobPortRetries = 0;
  AREX._abortController = new AbortController();
  AREX._job = {
    status: 'running',
    progress: [],
    result: null,
    error: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  ensureJobPort();
  postJob({
    type: 'AREX_JOB_START',
    chatUuid: AREX.chatUuid?.() || null,
    sourceUrl: location.href,
    startedAt: AREX._job.startedAt,
    progress: [],
    options,
  });
  startHeartbeat();

  const progress = p => {
    AREX.throwIfAborted();
    const event = { ...p, at: Date.now() };
    AREX._job.progress.push(event);
    // A full run normally emits fewer than 500 events; cap retained state for long-lived tabs.
    if (AREX._job.progress.length > 500) AREX._job.progress.shift();
    AREX._job.updatedAt = event.at;
    postJob({ type: 'AREX_PROGRESS', ...event });
  };
  // Never throws on abort: used for teardown reporting after a cancel.
  const progressBestEffort = p => {
    const event = { ...p, at: Date.now() };
    AREX._job.progress.push(event);
    if (AREX._job.progress.length > 500) AREX._job.progress.shift();
    postJob({ type: 'AREX_PROGRESS', ...event });
  };

  const expandState = { openedButtons: [] };
  try {
    const found = await AREX.waitFor(() => AREX.logEl(), { timeoutMs: 15000 });
    if (!found) throw new Error('Transcript not found. Open an Arena agent conversation page and retry.');
    const log = AREX.logEl();

    const hist = await AREX.loadFullHistory(log, { onProgress: progress });
    let expand = { expanded: 0, stuck: [], openedButtons: [] };
    if (options.includeToolActivity !== false) {
      expand = await AREX.expandAllSpoilers(log, { onProgress: progress });
      expandState.openedButtons = expand.openedButtons || [];
    }
    await AREX.settle(log, { quietMs: 400, maxMs: 6000 });

    progress({ stage: 'serialize', phase: 'start' });
    const markdown = AREX.serialize(log, options);
    const bytes = AREX.measureMarkdown(markdown).bytes;
    progress({ stage: 'serialize', phase: 'done', bytes });
    const leftCollapsed = options.includeToolActivity !== false ? AREX.qq(AREX.S.COLLAPSED, log).length : 0;

    const warnings = [];
    if (!hist.stable) warnings.push('History loading stopped before the oldest message was confirmed — the branch may be truncated.');
    if (leftCollapsed) warnings.push(leftCollapsed + ' spoiler(s) stayed collapsed (content unavailable).');

    const result = {
      markdown,
      filename: 'arena-' + AREX.slug(AREX.chatTitle()) + '-' + AREX.stamp() + '.md',
      stats: { messages: AREX.messages(log).length, expandedSpoilers: expand.expanded },
      warnings,
    };
    progress({ stage: 'done', ...result.stats, warnings });
    // Keep the raw result in the tab until the background coordinator confirms
    // it was persisted to IndexedDB (AREX_RESULT_ACK).
    AREX._job.status = 'done';
    AREX._job.result = result;
    AREX._job.updatedAt = Date.now();

    for (let offset = 0, seq = 0; offset < markdown.length || seq === 0; offset += JOB_CHUNK_CHARS, seq += 1) {
      const data = markdown.slice(offset, offset + JOB_CHUNK_CHARS);
      postJob({ type: 'AREX_RESULT_CHUNK', seq, data });
      if (!data && seq === 0) break;
    }
    // The background stores the snapshot to IndexedDB and then posts AREX_RESULT_ACK;
    // the job port handler releases AREX._job.result when it arrives. If the
    // acknowledgement never comes, the in-tab copy is kept for popup recovery.
    postJob({
      type: 'AREX_RESULT_END',
      ok: true,
      filename: result.filename,
      stats: result.stats,
      warnings: result.warnings,
      bytes,
      createdAt: Date.now(),
    });
    return result;
  } catch (error) {
    const cancelled = isAbortError(error);
    AREX._job.status = 'error';
    AREX._job.error = cancelled ? 'Export cancelled.' : String(error?.message || error);
    AREX._job.updatedAt = Date.now();
    postJob({ type: 'AREX_RESULT_END', ok: false, error: AREX._job.error });
    throw error;
  } finally {
    // Close only spoilers this export opened so Arena can release their large
    // nested DOM trees and return to its prior state — also on failure/cancel.
    if (expandState.openedButtons.length) {
      try {
        await AREX.collapseOpenedSpoilers(expandState.openedButtons, { onProgress: progressBestEffort });
      } catch { /* best effort */ }
    }
    stopHeartbeat();
    AREX._running = false;
    AREX._abortController = null;
  }
};

if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'AREX_PING') {
      sendResponse({ ok: true, compressionPreview: true, featureVersion: '0.3.0' });
      return;
    }
    if (msg?.type === 'AREX_EXPORT_CANCEL') {
      AREX._abortController?.abort(new DOMException('Export cancelled.', 'AbortError'));
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type !== 'AREX_EXPORT_START') return;
    if (AREX._running) {
      sendResponse({ ok: false, error: 'Export is already running in this tab.' });
      return;
    }
    sendResponse({ ok: true, started: true });
    AREX.runExport(msg.options || {}).catch(() => { /* state already recorded in AREX._job */ });
  });
}
