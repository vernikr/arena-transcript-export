// Orchestrator + chrome.runtime wiring (page module: EXPORT_START → markdown).
window.AREX = window.AREX || {};

AREX._port = null;
AREX._running = false;
AREX._job = {
  status: 'idle',
  progress: [],
  result: null,
  error: null,
  startedAt: null,
  updatedAt: null,
};

AREX.runExport = async function (options = {}) {
  if (AREX._running) throw new Error('Export is already running in this tab.');
  AREX._running = true;
  AREX._job = {
    status: 'running',
    progress: [],
    result: null,
    error: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  const progress = p => {
    const event = { ...p, at: Date.now() };
    AREX._job.progress.push(event);
    // A full run normally emits fewer than 500 events; cap retained state for long-lived tabs.
    if (AREX._job.progress.length > 500) AREX._job.progress.shift();
    AREX._job.updatedAt = event.at;
    try { AREX._port?.postMessage({ type: 'AREX_PROGRESS', ...event }); } catch { }
  };

  try {
    const found = await AREX.waitFor(() => AREX.logEl(), { timeoutMs: 15000 });
    if (!found) throw new Error('Transcript not found. Open an Arena agent conversation page and retry.');
    const log = AREX.logEl();

    const hist = await AREX.loadFullHistory(log, { onProgress: progress });
    let expand = { expanded: 0, stuck: [], openedButtons: [] };
    if (options.includeToolActivity !== false)
      expand = await AREX.expandAllSpoilers(log, { onProgress: progress });
    await AREX.settle(log, { quietMs: 400, maxMs: 6000 });

    progress({ stage: 'serialize', phase: 'start' });
    const markdown = AREX.serialize(log, options);
    const bytes = AREX.measureMarkdown(markdown).bytes;
    progress({ stage: 'serialize', phase: 'done', bytes });
    const leftCollapsed = options.includeToolActivity !== false ? AREX.qq(AREX.S.COLLAPSED, log).length : 0;

    // The Markdown snapshot is complete. Close only spoilers this export opened
    // so Arena can release their large nested DOM trees and return to its prior state.
    if (expand.openedButtons?.length)
      await AREX.collapseOpenedSpoilers(expand.openedButtons, { onProgress: progress });

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
    // Keep the raw result in the tab until the popup confirms it was persisted to IndexedDB.
    AREX._job.status = 'done';
    AREX._job.result = result;
    AREX._job.updatedAt = Date.now();
    return result;
  } catch (error) {
    AREX._job.status = 'error';
    AREX._job.error = String(error?.message || error);
    AREX._job.updatedAt = Date.now();
    throw error;
  } finally {
    AREX._running = false;
  }
};

if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
  const post = (port, message) => {
    try { port?.postMessage(message); } catch { /* popup may have closed */ }
  };

  const sendStatus = port => {
    const job = AREX._job;
    post(port, {
      type: 'AREX_STATUS',
      status: job.status,
      progress: job.progress,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
    });
    if (job.status === 'done' && job.result)
      post(port, { type: 'AREX_RESULT', ok: true, ...job.result });
    else if (job.status === 'error')
      post(port, { type: 'AREX_RESULT', ok: false, error: job.error });
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'AREX_PING') sendResponse({ ok: true, compressionPreview: true, featureVersion: '0.3.0' });
  });
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'AREX') return;
    AREX._port = port;
    port.onDisconnect.addListener(() => {
      if (AREX._port === port) AREX._port = null;
      // The export belongs to the Arena tab, not the short-lived popup.
      // Its progress and result remain in AREX._job for the next popup session.
    });
    port.onMessage.addListener(async msg => {
      if (msg?.type === 'AREX_GET_STATUS') {
        sendStatus(port);
        return;
      }
      if (msg?.type === 'AREX_RESULT_ACK') {
        AREX._job.result = null;
        AREX._job.status = 'saved';
        AREX._job.updatedAt = Date.now();
        return;
      }
      if (msg?.type !== 'AREX_EXPORT_START') return;
      if (AREX._running) {
        post(port, { type: 'AREX_RESULT', ok: false, error: 'Export is already running in this tab.' });
        return;
      }
      const task = AREX.runExport(msg.options || {});
      post(port, {
        type: 'AREX_STATUS',
        status: 'running',
        progress: AREX._job.progress,
        startedAt: AREX._job.startedAt,
        updatedAt: AREX._job.updatedAt,
      });
      try {
        const result = await task;
        if (AREX._port) post(AREX._port, { type: 'AREX_RESULT', ok: true, ...result });
      } catch (error) {
        if (AREX._port) post(AREX._port, { type: 'AREX_RESULT', ok: false, error: String(error?.message || error) });
      }
    });
  });
}
