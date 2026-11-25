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
  profile: null,
  partial: null,
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
    if (msg?.type === 'AREX_DUMP_LOG') {
      postJob({ type: 'AREX_DUMP_LOG_RESULT', requestId: msg.requestId, ...dumpLogResponse() });
      return;
    }
    if (msg?.type === 'AREX_RESULT_ACK') {
      // Background durably stored the snapshot and the tab can release its copy.
      AREX._job.result = null;
      AREX._job.partial = null;
      AREX._job.profile = null;
      stopHeartbeat();
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
  if (AREX._jobReconnectTimer || !needsJobReconnect()) return;
  if (AREX._jobPortRetries >= 5) {
    if (!AREX._running) stopHeartbeat();
    return;
  }
  AREX._jobPortRetries += 1;
  AREX._jobReconnectTimer = setTimeout(async () => {
    AREX._jobReconnectTimer = null;
    if (!needsJobReconnect()) return;
    const reconnected = ensureJobPort();
    if (!reconnected) { scheduleJobReconnect(); return; }
    const started = postJob({
      type: 'AREX_JOB_START', chatUuid: AREX.chatUuid?.() || null, sourceUrl: location.href,
      startedAt: AREX._job.startedAt || Date.now(), progress: AREX._job.progress, options: {}, resumed: true,
    });
    if (!started) { scheduleJobReconnect(); return; }
    if (AREX._job.result) {
      if (!(await sendPendingResult())) scheduleJobReconnect();
    } else if (AREX._job.status === 'error' && !AREX._job.errorDelivered) {
      AREX._job.errorDelivered = postJob({ type: 'AREX_RESULT_END', ok: false, error: AREX._job.error,
        ...(AREX._job.profile ? { profile: AREX._job.profile } : {}) });
      if (!AREX._job.errorDelivered) scheduleJobReconnect();
    }
  }, 1000);
}

// Retransmission is idempotent: a new AREX_JOB_START resets the background's
// partial assembly before the complete ordered chunk stream is sent again.
async function sendPendingResult() {
  const result = AREX._job.result;
  if (!result) return true;
  const markdown = result.markdown;
  const totalChunks = Math.max(1, Math.ceil(markdown.length / JOB_CHUNK_CHARS));
  for (let offset = 0, seq = 0; offset < markdown.length || seq === 0; offset += JOB_CHUNK_CHARS, seq += 1) {
    const data = markdown.slice(offset, offset + JOB_CHUNK_CHARS);
    if (!postJob({ type: 'AREX_RESULT_CHUNK', seq, data })) return false;
    if (!data && seq === 0) break;
    if ((seq + 1) % 2 === 0) {
      publishProgress({ stage: 'saving', sentChunks: seq + 1, totalChunks });
      await AREX.yieldToMain();
    }
  }
  if (totalChunks % 2) publishProgress({ stage: 'saving', sentChunks: totalChunks, totalChunks });
  return postJob({ type: 'AREX_RESULT_END', ok: true, filename: result.filename, stats: result.stats,
    warnings: result.warnings, bytes: AREX._job.resultBytes, createdAt: AREX._job.resultCreatedAt,
    partial: Boolean(result.partial), completedMessages: result.completedMessages,
    totalMessages: result.totalMessages,
    ...(AREX._job.profile ? { profile: AREX._job.profile } : {}) });
}

function startHeartbeat() {
  stopHeartbeat();
  AREX._heartbeatTimer = setInterval(() => {
    if (AREX._running || AREX._job.result) postJob({ type: 'AREX_HEARTBEAT' });
  }, 20000);
}

function stopHeartbeat() {
  if (AREX._heartbeatTimer) clearInterval(AREX._heartbeatTimer);
  AREX._heartbeatTimer = null;
}

function publishProgress(p) {
  const event = { ...p, at: Date.now() };
  AREX._job.progress.push(event);
  if (AREX._job.progress.length > 500) AREX._job.progress.shift();
  AREX._job.updatedAt = event.at;
  postJob({ type: 'AREX_PROGRESS', ...event });
}

function dumpLogResponse() {
  return {
    ok: true,
    status: AREX._job.status,
    progress: AREX._job.progress,
    profile: AREX._activeProfiler
      ? AREX._activeProfiler.snapshot({
        outcome: AREX._running ? 'running' : AREX._job.status,
        progressLog: AREX._job.progress,
      })
      : AREX._job.profile,
  };
}

// Expand, serialize and release just a few messages at a time. The shared
// openedButtons array is populated at click time so cancellation/errors during
// expansion still restore every control opened by this export.
AREX.processMessagesInWindows = async function (log, options = {}, { onProgress, onCleanup, windowSize = 4, profiler = null } = {}) {
  const perf = profiler && profiler.enabled ? profiler : null;
  const messages = AREX.messages(log);
  const totalMessages = messages.length;
  const parts = [AREX.serializeHeader(totalMessages)];
  const includeToolActivity = options.includeToolActivity !== false;
  let expandedSpoilers = 0, assembledBytes = AREX.utf8ByteLength(parts[0]), leftCollapsed = 0, stuckSpoilers = 0;
  let appendedMessages = false;
  const warnings = [];
  AREX._job.partial = { parts, completedMessages: 0, totalMessages, expandedSpoilers, warnings };
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
    if (current.length < totalMessages)
      throw new Error('Page unloaded or reordered messages during export; aborting to avoid a partial file.');
    for (let i = 0; i < totalMessages; i += 1) {
      const previous = messages[i];
      const candidate = current[i];
      if (candidate === previous && previous.isConnected) continue;
      const previousId = AREX.msgId?.(previous) || previous.getAttribute?.('data-chat-message-id') || '';
      const candidateId = AREX.msgId?.(candidate) || candidate?.getAttribute?.('data-chat-message-id') || '';
      if (!previousId || candidateId !== previousId)
        throw new Error('Page unloaded or reordered messages during export; aborting to avoid a partial file.');
      // React can replace a streaming wrapper while preserving its stable id.
      messages[i] = candidate;
    }
    if (current.length > totalMessages && !appendedMessages) {
      appendedMessages = true;
      warnings.push(`New messages appeared during export; exported initial ${totalMessages} messages`);
    }
  };
  for (let start = 0; start < totalMessages; start += Math.max(1, windowSize)) {
    AREX.throwIfAborted?.();
    verifyMessages();
    let roots = messages.slice(start, start + Math.max(1, windowSize));
    const openedButtons = [];
    const initialExpandableSpoilers = includeToolActivity ? countExpandableSpoilers(roots) : 0;
    let newlyDiscoveredSpoilers = 0;
    let spoilersCounted = false;
    let processedInWindow = 0;
    const windowIndex = Math.floor(start / Math.max(1, windowSize));
    profiler?.setCursor?.({ stage: 'process', phase: 'window', windowIndex, messageIndex: start });
    const windowStartMs = perf ? perf.now() : 0;
    const windowBytesStart = assembledBytes;
    const windowExpandedStart = expandedSpoilers;
    let expandMs = 0, serializeMs = 0, cleanupMs = 0;
    try {
      if (includeToolActivity) {
        const expandStartMs = perf ? perf.now() : 0;
        const expand = await AREX.expandAllSpoilers(log, {
          roots, openedButtons, cooperative: true,
          settleOptions: { quietMs: 100, maxMs: 1500, attributes: false },
          onProgress: event => {
            // One lightweight recount per full expansion pass, not per click batch.
            if (event.phase === 'settle') {
              newlyDiscoveredSpoilers = Math.max(newlyDiscoveredSpoilers,
                Math.max(0, countExpandableSpoilers(roots) - initialExpandableSpoilers));
            }
            profiler?.setCursor?.({ stage: 'process', phase: 'expand', windowIndex, pass: event.pass, spoilersOpened: event.expanded });
            const knownSpoilers = totalSpoilers + newlyDiscoveredSpoilers;
            const completedSpoilers = expandedSpoilers + (event.expanded || 0);
            onProgress?.({ stage: 'process', phase: 'expand', expansionPhase: event.phase, pass: event.pass,
              processedMessages: start, totalMessages, expandedSpoilers: completedSpoilers, totalSpoilers: knownSpoilers, assembledBytes,
              percent: progressPercent(start, completedSpoilers, knownSpoilers) });
          },
        });
        if (perf) {
          expandMs = perf.now() - expandStartMs;
          perf.phase('expand', expandMs, `${expand.expanded || 0} spoiler(s)`);
        }
        stuckSpoilers += (expand.stuck && expand.stuck.length) || 0;
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
      roots = messages.slice(start, start + Math.max(1, windowSize));
      const serializeStartMs = perf ? perf.now() : 0;
      for (let i = 0; i < roots.length; i++) {
        const messageStartMs = perf ? perf.now() : 0;
        profiler?.setCursor?.({ stage: 'process', phase: 'serialize', windowIndex, messageIndex: start + i });
        const segment = await AREX.serializeMessageAsync(roots[i], options);
        if (perf) perf.message(perf.now() - messageStartMs, start + i, windowIndex);
        parts.push(segment);
        assembledBytes += 2 + AREX.utf8ByteLength(segment);
        processedInWindow = i + 1;
        AREX._job.partial.completedMessages = start + processedInWindow;
        AREX._job.partial.expandedSpoilers = expandedSpoilers;
        AREX._job.partial.warnings = warnings;
        const processedMessages = start + processedInWindow;
        onProgress?.({ stage: 'process', processedMessages, totalMessages, expandedSpoilers, totalSpoilers, assembledBytes,
          percent: progressPercent(processedMessages, expandedSpoilers) });
      }
      if (perf) serializeMs = perf.now() - serializeStartMs;
    } finally {
      if (includeToolActivity && !spoilersCounted) {
        newlyDiscoveredSpoilers = Math.max(newlyDiscoveredSpoilers,
          Math.max(0, countExpandableSpoilers(roots) - initialExpandableSpoilers));
        totalSpoilers += newlyDiscoveredSpoilers;
      }
      if (openedButtons.length) {
        // Cleanup must finish even when progress reporting or serialization
        // throws, and must not be interrupted by the cancellation signal.
        profiler?.setCursor?.({ stage: 'cleanup', phase: 'collapse', windowIndex, spoilersClosed: 0 });
        const cleanupStartMs = perf ? perf.now() : 0;
        await AREX.collapseOpenedSpoilers(openedButtons, { roots, cooperative: true, onProgress: event => {
          profiler?.setCursor?.({ stage: 'cleanup', phase: 'collapse', windowIndex, spoilersClosed: event.closed });
          onCleanup?.({
            stage: 'cleanup', phase: 'cleanup', processedMessages: start + processedInWindow,
            totalMessages, expandedSpoilers, totalSpoilers, assembledBytes,
            percent: progressPercent(start + processedInWindow, expandedSpoilers),
            closed: event.closed, total: event.total,
          });
        } });
        profiler?.setCursor?.({ stage: 'cleanup', phase: 'collapse', windowIndex, spoilersClosed: openedButtons.length });
        if (perf) {
          cleanupMs = perf.now() - cleanupStartMs;
          perf.phase('cleanup', cleanupMs);
        }
      }
    }
    if (perf) {
      perf.window({
        index: windowIndex, from: start, to: start + roots.length, messages: roots.length,
        spoilers: expandedSpoilers - windowExpandedStart,
        ms: perf.now() - windowStartMs,
        expandMs, serializeMs, cleanupMs,
        bytes: assembledBytes - windowBytesStart,
      });
    }
    verifyMessages();
    if (start + roots.length < totalMessages) await AREX.yieldToMain();
  }
  AREX.throwIfAborted?.();
  verifyMessages();
  profiler?.setCursor?.({ stage: 'process', phase: 'done', windowIndex: Math.max(0, Math.ceil(totalMessages / Math.max(1, windowSize)) - 1) });
  return {
    markdown: parts.join('\n\n') + '\n',
    warnings,
    expandedSpoilers,
    leftCollapsed,
    totalMessages,
    totalSpoilers,
    stuckSpoilers,
    windowCount: totalMessages > 0 ? Math.floor((totalMessages - 1) / Math.max(1, windowSize)) + 1 : 0,
  };
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
    profile: null,
    partial: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  // A bounded, zero-I/O profiler for this export. Enabled by default; the popup
  // passes options.profile = false to keep the run free of profiling overhead.
  const profiler = AREX.createProfiler({
    enabled: options.profile !== false,
    toolVersion: '0.5.0',
    sourceUrl: location.href,
    chatUuid: AREX.chatUuid?.() || null,
    options,
  });
  AREX._activeProfiler = profiler;
  profiler.setCursor?.({ stage: 'history', phase: 'start' });
  profiler.event('export.start');
  profiler.sampleMemory('export.start');
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
    publishProgress(p);
  };
  // Never throws on abort: used for teardown reporting after a cancel.
  const progressBestEffort = p => publishProgress(p);

  try {
    const found = await AREX.waitFor(() => AREX.logEl(), { timeoutMs: 15000 });
    if (!found) throw new Error('Transcript not found. Open an Arena agent conversation page and retry.');
    const log = AREX.logEl();
    const historyStartMs = profiler.now();
    const hist = await AREX.loadFullHistory(log, { onProgress: event => {
      profiler.setCursor?.({ stage: 'history', phase: event.phase || 'load' });
      progress(event);
    } });
    const historyMs = profiler.now() - historyStartMs;
    profiler.phase('history', historyMs, `${hist.pages} earlier page(s) · ${hist.messages} message(s) · stable=${hist.stable ? 'yes' : 'no'}`);
    profiler.event('history.done', `${hist.pages} pages · ${hist.messages} messages · stable=${hist.stable ? 'yes' : 'no'}`);
    profiler.sampleMemory('history.done');
    const processStartMs = profiler.now();
    profiler.setCursor?.({ stage: 'process', phase: 'start' });
    const processed = await AREX.processMessagesInWindows(log, options, { onProgress: progress, onCleanup: progressBestEffort, profiler });
    profiler.phase('process', profiler.now() - processStartMs);
    profiler.event('process.done', `${processed.totalMessages} messages · ${processed.expandedSpoilers} spoilers · ${processed.windowCount} window(s)`);
    const { markdown, expandedSpoilers, leftCollapsed, totalMessages } = processed;
    const bytes = AREX.utf8ByteLength(markdown);
    profiler.event('serialize.assembled', `${bytes} byte(s)`);
    progress({ stage: 'serialize', phase: 'done', bytes });

    const warnings = [...(processed.warnings || [])];
    if (!hist.stable) warnings.push('History loading stopped before the oldest message was confirmed — the branch may be truncated.');
    if (leftCollapsed) warnings.push(leftCollapsed + ' spoiler(s) stayed collapsed (content unavailable).');

    const result = {
      markdown,
      filename: 'arena-' + AREX.slug(AREX.chatTitle()) + '-' + AREX.stamp() + '.md',
      stats: { messages: totalMessages, expandedSpoilers },
      warnings,
    };
    profiler.event('export.done', `done · ${bytes} bytes`);
    AREX._job.profile = profiler.finish({
      outcome: 'done',
      warnings,
      totals: {
        messages: totalMessages,
        windows: processed.windowCount,
        expandedSpoilers,
        spoilersStuck: processed.stuckSpoilers,
        spoilersTotal: processed.totalSpoilers,
        leftCollapsed,
        historyPages: hist.pages,
        historyStable: hist.stable,
        historyMessages: hist.messages,
        markdownChars: markdown.length,
        markdownBytes: bytes,
      },
    });
    progress({ stage: 'done', ...result.stats, warnings });
    // Keep the raw result in the tab until the background coordinator confirms
    // it was persisted to IndexedDB (AREX_RESULT_ACK).
    AREX._job.status = 'done';
    AREX._job.result = result;
    AREX._job.partial = null;
    AREX._job.updatedAt = Date.now();

    AREX._job.resultBytes = bytes;
    AREX._job.resultCreatedAt = Date.now();
    if (!(await sendPendingResult())) scheduleJobReconnect();
    return result;
  } catch (error) {
    const cancelled = isAbortError(error);
    const partial = AREX._job.partial;
    const completedMessages = partial?.completedMessages || 0;
    if (cancelled && completedMessages >= 1) {
      const totalMessages = partial.totalMessages;
      const warnings = [...(partial.warnings || []), `Partial export stopped at ${completedMessages}/${totalMessages} messages.`];
      // The header carries full metadata (including the partial line), so the
      // assembled document is a plain join just like a completed export.
      const markdown = [AREX.serializeHeader(completedMessages, { partial: true, totalMessages }), ...partial.parts.slice(1)].join('\n\n') + '\n';
      const bytes = AREX.utf8ByteLength(markdown);
      const result = {
        markdown,
        filename: 'arena-' + AREX.slug(AREX.chatTitle()) + '-' + AREX.stamp() + '.md',
        stats: { messages: completedMessages, expandedSpoilers: partial.expandedSpoilers || 0 },
        warnings,
        partial: true,
        completedMessages,
        totalMessages,
      };
      profiler.event('export.cancelled_partial', `${completedMessages}/${totalMessages} messages`);
      AREX._job.profile = profiler.finish({ outcome: 'cancelled_partial', warnings, totals: {
        messages: completedMessages, windows: 0, markdownChars: markdown.length, markdownBytes: bytes,
      } });
      AREX._job.status = 'done';
      AREX._job.error = null;
      AREX._job.result = result;
      AREX._job.resultBytes = bytes;
      AREX._job.resultCreatedAt = Date.now();
      AREX._job.updatedAt = Date.now();
      AREX._job.partial = { completedMessages, totalMessages };
      publishProgress({ stage: 'done', ...result.stats, warnings, partial: true });
      if (!(await sendPendingResult())) scheduleJobReconnect();
      return result;
    }
    AREX._job.status = 'error';
    AREX._job.error = cancelled ? 'Export cancelled.' : String(error?.message || error);
    AREX._job.updatedAt = Date.now();
    profiler.event(cancelled ? 'export.cancelled' : 'export.error', AREX._job.error);
    AREX._job.profile = profiler.finish({
      outcome: cancelled ? 'cancelled' : 'error',
      error: AREX._job.error,
      warnings: [],
      totals: {},
    });
    AREX._job.errorDelivered = postJob({ type: 'AREX_RESULT_END', ok: false, error: AREX._job.error,
      ...(AREX._job.profile ? { profile: AREX._job.profile } : {}) });
    if (!AREX._job.errorDelivered) scheduleJobReconnect();
    throw error;
  } finally {
    AREX._running = false;
    AREX._abortController = null;
    AREX._activeProfiler = null;
    if (!AREX._job.result || AREX._jobPortRetries >= 5) stopHeartbeat();
  }
};

if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'AREX_PING') {
      sendResponse({ ok: true, compressionPreview: true, featureVersion: '0.5.0' });
      return;
    }
    if (msg?.type === 'AREX_EXPORT_CANCEL') {
      AREX._abortController?.abort(new DOMException('Export cancelled.', 'AbortError'));
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'AREX_DUMP_LOG') {
      sendResponse(dumpLogResponse());
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
