/* Popup: prepare once, preview compression modes locally, then download.
 * Talks to the background coordinator (AREX_POPUP port); the Arena tab talks
 * to the background via AREX_JOB. The popup never injects scripts or messages
 * the tab directly — closing the popup no longer affects the export.
 *
 * State is strictly scoped to the active Arena tab: the popup only ever shows
 * the snapshot / diagnostic log stored under (tabId, chatUuid) of that tab,
 * never a global "latest" record from another branch or another tab. */
(() => {
  const theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  chrome.storage.local.set({ theme });
  chrome.runtime.sendMessage({ arexTheme: theme }).catch(() => { });
})();

const $ = s => document.querySelector(s);
const status = $('#status');
const btn = $('#export');
const cancelBtn = $('#cancel');
const resnapshotBtn = $('#resnapshot');
const sizeExactValue = $('#sizeExactValue');
const sizeLabel = $('#sizeLabel');
const optActivity = $('#includeToolActivity');
const optTimestamps = $('#timestamps');
const optProfile = $('#profileOpt');
const profileSummary = $('#profileSummary');
const profileDownload = $('#profileDownload');
const optCompress = $('#compressHistory');
const optCondense = $('#condenseThoughts');
const compression = $('#compression');
const modeButtons = [...document.querySelectorAll('.mode')];
const modeDescription = $('#modeDescription');
const sizePreview = $('#sizePreview');
const sizeValue = $('#sizeValue');
const tokensValue = $('#tokensValue');
const savedValue = $('#savedValue');
const progress = $('#progress');
const progressBar = $('#progressBar');
const progressFill = $('#progressFill');
const logEl = $('#log');
const banner = $('#backgroundJobBanner');
const bannerText = $('#backgroundJobBannerText');
const bannerSwitch = $('#backgroundJobSwitch');
const singleTabNotice = $('#singleTabNotice');
const partialCallout = $('#partialCallout');
const partialTitle = $('#partialTitle');
const partialDetail = $('#partialDetail');
const diagnostics = $('#diagnostics');
const diagnosticsHint = $('#diagnosticsHint');
const exportLogBtn = $('#exportLog');
const logNotice = $('#logNotice');

const STAGE_ORDER = ['history', 'expand', 'process', 'serialize', 'saving'];
const STAGE_PERCENT = { history: 10, expand: 45, serialize: 75, saving: 92, done: 100 };
const MODE_DESCRIPTIONS = {
  off: 'Raw Markdown: no deduplication, compaction or reasoning changes are applied.',
  lossless: 'Exact duplicate outputs are kept once and replaced by links to the original block. Reasoning is never changed.',
  smart: 'Lossless + removes terminal noise, folds long passing-test runs and trims very long clean logs. Error output is preserved.',
  stubs: 'Smart + references identical lines in earlier outputs, shortens clean scripts and trims logs harder; unique lines can still be omitted.',
};
const REASONING_NOTES = {
  condensed: ' Long middle reasoning blocks are condensed; your messages and final answers are never changed.',
  kept: ' Reasoning is kept in full.',
};
const LOG_EXPORT_TIMEOUT_MS = 20000;
// A Blob URL stays alive until the browser reports the download as finished.
// This timer only exists as a last-resort net when downloads.onChanged is
// missing or never fires (e.g. an interrupted service worker).
const BLOB_REVOKE_FALLBACK_MS = 10 * 60 * 1000;
const say = (text, cls = '') => {
  status.textContent = text;
  status.className = cls;
};
const kb = n => AREX.formatBytes(n);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let port = null;
let prepared = null;
let preparedPartial = false;
let profileDoc = null;
let preparing = false;
let downloading = false;
let activeMode = 'lossless';
let currentTabId = null;
let currentChatUuid = null;
let currentTabUrl = null;
let hasArenaTab = false;
let replayedProgress = 0;
let compressionState = null;
let nextSnapshotId = 0;
let nextRequestId = 0;
let previewBusyCount = 0;
let currentPercent = 0;
let gateOpen = false;
let statusWaiter = null;
let logExportSeq = 0;
let logExporting = false;
let quietLogRequests = 0;
const pendingLogExports = new Map();
const optionsReadyRef = { resolve: null };
const optionsReady = new Promise(resolve => { optionsReadyRef.resolve = resolve; });

chrome.storage.sync.get({
  includeToolActivity: true,
  timestamps: false,
  compressHistory: true,
  compressionMode: 'lossless',
  condenseThoughts: true,
  profile: true,
}, options => {
  optActivity.checked = options.includeToolActivity;
  optTimestamps.checked = options.timestamps;
  optProfile.checked = options.profile !== false;
  optCondense.checked = options.condenseThoughts !== false;
  activeMode = ['off', 'lossless', 'smart', 'stubs'].includes(options.compressionMode)
    ? options.compressionMode : 'lossless';
  optCompress.checked = options.compressHistory !== false && activeMode !== 'off';
  updateCompressionControls();
  optionsReadyRef.resolve();
});

function persistOptions() {
  chrome.storage.sync.set({
    includeToolActivity: optActivity.checked,
    timestamps: optTimestamps.checked,
    compressHistory: optCompress.checked,
    compressionMode: activeMode,
    condenseThoughts: optCondense.checked,
    profile: optProfile.checked,
  });
}

function compressionMode() {
  return optActivity.checked && optCompress.checked && activeMode !== 'off' ? activeMode : 'off';
}

// The toggle only applies to Smart and Stubs; Off/Lossless ignore it but keep the saved choice.
function condenseSelected(mode = compressionMode()) {
  return (mode === 'smart' || mode === 'stubs') && optCondense.checked;
}

const modeKey = (mode, condense) => mode + ':' + condense;
const previewKey = () => modeKey(compressionMode(), condenseSelected());

function describeMode(mode) {
  if (mode !== 'smart' && mode !== 'stubs') return MODE_DESCRIPTIONS[mode];
  return MODE_DESCRIPTIONS[mode] + (condenseSelected(mode) ? REASONING_NOTES.condensed : REASONING_NOTES.kept);
}

function updateCompressionControls() {
  const available = optActivity.checked;
  optCompress.disabled = !available;
  const mode = compressionMode();
  optCondense.disabled = !available || (mode !== 'smart' && mode !== 'stubs');
  compression.classList.toggle('disabled', !available);
  modeButtons.forEach(button => {
    button.disabled = !available;
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  });
  modeDescription.textContent = available
    ? describeMode(mode)
    : 'Enable tool activity to compress command outputs and repeated file snapshots.';
}

function setPreparationControlsDisabled(disabled) {
  optActivity.disabled = disabled;
  optTimestamps.disabled = disabled;
}

/* ----- primary button, partial state, busy flags ----- */

function updatePrimary() {
  if (preparing) btn.textContent = 'Scanning…';
  else if (downloading) btn.textContent = 'Saving…';
  else if (prepared) btn.textContent = preparedPartial ? 'Download Partial Markdown' : 'Download Markdown';
  else btn.textContent = 'Prepare preview';
  const previewReady = !prepared || Boolean(prepared.preview && prepared.previewMode === previewKey());
  btn.disabled = preparing || downloading || previewBusyCount > 0 || !hasArenaTab || !previewReady;
  refreshDiagnostics();
}

function startPreviewBusy() { previewBusyCount += 1; updatePrimary(); }
function stopPreviewBusy() { previewBusyCount = Math.max(0, previewBusyCount - 1); updatePrimary(); }

function setPartialUi(partial, meta = null, snapshot = null) {
  preparedPartial = Boolean(partial);
  partialCallout.hidden = !preparedPartial;
  sizeLabel.textContent = preparedPartial ? 'Partial Markdown size' : 'Final Markdown size';
  resnapshotBtn.hidden = !prepared;
  resnapshotBtn.textContent = preparedPartial ? 'Export full branch' : 'Retake snapshot';
  if (preparedPartial) {
    const captured = meta?.completedMessages ?? snapshot?.completedMessages ?? snapshot?.stats?.messages ?? null;
    const total = meta?.totalMessages ?? snapshot?.totalMessages ?? snapshot?.stats?.totalMessages ?? null;
    partialTitle.textContent = captured != null
      ? 'Partial snapshot · ' + captured + (total != null ? ' of ' + total : '') + ' messages captured before stop'
      : 'Partial snapshot';
    partialDetail.textContent = 'The scan was stopped early. Compression below applies to the captured messages; ' +
      'retake the snapshot to export the full branch.';
  }
  updatePrimary();
}

function setRunningUi(running) {
  preparing = running;
  if (running) {
    cancelBtn.hidden = false;
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Stop & keep partial';
    setPreparationControlsDisabled(true);
    progress.hidden = false;
    progressBar.hidden = false;
  } else {
    cancelBtn.hidden = true;
    setPreparationControlsDisabled(Boolean(prepared));
  }
  resnapshotBtn.disabled = running;
  updatePrimary();
}

function setProgressPercent(value) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  currentPercent = Math.max(currentPercent, pct);
  progressFill.style.width = currentPercent + '%';
  progressBar.setAttribute('aria-valuenow', String(currentPercent));
}

function resetProgress() {
  currentPercent = 0;
  setProgressPercent(0);
}

function hideProgressChrome() {
  progressBar.hidden = true;
}

function refreshDiagnostics() {
  if (!hasArenaTab) {
    diagnosticsHint.textContent = '';
    exportLogBtn.disabled = true;
    logNotice.textContent = 'Open an Arena.ai agent conversation to export diagnostics.';
    return;
  }
  diagnosticsHint.textContent = profileDoc ? 'profiler summary' : '';
  exportLogBtn.disabled = logExporting;
  logNotice.textContent = optProfile.checked
    ? 'Stage log, job & transfer diagnostics plus the live profiler summary. Exporting never stops the scan.'
    : 'Profiling is off: the export contains the timestamped stage log and job/transfer diagnostics only.';
}

/* ----- background port ----- */

function postToBackground(message) {
  try {
    if (port) { port.postMessage(message); return true; }
  } catch { port = null; }
  return false;
}

function activeArenaTab() {
  return chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (!tab || !/^https:\/\/arena\.ai\/agent\//.test(tab.url || '')) return null;
    return tab;
  });
}

function chatUuidFromUrl(rawUrl) {
  const match = String(rawUrl || '').match(/^https:\/\/arena\.ai\/agent\/([^/?#]+)/);
  if (!match || !match[1]) return null;
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}

function slugify(text) {
  return String(text || '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || '';
}

function stamp(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
}

function announceJobStatus(job) {
  if (statusWaiter) { const waiter = statusWaiter; statusWaiter = null; waiter(job); return; }
  if (!gateOpen) return;
  void onBackgroundStatus(job);
}

function ensureBackgroundPort() {
  if (port) return port;
  try {
    port = chrome.runtime.connect({ name: 'AREX_POPUP' });
  } catch {
    port = null;
    return null;
  }
  port.onDisconnect.addListener(() => { port = null; });
  port.onMessage.addListener(msg => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'AREX_STATUS') announceJobStatus(msg.job || null);
    else if (msg.type === 'AREX_PROGRESS') onProgress(msg);
    else if (msg.type === 'AREX_JOBS') onJobsList(msg.jobs || []);
    else if (msg.type === 'AREX_ERROR') say(msg.error || 'The background worker reported an error.', 'error');
    else if (msg.type === 'AREX_INMEMORY_RESULT') onInMemoryResult(msg);
    else if (msg.type === 'AREX_LOG_BUNDLE') resolveLogExport(msg);
  });
  return port;
}

/* ----- staged progress log ----- */
const lines = {};
function stageLine(stage) {
  if (lines[stage]) return lines[stage];
  progress.hidden = false;
  for (const earlier of STAGE_ORDER) {
    if (earlier === stage) break;
    if (lines[earlier]) setIcon(lines[earlier], '✓', 'tick');
  }
  const li = document.createElement('li');
  li.className = 'active';
  const ic = document.createElement('span');
  ic.className = 'ic spin';
  const txt = document.createElement('span');
  li.append(ic, txt);
  logEl.append(li);
  li.scrollIntoView?.({ block: 'nearest' });
  lines[stage] = { li, ic, txt };
  return lines[stage];
}
function setIcon(line, character, cls) {
  line.ic.className = 'ic ' + cls;
  line.ic.textContent = character;
  line.li.classList.remove('active');
  line.li.classList.add('done');
}
function setText(stage, value) {
  const line = stageLine(stage);
  if (line.txt.textContent === value) return;
  line.txt.textContent = value;
  line.li.scrollIntoView?.({ block: 'nearest' });
}
function clearLog() {
  logEl.replaceChildren();
  for (const key in lines) delete lines[key];
}
function markStagesDone() {
  for (const stage of STAGE_ORDER) if (lines[stage]) setIcon(lines[stage], '✓', 'tick');
  setProgressPercent(100);
  progressBar.hidden = true;
}
function markStagesFailed() {
  for (const stage in lines) {
    if (!lines[stage].li.classList.contains('done')) {
      lines[stage].ic.className = 'ic';
      lines[stage].ic.textContent = '✕';
      lines[stage].ic.style.color = 'var(--error)';
    }
  }
}
function markStagesStopped() {
  for (const stage of STAGE_ORDER) {
    const line = lines[stage];
    if (!line || line.li.classList.contains('done')) continue;
    line.ic.className = 'ic';
    line.ic.textContent = '‖';
    line.ic.style.color = 'var(--warn)';
    line.li.classList.remove('active');
  }
  progressBar.hidden = true;
}

function formatCounter(value, total) {
  return Number.isFinite(total) && total > 0 ? value + '/' + total : String(value ?? 0);
}

function onProgress(message) {
  if (!hasArenaTab) return;
  if (currentTabId != null && message.tabId != null && message.tabId !== currentTabId) return;
  if (Number.isFinite(message.percent)) setProgressPercent(message.percent);
  else if (STAGE_PERCENT[message.stage] != null) setProgressPercent(STAGE_PERCENT[message.stage]);
  switch (message.stage) {
    case 'history':
      if (message.phase === 'scan') setText('history', 'History: checking for earlier messages… (round ' + message.round + ', ' + message.loaded + ')');
      else if (message.phase === 'page') setText('history', 'History: ' + message.pages + ' earlier page(s) · ' + message.loaded + ' messages…');
      else if (message.phase === 'loading') setText('history', 'History: receiving older messages…');
      else if (message.phase === 'retry') setText('history', 'History: retrying a failed page load…');
      else if (message.phase === 'settle') setText('history', 'History: verifying top of branch (' + message.stagnant + '/' + (message.target || 2) + ') · ' + message.loaded + ' messages');
      else setText('history', 'History: settling…');
      break;
    case 'expand':
      setText('expand', message.phase === 'settle'
        ? 'Spoilers: pass ' + message.pass + ', rendering… (' + message.expanded + ' opened)'
        : 'Spoilers: pass ' + message.pass + ', opening ' + message.openedThisPass + '/' + message.total + '… (' + message.expanded + ' total)');
      break;
    case 'process': {
      if (Number.isFinite(message.percent)) setProgressPercent(message.percent);
      const expandedSpoilers = Number.isFinite(message.expandedSpoilers) ? message.expandedSpoilers : 0;
      const spoilerProgress = formatCounter(expandedSpoilers, message.totalSpoilers) + ' spoilers';
      const percent = Number.isFinite(message.percent) ? ' · ' + Math.round(message.percent) + '%' : '';
      if (message.phase === 'cleanup') {
        // Tail-end sub-stage: closing the spoilers opened for the last window.
        setText('process', 'Closing opened spoilers: ' + formatCounter(message.closed, message.total) +
          ' spoilers · ' + formatCounter(message.processedMessages, message.totalMessages) + ' messages scanned' + percent + '…');
      } else if (message.phase === 'expand') {
        setText('process', 'Spoilers: pass ' + message.pass + ', opening ' + formatCounter(expandedSpoilers, message.totalSpoilers) + '… · ' +
          formatCounter(message.processedMessages, message.totalMessages) + ' messages' + percent);
      } else {
        setText('process', 'Scanning: ' + formatCounter(message.processedMessages, message.totalMessages) + ' messages · ' +
          spoilerProgress + percent + '…');
      }
      break;
    }
    case 'serialize':
      setText('serialize', message.phase === 'done'
        ? 'Markdown: ' + AREX.formatByteCount(message.bytes) + ' assembled'
        : 'Markdown: converting…');
      break;
    case 'cleanup':
      // Some builds publish cleanup as a top-level stage; keep one process line.
      setText('process', 'Closing opened spoilers: ' + formatCounter(message.closed, message.total) + ' spoilers…');
      break;
    case 'saving': {
      const sent = Number.isFinite(message.sentChunks) ? message.sentChunks : null;
      const received = Number.isFinite(message.receivedChunks) ? message.receivedChunks : null;
      if (message.phase === 'transfer' && received != null) {
        setText('saving', 'Saving snapshot chunk ' + formatCounter(received, message.totalChunks) + ' to storage…');
      } else {
        const doneChunks = sent ?? received ?? 0;
        setText('saving', 'Saving snapshot chunk ' + formatCounter(doneChunks, message.totalChunks) + ' to storage…');
      }
      break;
    }
    case 'cancel':
      say('Stopping the export; captured messages will be kept…', 'warn');
      break;
    case 'done':
      break; // completion is driven by AREX_STATUS
    default:
      break;
  }
}

/* ----- profiling summary ----- */

function formatProfileDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return null;
  return ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms';
}

function profileSummaryLines(profile) {
  const totals = profile.totals || {};
  const head = [];
  const duration = formatProfileDuration(profile.durationMs);
  if (duration) head.push('Total ' + duration);
  if (totals.messages != null) head.push(totals.messages + ' messages');
  if (totals.expandedSpoilers != null) head.push(totals.expandedSpoilers + ' spoilers');
  if (totals.markdownBytes != null) head.push(AREX.formatBytes(totals.markdownBytes));
  head.push('outcome ' + (profile.outcome || 'unknown'));
  const lines = [head.join(' · ')];
  const phases = Object.entries(profile.phases || {}).map(([name, rec]) => name + ' ' + Math.round(Number(rec.ms) || 0) + ' ms');
  if (phases.length) lines.push(phases.join(' · '));
  const windows = Array.isArray(profile.windows) ? profile.windows : [];
  const timing = profile.messageTiming || {};
  const slowest = windows[0];
  const details = [];
  if (slowest) details.push('Slowest window #' + slowest.index + ' (' + Math.round(Number(slowest.ms) || 0) + ' ms' + (slowest.messages != null ? ' · ' + slowest.messages + ' msg' : '') + ')');
  if (timing.count) details.push('p95 ' + Math.round(timing.p95Ms || 0) + ' ms · max ' + Math.round(timing.maxMs || 0) + ' ms');
  if (details.length) lines.push(details.join(' · '));
  return lines.join('\n');
}

function renderProfile(profile) {
  profileDoc = profile || null;
  profileSummary.textContent = profile ? profileSummaryLines(profile) : '';
  profileDownload.hidden = !profile;
  refreshDiagnostics();
}

function isProfileObject(value) {
  return Boolean(value && typeof value === 'object' &&
    (value.profileVersion === 1 || value.profileVersion === 2));
}

// Profiles are attached by the coordinator to the scoped diagnostic record;
// legacy runs kept a single default-scope profile, which stays a read-only
// fallback here and is never used to infer the current tab's snapshot.
async function loadProfileScoped() {
  const store = globalThis.AREX_RESULT_STORE;
  if (!store) return null;
  if (typeof store.loadDiagnosticLog === 'function' && currentTabId != null) {
    try {
      const record = await store.loadDiagnosticLog(currentTabId, currentChatUuid);
      if (isProfileObject(record?.profile)) return record.profile;
    } catch { /* fall through to the legacy record */ }
  }
  if (typeof store.loadProfile === 'function') {
    try {
      const legacy = await store.loadProfile();
      if (isProfileObject(legacy)) return legacy;
    } catch { /* profile unavailable */ }
  }
  return null;
}

/* ----- Blob URL lifetime ----- */

function trackBlobUrl(url, downloadId) {
  let settled = false;
  let listener = null;
  let timer = null;
  const canWatch = typeof downloadId === 'number' && chrome.downloads?.onChanged?.addListener;
  const cleanupListener = () => {
    if (!listener) return;
    try { chrome.downloads?.onChanged?.removeListener?.(listener); } catch { /* extension reloaded */ }
    listener = null;
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    cleanupListener();
    try { URL.revokeObjectURL(url); } catch { /* already revoked */ }
  };
  if (canWatch) {
    listener = delta => {
      if (!delta || delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') finish();
    };
    try { chrome.downloads.onChanged.addListener(listener); } catch { listener = null; }
  }
  timer = setTimeout(finish, BLOB_REVOKE_FALLBACK_MS);
  timer?.unref?.();
  return finish;
}

async function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({ url, filename, saveAs: true });
    trackBlobUrl(url, downloadId);
    return { filename, bytes: blob.size };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

async function downloadProfile() {
  if (!profileDoc) return;
  const base = (prepared?.filename || currentChatUuid || 'arena').replace(/\.md$/i, '');
  profileDownload.disabled = true;
  try {
    await downloadJson(base + '-profile.json', profileDoc);
  } catch (error) {
    say(String(error?.message || error), 'error');
  } finally {
    profileDownload.disabled = false;
  }
}

/* ----- snapshot loading (strict per-tab scope) ----- */

async function loadScopedSnapshot() {
  const store = globalThis.AREX_RESULT_STORE;
  if (!store || typeof store.loadForTab !== 'function') return { snapshot: null, meta: null };
  const [snapshot, meta] = await Promise.all([
    store.loadForTab(currentTabId, currentChatUuid),
    typeof store.loadMetaForTab === 'function' ? store.loadMetaForTab(currentTabId, currentChatUuid) : Promise.resolve(null),
  ]);
  const valid = snapshot && typeof snapshot.markdown === 'string' && snapshot.filename ? snapshot : null;
  return { snapshot: valid, meta: meta || null };
}

function partialFilename(filename) {
  const base = String(filename || 'arena-export.md');
  if (/-partial\.md$/i.test(base)) return base;
  if (/\.md$/i.test(base)) return base.replace(/\.md$/i, '-partial.md');
  return base + '-partial.md';
}

async function prepareFromSnapshot(snapshot, { partial = false, warning = '', restored = false, meta = null, showProfile = true } = {}) {
  const sameDocument = Boolean(prepared && snapshot &&
    prepared.createdAt === snapshot.createdAt &&
    prepared.filename === snapshot.filename &&
    prepared.markdown?.length === snapshot.markdown?.length);
  prepared = snapshot;
  resnapshotBtn.disabled = false;
  setPreparationControlsDisabled(true);
  setPartialUi(Boolean(partial || meta?.partial), meta, snapshot);
  sizePreview.hidden = false;
  if (!sameDocument) {
    initializeCompression(snapshot);
    void renderSizePreview();
  }
  if (showProfile) renderProfile(await loadProfileScoped());
  else renderProfile(null);
  if (sameDocument && !restored) return;
  const warnings = prepared.warnings?.length ? '\n⚠ ' + prepared.warnings.join('\n⚠ ') : '';
  const stats = prepared.stats || {};
  const captured = meta?.completedMessages ?? snapshot.completedMessages ?? stats.messages ?? null;
  const totalMsgs = meta?.totalMessages ?? snapshot.totalMessages ?? stats.totalMessages ?? null;
  if (restored) {
    const when = snapshot.createdAt ? new Date(snapshot.createdAt).toLocaleString() : 'previous session';
    const head = preparedPartial
      ? 'Partial snapshot restored · ' + (captured != null ? captured + (totalMsgs != null ? ' of ' + totalMsgs : '') + ' messages · ' : '') + when
      : 'Previous snapshot restored · ' + when;
    say(head + '\nChoose a compression mode, download it, or ' + (preparedPartial ? 'export the full branch' : 'retake the snapshot') + '.' + warnings,
      warning || preparedPartial ? 'warn' : '');
  } else if (preparedPartial) {
    say('Partial snapshot ready · ' + (captured != null ? captured + (totalMsgs != null ? ' of ' + totalMsgs : '') + ' messages captured before stop' : 'stopped early') +
      '\nSwitch compression modes to update the size, download the partial Markdown, or export the full branch.' + warnings,
      warning ? 'warn' : '');
  } else if (warning) {
    say(warning + warnings, 'warn');
  } else {
    say(
      'Preview ready · ' + (stats.messages ?? 0) + ' messages · ' + (stats.expandedSpoilers ?? 0) +
        ' spoilers\nSwitch compression modes to update the size, then download.' + warnings,
      warnings ? 'warn' : '',
    );
  }
}

async function onInMemoryResult(message) {
  if (!message?.ok || typeof message.markdown !== 'string') {
    say('The export finished but its snapshot is unavailable: ' + (message?.error || 'unknown error'), 'error');
    return;
  }
  await prepareFromSnapshot({
    markdown: message.markdown,
    filename: message.filename || 'arena-export.md',
    stats: message.stats || { messages: 0, expandedSpoilers: 0 },
    warnings: message.warnings || [],
    completedMessages: message.completedMessages ?? null,
    totalMessages: message.totalMessages ?? null,
    partial: Boolean(message.partial),
    createdAt: Date.now(),
  }, {
    partial: Boolean(message.partial),
    warning: '⚠ Could not save the snapshot to browser storage — download it now before closing the popup.',
    showProfile: false,
  });
}

// The coordinator keeps the finished profile in job.lastProfile; an
// AREX_EXPORT_LOG roundtrip hands it over (and persists the diagnostic record)
// without touching the Arena tab's state.
async function refreshProfileFromCoordinator() {
  if (!hasArenaTab || !optProfile.checked || logExporting) return;
  const profile = await loadProfileScoped();
  if (profile) { renderProfile(profile); return; }
  if (quietLogRequests > 0) return;
  let reply = null;
  try {
    reply = await requestLogBundle({ quiet: true });
  } catch {
    return; // best-effort: the coordinator may be busy or the tab wedged
  }
  const bundle = reply?.bundle;
  if (bundle && isProfileObject(bundle.profile)) renderProfile(bundle.profile);
}

async function applyCompletedJob(partial) {
  preparing = false;
  downloading = false;
  cancelBtn.hidden = true;
  cancelBtn.disabled = false;
  if (partial) markStagesStopped();
  else markStagesDone();
  let storageWarning = '';
  let scoped = { snapshot: null, meta: null };
  try {
    scoped = await loadScopedSnapshot();
  } catch (error) {
    storageWarning = '⚠ Could not read the saved snapshot: ' + String(error?.message || error);
  }
  if (scoped.snapshot) {
    await prepareFromSnapshot(scoped.snapshot, {
      partial: partial || scoped.meta?.partial === true,
      meta: scoped.meta,
      warning: storageWarning,
    });
    await refreshProfileFromCoordinator();
    return;
  }
  // Background could not persist the snapshot — ask it for the in-memory copy.
  postToBackground({ type: 'AREX_GET_INMEMORY_RESULT', tabId: currentTabId });
}

async function onBackgroundStatus(job) {
  if (!hasArenaTab) {
    if (job) onForeignJob(job);
    return;
  }
  if (!job) return;
  if (currentTabId != null && job.tabId !== currentTabId) return;
  if (currentChatUuid && job.chatUuid && String(job.chatUuid) !== String(currentChatUuid)) return;
  if (Array.isArray(job.progress)) {
    const fresh = job.progress.slice(replayedProgress);
    replayedProgress = job.progress.length;
    for (const event of fresh) onProgress({ ...event, tabId: job.tabId });
  }
  if (job.status === 'running') {
    setRunningUi(true);
    say('The scan continued in the Arena tab. Live progress is restored below.');
    return;
  }
  if (job.status === 'done') {
    await applyCompletedJob(false);
    return;
  }
  if (job.status === 'stopped') {
    await applyCompletedJob(true);
    return;
  }
  if (job.status === 'error') {
    preparing = false;
    cancelBtn.hidden = true;
    resnapshotBtn.disabled = false;
    setPreparationControlsDisabled(Boolean(prepared));
    if (prepared) renderSizePreview();
    say(job.error || 'Export failed.', 'error');
    markStagesFailed();
    renderProfile(await loadProfileScoped());
    if (job.hasInMemoryResult && !prepared) postToBackground({ type: 'AREX_GET_INMEMORY_RESULT', tabId: currentTabId });
  }
}

/* ----- banner for jobs in other tabs ----- */

function describeJob(job) {
  const scope = job.chatUuid ? ' (' + job.chatUuid + ')' : '';
  if (job.status === 'running') return 'An export is running in another Arena tab' + scope + '.';
  if (job.status === 'stopped') return 'A partial snapshot is ready in another Arena tab' + scope + '.';
  if (job.status === 'done') return 'An export finished in another Arena tab' + scope + '.';
  if (job.status === 'error') return 'An export failed in another Arena tab' + scope + '.';
  return 'Another Arena tab has export activity' + scope + '.';
}

function showBanner(job) {
  banner.hidden = false;
  bannerText.textContent = describeJob(job);
  bannerSwitch.onclick = () => {
    try { chrome.tabs.update?.(job.tabId, { active: true }); } catch { /* tab closed */ }
  };
}

function onForeignJob(job) {
  if (!job || typeof job.tabId !== 'number') return;
  if (job.tabId === currentTabId) return;
  const visible = job.status === 'running' || (job.unseen && job.status !== 'running');
  if (!visible) return;
  showBanner(job);
}

function onJobsList(jobs) {
  const others = jobs.filter(job => typeof job.tabId === 'number' && job.tabId !== currentTabId);
  const running = others.find(job => job.status === 'running');
  const unseen = others.find(job => job.unseen && (job.status === 'done' || job.status === 'stopped' || job.status === 'error'));
  const chosen = running || unseen;
  if (!chosen) { banner.hidden = true; return; }
  showBanner(chosen);
}

/* ----- compression worker ----- */

// A worker owns one snapshot and its BlockIndex. Replacing the snapshot kills
// the old worker, so obsolete expensive work cannot delay the new preview.
function disableCompressionWorker(state, error) {
  state.worker?.terminate(); state.worker = null;
  for (const pending of state.pending.values()) pending.reject(error);
  state.pending.clear();
}

function initializeCompression(snapshot) {
  if (compressionState?.worker) compressionState.worker.terminate();
  if (compressionState) for (const pending of compressionState.pending.values()) pending.reject(new Error('Snapshot replaced.'));
  const state = {
    snapshot, id: ++nextSnapshotId, worker: null, pending: new Map(),
    cache: new Map(), requests: new Map(), fallbackIndex: null, fallbackBase: new Map(), fallbackResults: new Map(),
  };
  compressionState = state;
  try {
    if (typeof Worker === 'undefined') throw new Error('Workers are unavailable.');
    const worker = new Worker('compress-worker.js');
    state.worker = worker;
    worker.onmessage = ({ data }) => {
      const pending = state.pending.get(data?.requestId);
      if (!pending) return;
      state.pending.delete(data.requestId);
      if (data.snapshotId !== state.id) {
        pending.reject(new Error('Snapshot replaced.'));
        return;
      }
      if (data.type === 'MODE_RESULT') pending.resolve(data.result);
      else if (data.type === 'MARKDOWN_RESULT' && typeof data.markdown === 'string') pending.resolve(data.markdown);
      else pending.reject(new Error(data?.error || 'Compression worker failed.'));
    };
    worker.onerror = () => {
      disableCompressionWorker(state, new Error('Compression worker stopped.'));
    };
    worker.postMessage({ type: 'INIT_SNAPSHOT', snapshotId: state.id, markdown: snapshot.markdown });
  } catch {
    state.worker?.terminate(); state.worker = null;
  }
}

function fallbackResult(state, mode, condense) {
  const key = modeKey(mode, condense);
  if (!state.fallbackResults.has(key)) {
    state.fallbackIndex ||= AREX.buildMarkdownIndex(state.snapshot.markdown);
    if (!state.fallbackBase.has(mode)) state.fallbackBase.set(mode, AREX.compressIndex(state.fallbackIndex, { mode, condenseThoughts: false }));
    const base = state.fallbackBase.get(mode);
    state.fallbackResults.set(key, AREX.applyThoughtCondensation
      ? AREX.applyThoughtCondensation(base, { mode, condenseThoughts: condense })
      : base);
  }
  return state.fallbackResults.get(key);
}

function fallbackCompress(state, mode, condense) {
  const { markdown, ...meta } = fallbackResult(state, mode, condense);
  return meta;
}

const fallbackMarkdown = (state, mode, condense) => fallbackResult(state, mode, condense).markdown;

// Mode previews only move statistics across the port (includeMarkdown: false);
// the multi-megabyte Markdown string is fetched lazily on Download. Results are
// cached per mode and condense choice, so toggling never rescans the Arena tab.
function previewFor(state, mode, condense) {
  const key = modeKey(mode, condense);
  if (state.cache.has(key)) return Promise.resolve(state.cache.get(key));
  if (state.requests.has(key)) return state.requests.get(key);
  let work;
  if (state.worker) {
    const requestId = ++nextRequestId;
    work = new Promise((resolve, reject) => {
      state.pending.set(requestId, { resolve, reject, kind: 'preview' });
      try { state.worker.postMessage({ type: 'GET_MODE', snapshotId: state.id, requestId, mode, condenseThoughts: condense, includeMarkdown: false }); }
      catch (error) { state.pending.delete(requestId); reject(error); }
    }).catch(error => {
      if (compressionState !== state) throw error;
      disableCompressionWorker(state, error);
      return fallbackCompress(state, mode, condense);
    });
  } else {
    // Defer the fallback so the popup can paint its busy state first.
    work = delay(0).then(() => fallbackCompress(state, mode, condense));
  }
  const request = work.then(result => { state.cache.set(key, result); return result; }).finally(() => state.requests.delete(key));
  state.requests.set(key, request);
  return request;
}

function markdownForMode(state, mode, condense) {
  let work;
  if (state.worker) {
    const requestId = ++nextRequestId;
    work = new Promise((resolve, reject) => {
      state.pending.set(requestId, { resolve, reject, kind: 'markdown' });
      try { state.worker.postMessage({ type: 'GET_MARKDOWN', snapshotId: state.id, requestId, mode, condenseThoughts: condense }); }
      catch (error) { state.pending.delete(requestId); reject(error); }
    }).catch(error => {
      if (compressionState !== state) throw error;
      disableCompressionWorker(state, error);
      return fallbackMarkdown(state, mode, condense);
    });
  } else {
    work = Promise.resolve().then(() => fallbackMarkdown(state, mode, condense));
  }
  return work;
}

async function renderSizePreview() {
  if (!prepared || !compressionState) return;
  const state = compressionState, snapshot = prepared, mode = compressionMode();
  const condense = condenseSelected(mode), key = modeKey(mode, condense);
  snapshot.preview = null;
  snapshot.previewMode = null;
  sizePreview.hidden = false;
  sizeValue.textContent = 'Calculating…';
  sizeExactValue.textContent = '';
  tokensValue.textContent = '';
  savedValue.textContent = '';
  startPreviewBusy();
  try {
    const preview = await previewFor(state, mode, condense);
    if (compressionState !== state || prepared !== snapshot || previewKey() !== key) return;
    snapshot.preview = preview;
    snapshot.previewMode = key;
    sizeValue.textContent = kb(preview.bytes);
    sizeExactValue.textContent = AREX.formatByteCount(preview.bytes);
    tokensValue.textContent = '~' + AREX.formatTokenCount(preview.estimatedTokens) + ' tokens';
    if (preview.savedBytes > 0) {
      const percent = Math.max(1, Math.round(preview.savedRatio * 100));
      savedValue.textContent = '−' + percent + '% from ' + kb(preview.baselineBytes);
    }
  } catch (error) {
    if (compressionState !== state || prepared !== snapshot || previewKey() !== key) return;
    sizeValue.textContent = 'Unavailable';
    say('Could not calculate the preview: ' + String(error?.message || error), 'error');
  } finally {
    // Always release this call's slot: a superseded run must not freeze the button.
    stopPreviewBusy();
  }
}

/* ----- export / download flow ----- */

async function preparePreview() {
  if (preparing) return;
  profileDoc = null;
  renderProfile(null);
  setRunningUi(true);
  const tab = await activeArenaTab();
  if (!tab) {
    setRunningUi(false);
    setPartialUi(preparedPartial, null, prepared);
    say('Open an Arena.ai agent conversation to export it.', 'error');
    return;
  }
  currentTabId = tab.id;
  currentChatUuid = chatUuidFromUrl(tab.url);
  currentTabUrl = tab.url;
  hasArenaTab = true;
  replayedProgress = 0;
  clearLog();
  resetProgress();
  setProgressPercent(2);
  const connection = ensureBackgroundPort();
  if (!connection) {
    setRunningUi(false);
    say('Could not reach the extension background worker. Reload the extension and retry.', 'error');
    return;
  }
  postToBackground({ type: 'AREX_HELLO', tabId: tab.id, chatUuid: currentChatUuid, tabUrl: tab.url });
  say(prepared ? 'Taking a fresh snapshot. The previous preview remains available until this one is ready.' : 'The scan continues in the Arena tab; you can close and reopen this popup.');
  postToBackground({
    type: 'AREX_EXPORT_START',
    tabId: tab.id,
    chatUuid: currentChatUuid,
    tabUrl: tab.url,
    options: {
      includeToolActivity: optActivity.checked,
      timestamps: optTimestamps.checked,
      profile: optProfile.checked,
    },
  });
}

function snapshotFilename(snapshot) {
  const filename = snapshot?.filename || 'arena-export.md';
  return preparedPartial ? partialFilename(filename) : filename;
}

async function downloadPrepared() {
  if (downloading || preparing || !prepared) return;
  const state = compressionState;
  if (!state || !prepared.preview || prepared.previewMode !== previewKey()) return;
  downloading = true;
  const snapshot = prepared, selectedKey = snapshot.previewMode;
  const selectedMode = compressionMode(), selectedCondense = condenseSelected(selectedMode);
  const filename = snapshotFilename(snapshot);
  updatePrimary();
  let url = null;
  try {
    const markdown = await markdownForMode(state, selectedMode, selectedCondense);
    if (compressionState !== state || prepared !== snapshot || previewKey() !== selectedKey) return;
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const preview = snapshot.preview;
    preview.bytes = blob.size;
    url = URL.createObjectURL(blob);
    let downloadId = null;
    try { downloadId = await chrome.downloads.download({ url, filename, saveAs: true }); }
    catch (error) { URL.revokeObjectURL(url); url = null; throw error; }
    trackBlobUrl(url, downloadId);
    const { messages = 0, expandedSpoilers = 0 } = snapshot.stats || {};
    const captured = snapshot.completedMessages ?? messages;
    const totalMsgs = snapshot.totalMessages ?? snapshot.stats?.totalMessages ?? null;
    if (prepared === snapshot && previewKey() === selectedKey) {
      sizeValue.textContent = kb(blob.size);
      sizeExactValue.textContent = AREX.formatByteCount(blob.size);
    }
    const details = [];
    if (preview.stats?.deduplicated) details.push(preview.stats.deduplicated + ' duplicate output(s) linked');
    if (preview.stats?.smartCompacted) details.push(preview.stats.smartCompacted + ' log block(s) compacted');
    if (preview.stats?.stubbed) details.push(preview.stats.stubbed + ' file output(s) with repeated lines referenced');
    if (preview.stats?.thoughtsCondensed) details.push(preview.stats.thoughtsCondensed + ' reasoning section(s) condensed');
    const detailText = details.length ? '\n' + details.join(' · ') : '';
    if (preparedPartial) {
      say(
        'Saved partial Markdown as ' + filename + '\n' +
          captured + (totalMsgs != null ? ' of ' + totalMsgs : '') + ' messages captured · ' +
          expandedSpoilers + ' spoilers · ' + AREX.formatByteCount(blob.size) +
          ' (' + kb(blob.size) + ') · ~' + AREX.formatTokenCount(preview.estimatedTokens) + ' tokens' + detailText,
        'ok',
      );
    } else {
      say(
        'Saved as ' + filename + '\n' + messages + ' messages · ' +
          expandedSpoilers + ' spoilers · ' + AREX.formatByteCount(blob.size) +
          ' (' + kb(blob.size) + ') · ~' + AREX.formatTokenCount(preview.estimatedTokens) + ' tokens' + detailText,
        'ok',
      );
    }
  } catch (error) {
    say(String(error?.message || error), 'error');
  } finally {
    downloading = false;
    updatePrimary();
  }
}

/* ----- anytime diagnostic log export ----- */

function logExportFilename() {
  let slug = '';
  const markdown = prepared?.markdown;
  if (typeof markdown === 'string') {
    const heading = markdown.match(/^#\s+(.+)$/m);
    if (heading) slug = slugify(heading[1]);
  }
  if (!slug) slug = slugify(currentChatUuid) || 'arena';
  return slug + '-log-' + stamp() + '.json';
}

function resolveLogExport(message) {
  const pending = pendingLogExports.get(message.requestId);
  if (!pending) return;
  pendingLogExports.delete(message.requestId);
  if (pending.quiet) quietLogRequests = Math.max(0, quietLogRequests - 1);
  pending.resolve(message);
}

function requestLogBundle({ quiet = false } = {}) {
  if (!hasArenaTab || currentTabId == null) {
    return Promise.reject(new Error('Open an Arena.ai agent conversation to export diagnostics.'));
  }
  if (!ensureBackgroundPort()) {
    return Promise.reject(new Error('The background worker is unavailable.'));
  }
  const requestId = 'log-' + (++logExportSeq) + '-' + Date.now();
  const timeoutMs = quiet ? LOG_EXPORT_TIMEOUT_MS * 0.6 : LOG_EXPORT_TIMEOUT_MS;
  if (quiet) quietLogRequests += 1;
  return new Promise((resolve, reject) => {
    let timer = null;
    pendingLogExports.set(requestId, {
      quiet,
      resolve: message => { if (timer) clearTimeout(timer); resolve(message); },
    });
    timer = setTimeout(() => {
      pendingLogExports.delete(requestId);
      if (quiet) quietLogRequests = Math.max(0, quietLogRequests - 1);
      reject(new Error('The background worker did not answer within ' + Math.round(timeoutMs / 1000) + ' s.'));
    }, timeoutMs);
    timer?.unref?.();
    const sent = postToBackground({
      type: 'AREX_EXPORT_LOG',
      tabId: currentTabId,
      chatUuid: currentChatUuid,
      tabUrl: currentTabUrl,
      requestId,
    });
    if (!sent) {
      clearTimeout(timer);
      pendingLogExports.delete(requestId);
      if (quiet) quietLogRequests = Math.max(0, quietLogRequests - 1);
      reject(new Error('The background worker is unavailable.'));
    }
  });
}

async function exportDiagnosticLog() {
  if (!hasArenaTab || currentTabId == null || logExporting) return;
  logExporting = true;
  exportLogBtn.textContent = 'Exporting log…';
  refreshDiagnostics();
  try {
    const reply = await requestLogBundle();
    if (!reply?.ok) throw new Error(reply?.error || 'The background worker could not assemble the log.');
    const bundle = reply.bundle && typeof reply.bundle === 'object' ? reply.bundle : reply;
    const filename = logExportFilename();
    await downloadJson(filename, bundle);
    const note = reply.timedOut
      ? ' (the Arena tab did not answer in time; coordinator + transfer state attached)'
      : '';
    say('Exported diagnostic log as ' + filename + note +
      (bundle.profile ? '\nContains the live profiler snapshot.' : '\nProfiling was off; stage log and transfer diagnostics only.'),
      reply.timedOut ? 'warn' : 'ok');
  } catch (error) {
    say('Could not export the log: ' + String(error?.message || error), 'error');
  } finally {
    logExporting = false;
    exportLogBtn.textContent = 'Export log (JSON)';
    refreshDiagnostics();
  }
}

/* ----- initialization ----- */

async function restoreScopedSnapshot() {
  try {
    const { snapshot, meta } = await loadScopedSnapshot();
    if (snapshot) {
      await prepareFromSnapshot(snapshot, { restored: true, meta, partial: Boolean(meta?.partial) });
      hideProgressChrome();
      // The finished profile may only be known to the coordinator / Arena tab.
      await refreshProfileFromCoordinator();
      return;
    }
    setPreparationControlsDisabled(false);
    resnapshotBtn.hidden = true;
    setPartialUi(false);
    renderProfile(null);
    updatePrimary();
  } catch (error) {
    setPreparationControlsDisabled(false);
    resnapshotBtn.hidden = true;
    updatePrimary();
    say('Could not restore the previous snapshot: ' + String(error?.message || error), 'warn');
  }
}

async function initializeArenaTab(tab) {
  currentTabId = tab.id;
  currentChatUuid = chatUuidFromUrl(tab.url);
  currentTabUrl = tab.url || null;
  hasArenaTab = true;
  singleTabNotice.hidden = true;
  compression.hidden = false;
  btn.disabled = true;
  refreshDiagnostics();
  const connection = ensureBackgroundPort();
  if (!connection) {
    setPreparationControlsDisabled(false);
    resnapshotBtn.hidden = true;
    updatePrimary();
    say('Could not reach the extension background worker. Reload the extension and retry.', 'error');
    return;
  }
  const firstStatus = new Promise(resolve => { statusWaiter = resolve; });
  postToBackground({ type: 'AREX_HELLO', tabId: currentTabId, chatUuid: currentChatUuid, tabUrl: currentTabUrl });
  postToBackground({ type: 'AREX_LIST_JOBS' });
  const job = await Promise.race([firstStatus, delay(800).then(() => undefined)]);
  statusWaiter = null;
  if (job && job.status === 'running') {
    gateOpen = true;
    await onBackgroundStatus(job);
    return;
  }
  await restoreScopedSnapshot();
  gateOpen = true;
  if (job) await onBackgroundStatus(job);
}

async function initializeNonArenaTab() {
  currentTabId = null;
  currentChatUuid = null;
  currentTabUrl = null;
  hasArenaTab = false;
  singleTabNotice.hidden = false;
  compression.hidden = true;
  sizePreview.hidden = true;
  partialCallout.hidden = true;
  resnapshotBtn.hidden = true;
  progress.hidden = true;
  renderProfile(null);
  refreshDiagnostics();
  updatePrimary();
  const connection = ensureBackgroundPort();
  if (connection) {
    postToBackground({ type: 'AREX_HELLO' });
    postToBackground({ type: 'AREX_LIST_JOBS' });
  }
  gateOpen = true;
}

async function initializePopup() {
  updatePrimary();
  renderProfile(null);
  await optionsReady;
  diagnostics.hidden = false;
  let tab = null;
  try { tab = await activeArenaTab(); } catch { tab = null; }
  if (!tab) {
    await initializeNonArenaTab();
    return;
  }
  await initializeArenaTab(tab);
}

btn.addEventListener('click', async () => {
  if (preparing) return;
  if (prepared) {
    await downloadPrepared();
    return;
  }
  await preparePreview();
});

cancelBtn.addEventListener('click', () => {
  if (!preparing) return;
  cancelBtn.disabled = true;
  cancelBtn.textContent = 'Stopping…';
  say('Stopping the export; messages captured so far will be kept as a partial snapshot.', 'warn');
  postToBackground({ type: 'AREX_EXPORT_CANCEL', tabId: currentTabId });
});

resnapshotBtn.addEventListener('click', () => {
  if (!preparing) void preparePreview();
});

[optActivity, optTimestamps].forEach(control => control.addEventListener('change', () => {
  persistOptions();
  updateCompressionControls();
  if (prepared) void renderSizePreview();
}));
optCompress.addEventListener('change', () => {
  if (!optCompress.checked) activeMode = 'off';
  else if (activeMode === 'off') activeMode = 'lossless';
  persistOptions();
  updateCompressionControls();
  if (prepared) void renderSizePreview();
});
optCondense.addEventListener('change', () => {
  persistOptions();
  updateCompressionControls();
  if (prepared) void renderSizePreview();
});
optProfile.addEventListener('change', () => {
  persistOptions();
  refreshDiagnostics();
});
profileDownload.addEventListener('click', () => {
  void downloadProfile();
});
exportLogBtn.addEventListener('click', () => {
  void exportDiagnosticLog();
});
modeButtons.forEach(button => button.addEventListener('click', () => {
  activeMode = button.dataset.mode;
  optCompress.checked = activeMode !== 'off';
  persistOptions();
  updateCompressionControls();
  if (prepared) void renderSizePreview();
}));

void initializePopup();
