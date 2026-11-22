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
  'content/loader.js', 'content/expand.js', 'content/compress.js', 'content/profile.js', 'content/main.js',
];

// Bounded shape check for the profile artifact: a small structured log, not the markdown.
function isValidProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return false;
  if (profile.profileVersion !== 1) return false;
  try { return JSON.stringify(profile).length <= 256 * 1024; } catch { return false; }
}
const CONTENT_FEATURE_VERSION = '0.4.1';
const MAX_TRACKED_JOBS = 30;
const PROGRESS_CAP = 500;
const CHUNK_LIMIT_CODE_UNITS = 64 * 1024 * 1024; // bound assembled UTF-16 string size
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
    unseen: Boolean(job.unseen),
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
      job.unseen = !openPopups.size;
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
  updateIndicator();
}

function setJobStatus(job, status, extra = {}) {
  job.status = status;
  Object.assign(job, extra);
  job.unseen = (status === 'done' || status === 'error') && !openPopups.size &&
    !(status === 'error' && /^Export cancelled\.?$/i.test(job.error || ''));
  job.updatedAt = now();
  broadcastStatus(job);
  persistJobs({ immediate: true });
  updateIndicator();
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
    if (!ordered.length || ordered.some(([seq], index) => seq !== index)) {
      job.pendingResult = null;
      setJobStatus(job, 'error', { error: 'Export transfer was incomplete; retry the export.' });
      return;
    }
    markdown = ordered.map(([, data]) => data).join('');
  } else if (typeof endMessage?.markdown === 'string') {
    markdown = endMessage.markdown; // single-message transfer (small exports)
  } else {
    setJobStatus(job, 'error', { error: 'Export transfer contained no result; retry the export.' });
    return;
  }
  job.pendingResult = null;
  const bytes = new TextEncoder().encode(markdown).length;
  if (endMessage?.bytes != null && (!Number.isSafeInteger(endMessage.bytes) || endMessage.bytes !== bytes)) {
    setJobStatus(job, 'error', { error: 'Export transfer size did not match; retry the export.' });
    return;
  }

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

  // Preserve metadata even if persistence fails and the popup must recover the
  // in-memory result; do not ACK until the IndexedDB transaction commits.
  job.resultMeta = { filename: snapshot.filename, bytes, stats: snapshot.stats, warnings: snapshot.warnings, createdAt: snapshot.createdAt };
  if (RESULT_STORE) {
    try {
      await RESULT_STORE.save(snapshot);
      // The profiling record is best-effort: keep the snapshot primary and ACK
      // even if saving the profile fails.
      try {
        if (isValidProfile(endMessage?.profile)) await RESULT_STORE.saveProfile(endMessage.profile);
        else await RESULT_STORE.clearProfile();
      } catch { /* profile unavailable; snapshot is still saved */ }
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

async function handleJobMessage(job, msg, port) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'AREX_JOB_START': {
      job.chatUuid = msg.chatUuid || null;
      job.sourceUrl = msg.sourceUrl || null;
      job.status = 'running';
      job.error = null;
      job.unseen = false;
      job.startedAt = msg.startedAt || now();
      job.resultMeta = null;
      job.pendingResult = null;
      job.finalizing = false;
      if (Array.isArray(msg.progress) && msg.progress.length) {
        // Re-sync after a service-worker restart: adopt the tab's own log.
        job.progress = msg.progress.slice(-PROGRESS_CAP);
      }
      job.updatedAt = now();
      broadcastStatus(job);
      persistJobs({ immediate: true });
      updateIndicator();
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
      pending.bytes += msg.data.length;
      if (pending.bytes > CHUNK_LIMIT_CODE_UNITS) {
        job.pendingResult = null;
        setJobStatus(job, 'error', { error: 'Export is too large to transfer to the background worker.' });
        return;
      }
      pending.chunks.set(msg.seq, msg.data);
      return;
    }
    case 'AREX_RESULT_END':
      if (job.status !== 'running' || job.finalizing) return;
      if (msg.ok === false) {
        job.pendingResult = null;
        // Persist the profile from a failed/cancelled run so the popup can show it.
        if (isValidProfile(msg.profile) && RESULT_STORE?.saveProfile) {
          // Best-effort; the failure itself must not wait on persistence.
          try { await RESULT_STORE.saveProfile(msg.profile); } catch { /* best effort */ }
        }
        setJobStatus(job, 'error', { error: msg.error || 'Export failed.' });
        return;
      }
      job.finalizing = true;
      void finalizeResult(job, msg).finally(() => { job.finalizing = false; });
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
      // An obsolete port must not fail a newer connection for the same tab.
      if (jobPortsByTab.get(tabId) !== port) return;
      jobPortsByTab.delete(tabId);
      if (jobsByTab.get(tabId) !== job || job.status !== 'running' || job.finalizing) return;
      // Allow the content script's reconnect attempts, but do not leave a
      // crashed tab spinning indefinitely when no tabs event is delivered.
      const timer = setTimeout(() => {
        if (jobsByTab.get(tabId) === job && job.status === 'running' && !job.finalizing &&
            !jobPortsByTab.has(tabId) && now() - job.updatedAt >= 5000)
          setJobStatus(job, 'error', { error: 'Lost contact with the Arena tab before the export finished.' });
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
      for (const job of jobsByTab.values()) job.unseen = false;
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
          if (job) { job.unseen = false; persistJobs({ immediate: true }); updateIndicator(); }
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
  updateIndicator();
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

// --- Global toolbar indicator -----------------------------------------------
// A global action reflects all tabs: running jobs take precedence, then the
// newest unseen error/success. A single timer and a coalescing async renderer
// prevent overlapping setIcon calls and stale frames after a state/theme change.
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
  const jobs = [...jobsByTab.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  const running = jobs.find(job => job.status === 'running');
  if (running) return { kind: 'running', job: running };
  const error = jobs.find(job => job.status === 'error' && job.unseen);
  if (error) return { kind: 'error', job: error };
  const done = jobs.find(job => job.status === 'done' && job.unseen);
  return done ? { kind: 'done', job: done } : { kind: 'idle' };
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
    const percent = job.progress.some(p => p.stage === 'process') ? 100 : 75;
    return { badge: `${percent}%`, percent, title: event.phase === 'done' ? 'Saving snapshot…' : 'Converting Markdown…' };
  }
  if (event.stage === 'cleanup') return { badge: '90%', percent: 90, title: `Cleaning up${Number.isFinite(event.closed) && Number.isFinite(event.total) ? ` (${event.closed}/${event.total})` : ''}…` };
  if (event.stage === 'saving') return { badge: '99%', percent: 99, title: 'Saving snapshot…' };
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
      ctx.fillStyle = state.kind === 'done' ? '#188038' : '#d93025'; ctx.fill();
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

async function renderIndicator(revision) {
  const state = indicatorState(), theme = indicatorTheme, frame = indicatorFrame;
  const detail = state.kind === 'running' ? progressDetails(state.job) : null;
  const badge = detail?.badge || (state.kind === 'done' ? '✓' : state.kind === 'error' ? '!' : '');
  const color = state.kind === 'done' ? '#188038' : state.kind === 'error' ? '#d93025' : '#1a73e8';
  const bytes = state.kind === 'done' ? byteLabel(state.job.resultMeta?.bytes) : '';
  const title = state.kind === 'idle' ? DEFAULT_TITLE : 'Arena Export — ' +
    (detail?.title || (state.kind === 'done' ? `Ready to download${bytes ? ` (${bytes})` : ''}` : `Error: ${state.job.error || 'Export failed.'}`));
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
