// ---------------------------------------------------------------------------
// Background coordinator for transcript exports (v2).
//
// The Arena tab (content/main.js) opens a long-lived AREX_JOB port for the
// lifetime of an export. This service worker keeps the export observable even
// after the popup closes: it relays progress to any open popup, receives the
// finished or stopped-partial Markdown (in <=2 MB chunks), persists it to
// IndexedDB scoped by (tabId, chatUuid), and ACKs the content script so the
// tab can release its multi-megabyte copy.
// Popup <-> background use the AREX_POPUP port; background <-> content use
// AREX_JOB. Job state (never the Markdown) is mirrored to
// chrome.storage.session so a service-worker restart does not lose it.
// ---------------------------------------------------------------------------

if (typeof globalThis.AREX_RESULT_STORE === 'undefined' && typeof importScripts === 'function') {
  try { importScripts('shared/result-store.js'); } catch (error) {
    console.error('[arex] failed to load shared result store', error);
  }
}
const RESULT_STORE = globalThis.AREX_RESULT_STORE || null;

// Development convenience: reload this profile's extension when the checkout
// changes (see dev-reload.js). No-ops outside a real service worker.
if (typeof importScripts === 'function') {
  try { importScripts('dev-reload.js'); } catch (error) {
    console.error('[arex] failed to load dev reload', error);
  }
}

const CONTENT_FILES = [
  'content/selectors.js', 'content/util.js', 'content/markdown.js', 'content/serialize.js',
  'content/loader.js', 'content/expand.js', 'content/compress.js', 'content/profile.js', 'content/main.js',
];

const CONTENT_FEATURE_VERSION = '0.4.1';
const MAX_TRACKED_JOBS = 30;
const PROGRESS_CAP = 500;
const SESSION_PROGRESS_CAP = 20;
const SESSION_PERSIST_INTERVAL_MS = 1000;
const CHUNK_LIMIT_CODE_UNITS = 128 * 1024 * 1024; // 128 Mi UTF-16 code units
const STALE_RUNNING_MS = 45000; // > 2 missed 20 s heartbeats
const DUMP_LOG_TIMEOUT_MS = 1200;
const SESSION_KEY = 'arexJobs';

// Exact UTF-8 byte count without allocating a Uint8Array copy. Unpaired
// surrogates count as 3 bytes (U+FFFD), matching TextEncoder.encode().
function utf8ByteLength(value) {
  const s = String(value ?? '');
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i += 1; }
      else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

// Adjusts summed per-chunk UTF-8 byte counts for surrogate pairs split across
// adjacent chunk boundaries: two 3-byte lone surrogates become one 4-byte pair (-2).
function boundarySurrogateByteDelta(orderedChunks) {
  let delta = 0;
  for (let i = 0; i + 1 < orderedChunks.length; i += 1) {
    const prev = orderedChunks[i][1];
    const next = orderedChunks[i + 1][1];
    if (prev.length > 0 && next.length > 0) {
      const last = prev.charCodeAt(prev.length - 1);
      const first = next.charCodeAt(0);
      if (last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff) {
        delta -= 2;
      }
    }
  }
  return delta;
}

// Bounded shape check for the profile artifact (v1 finished or v2 live snapshot).
function isValidProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return false;
  if (profile.profileVersion !== 1 && profile.profileVersion !== 2) return false;
  try { return utf8ByteLength(JSON.stringify(profile)) <= 256 * 1024; } catch { return false; }
}

function normalizeChatUuid(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function parseArenaAgentUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return { isArena: false, chatUuid: null };
  try {
    const u = new URL(rawUrl);
    const isArena = u.host === 'arena.ai' && (u.pathname === '/agent' || u.pathname.startsWith('/agent/'));
    if (!isArena) return { isArena: false, chatUuid: null };
    const match = u.pathname.match(/^\/agent\/([^/?#]+)/);
    if (!match || !match[1]) return { isArena: true, chatUuid: null };
    try { return { isArena: true, chatUuid: normalizeChatUuid(decodeURIComponent(match[1])) }; }
    catch { return { isArena: true, chatUuid: normalizeChatUuid(match[1]) }; }
  } catch {
    return { isArena: false, chatUuid: null };
  }
}

function chatUuidFromUrl(rawUrl) {
  return parseArenaAgentUrl(rawUrl).chatUuid;
}

function resolveMessageChatUuid(msg) {
  return normalizeChatUuid(msg?.chatUuid) || chatUuidFromUrl(msg?.tabUrl || msg?.url || msg?.sourceUrl || null);
}

/** tabId -> active/current-branch job */
const jobsByTab = new Map();
/** archiveKey -> detached job (kept bounded for unseen indicators across SPA switches) */
const archivedJobs = new Map();
/** tabId -> latest known chatUuid / URL for SPA branch verification */
const knownTabChat = new Map();
const knownTabUrl = new Map();
/** tabId -> Set<Port> */
const popupPortsByTab = new Map();
/** Set<Port> — popups opened on a non-Arena page watching all jobs */
const listenerPorts = new Set();
/** tabId -> Port (AREX_JOB) */
const jobPortsByTab = new Map();
/** tabId -> Map<requestId, (payload) => void> */
const pendingDumpLogsByTab = new Map();
let nextDumpRequestId = 0;
let nextArchiveSeq = 0;
let persistTimer = null;
/** All open popups, including those which have not sent AREX_HELLO yet. */
const openPopups = new Set();

const now = () => Date.now();
const newJob = tabId => ({
  tabId,
  chatUuid: null,
  sourceUrl: null,
  status: 'running',
  progress: [],
  error: null,
  startedAt: now(),
  updatedAt: now(),
  resultMeta: null,
  unseen: false,
  finalizing: false,
  awaitingJobStart: false,
  transferStats: { receivedChunks: 0, totalChunks: null, receivedChars: 0, receivedUtf8Bytes: 0 },
  lastProfile: null,
  // In-memory-only fallback when the IndexedDB write fails (or chunks in flight). Never persisted.
  pendingResult: null,
  _sessionEntry: null,
});

function invalidateSessionCache(job) {
  if (job) job._sessionEntry = null;
}

function publicJob(job) {
  if (!job) return null;
  return {
    tabId: job.tabId,
    chatUuid: job.chatUuid,
    sourceUrl: job.sourceUrl,
    status: job.status,
    finalizing: Boolean(job.finalizing),
    progress: job.progress,
    error: job.error,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    resultMeta: job.resultMeta,
    unseen: Boolean(job.unseen),
    hasInMemoryResult: Boolean(job.pendingResult && typeof job.pendingResult.markdown === 'string'),
  };
}

function capJobs() {
  if (jobsByTab.size > MAX_TRACKED_JOBS) {
    const evictable = [...jobsByTab.values()]
      .filter(job => job.status !== 'running')
      .sort((a, b) => a.updatedAt - b.updatedAt);
    while (jobsByTab.size > MAX_TRACKED_JOBS && evictable.length) {
      const victim = evictable.shift();
      jobsByTab.delete(victim.tabId);
    }
  }
  if (archivedJobs.size > MAX_TRACKED_JOBS) {
    const ordered = [...archivedJobs.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    while (archivedJobs.size > MAX_TRACKED_JOBS && ordered.length) {
      const [key] = ordered.shift();
      archivedJobs.delete(key);
    }
  }
}

function archiveAndDetachJob(tabId, job) {
  if (!job) return;
  if (jobsByTab.get(tabId) === job) jobsByTab.delete(tabId);
  const key = `${tabId}:${job.chatUuid || 'unknown'}:${++nextArchiveSeq}`;
  archivedJobs.set(key, job);
  capJobs();
}

function storageSession() {
  try { return chrome.storage?.session || null; } catch { return null; }
}

function sessionEntryFor(job) {
  if (job._sessionEntry) return job._sessionEntry;
  const entry = {
    ...publicJob(job),
    progress: job.progress.slice(-SESSION_PROGRESS_CAP),
  };
  delete entry.finalizing;
  delete entry.hasInMemoryResult;
  job._sessionEntry = entry;
  return entry;
}

function serializableJobs() {
  return [...jobsByTab.values()].map(sessionEntryFor);
}

function persistJobs({ immediate = false } = {}) {
  const session = storageSession();
  if (!session) return;
  const write = () => {
    persistTimer = null;
    try { session.set({ [SESSION_KEY]: serializableJobs() }); } catch { /* quota / context gone */ }
  };
  if (immediate) {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    write();
    return;
  }
  if (persistTimer) return;
  persistTimer = setTimeout(write, SESSION_PERSIST_INTERVAL_MS);
  persistTimer?.unref?.();
}

async function restoreJobs() {
  const session = storageSession();
  if (!session?.get) return;
  let stored = null;
  try { stored = await session.get(SESSION_KEY); } catch { return; }
  const list = stored?.[SESSION_KEY];
  if (!Array.isArray(list)) return;
  for (const saved of list) {
    if (typeof saved?.tabId !== 'number') continue;
    const job = {
      ...newJob(saved.tabId),
      ...saved,
      pendingResult: null,
      finalizing: false,
      awaitingJobStart: false,
      lastProfile: null,
      _sessionEntry: null,
    };
    delete job.hasInMemoryResult;
    if (!job.chatUuid && job.sourceUrl) job.chatUuid = chatUuidFromUrl(job.sourceUrl);
    if (job.status === 'running' && now() - (job.updatedAt || 0) > STALE_RUNNING_MS) {
      // The tab died while the service worker was down; its content script
      // cannot re-attach, so surface the loss instead of an endless spinner.
      job.status = 'error';
      job.error = 'Lost contact with the Arena tab (browser restart). Start the export again.';
      job.unseen = !openPopups.size;
    }
    // Never clobber a live job that connected while the restore was in flight.
    if (!jobsByTab.has(job.tabId)) {
      jobsByTab.set(job.tabId, job);
      if (job.chatUuid) knownTabChat.set(job.tabId, job.chatUuid);
      if (job.sourceUrl) knownTabUrl.set(job.tabId, job.sourceUrl);
    }
  }
}

function emitToPopups(tabId, message) {
  const ports = popupPortsByTab.get(tabId);
  if (ports) for (const port of [...ports]) postSafe(port, message);
  for (const port of [...listenerPorts]) postSafe(port, message);
}

function broadcastStatus(job) {
  emitToPopups(job.tabId, { type: 'AREX_STATUS', job: publicJob(job) });
}

function noteProgress(job, event) {
  job.progress.push({ ...event, at: event.at || now() });
  if (job.progress.length > PROGRESS_CAP) job.progress.shift();
  job.updatedAt = now();
  invalidateSessionCache(job);
  emitToPopups(job.tabId, { type: 'AREX_PROGRESS', tabId: job.tabId, ...event });
  persistJobs();
  updateIndicator();
}

function setJobStatus(job, status, extra = {}) {
  job.status = status;
  Object.assign(job, extra);
  job.unseen = (status === 'done' || status === 'stopped' || status === 'error') && !openPopups.size &&
    !(status === 'error' && /^Export cancelled\.?$/i.test(job.error || ''));
  job.updatedAt = now();
  invalidateSessionCache(job);
  broadcastStatus(job);
  persistJobs({ immediate: true });
  updateIndicator();
}

const postSafe = (port, message) => {
  try { port?.postMessage(message); } catch { /* peer went away */ }
};

// --- Result assembly & scoped persistence ----------------------------------

function ensurePendingResult(job) {
  if (!job.pendingResult) {
    job.pendingResult = {
      chunks: new Map(),
      codeUnits: 0,
      utf8Bytes: 0,
      totalChunks: null,
      startedAt: now(),
    };
  }
  return job.pendingResult;
}

function isPartialEndMessage(msg, job) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.partial === true) return true;
  if (msg.outcome === 'partial' || msg.outcome === 'cancelled_partial' || msg.outcome === 'stopped') return true;
  const hasPayload = Boolean(job?.pendingResult?.chunks?.size) || typeof msg.markdown === 'string';
  if (hasPayload && msg.partial !== false && (msg.cancelled === true || /partial|cancel|stop/i.test(String(msg.outcome || msg.error || '')))) {
    return true;
  }
  return false;
}

async function finalizeResult(job, endMessage, { partial = false } = {}) {
  const pending = job.pendingResult;
  let markdown = '';
  let bytes = 0;
  if (pending && pending.chunks) {
    const ordered = [...pending.chunks.entries()].sort((a, b) => a[0] - b[0]);
    if (!ordered.length || ordered.some(([seq], index) => seq !== index)) {
      job.pendingResult = null;
      setJobStatus(job, 'error', { error: 'Export transfer was incomplete; retry the export.' });
      return;
    }
    bytes = pending.utf8Bytes + boundarySurrogateByteDelta(ordered);
    markdown = ordered.map(([, data]) => data).join('');
  } else if (typeof endMessage?.markdown === 'string') {
    markdown = endMessage.markdown; // single-message transfer (small exports)
    if (markdown.length > CHUNK_LIMIT_CODE_UNITS) {
      job.pendingResult = null;
      setJobStatus(job, 'error', { error: 'Export is too large to transfer to the background worker.' });
      return;
    }
    bytes = utf8ByteLength(markdown);
    job.transferStats = {
      receivedChunks: 1,
      totalChunks: 1,
      receivedChars: markdown.length,
      receivedUtf8Bytes: bytes,
    };
  } else {
    job.pendingResult = null;
    setJobStatus(job, 'error', { error: 'Export transfer contained no result; retry the export.' });
    return;
  }
  job.pendingResult = null;
  if (endMessage?.bytes != null && (!Number.isSafeInteger(endMessage.bytes) || endMessage.bytes !== bytes)) {
    setJobStatus(job, 'error', { error: 'Export transfer size did not match; retry the export.' });
    return;
  }

  const resolvedChat = job.chatUuid || resolveMessageChatUuid(endMessage) || chatUuidFromUrl(job.sourceUrl) || null;
  if (resolvedChat && !job.chatUuid) job.chatUuid = resolvedChat;

  const rawStats = endMessage?.stats && typeof endMessage.stats === 'object'
    ? { ...endMessage.stats }
    : { messages: 0, expandedSpoilers: 0 };
  const completedMessages = Number.isInteger(endMessage?.completedMessages)
    ? endMessage.completedMessages
    : (Number.isInteger(rawStats.completedMessages)
      ? rawStats.completedMessages
      : (Number.isInteger(rawStats.messages) ? rawStats.messages : 0));
  const totalMessages = Number.isInteger(endMessage?.totalMessages)
    ? endMessage.totalMessages
    : (Number.isInteger(rawStats.totalMessages) ? rawStats.totalMessages : completedMessages);
  if (partial) {
    if (!Number.isInteger(rawStats.messages)) rawStats.messages = completedMessages;
    if (!Number.isInteger(rawStats.completedMessages)) rawStats.completedMessages = completedMessages;
    if (!Number.isInteger(rawStats.totalMessages)) rawStats.totalMessages = totalMessages;
  }

  const snapshot = {
    markdown,
    filename: endMessage?.filename || (partial ? 'arena-export-partial.md' : 'arena-export.md'),
    stats: rawStats,
    warnings: Array.isArray(endMessage?.warnings) ? endMessage.warnings : [],
    createdAt: endMessage?.createdAt || now(),
    tabId: job.tabId,
    chatUuid: job.chatUuid,
    sourceUrl: job.sourceUrl,
    bytes,
    partial: Boolean(partial),
    completedMessages,
    totalMessages,
  };

  const validProfile = isValidProfile(endMessage?.profile) ? endMessage.profile : null;
  job.lastProfile = validProfile;

  // Preserve metadata even if persistence fails and the popup must recover the
  // in-memory result; do not ACK until the IndexedDB transaction commits.
  job.resultMeta = {
    filename: snapshot.filename,
    bytes,
    stats: snapshot.stats,
    warnings: snapshot.warnings,
    createdAt: snapshot.createdAt,
    partial: Boolean(partial),
    completedMessages,
    totalMessages,
  };
  invalidateSessionCache(job);

  if (RESULT_STORE) {
    try {
      if (typeof RESULT_STORE.saveForScope === 'function') {
        const savedMeta = await RESULT_STORE.saveForScope(
          { tabId: job.tabId, chatUuid: job.chatUuid },
          snapshot,
          { partial: Boolean(partial), profile: validProfile },
        );
        if (savedMeta && typeof savedMeta === 'object') {
          job.resultMeta = {
            ...job.resultMeta,
            ...savedMeta,
            partial: Boolean(partial),
            completedMessages,
            totalMessages,
          };
        }
      } else {
        await RESULT_STORE.save(snapshot);
        try {
          if (validProfile && typeof RESULT_STORE.saveProfile === 'function') await RESULT_STORE.saveProfile(validProfile);
          else if (!validProfile && typeof RESULT_STORE.clearProfile === 'function') await RESULT_STORE.clearProfile();
        } catch { /* profile unavailable; snapshot is still saved */ }
      }
      setJobStatus(job, partial ? 'stopped' : 'done', { error: null });
      postSafe(jobPortsByTab.get(job.tabId), { type: 'AREX_RESULT_ACK', partial: Boolean(partial) });
      return;
    } catch (error) {
      // Keep the assembled result in memory so an open popup can still recover it.
      job.pendingResult = {
        markdown,
        chunks: null,
        codeUnits: markdown.length,
        utf8Bytes: bytes,
        partial: Boolean(partial),
        completedMessages,
        totalMessages,
        startedAt: now(),
      };
      setJobStatus(job, 'error', { error: 'Could not save the snapshot: ' + String(error?.message || error) });
      return;
    }
  }
  job.pendingResult = {
    markdown,
    chunks: null,
    codeUnits: markdown.length,
    utf8Bytes: bytes,
    partial: Boolean(partial),
    completedMessages,
    totalMessages,
    startedAt: now(),
  };
  setJobStatus(job, 'error', { error: 'Snapshot storage is unavailable in the background worker.' });
}

// --- Anytime diagnostic log RPC (AREX_EXPORT_LOG) --------------------------

function resolvePendingDumpLogs(tabId, snapshot) {
  const waiters = pendingDumpLogsByTab.get(tabId);
  if (!waiters || !waiters.size) return;
  const reqId = snapshot?.requestId;
  if (reqId !== undefined && waiters.has(reqId)) {
    const fn = waiters.get(reqId);
    waiters.delete(reqId);
    if (!waiters.size) pendingDumpLogsByTab.delete(tabId);
    fn(snapshot);
    return;
  }
  for (const [id, fn] of [...waiters.entries()]) {
    waiters.delete(id);
    fn(snapshot);
  }
  pendingDumpLogsByTab.delete(tabId);
}

function queryTabDiagnostics(tabId) {
  if (typeof tabId !== 'number') {
    return Promise.resolve({
      ok: false,
      via: null,
      snapshot: null,
      timedOut: false,
      reason: 'No Arena tab selected for diagnostic log query.',
    });
  }
  return new Promise(resolve => {
    let settled = false;
    const requestId = ++nextDumpRequestId;
    const jobPort = jobPortsByTab.get(tabId) || null;
    const hasJobPort = Boolean(jobPort);
    let timer = null;

    const cleanupPortWaiter = () => {
      const waiters = pendingDumpLogsByTab.get(tabId);
      if (waiters) {
        waiters.delete(requestId);
        if (!waiters.size) pendingDumpLogsByTab.delete(tabId);
      }
    };

    const finish = result => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      cleanupPortWaiter();
      resolve(result);
    };

    if (hasJobPort) {
      const waiters = pendingDumpLogsByTab.get(tabId) || new Map();
      waiters.set(requestId, snapshot => {
        finish({ ok: true, via: 'jobPort', snapshot, timedOut: false, reason: null });
      });
      pendingDumpLogsByTab.set(tabId, waiters);
      postSafe(jobPort, { type: 'AREX_DUMP_LOG', requestId });
    }

    timer = setTimeout(() => {
      finish({
        ok: false,
        via: null,
        snapshot: null,
        timedOut: true,
        reason: `Content tab did not respond within ${DUMP_LOG_TIMEOUT_MS} ms (main thread may be busy or unresponsive).`,
      });
    }, DUMP_LOG_TIMEOUT_MS);

    try {
      chrome.tabs.sendMessage(tabId, { type: 'AREX_DUMP_LOG', requestId }, response => {
        const lastError = chrome.runtime?.lastError;
        if (lastError) {
          if (!hasJobPort) {
            finish({
              ok: false,
              via: null,
              snapshot: null,
              timedOut: false,
              reason: lastError.message || 'No active content script responder in tab.',
            });
          }
          return;
        }
        if (response && typeof response === 'object') {
          finish({ ok: true, via: 'tabs.sendMessage', snapshot: response, timedOut: false, reason: null });
          return;
        }
        if (!hasJobPort) {
          finish({
            ok: false,
            via: null,
            snapshot: null,
            timedOut: false,
            reason: 'No active content script responder in tab.',
          });
        }
      });
    } catch (error) {
      if (!hasJobPort) {
        finish({
          ok: false,
          via: null,
          snapshot: null,
          timedOut: false,
          reason: String(error?.message || error),
        });
      }
    }
  });
}

function buildDiagnosticBundle({ tabId, chatUuid, sourceUrl, job, tabDump }) {
  const tabSnapshot = tabDump?.ok && tabDump.snapshot && typeof tabDump.snapshot === 'object'
    ? tabDump.snapshot
    : null;
  const pending = job?.pendingResult;
  const stats = job?.transferStats || { receivedChunks: 0, totalChunks: null, receivedChars: 0, receivedUtf8Bytes: 0 };
  const receivedChunks = pending?.chunks
    ? pending.chunks.size
    : (typeof pending?.markdown === 'string' ? 1 : (stats.receivedChunks ?? 0));
  const receivedChars = pending ? (pending.codeUnits ?? 0) : (stats.receivedChars ?? 0);
  const receivedUtf8Bytes = pending ? (pending.utf8Bytes ?? 0) : (stats.receivedUtf8Bytes ?? 0);
  const totalChunks = pending?.totalChunks ?? stats.totalChunks ?? null;

  const effectiveStatus = job
    ? (job.finalizing ? 'finalizing' : job.status)
    : (typeof tabSnapshot?.status === 'string' ? tabSnapshot.status : 'idle');

  const tabProgress = Array.isArray(tabSnapshot?.progress) ? tabSnapshot.progress : null;
  const jobProgress = Array.isArray(job?.progress) ? job.progress : [];
  const mergedProgress = tabProgress && tabProgress.length >= jobProgress.length
    ? tabProgress.slice(-PROGRESS_CAP)
    : jobProgress.slice(-PROGRESS_CAP);

  const liveProfile = isValidProfile(tabSnapshot?.profile)
    ? tabSnapshot.profile
    : (isValidProfile(job?.lastProfile) ? job.lastProfile : null);

  const resolvedChatUuid = chatUuid
    || job?.chatUuid
    || normalizeChatUuid(tabSnapshot?.profile?.chatUuid)
    || chatUuidFromUrl(sourceUrl || job?.sourceUrl)
    || null;
  const resolvedSourceUrl = sourceUrl
    || job?.sourceUrl
    || (typeof tabSnapshot?.profile?.sourceUrl === 'string' && tabSnapshot.profile.sourceUrl ? tabSnapshot.profile.sourceUrl : null)
    || (typeof tabId === 'number' ? knownTabUrl.get(tabId) || null : null);

  const warnings = [];
  if (Array.isArray(job?.resultMeta?.warnings)) {
    for (const w of job.resultMeta.warnings) warnings.push(String(w));
  }
  if (tabDump?.timedOut && tabDump.reason) warnings.push(tabDump.reason);

  return {
    schemaVersion: 1,
    exportedAt: new Date(now()).toISOString(),
    createdAt: now(),
    tool: 'arena-transcript-export',
    toolVersion: CONTENT_FEATURE_VERSION,
    tabId: typeof tabId === 'number' ? tabId : null,
    chatUuid: resolvedChatUuid,
    sourceUrl: resolvedSourceUrl,
    status: effectiveStatus,
    tab: {
      responded: Boolean(tabDump?.ok),
      timedOut: Boolean(tabDump?.timedOut),
      via: tabDump?.via || null,
      notice: tabDump?.ok ? null : (tabDump?.reason || null),
      status: typeof tabSnapshot?.status === 'string' ? tabSnapshot.status : null,
    },
    coordinator: {
      status: job ? job.status : 'idle',
      effectiveStatus,
      finalizing: Boolean(job?.finalizing),
      startedAt: job?.startedAt || null,
      updatedAt: job?.updatedAt || null,
      error: job?.error || null,
      resultMeta: job?.resultMeta || null,
      hasJobPort: typeof tabId === 'number' ? jobPortsByTab.has(tabId) : false,
      hasInMemoryResult: Boolean(pending && typeof pending.markdown === 'string'),
      receivedChunks,
      totalChunks,
      receivedChars,
      receivedUtf8Bytes,
    },
    progress: mergedProgress,
    profile: liveProfile,
    warnings,
  };
}

async function handleExportLogRequest(port, msg, tabId) {
  const reqUrl = typeof (msg?.tabUrl || msg?.url) === 'string' ? (msg.tabUrl || msg.url) : null;
  const reqChatUuid = resolveMessageChatUuid(msg)
    || (typeof tabId === 'number' ? knownTabChat.get(tabId) || null : null);
  if (typeof tabId === 'number' && (reqUrl || reqChatUuid)) {
    reconcileTabScope(tabId, { url: reqUrl, chatUuid: reqChatUuid });
  }
  const job = typeof tabId === 'number' ? jobsByTab.get(tabId) || null : null;
  const tabDump = await queryTabDiagnostics(tabId);
  const bundle = buildDiagnosticBundle({
    tabId,
    chatUuid: reqChatUuid || job?.chatUuid || null,
    sourceUrl: reqUrl || job?.sourceUrl || null,
    job,
    tabDump,
  });

  if (RESULT_STORE && typeof RESULT_STORE.saveDiagnosticLog === 'function' &&
      (typeof bundle.tabId === 'number' || bundle.chatUuid)) {
    try {
      await RESULT_STORE.saveDiagnosticLog({ tabId: bundle.tabId, chatUuid: bundle.chatUuid }, bundle);
    } catch { /* best-effort persistence; log RPC still returns the bundle */ }
  }

  postSafe(port, {
    type: 'AREX_LOG_BUNDLE',
    ok: true,
    ...(msg?.requestId !== undefined ? { requestId: msg.requestId } : {}),
    tabId: bundle.tabId,
    chatUuid: bundle.chatUuid,
    timedOut: Boolean(tabDump.timedOut),
    bundle,
  });
}

// --- AREX_JOB port (content script -> background) ---------------------------

async function handleJobMessage(tabId, msg, port) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'AREX_DUMP_LOG_RESULT' || msg.type === 'AREX_DUMP_LOG' || msg.type === 'AREX_LOG_SNAPSHOT') {
    resolvePendingDumpLogs(tabId, msg);
    return;
  }
  if (msg.type === 'AREX_JOB_START') {
    const msgChatUuid = resolveMessageChatUuid(msg);
    const currentKnownChat = knownTabChat.get(tabId) || null;
    if (msg.resumed && currentKnownChat && msgChatUuid && msgChatUuid !== currentKnownChat) {
      // Ignore a stale reconnect from an earlier conversation after an SPA branch switch.
      return;
    }
    let job = jobsByTab.get(tabId);
    if (!job) {
      job = newJob(tabId);
      jobsByTab.set(tabId, job);
      capJobs();
    }
    job.chatUuid = msgChatUuid || job.chatUuid || null;
    job.sourceUrl = msg.sourceUrl || job.sourceUrl || null;
    if (job.chatUuid) knownTabChat.set(tabId, job.chatUuid);
    if (job.sourceUrl) knownTabUrl.set(tabId, job.sourceUrl);
    job.status = 'running';
    job.error = null;
    job.unseen = false;
    job.startedAt = msg.startedAt || now();
    job.resultMeta = null;
    job.pendingResult = null;
    job.transferStats = { receivedChunks: 0, totalChunks: null, receivedChars: 0, receivedUtf8Bytes: 0 };
    job.lastProfile = null;
    job.finalizing = false;
    job.awaitingJobStart = false;
    if (!msg.resumed) job.progress = [];
    if (Array.isArray(msg.progress) && msg.progress.length) {
      // Re-sync after a service-worker restart: adopt the tab's own log.
      job.progress = msg.progress.slice(-PROGRESS_CAP);
    }
    job.updatedAt = now();
    invalidateSessionCache(job);
    broadcastStatus(job);
    persistJobs({ immediate: true });
    updateIndicator();
    return;
  }

  const job = jobsByTab.get(tabId);
  if (!job || job.awaitingJobStart) return;
  const msgChat = normalizeChatUuid(msg.chatUuid);
  if (msgChat && job.chatUuid && msgChat !== job.chatUuid) return;

  switch (msg.type) {
    case 'AREX_PROGRESS':
      if (msg.stage === 'saving' && Number.isInteger(msg.totalChunks) && msg.totalChunks > 0) {
        if (job.pendingResult) job.pendingResult.totalChunks = msg.totalChunks;
        if (job.transferStats) job.transferStats.totalChunks = msg.totalChunks;
      }
      noteProgress(job, msg);
      return;
    case 'AREX_HEARTBEAT':
      job.updatedAt = now();
      invalidateSessionCache(job);
      persistJobs();
      return;
    case 'AREX_RESULT_CHUNK': {
      if (job.status !== 'running' || job.finalizing) return;
      if (!Number.isSafeInteger(msg.seq) || msg.seq < 0 || typeof msg.data !== 'string') {
        job.pendingResult = null;
        setJobStatus(job, 'error', { error: 'Invalid export chunk; retry the export.' });
        return;
      }
      const pending = ensurePendingResult(job);
      if (pending.chunks.has(msg.seq)) {
        job.pendingResult = null;
        setJobStatus(job, 'error', { error: 'Duplicate export chunk; retry the export.' });
        return;
      }
      pending.codeUnits += msg.data.length;
      if (pending.codeUnits > CHUNK_LIMIT_CODE_UNITS) {
        job.pendingResult = null;
        setJobStatus(job, 'error', { error: 'Export is too large to transfer to the background worker.' });
        return;
      }
      pending.utf8Bytes += utf8ByteLength(msg.data);
      if (Number.isInteger(msg.totalChunks) && msg.totalChunks > 0) pending.totalChunks = msg.totalChunks;
      pending.chunks.set(msg.seq, msg.data);
      const receivedChunks = pending.chunks.size;
      const totalChunks = pending.totalChunks || null;
      job.transferStats = {
        receivedChunks,
        totalChunks,
        receivedChars: pending.codeUnits,
        receivedUtf8Bytes: pending.utf8Bytes,
      };
      noteProgress(job, {
        stage: 'saving',
        phase: 'transfer',
        receivedChunks,
        totalChunks,
        receivedChars: pending.codeUnits,
        receivedBytes: pending.utf8Bytes,
      });
      return;
    }
    case 'AREX_RESULT_END': {
      if (job.status !== 'running' || job.finalizing) return;
      const partial = isPartialEndMessage(msg, job);
      if (!partial && msg.ok === false) {
        job.pendingResult = null;
        const validProfile = isValidProfile(msg.profile) ? msg.profile : null;
        job.lastProfile = validProfile;
        setJobStatus(job, 'error', { error: msg.error || 'Export failed.' });
        if (validProfile && RESULT_STORE) {
          try {
            if (typeof RESULT_STORE.saveDiagnosticLog === 'function') {
              const bundle = buildDiagnosticBundle({
                tabId: job.tabId,
                chatUuid: job.chatUuid,
                sourceUrl: job.sourceUrl,
                job,
                tabDump: { ok: true, via: 'resultEnd', snapshot: { status: 'error', progress: job.progress, profile: validProfile }, timedOut: false },
              });
              await RESULT_STORE.saveDiagnosticLog({ tabId: job.tabId, chatUuid: job.chatUuid }, bundle);
            } else if (typeof RESULT_STORE.saveProfile === 'function') {
              await RESULT_STORE.saveProfile(validProfile);
            }
          } catch { /* best effort */ }
        }
        return;
      }
      job.finalizing = true;
      invalidateSessionCache(job);
      void finalizeResult(job, msg, { partial }).finally(() => { job.finalizing = false; });
      return;
    }
    default:
      return;
  }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'AREX_JOB') {
    const tabId = port.sender?.tab?.id;
    if (typeof tabId !== 'number') { port.disconnect(); return; }
    if (!jobsByTab.has(tabId)) {
      jobsByTab.set(tabId, newJob(tabId));
      capJobs();
    }
    jobPortsByTab.set(tabId, port);
    port.onMessage.addListener(msg => {
      if (jobPortsByTab.get(tabId) !== port) return;
      return handleJobMessage(tabId, msg, port);
    });
    port.onDisconnect.addListener(() => {
      // An obsolete port must not fail a newer connection for the same tab.
      if (jobPortsByTab.get(tabId) !== port) return;
      jobPortsByTab.delete(tabId);
      const activeJob = jobsByTab.get(tabId);
      if (!activeJob || activeJob.status !== 'running' || activeJob.finalizing) return;
      // Allow the content script's reconnect attempts, but do not leave a
      // crashed tab spinning indefinitely when no tabs event is delivered.
      const timer = setTimeout(() => {
        if (jobsByTab.get(tabId) === activeJob && activeJob.status === 'running' && !activeJob.finalizing &&
            !jobPortsByTab.has(tabId) && now() - activeJob.updatedAt >= 5000)
          setJobStatus(activeJob, 'error', { error: 'Lost contact with the Arena tab before the export finished.' });
      }, 6000);
      timer?.unref?.(); // Node test harness; browser timer IDs are numeric.
    });
    return;
  }

  if (port.name === 'AREX_POPUP') {
    openPopups.add(port);
    // Opening the popup acknowledges all notifications represented by the global icon.
    void restored.then(() => {
      if (!openPopups.has(port)) return;
      for (const job of jobsByTab.values()) { job.unseen = false; invalidateSessionCache(job); }
      for (const job of archivedJobs.values()) { job.unseen = false; invalidateSessionCache(job); }
      persistJobs({ immediate: true });
      updateIndicator();
    });
    let subscribedTabId = null, disconnected = false;
    port.onMessage.addListener(async msg => {
      if (!msg || typeof msg !== 'object') return;
      // The service worker may have been woken by this popup before its
      // asynchronous session restore has finished. Never reply with a false
      // empty status or start a competing export during that restore.
      await restored;
      if (disconnected) return;
      const tabId = typeof msg.tabId === 'number' ? msg.tabId : subscribedTabId;
      switch (msg.type) {
        case 'AREX_HELLO': {
          const nextTabId = typeof msg.tabId === 'number' ? msg.tabId : null;
          if (subscribedTabId !== null && subscribedTabId !== nextTabId) {
            const prev = popupPortsByTab.get(subscribedTabId);
            prev?.delete(port);
            if (prev && !prev.size) popupPortsByTab.delete(subscribedTabId);
          }
          listenerPorts.delete(port);
          subscribedTabId = nextTabId;
          if (subscribedTabId !== null) {
            const reqUrl = typeof (msg.tabUrl || msg.url) === 'string' ? (msg.tabUrl || msg.url) : null;
            const reqChatUuid = resolveMessageChatUuid(msg);
            if (reqUrl || reqChatUuid) {
              reconcileTabScope(subscribedTabId, { url: reqUrl, chatUuid: reqChatUuid, broadcastOnRunningAbort: false });
            }
            const set = popupPortsByTab.get(subscribedTabId) || new Set();
            set.add(port);
            popupPortsByTab.set(subscribedTabId, set);
          } else {
            listenerPorts.add(port);
          }
          postSafe(port, { type: 'AREX_STATUS', job: publicJob(subscribedTabId !== null ? jobsByTab.get(subscribedTabId) || null : null) });
          return;
        }
        case 'AREX_GET_STATUS': {
          if (typeof tabId === 'number') {
            const reqUrl = typeof (msg.tabUrl || msg.url) === 'string' ? (msg.tabUrl || msg.url) : null;
            const reqChatUuid = resolveMessageChatUuid(msg);
            if (reqUrl || reqChatUuid) {
              reconcileTabScope(tabId, { url: reqUrl, chatUuid: reqChatUuid, broadcastOnRunningAbort: false });
            }
          }
          postSafe(port, { type: 'AREX_STATUS', job: publicJob(typeof tabId === 'number' ? jobsByTab.get(tabId) || null : null) });
          return;
        }
        case 'AREX_LIST_JOBS': {
          const jobs = [...jobsByTab.values()]
            .map(publicJob)
            .filter(j => j.status === 'running' || j.status === 'done' || j.status === 'stopped' || j.status === 'error');
          postSafe(port, { type: 'AREX_JOBS', jobs });
          return;
        }
        case 'AREX_EXPORT_START': {
          if (typeof tabId !== 'number') { postSafe(port, { type: 'AREX_ERROR', error: 'No target tab for the export.' }); return; }
          await startExportInTab(tabId, msg.options || {}, {
            chatUuid: resolveMessageChatUuid(msg),
            sourceUrl: typeof (msg.tabUrl || msg.url) === 'string' ? (msg.tabUrl || msg.url) : null,
          });
          return;
        }
        case 'AREX_EXPORT_CANCEL': {
          if (typeof tabId !== 'number') return;
          cancelExportInTab(tabId);
          return;
        }
        case 'AREX_EXPORT_LOG': {
          await handleExportLogRequest(port, msg, tabId);
          return;
        }
        case 'AREX_GET_INMEMORY_RESULT': {
          const job = typeof tabId === 'number' ? jobsByTab.get(tabId) : null;
          const pending = job?.pendingResult;
          if (pending && typeof pending.markdown === 'string') {
            postSafe(port, {
              type: 'AREX_INMEMORY_RESULT',
              ok: true,
              markdown: pending.markdown,
              filename: job.resultMeta?.filename || 'arena-export.md',
              stats: job.resultMeta?.stats || null,
              warnings: job.resultMeta?.warnings || [],
              partial: Boolean(pending.partial || job.resultMeta?.partial),
              completedMessages: job.resultMeta?.completedMessages ?? pending.completedMessages ?? null,
              totalMessages: job.resultMeta?.totalMessages ?? pending.totalMessages ?? null,
            });
          } else {
            postSafe(port, { type: 'AREX_INMEMORY_RESULT', ok: false, error: 'The in-progress snapshot is no longer available.' });
          }
          return;
        }
        case 'AREX_POPUP_OPENED': {
          // User looked at the final state: clear "done"/"stopped"/"error" visibility markers.
          const job = typeof tabId === 'number' ? jobsByTab.get(tabId) : null;
          if (job) {
            job.unseen = false;
            invalidateSessionCache(job);
            persistJobs({ immediate: true });
            updateIndicator();
          }
          return;
        }
        default:
          return;
      }
    });
    port.onDisconnect.addListener(() => {
      disconnected = true;
      if (subscribedTabId !== null) {
        const set = popupPortsByTab.get(subscribedTabId);
        set?.delete(port);
        if (set && !set.size) popupPortsByTab.delete(subscribedTabId);
      }
      listenerPorts.delete(port);
      openPopups.delete(port);
    });
    return;
  }
});

// --- Export start / cancel plumbing -----------------------------------------

async function pingContent(tabId) {
  return new Promise(resolve => {
    let done = false;
    const fin = value => { if (!done) { done = true; resolve(value); } };
    try {
      chrome.tabs.sendMessage(tabId, { type: 'AREX_PING' }, response => {
        if (chrome.runtime.lastError) return fin(null);
        fin(response || null);
      });
    } catch { fin(null); }
    setTimeout(() => fin(null), 800);
  });
}

function sendCancelSignalToTab(tabId) {
  const port = jobPortsByTab.get(tabId);
  if (port) postSafe(port, { type: 'AREX_EXPORT_CANCEL' });
  try { chrome.tabs.sendMessage(tabId, { type: 'AREX_EXPORT_CANCEL' }, () => void chrome.runtime.lastError); } catch { /* tab gone */ }
}

async function startExportInTab(tabId, options, meta = {}) {
  const reqChatUuid = normalizeChatUuid(meta?.chatUuid) || chatUuidFromUrl(meta?.sourceUrl);
  const reqUrl = typeof meta?.sourceUrl === 'string' && meta.sourceUrl ? meta.sourceUrl : null;
  if (reqUrl || reqChatUuid) {
    reconcileTabScope(tabId, { url: reqUrl, chatUuid: reqChatUuid });
  }
  const job = jobsByTab.get(tabId);
  if (job?.status === 'running') {
    // Re-sync the popup with the running job instead of failing the start.
    broadcastStatus(job);
    return;
  }
  let readiness = await pingContent(tabId);
  if (readiness?.ok && readiness.featureVersion !== CONTENT_FEATURE_VERSION) readiness = null;
  if (!readiness?.ok) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
    } catch (error) {
      const failed = jobsByTab.get(tabId) || newJob(tabId);
      jobsByTab.set(tabId, failed);
      setJobStatus(failed, 'error', { error: 'Could not inject the export script: ' + String(error?.message || error) });
      return;
    }
  }
  // Fresh or re-injected job: ignore any trailing messages until AREX_JOB_START arrives.
  const fresh = newJob(tabId);
  fresh.chatUuid = reqChatUuid || knownTabChat.get(tabId) || null;
  fresh.sourceUrl = reqUrl || knownTabUrl.get(tabId) || null;
  fresh.awaitingJobStart = true;
  jobsByTab.set(tabId, fresh);
  capJobs();
  broadcastStatus(fresh);
  persistJobs({ immediate: true });
  updateIndicator();
  try {
    chrome.tabs.sendMessage(tabId, { type: 'AREX_EXPORT_START', options }, () => void chrome.runtime.lastError);
  } catch (error) {
    fresh.awaitingJobStart = false;
    setJobStatus(fresh, 'error', { error: 'Could not start the export: ' + String(error?.message || error) });
  }
}

function cancelExportInTab(tabId) {
  const job = jobsByTab.get(tabId);
  sendCancelSignalToTab(tabId);
  if (job?.status === 'running') noteProgress(job, { stage: 'cancel', phase: 'requested' });
}

// --- Tab lifecycle & SPA branch isolation -----------------------------------

function failRunningJob(tabId, error) {
  const job = jobsByTab.get(tabId);
  if (job?.status === 'running') {
    job.pendingResult = null;
    setJobStatus(job, 'error', { error });
  }
}

function abortAndDetachSwitchedJob(tabId, job, error, { broadcast = true } = {}) {
  sendCancelSignalToTab(tabId);
  job.pendingResult = null;
  job.finalizing = false;
  if (broadcast) {
    setJobStatus(job, 'error', { error });
  } else {
    job.status = 'error';
    job.error = error;
    job.unseen = !openPopups.size;
    job.updatedAt = now();
    invalidateSessionCache(job);
  }
  archiveAndDetachJob(tabId, job);
  persistJobs({ immediate: true });
  updateIndicator();
}

function reconcileTabScope(tabId, { url = null, chatUuid = null, broadcastOnRunningAbort = true } = {}) {
  const parsed = url ? parseArenaAgentUrl(url) : null;
  const isArena = parsed ? parsed.isArena : true;
  const nextChatUuid = normalizeChatUuid(chatUuid) || (parsed ? parsed.chatUuid : null);

  if (url) {
    if (isArena) knownTabUrl.set(tabId, url);
    else knownTabUrl.delete(tabId);
  }
  if (isArena) {
    if (nextChatUuid) knownTabChat.set(tabId, nextChatUuid);
    else if (url) knownTabChat.delete(tabId);
  } else {
    knownTabChat.delete(tabId);
  }

  const job = jobsByTab.get(tabId);
  if (!job) return;
  const jobChat = job.chatUuid || chatUuidFromUrl(job.sourceUrl);

  if (!isArena) {
    if (job.status === 'running') {
      abortAndDetachSwitchedJob(tabId, job, 'Tab was navigated away before the scan finished.', { broadcast: broadcastOnRunningAbort });
    } else {
      archiveAndDetachJob(tabId, job);
      persistJobs({ immediate: true });
      updateIndicator();
    }
    return;
  }

  // Still on arena.ai/agent/*: check whether the conversation branch changed.
  const switchedBranch = jobChat
    ? (nextChatUuid !== jobChat && (url !== null || nextChatUuid !== null))
    : Boolean(job.sourceUrl && url && nextChatUuid !== chatUuidFromUrl(job.sourceUrl));

  if (job.status === 'running') {
    if (switchedBranch) {
      abortAndDetachSwitchedJob(
        tabId,
        job,
        'Tab switched to a different Arena conversation before the scan finished.',
        { broadcast: broadcastOnRunningAbort },
      );
      return;
    }
    if (!job.chatUuid && nextChatUuid) { job.chatUuid = nextChatUuid; invalidateSessionCache(job); }
    if (url) { job.sourceUrl = url; invalidateSessionCache(job); }
    return;
  }

  // Finished job (done / stopped / error): detach if branch changed so new branch starts clean.
  if (switchedBranch || (!jobChat && nextChatUuid)) {
    archiveAndDetachJob(tabId, job);
    persistJobs({ immediate: true });
    updateIndicator();
  }
}

if (chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener(tabId => {
    failRunningJob(tabId, 'Tab was closed before the scan finished.');
    jobPortsByTab.delete(tabId);
    knownTabChat.delete(tabId);
    knownTabUrl.delete(tabId);
    pendingDumpLogsByTab.delete(tabId);
    const ports = popupPortsByTab.get(tabId);
    if (ports) { for (const port of ports) postSafe(port, { type: 'AREX_STATUS', job: publicJob(jobsByTab.get(tabId) || null) }); }
  });
}

if (chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const url = changeInfo?.url;
    if (!url) return;
    reconcileTabScope(tabId, { url, broadcastOnRunningAbort: true });
  });
}

// --- Global toolbar indicator -----------------------------------------------
// A global action reflects all tabs: running jobs take precedence, then the
// newest unseen error, then the newest unseen stopped/done snapshot. A single
// timer and a coalescing async renderer prevent overlapping setIcon calls.
const ICON_SETS = {
  light: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  dark: { 16: 'icons/icon16-dark.png', 32: 'icons/icon32-dark.png', 48: 'icons/icon48-dark.png', 128: 'icons/icon128-dark.png' },
};
const DEFAULT_TITLE = 'Export Arena transcript to Markdown';
const iconBitmaps = new Map();
let indicatorTheme = 'light';
let themeRevision = 0;
let indicatorTimer = null;
let indicatorFrame = 0;
let renderRevision = 0;
let rendering = false;

function indicatorState() {
  const active = [...jobsByTab.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  const running = active.find(job => job.status === 'running');
  if (running) return { kind: 'running', job: running };
  const all = [...jobsByTab.values(), ...archivedJobs.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  const error = all.find(job => job.status === 'error' && job.unseen);
  if (error) return { kind: 'error', job: error };
  const finished = all.find(job => (job.status === 'done' || job.status === 'stopped') && job.unseen);
  return finished ? { kind: finished.status, job: finished } : { kind: 'idle' };
}

function progressDetails(job) {
  const event = [...job.progress].reverse().find(p => p.stage && !['cancel', 'done'].includes(p.stage)) || {};
  const messageCounts = Number.isFinite(event.processedMessages) && Number.isFinite(event.totalMessages) && event.totalMessages > 0
    ? `${event.processedMessages}/${event.totalMessages} msgs` : '';
  const spoilerCounts = Number.isFinite(event.expandedSpoilers)
    ? Number.isFinite(event.totalSpoilers) && event.totalSpoilers > 0
      ? `${event.expandedSpoilers}/${event.totalSpoilers} spoilers`
      : `${event.expandedSpoilers} spoilers`
    : '';
  const counts = [messageCounts, spoilerCounts].filter(Boolean).join(' · ');
  let percent = Number.isFinite(event.percent) ? Math.max(0, Math.min(100, Math.round(event.percent))) : null;
  if (percent === null && messageCounts) percent = Math.max(0, Math.min(100, Math.round(event.processedMessages / event.totalMessages * 100)));
  if (event.stage === 'history') return { badge: event.pages ? `p${event.pages}` : '1/3', percent: null, title: `Loading history${Number.isFinite(event.loaded) ? `: ${event.loaded} msgs` : ''}…` };
  if (event.stage === 'process') return { badge: percent === null ? '2/3' : `${percent}%`, percent,
    title: `Scanning${percent === null ? '' : ` ${percent}%`}${counts ? ` (${counts})` : ''}…` };
  if (event.stage === 'expand') return { badge: '45%', percent: 45, title: `Opening spoilers${Number.isFinite(event.expanded) ? `: ${event.expanded} opened` : ''}…` };
  if (event.stage === 'serialize') {
    const pct = job.progress.some(p => p.stage === 'process') ? 100 : 75;
    return { badge: `${pct}%`, percent: pct, title: event.phase === 'done' ? 'Saving snapshot…' : 'Converting Markdown…' };
  }
  if (event.stage === 'cleanup') return { badge: '90%', percent: 90, title: `Cleaning up${Number.isFinite(event.closed) && Number.isFinite(event.total) ? ` (${event.closed}/${event.total})` : ''}…` };
  if (event.stage === 'saving') {
    const doneChunks = Number.isInteger(event.receivedChunks) ? event.receivedChunks : (Number.isInteger(event.sentChunks) ? event.sentChunks : 0);
    const chunkInfo = doneChunks > 0
      ? (Number.isInteger(event.totalChunks) && event.totalChunks > 0
        ? ` (${doneChunks}/${event.totalChunks} chunks)`
        : ` (chunk ${doneChunks})`)
      : '';
    return { badge: '99%', percent: 99, title: `Saving snapshot${chunkInfo}…` };
  }
  return { badge: '1/3', percent: null, title: 'Starting export…' };
}

function byteLabel(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1000000).toFixed(2)} MB`;
}

function bitmapFor(theme, size) {
  const path = ICON_SETS[theme][size];
  if (!iconBitmaps.has(path)) {
    const promise = fetch(chrome.runtime.getURL(path)).then(response => {
      if (!response.ok) throw new Error(`Icon fetch failed: ${path}`);
      return response.blob();
    }).then(blob => createImageBitmap(blob));
    iconBitmaps.set(path, promise);
    promise.catch(() => iconBitmaps.delete(path));
  }
  return iconBitmaps.get(path);
}

async function drawIcon(state, theme, frame) {
  const entries = await Promise.all([16, 32].map(async size => {
    const bitmap = await bitmapFor(theme, size);
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, size, size);
    const x = size * 0.74, y = size * 0.74, radius = size * 0.20;
    ctx.beginPath(); ctx.arc(x, y, radius + size * 0.045, 0, Math.PI * 2);
    ctx.fillStyle = theme === 'dark' ? '#202124' : '#ffffff'; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, radius * 0.72, 0, Math.PI * 2);
    if (state.kind !== 'running') {
      ctx.fillStyle = state.kind === 'done' ? '#188038' : state.kind === 'stopped' ? '#e37400' : '#d93025';
      ctx.fill();
      if (state.kind === 'stopped' && typeof ctx.fillRect === 'function') {
        const barW = Math.max(1, size * 0.045);
        const barH = Math.max(2, radius * 0.78);
        const gap = Math.max(1, size * 0.03);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x - gap / 2 - barW, y - barH / 2, barW, barH);
        ctx.fillRect(x + gap / 2, y - barH / 2, barW, barH);
      }
    } else {
      ctx.strokeStyle = theme === 'dark' ? '#8ab4f8' : '#1a73e8';
      ctx.lineWidth = Math.max(1.5, size * 0.09); ctx.globalAlpha = 0.24; ctx.stroke();
      ctx.globalAlpha = 1; ctx.beginPath();
      const percent = progressDetails(state.job).percent;
      const start = -Math.PI / 2 + (percent === null ? frame * Math.PI / 5 : 0);
      ctx.arc(x, y, radius * 0.72, start, start + (percent === null ? Math.PI * 1.2 : Math.max(0.05, percent / 100 * Math.PI * 2)));
      ctx.lineCap = 'round'; ctx.stroke();
    }
    return [size, ctx.getImageData(0, 0, size, size)];
  }));
  return Object.fromEntries(entries);
}

function stoppedIndicatorTitle(job) {
  const meta = job?.resultMeta || {};
  const msgSummary = Number.isInteger(meta.completedMessages) && Number.isInteger(meta.totalMessages) && meta.totalMessages > 0
    ? `${meta.completedMessages}/${meta.totalMessages} msgs`
    : '';
  const bytes = byteLabel(meta.bytes);
  const info = [msgSummary, bytes].filter(Boolean).join(' · ');
  return `Stopped · partial snapshot ready${info ? ` (${info})` : ''}`;
}

async function renderIndicator(revision) {
  const state = indicatorState(), theme = indicatorTheme, frame = indicatorFrame;
  const detail = state.kind === 'running' ? progressDetails(state.job) : null;
  const badge = detail?.badge || (state.kind === 'done' ? '✓' : state.kind === 'stopped' ? '‖' : state.kind === 'error' ? '!' : '');
  const color = state.kind === 'done' ? '#188038' : state.kind === 'stopped' ? '#e37400' : state.kind === 'error' ? '#d93025' : '#1a73e8';
  const bytes = state.kind === 'done' ? byteLabel(state.job.resultMeta?.bytes) : '';
  const statusTitle = detail?.title
    || (state.kind === 'done' ? `Ready to download${bytes ? ` (${bytes})` : ''}`
      : state.kind === 'stopped' ? stoppedIndicatorTitle(state.job)
        : `Error: ${state.job?.error || 'Export failed.'}`);
  const title = state.kind === 'idle' ? DEFAULT_TITLE : 'Arena Export — ' + statusTitle;
  let icon = { path: ICON_SETS[theme] };
  if (state.kind !== 'idle') {
    try { icon = { imageData: await drawIcon(state, theme, frame) }; } catch { /* static icon + badge still works */ }
  }
  if (revision !== renderRevision) return;
  // Calls are serialized, and the next render always follows any in-flight call.
  try { await chrome.action.setIcon(icon); } catch { /* extension is shutting down */ }
  if (revision !== renderRevision) return;
  try { if (badge && chrome.action.setBadgeBackgroundColor) await chrome.action.setBadgeBackgroundColor({ color }); } catch { /* optional API */ }
  if (revision !== renderRevision) return;
  try { await chrome.action.setBadgeText({ text: badge }); } catch { /* extension is shutting down */ }
  if (revision !== renderRevision) return;
  try { await chrome.action.setTitle({ title }); } catch { /* extension is shutting down */ }
}

function requestIndicatorRender() {
  renderRevision++;
  if (rendering) return;
  rendering = true;
  void (async () => {
    let revision;
    do { revision = renderRevision; await renderIndicator(revision); } while (revision !== renderRevision);
    rendering = false;
  })();
}

function updateIndicator() {
  const running = [...jobsByTab.values()].some(job => job.status === 'running');
  if (running && !indicatorTimer) {
    indicatorTimer = setInterval(() => { indicatorFrame++; requestIndicatorRender(); }, 180);
    indicatorTimer?.unref?.(); // Node test harness only; browser timers are numeric.
  } else if (!running && indicatorTimer) {
    clearInterval(indicatorTimer); indicatorTimer = null;
  }
  requestIndicatorRender();
}

function setIndicatorTheme(theme) {
  themeRevision++;
  indicatorTheme = theme === 'dark' ? 'dark' : 'light';
  updateIndicator();
}
chrome.runtime.onMessage.addListener(m => { if (m?.arexTheme) setIndicatorTheme(m.arexTheme); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.theme) setIndicatorTheme(changes.theme.newValue);
});
function restoreTheme() {
  const revision = themeRevision;
  return chrome.storage.local.get('theme').then(value => {
    if (revision === themeRevision && value.theme) setIndicatorTheme(value.theme);
  }).catch(() => {});
}
chrome.runtime.onStartup.addListener(restoreTheme);
chrome.runtime.onInstalled.addListener(restoreTheme);
void restoreTheme();

// --- Boot ----------------------------------------------------------------------

const restored = restoreJobs().then(() => { updateIndicator(); });
if (typeof chrome !== 'undefined' && chrome.runtime?.onStartup) chrome.runtime.onStartup.addListener(() => void restored);
void restored;
