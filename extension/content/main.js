// Orchestrator + chrome.runtime wiring (page module: AREX_EXPORT_START → markdown).
// The export is owned by this tab; progress and the final Markdown are streamed
// to the background coordinator (AREX_JOB port), which persists the snapshot to
// IndexedDB even when the popup is closed.
window.AREX = window.AREX || {};

AREX._jobPort = null;
AREX._jobPortRetries = 0;
AREX._jobReconnectTimer = null;
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
  if (!AREX._jobPort) return false;
  try { AREX._jobPort.postMessage(message); return true; } catch { AREX._jobPort = null; return false; }
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
      if (AREX._jobReconnectTimer) clearTimeout(AREX._jobReconnectTimer);
      AREX._jobReconnectTimer = null;
      AREX._job.status = 'saved';
      AREX._job.updatedAt = Date.now();
      return;
    }
  });
  port.onDisconnect.addListener(() => {
    if (AREX._jobPort === port) AREX._jobPort = null;
    // A completed result is retained until ACK, so reconnect and resend even
    // after the scan itself has finished if the worker restarted mid-transfer.
    scheduleJobReconnect();
  });
  return port;
}

function needsJobReconnect() {
  return AREX._running || Boolean(AREX._job.result) || (AREX._job.status === 'error' && !AREX._job.errorDelivered);
}

function scheduleJobReconnect() {
  if (AREX._jobReconnectTimer || AREX._jobPortRetries >= 5 || !needsJobReconnect()) return;
  AREX._jobPortRetries += 1;
  AREX._jobReconnectTimer = setTimeout(() => {
    AREX._jobReconnectTimer = null;
    if (!needsJobReconnect()) return;
    const reconnected = ensureJobPort();
    if (!reconnected) { scheduleJobReconnect(); return; }
    const started = postJob({
      type: 'AREX_JOB_START', chatUuid: AREX.chatUuid?.() || null, sourceUrl: location.href,
      startedAt: AREX._job.startedAt || Date.now(), progress: AREX._job.progress, options: {}, resumed: true,
    });
    if (!started) { scheduleJobReconnect(); return; }
    if (AREX._job.result && !sendPendingResult()) scheduleJobReconnect();
    else if (AREX._job.status === 'error' && !AREX._job.errorDelivered) {
      AREX._job.errorDelivered = postJob({ type: 'AREX_RESULT_END', ok: false, error: AREX._job.error });
      if (!AREX._job.errorDelivered) scheduleJobReconnect();
    }
  }, 1000);
}

// Retransmission is idempotent: a new AREX_JOB_START resets the background's
// partial assembly before the complete ordered chunk stream is sent again.
function sendPendingResult() {
  const result = AREX._job.result;
  if (!result) return true;
  const markdown = result.markdown;
  for (let offset = 0, seq = 0; offset < markdown.length || seq === 0; offset += JOB_CHUNK_CHARS, seq += 1) {
    const data = markdown.slice(offset, offset + JOB_CHUNK_CHARS);
    if (!postJob({ type: 'AREX_RESULT_CHUNK', seq, data })) return false;
    if (!data && seq === 0) break;
  }
  return postJob({ type: 'AREX_RESULT_END', ok: true, filename: result.filename, stats: result.stats,
    warnings: result.warnings, bytes: AREX._job.resultBytes, createdAt: AREX._job.resultCreatedAt });
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

// Expand, serialize and release just a few messages at a time. The shared
// openedButtons array is populated at click time so cancellation/errors during
// expansion still restore every control opened by this export.
AREX.processMessagesInWindows = async function (log, options = {}, { onProgress, onCleanup, windowSize = 4 } = {}) {
  const messages = AREX.messages(log);
  const totalMessages = messages.length;
  const parts = [AREX.serializeHeader(totalMessages)];
  const includeToolActivity = options.includeToolActivity !== false;
  let expandedSpoilers = 0, assembledBytes = new TextEncoder().encode(parts[0]).length, leftCollapsed = 0;
  // Count visible collapsed spoilers up front, then add nested spoilers as their
  // parent panels mount. Each message and each spoiler is one unit of work.
  let totalSpoilers = includeToolActivity
    ? messages.reduce((count, message) => count + AREX.qq(AREX.S.COLLAPSED, message).length, 0)
    : 0;
  let lastPercent = 0;
  const progressPercent = (processedMessages, completedSpoilers, knownSpoilers = totalSpoilers) => {
    const totalWork = totalMessages + knownSpoilers;
    if (totalWork <= 0) return 100;
    const raw = Math.round((processedMessages + completedSpoilers) * 100 / totalWork);
    const bounded = Math.max(0, Math.min(100, raw));
    // Nested spoilers are discovered lazily. Keep the displayed estimate
    // monotonic when discovering them increases the denominator.
    lastPercent = Math.max(lastPercent, processedMessages < totalMessages ? Math.min(99, bounded) : bounded);
    return lastPercent;
  };
  const countExpandableSpoilers = roots => roots.reduce((count, root) =>
    count + AREX.qq(AREX.S.EXPANDABLE, root).length, 0);

  if (includeToolActivity) {
    leftCollapsed = AREX.qq(AREX.S.COLLAPSED, log).filter(button => !button.closest(AREX.S.MSG)).length;
  }
  const verifyMessages = () => {
    const current = AREX.messages(log);
    if (current.length < totalMessages || messages.some((m, i) => current[i] !== m || !m.isConnected))
      throw new Error('Page unloaded or reordered messages during export; aborting to avoid a partial file.');
  };
  for (let start = 0; start < totalMessages; start += Math.max(1, windowSize)) {
    AREX.throwIfAborted?.();
    verifyMessages();
    const roots = messages.slice(start, start + Math.max(1, windowSize));
    const openedButtons = [];
    const initialExpandableSpoilers = includeToolActivity ? countExpandableSpoilers(roots) : 0;
    let newlyDiscoveredSpoilers = 0;
    let spoilersCounted = false;
    let processedInWindow = 0;
    try {
      if (includeToolActivity) {
        const expand = await AREX.expandAllSpoilers(log, {
          roots, openedButtons, cooperative: true,
          settleOptions: { quietMs: 100, maxMs: 1500, attributes: false },
          onProgress: event => {
            newlyDiscoveredSpoilers = Math.max(newlyDiscoveredSpoilers,
              Math.max(0, countExpandableSpoilers(roots) - initialExpandableSpoilers));
            const knownSpoilers = totalSpoilers + newlyDiscoveredSpoilers;
            const completedSpoilers = expandedSpoilers + (event.expanded || 0);
            onProgress?.({ stage: 'process', phase: 'expand',
              processedMessages: start, totalMessages, expandedSpoilers: completedSpoilers, totalSpoilers: knownSpoilers, assembledBytes,
              percent: progressPercent(start, completedSpoilers, knownSpoilers) });
          },
        });
        // Allows compatible callers that return their own array; the built-in
        // expander normally appends to the shared array as it clicks.
        if (expand.openedButtons && expand.openedButtons !== openedButtons)
          for (const button of expand.openedButtons) if (!openedButtons.includes(button)) openedButtons.push(button);
        newlyDiscoveredSpoilers = Math.max(newlyDiscoveredSpoilers,
          Math.max(0, countExpandableSpoilers(roots) - initialExpandableSpoilers));
        totalSpoilers += newlyDiscoveredSpoilers;
        spoilersCounted = true;
        expandedSpoilers += expand.expanded || 0;
        leftCollapsed += roots.reduce((n, root) => n + AREX.qq(AREX.S.COLLAPSED, root).length, 0);
      }
      AREX.throwIfAborted?.();
      verifyMessages();
      for (let i = 0; i < roots.length; i++) {
        const segment = await AREX.serializeMessageAsync(roots[i], options);
        parts.push(segment);
        assembledBytes += 2 + new TextEncoder().encode(segment).length;
        processedInWindow = i + 1;
        const processedMessages = start + processedInWindow;
        onProgress?.({ stage: 'process', processedMessages, totalMessages, expandedSpoilers, totalSpoilers, assembledBytes,
          percent: progressPercent(processedMessages, expandedSpoilers) });
      }
    } finally {
      if (includeToolActivity && !spoilersCounted) {
        newlyDiscoveredSpoilers = Math.max(newlyDiscoveredSpoilers,
          Math.max(0, countExpandableSpoilers(roots) - initialExpandableSpoilers));
        totalSpoilers += newlyDiscoveredSpoilers;
      }
      if (openedButtons.length) {
        // Cleanup must finish even when progress reporting or serialization
        // throws, and must not be interrupted by the cancellation signal.
        await AREX.collapseOpenedSpoilers(openedButtons, { roots, cooperative: true, onProgress: event => onCleanup?.({
          stage: 'process', phase: 'cleanup', processedMessages: start + processedInWindow,
          totalMessages, expandedSpoilers, totalSpoilers, assembledBytes,
          percent: progressPercent(start + processedInWindow, expandedSpoilers),
          closed: event.closed, total: event.total,
        }) });
      }
    }
    verifyMessages();
    if (start + roots.length < totalMessages) await AREX.yieldToMain();
  }
  AREX.throwIfAborted?.();
  return { markdown: parts.join('\n\n') + '\n', expandedSpoilers, leftCollapsed, totalMessages };
};

AREX.runExport = async function (options = {}) {
  if (AREX._running) throw new Error('Export is already running in this tab.');
  AREX._running = true;
  if (AREX._jobReconnectTimer) clearTimeout(AREX._jobReconnectTimer);
  AREX._jobReconnectTimer = null;
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
  const announced = postJob({
    type: 'AREX_JOB_START',
    chatUuid: AREX.chatUuid?.() || null,
    sourceUrl: location.href,
    startedAt: AREX._job.startedAt,
    progress: [],
    options,
  });
  if (!announced) scheduleJobReconnect();
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

  try {
    const found = await AREX.waitFor(() => AREX.logEl(), { timeoutMs: 15000 });
    if (!found) throw new Error('Transcript not found. Open an Arena agent conversation page and retry.');
    const log = AREX.logEl();
    const hist = await AREX.loadFullHistory(log, { onProgress: progress });
    const processed = await AREX.processMessagesInWindows(log, options, { onProgress: progress, onCleanup: progressBestEffort });
    const { markdown, expandedSpoilers, leftCollapsed, totalMessages } = processed;
    const bytes = new TextEncoder().encode(markdown).length;
    progress({ stage: 'serialize', phase: 'done', bytes });

    const warnings = [];
    if (!hist.stable) warnings.push('History loading stopped before the oldest message was confirmed — the branch may be truncated.');
    if (leftCollapsed) warnings.push(leftCollapsed + ' spoiler(s) stayed collapsed (content unavailable).');

    const result = {
      markdown,
      filename: 'arena-' + AREX.slug(AREX.chatTitle()) + '-' + AREX.stamp() + '.md',
      stats: { messages: totalMessages, expandedSpoilers },
      warnings,
    };
    progress({ stage: 'done', ...result.stats, warnings });
    // Keep the raw result in the tab until the background coordinator confirms
    // it was persisted to IndexedDB (AREX_RESULT_ACK).
    AREX._job.status = 'done';
    AREX._job.result = result;
    AREX._job.updatedAt = Date.now();

    AREX._job.resultBytes = bytes;
    AREX._job.resultCreatedAt = Date.now();
    if (!sendPendingResult()) scheduleJobReconnect();
    return result;
  } catch (error) {
    const cancelled = isAbortError(error);
    AREX._job.status = 'error';
    AREX._job.error = cancelled ? 'Export cancelled.' : String(error?.message || error);
    AREX._job.updatedAt = Date.now();
    AREX._job.errorDelivered = postJob({ type: 'AREX_RESULT_END', ok: false, error: AREX._job.error });
    if (!AREX._job.errorDelivered) scheduleJobReconnect();
    throw error;
  } finally {
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
