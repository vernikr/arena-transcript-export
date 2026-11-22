// Theme-adaptive toolbar icon. MV3 service workers have no matchMedia, so the theme is probed
// by window contexts (content script on arena.ai pages, popup on open) and bridged here via
// runtime messages + chrome.storage.local (the cached value also survives browser restarts).
const SETS = {
  light: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  dark: { 16: 'icons/icon16-dark.png', 32: 'icons/icon32-dark.png', 48: 'icons/icon48-dark.png', 128: 'icons/icon128-dark.png' },
};
const apply = theme =>
  chrome.action.setIcon({ path: SETS[theme === 'dark' ? 'dark' : 'light'] }).catch(() => { });

chrome.runtime.onMessage.addListener(m => { if (m?.arexTheme) apply(m.arexTheme); });
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.theme) apply(c.theme.newValue); });
const restore = () => chrome.storage.local.get('theme').then(v => v.theme && apply(v.theme));
chrome.runtime.onStartup.addListener(restore);
chrome.runtime.onInstalled.addListener(restore);
restore();

// ---------------------------------------------------------------------------
// Background coordinator for transcript exports.
//
// The Arena tab (content/main.js) opens a long-lived AREX_JOB port for the
// lifetime of an export. This service worker keeps the export observable even
// after the popup closes: it relays progress to any open popup, receives the
// finished Markdown (in <=2 MB chunks), persists it to IndexedDB itself and
// ACKs the content script so the tab can release its multi-megabyte copy.
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

const CONTENT_FILES = [
  'content/selectors.js', 'content/util.js', 'content/markdown.js', 'content/serialize.js',
  'content/loader.js', 'content/expand.js', 'content/compress.js', 'content/main.js',
];
const CONTENT_FEATURE_VERSION = '0.3.0';
const MAX_TRACKED_JOBS = 30;
const PROGRESS_CAP = 500;
const CHUNK_LIMIT_BYTES = 64 * 1024 * 1024; // guard against corrupt/oversized transfers
const STALE_RUNNING_MS = 45000; // > 2 missed 20 s heartbeats
const SESSION_KEY = 'arexJobs';

/** tabId -> job */
const jobsByTab = new Map();
/** tabId -> Set<Port> */
const popupPortsByTab = new Map();
/** Set<Port> — popups opened on a non-Arena page watching all jobs */
const listenerPorts = new Set();
/** tabId -> Port (AREX_JOB) */
const jobPortsByTab = new Map();
let persistTimer = null;

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
  // In-memory-only fallback when the IndexedDB write fails. Never persisted.
  pendingResult: null,
});

function publicJob(job) {
  if (!job) return null;
  return {
    tabId: job.tabId,
    chatUuid: job.chatUuid,
    sourceUrl: job.sourceUrl,
    status: job.status,
    progress: job.progress,
    error: job.error,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    resultMeta: job.resultMeta,
    hasInMemoryResult: Boolean(job.pendingResult),
  };
}

function capJobs() {
  if (jobsByTab.size <= MAX_TRACKED_JOBS) return;
  const evictable = [...jobsByTab.values()]
    .filter(job => job.status !== 'running')
    .sort((a, b) => a.updatedAt - b.updatedAt);
  while (jobsByTab.size > MAX_TRACKED_JOBS && evictable.length) {
    const victim = evictable.shift();
    jobsByTab.delete(victim.tabId);
  }
}

function storageSession() {
  try { return chrome.storage?.session || null; } catch { return null; }
}

function serializableJobs() {
  return [...jobsByTab.values()].map(job => ({
    ...publicJob(job),
    progress: job.progress.slice(-50), // enough to repaint the log, small enough for storage.session
  }));
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
  persistTimer = setTimeout(write, 400);
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
    const job = { ...newJob(saved.tabId), ...saved, pendingResult: null };
    delete job.hasInMemoryResult; // derived flag, not state
    if (job.status === 'running' && now() - (job.updatedAt || 0) > STALE_RUNNING_MS) {
      // The tab died while the service worker was down; its content script
      // cannot re-attach, so surface the loss instead of an endless spinner.
      job.status = 'error';
      job.error = 'Lost contact with the Arena tab (browser restart). Start the export again.';
    }
    // Never clobber a live job that connected while the restore was in flight.
    if (!jobsByTab.has(job.tabId)) jobsByTab.set(job.tabId, job);
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
  emitToPopups(job.tabId, { type: 'AREX_PROGRESS', tabId: job.tabId, ...event });
  persistJobs();
}

function setJobStatus(job, status, extra = {}) {
  job.status = status;
  Object.assign(job, extra);
  job.updatedAt = now();
  broadcastStatus(job);
  persistJobs({ immediate: true });
}

const postSafe = (port, message) => {
  try { port?.postMessage(message); } catch { /* peer went away */ }
};

// --- Result assembly -------------------------------------------------------

function ensurePendingResult(job) {
  if (!job.pendingResult) job.pendingResult = { chunks: new Map(), bytes: 0, startedAt: now() };
  return job.pendingResult;
}

async function finalizeResult(job, endMessage) {
  const pending = job.pendingResult;
  let markdown = '';
  if (pending) {
    const ordered = [...pending.chunks.entries()].sort((a, b) => a[0] - b[0]);
    markdown = ordered.map(([, data]) => data).join('');
  } else if (typeof endMessage?.markdown === 'string') {
    markdown = endMessage.markdown; // single-message transfer (small exports)
  }
  job.pendingResult = null;
  const bytes = endMessage?.bytes ?? new TextEncoder().encode(markdown).length;

  const snapshot = {
    markdown,
    filename: endMessage?.filename || 'arena-export.md',
    stats: endMessage?.stats || { messages: 0, expandedSpoilers: 0 },
    warnings: endMessage?.warnings || [],
    createdAt: endMessage?.createdAt || now(),
    tabId: job.tabId,
    chatUuid: job.chatUuid,
    sourceUrl: job.sourceUrl,
    bytes,
  };

  if (RESULT_STORE) {
    try {
      await RESULT_STORE.save(snapshot);
      job.resultMeta = { filename: snapshot.filename, bytes, stats: snapshot.stats, warnings: snapshot.warnings, createdAt: snapshot.createdAt };
      setJobStatus(job, 'done', { error: null });
      postSafe(jobPortsByTab.get(job.tabId), { type: 'AREX_RESULT_ACK' });
      return;
    } catch (error) {
      // Keep the assembled result in memory so an open popup can still recover it.
      job.pendingResult = { markdown, chunks: null, bytes, startedAt: now() };
      setJobStatus(job, 'error', { error: 'Could not save the snapshot: ' + String(error?.message || error) });
      return;
    }
  }
  job.pendingResult = { markdown, chunks: null, bytes, startedAt: now() };
  setJobStatus(job, 'error', { error: 'Snapshot storage is unavailable in the background worker.' });
}

// --- AREX_JOB port (content script -> background) ---------------------------

function handleJobMessage(job, msg, port) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'AREX_JOB_START': {
      job.chatUuid = msg.chatUuid || null;
      job.sourceUrl = msg.sourceUrl || null;
      job.status = 'running';
      job.error = null;
      job.startedAt = msg.startedAt || now();
      job.resultMeta = null;
      job.pendingResult = null;
      if (Array.isArray(msg.progress) && msg.progress.length) {
        // Re-sync after a service-worker restart: adopt the tab's own log.
        job.progress = msg.progress.slice(-PROGRESS_CAP);
      }
      job.updatedAt = now();
      broadcastStatus(job);
      persistJobs({ immediate: true });
      return;
    }
    case 'AREX_PROGRESS':
      noteProgress(job, msg);
      return;
    case 'AREX_HEARTBEAT':
      job.updatedAt = now();
      persistJobs();
      return;
    case 'AREX_RESULT_CHUNK': {
      if (typeof msg.seq !== 'number' || typeof msg.data !== 'string') return;
      const pending = ensurePendingResult(job);
      pending.bytes += msg.data.length;
      if (pending.bytes > CHUNK_LIMIT_BYTES) {
        pending.chunks.clear();
        pending.bytes = 0;
        setJobStatus(job, 'error', { error: 'Export is too large to transfer to the background worker.' });
        return;
      }
      pending.chunks.set(msg.seq, msg.data);
      return;
    }
    case 'AREX_RESULT_END':
      if (msg.ok === false) {
        job.pendingResult = null;
        setJobStatus(job, 'error', { error: msg.error || 'Export failed.' });
        return;
      }
      void finalizeResult(job, msg);
      return;
    default:
      return;
  }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'AREX_JOB') {
    const tabId = port.sender?.tab?.id;
    if (typeof tabId !== 'number') { port.disconnect(); return; }
    const job = jobsByTab.get(tabId) || newJob(tabId);
    jobsByTab.set(tabId, job);
    jobPortsByTab.set(tabId, port);
    capJobs();
    port.onMessage.addListener(msg => handleJobMessage(job, msg, port));
    port.onDisconnect.addListener(() => {
      if (jobPortsByTab.get(tabId) === port) jobPortsByTab.delete(tabId);
      if (jobsByTab.get(tabId)?.status === 'running' && now() - job.updatedAt > 5000) {
        // Content vanished mid-run (tab closed / crashed) without a tabs event.
        setJobStatus(job, 'error', { error: 'Lost contact with the Arena tab before the export finished.' });
      }
    });
    return;
  }

  if (port.name === 'AREX_POPUP') {
    let subscribedTabId = null;
    port.onMessage.addListener(async msg => {
      if (!msg || typeof msg !== 'object') return;
      const tabId = typeof msg.tabId === 'number' ? msg.tabId : subscribedTabId;
      switch (msg.type) {
        case 'AREX_HELLO': {
          subscribedTabId = typeof msg.tabId === 'number' ? msg.tabId : null;
          if (subscribedTabId !== null) {
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
          postSafe(port, { type: 'AREX_STATUS', job: publicJob(tabId !== null && tabId !== undefined ? jobsByTab.get(tabId) || null : null) });
          return;
        }
        case 'AREX_LIST_JOBS': {
          const jobs = [...jobsByTab.values()].map(publicJob).filter(j => j.status === 'running' || j.status === 'done' || j.status === 'error');
          postSafe(port, { type: 'AREX_JOBS', jobs });
          return;
        }
        case 'AREX_EXPORT_START': {
          if (typeof tabId !== 'number') { postSafe(port, { type: 'AREX_ERROR', error: 'No target tab for the export.' }); return; }
          await startExportInTab(tabId, msg.options || {});
          return;
        }
        case 'AREX_EXPORT_CANCEL': {
          if (typeof tabId !== 'number') return;
          cancelExportInTab(tabId);
          return;
        }
        case 'AREX_GET_INMEMORY_RESULT': {
          const job = typeof tabId === 'number' ? jobsByTab.get(tabId) : null;
          const pending = job?.pendingResult;
          if (pending && typeof pending.markdown === 'string') {
            postSafe(port, { type: 'AREX_INMEMORY_RESULT', ok: true, markdown: pending.markdown, filename: job.resultMeta?.filename || 'arena-export.md', stats: job.resultMeta?.stats || null, warnings: job.resultMeta?.warnings || [] });
          } else {
            postSafe(port, { type: 'AREX_INMEMORY_RESULT', ok: false, error: 'The in-progress snapshot is no longer available.' });
          }
          return;
        }
        case 'AREX_POPUP_OPENED': {
          // User looked at the final state: clear "done" visibility markers.
          const job = typeof tabId === 'number' ? jobsByTab.get(tabId) : null;
          if (job && job.status === 'done') persistJobs();
          return;
        }
        default:
          return;
      }
    });
    port.onDisconnect.addListener(() => {
      if (subscribedTabId !== null) {
        const set = popupPortsByTab.get(subscribedTabId);
        set?.delete(port);
        if (set && !set.size) popupPortsByTab.delete(subscribedTabId);
      }
      listenerPorts.delete(port);
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

async function startExportInTab(tabId, options) {
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
  // Fresh or re-injected job: the content script creates/replaces its own AREX_JOB port.
  const fresh = newJob(tabId);
  fresh.sourceUrl = null;
  jobsByTab.set(tabId, fresh);
  capJobs();
  broadcastStatus(fresh);
  persistJobs({ immediate: true });
  try {
    chrome.tabs.sendMessage(tabId, { type: 'AREX_EXPORT_START', options }, () => void chrome.runtime.lastError);
  } catch (error) {
    setJobStatus(fresh, 'error', { error: 'Could not start the export: ' + String(error?.message || error) });
  }
}

function cancelExportInTab(tabId) {
  const job = jobsByTab.get(tabId);
  const port = jobPortsByTab.get(tabId);
  if (port) postSafe(port, { type: 'AREX_EXPORT_CANCEL' });
  try { chrome.tabs.sendMessage(tabId, { type: 'AREX_EXPORT_CANCEL' }, () => void chrome.runtime.lastError); } catch { /* tab gone */ }
  if (job?.status === 'running') noteProgress(job, { stage: 'cancel', phase: 'requested' });
}

// --- Tab lifecycle ------------------------------------------------------------

function failRunningJob(tabId, error) {
  const job = jobsByTab.get(tabId);
  if (job?.status === 'running') setJobStatus(job, 'error', { error });
}

if (chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener(tabId => {
    failRunningJob(tabId, 'Tab was closed before the scan finished.');
    jobPortsByTab.delete(tabId);
    const ports = popupPortsByTab.get(tabId);
    if (ports) { for (const port of ports) postSafe(port, { type: 'AREX_STATUS', job: publicJob(jobsByTab.get(tabId) || null) }); }
  });
}

if (chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const url = changeInfo?.url;
    if (!url) return;
    const job = jobsByTab.get(tabId);
    if (job?.status !== 'running') return;
    let stillArena = false;
    try { const u = new URL(url); stillArena = u.host === 'arena.ai' && u.pathname.startsWith('/agent/'); } catch { stillArena = false; }
    if (!stillArena) failRunningJob(tabId, 'Tab was navigated away before the scan finished.');
  });
}

// --- Boot ----------------------------------------------------------------------

const restored = restoreJobs();
if (typeof chrome !== 'undefined' && chrome.runtime?.onStartup) chrome.runtime.onStartup.addListener(() => void restored);
void restored;
