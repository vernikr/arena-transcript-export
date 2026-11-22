/* Popup: prepare once, preview compression modes locally, then download.
 * Talks to the background coordinator (AREX_POPUP port); the Arena tab talks
 * to the background via AREX_JOB. The popup never injects scripts or messages
 * the tab directly — closing the popup no longer affects the export. */
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
const optActivity = $('#includeToolActivity');
const optTimestamps = $('#timestamps');
const optCompress = $('#compressHistory');
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

const STAGE_ORDER = ['history', 'expand', 'process', 'serialize', 'cleanup'];
const STAGE_PERCENT = { history: 10, expand: 45, serialize: 75, cleanup: 90, done: 100, cancel: 100 };
const MODE_DESCRIPTIONS = {
  lossless: 'Exact duplicate outputs are kept once and replaced by links to the original block.',
  smart: 'Lossless + removes terminal noise, folds long passing-test runs and trims very long clean logs. Error output is preserved.',
  stubs: 'Smart + shortens earlier repeated file snapshots when a later read of the same file is included.',
};
const say = (text, cls = '') => { status.textContent = text; status.className = cls; };
const kb = n => AREX.formatBytes(n);

let port = null;
let prepared = null;
let preparing = false;
let downloading = false;
let activeMode = 'lossless';
let currentTabId = null;
let replayedProgress = 0;
let compressionState = null;
let nextSnapshotId = 0;
let nextRequestId = 0;
const optionsReadyRef = { resolve: null };
const optionsReady = new Promise(resolve => { optionsReadyRef.resolve = resolve; });

chrome.storage.sync.get({
  includeToolActivity: true,
  timestamps: false,
  compressHistory: true,
  compressionMode: 'lossless',
}, options => {
  optActivity.checked = options.includeToolActivity;
  optTimestamps.checked = options.timestamps;
  optCompress.checked = options.compressHistory;
  activeMode = ['lossless', 'smart', 'stubs'].includes(options.compressionMode)
    ? options.compressionMode : 'lossless';
  updateCompressionControls();
  optionsReadyRef.resolve();
});

function persistOptions() {
  chrome.storage.sync.set({
    includeToolActivity: optActivity.checked,
    timestamps: optTimestamps.checked,
    compressHistory: optCompress.checked,
    compressionMode: activeMode,
  });
}

function updateCompressionControls() {
  const available = optActivity.checked;
  optCompress.disabled = !available;
  compression.classList.toggle('disabled', !optCompress.checked || !available);
  modeButtons.forEach(button => {
    button.disabled = !available || !optCompress.checked;
    button.setAttribute('aria-pressed', String(button.dataset.mode === activeMode));
  });
  modeDescription.textContent = available
    ? MODE_DESCRIPTIONS[activeMode]
    : 'Enable tool activity to compress command outputs and repeated file snapshots.';
}

function setPreparationControlsDisabled(disabled) {
  optActivity.disabled = disabled;
  optTimestamps.disabled = disabled;
}

function setRunningUi(running) {
  preparing = running;
  btn.disabled = running;
  resnapshotBtn.disabled = running;
  cancelBtn.hidden = !running;
  cancelBtn.disabled = false;
  cancelBtn.textContent = 'Cancel export';
  setPreparationControlsDisabled(running || Boolean(prepared));
  progress.hidden = false;
  progressBar.hidden = false;
  if (running) btn.textContent = 'Scanning…';
}

function setProgressPercent(value) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  progressFill.style.width = pct + '%';
  progressBar.setAttribute('aria-valuenow', String(pct));
}

function hideProgressChrome() {
  progressBar.hidden = true;
}

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
    if (msg.type === 'AREX_STATUS') onBackgroundStatus(msg.job || null);
    else if (msg.type === 'AREX_PROGRESS') onProgress(msg);
    else if (msg.type === 'AREX_JOBS') onJobsList(msg.jobs || []);
    else if (msg.type === 'AREX_ERROR') say(msg.error || 'The background worker reported an error.', 'error');
    else if (msg.type === 'AREX_INMEMORY_RESULT') onInMemoryResult(msg);
  });
  return port;
}

/* ----- staged progress log ----- */
const lines = {};
function stageLine(stage) {
  if (lines[stage]) return lines[stage];
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
  line.txt.textContent = value;
  line.li.scrollIntoView?.({ block: 'nearest' });
}
function updatePercent(stage) {
  if (stage && STAGE_PERCENT[stage] != null) setProgressPercent(STAGE_PERCENT[stage]);
}
function markStagesDone() {
  for (const stage of STAGE_ORDER) if (lines[stage]) setIcon(lines[stage], '✓', 'tick');
  setProgressPercent(100);
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

function onProgress(message) {
  if (currentTabId != null && message.tabId != null && message.tabId !== currentTabId) return;
  if (message.stage === 'serialize' && lines.process) setProgressPercent(100);
  else if (STAGE_PERCENT[message.stage] != null) updatePercent(message.stage);
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
    case 'process':
      setProgressPercent(message.percent ?? 0);
      setText('process', 'Scanning: ' + message.processedMessages + '/' + message.totalMessages + ' messages · ' + message.expandedSpoilers + ' spoilers…');
      break;
    case 'serialize':
      setText('serialize', message.phase === 'done'
        ? 'Markdown: ' + AREX.formatByteCount(message.bytes) + ' assembled'
        : 'Markdown: converting…');
      break;
    case 'cleanup':
      setText('cleanup', 'Cleanup: closing ' + message.closed + '/' + message.total + ' expanded spoilers…');
      break;
    case 'cancel':
      say('Cancelling the export…', 'warn');
      break;
    case 'done':
      break; // completion is driven by AREX_STATUS
    default:
      break;
  }
}

async function snapshotFromStore() {
  const snapshot = await AREX_RESULT_STORE.load();
  return snapshot && typeof snapshot.markdown === 'string' && snapshot.filename ? snapshot : null;
}

async function prepareFromSnapshot(snapshot, { restored = false, warning = '' } = {}) {
  prepared = snapshot;
  initializeCompression(snapshot);
  resnapshotBtn.hidden = false;
  resnapshotBtn.disabled = false;
  btn.textContent = 'Download Markdown';
  setPreparationControlsDisabled(true);
  renderSizePreview();
  const warnings = prepared.warnings?.length ? '\n⚠ ' + prepared.warnings.join('\n⚠ ') : '';
  if (restored) {
    const when = snapshot.createdAt ? new Date(snapshot.createdAt).toLocaleString() : 'previous session';
    say('Previous snapshot restored · ' + when + '\nChoose a compression mode, download it, or retake the snapshot.' + warnings, warning ? 'warn' : '');
  } else if (warning) {
    say(warning + warnings, 'warn');
  } else {
    say(
      'Preview ready · ' + prepared.stats.messages + ' messages · ' + prepared.stats.expandedSpoilers +
        ' spoilers\nSwitch compression modes to update the size, then download.' + warnings,
      warnings ? 'warn' : '',
    );
  }
}

async function onExportDoneFromBackground() {
  preparing = false;
  btn.disabled = false;
  resnapshotBtn.disabled = false;
  cancelBtn.hidden = true;
  markStagesDone();
  let storageWarning = '';
  let snapshot = null;
  try {
    snapshot = await snapshotFromStore();
  } catch (error) {
    storageWarning = '⚠ Could not read the saved snapshot: ' + String(error?.message || error);
  }
  if (snapshot) {
    await prepareFromSnapshot(snapshot, { warning: storageWarning });
    return;
  }
  // Background could not persist the snapshot — ask it for the in-memory copy.
  postToBackground({ type: 'AREX_GET_INMEMORY_RESULT', tabId: currentTabId });
}

function onInMemoryResult(message) {
  if (!message?.ok || typeof message.markdown !== 'string') {
    say('The export finished but its snapshot is unavailable: ' + (message?.error || 'unknown error'), 'error');
    return;
  }
  void prepareFromSnapshot({
    markdown: message.markdown,
    filename: message.filename || 'arena-export.md',
    stats: message.stats || { messages: 0, expandedSpoilers: 0 },
    warnings: message.warnings || [],
    createdAt: Date.now(),
  }, { warning: '⚠ Could not save the snapshot to browser storage — download it now before closing the popup.' });
}

async function onBackgroundStatus(job) {
  if (!job) return;
  if (currentTabId != null && job.tabId !== currentTabId) return;
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
  if (job.status === 'done' || job.status === 'saved') {
    await onExportDoneFromBackground();
    return;
  }
  if (job.status === 'error') {
    preparing = false;
    btn.disabled = false;
    resnapshotBtn.disabled = false;
    cancelBtn.hidden = true;
    btn.textContent = prepared ? 'Download Markdown' : 'Prepare preview';
    setPreparationControlsDisabled(Boolean(prepared));
    if (prepared) renderSizePreview();
    say(job.error || 'Export failed.', 'error');
    markStagesFailed();
    if (job.hasInMemoryResult && !prepared) postToBackground({ type: 'AREX_GET_INMEMORY_RESULT', tabId: currentTabId });
    return;
  }
}

function onJobsList(jobs) {
  const running = jobs.find(job => job.status === 'running');
  if (!running || currentTabId != null) return;
  banner.hidden = false;
  bannerText.textContent = 'An export is running in another Arena tab' +
    (running.chatUuid ? ' (' + running.chatUuid + ')' : '') + '.';
  bannerSwitch.onclick = () => chrome.tabs.update(running.tabId, { active: true });
}

function compressionMode() {
  return optCompress.checked && optActivity.checked ? activeMode : 'off';
}

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
  const state = { snapshot, id: ++nextSnapshotId, worker: null, pending: new Map(), cache: new Map(), requests: new Map(), fallbackIndex: null };
  compressionState = state;
  try {
    if (typeof Worker === 'undefined') throw new Error('Workers are unavailable.');
    const worker = new Worker('compress-worker.js');
    state.worker = worker;
    worker.onmessage = ({ data }) => {
      const pending = state.pending.get(data?.requestId);
      if (!pending) return;
      state.pending.delete(data.requestId);
      if (data.type === 'MODE_RESULT' && data.snapshotId === state.id) pending.resolve(data.result);
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

function previewFor(state, mode) {
  if (state.cache.has(mode)) return Promise.resolve(state.cache.get(mode));
  if (state.requests.has(mode)) return state.requests.get(mode);
  const computeFallback = () => {
    // Used only if Worker is unavailable or fails. Keep the export usable.
    state.fallbackIndex ||= AREX.buildMarkdownIndex(state.snapshot.markdown);
    return AREX.compressIndex(state.fallbackIndex, { mode });
  };
  let work;
  if (state.worker) {
    const requestId = ++nextRequestId;
    work = new Promise((resolve, reject) => {
      state.pending.set(requestId, { resolve, reject });
      try { state.worker.postMessage({ type: 'GET_MODE', snapshotId: state.id, requestId, mode }); }
      catch (error) { state.pending.delete(requestId); reject(error); }
    }).catch(error => {
      if (compressionState !== state) throw error;
      disableCompressionWorker(state, error);
      return computeFallback();
    });
  } else {
    // Defer fallback to allow the popup to paint its busy state first.
    work = new Promise(resolve => setTimeout(resolve, 0)).then(computeFallback);
  }
  const request = work.then(result => { state.cache.set(mode, result); return result; }).finally(() => state.requests.delete(mode));
  state.requests.set(mode, request);
  return request;
}

async function renderSizePreview() {
  if (!prepared || !compressionState) return;
  const state = compressionState, snapshot = prepared, mode = compressionMode();
  snapshot.preview = null;
  snapshot.previewMode = null;
  sizePreview.hidden = false;
  sizeValue.textContent = 'Calculating…';
  sizeExactValue.textContent = '';
  tokensValue.textContent = '';
  savedValue.textContent = '';
  if (!preparing && !downloading) btn.disabled = true;
  try {
    const preview = await previewFor(state, mode);
    if (compressionState !== state || prepared !== snapshot || compressionMode() !== mode) return;
    snapshot.preview = preview;
    snapshot.previewMode = mode;
    sizeValue.textContent = kb(preview.bytes);
    sizeExactValue.textContent = AREX.formatByteCount(preview.bytes);
    tokensValue.textContent = '~' + AREX.formatTokenCount(preview.estimatedTokens) + ' tokens';
    if (preview.savedBytes > 0) {
      const percent = Math.max(1, Math.round(preview.savedRatio * 100));
      savedValue.textContent = '−' + percent + '% from ' + kb(preview.baselineBytes);
    }
    if (!preparing && !downloading) btn.disabled = false;
  } catch (error) {
    if (compressionState !== state || prepared !== snapshot || compressionMode() !== mode) return;
    sizeValue.textContent = 'Unavailable';
    say('Could not calculate the preview: ' + String(error?.message || error), 'error');
    if (!preparing && !downloading) btn.disabled = true;
  }
}

async function preparePreview() {
  if (preparing) return;
  preparing = true;
  btn.disabled = true;
  resnapshotBtn.disabled = true;
  btn.textContent = 'Preparing history…';
  setPreparationControlsDisabled(true);
  const tab = await activeArenaTab();
  if (!tab) {
    preparing = false;
    btn.disabled = false;
    resnapshotBtn.disabled = false;
    btn.textContent = prepared ? 'Download Markdown' : 'Prepare preview';
    setPreparationControlsDisabled(Boolean(prepared));
    progress.hidden = false;
    logEl.replaceChildren();
    for (const key in lines) delete lines[key];
    say('Open an Arena.ai agent conversation to export it.', 'error');
    return;
  }
  currentTabId = tab.id;
  replayedProgress = 0;
  progress.hidden = false;
  progressBar.hidden = false;
  setProgressPercent(2);
  logEl.replaceChildren();
  for (const key in lines) delete lines[key];
  const connection = ensureBackgroundPort();
  if (!connection) {
    preparing = false;
    btn.disabled = false;
    resnapshotBtn.disabled = false;
    btn.textContent = prepared ? 'Download Markdown' : 'Prepare preview';
    setPreparationControlsDisabled(Boolean(prepared));
    say('Could not reach the extension background worker. Reload the extension and retry.', 'error');
    return;
  }
  postToBackground({ type: 'AREX_HELLO', tabId: tab.id });
  say(prepared ? 'Taking a fresh snapshot. The previous preview remains available until this one is ready.' : 'The scan continues in the Arena tab; you can close and reopen this popup.');
  setRunningUi(true);
  postToBackground({
    type: 'AREX_EXPORT_START',
    tabId: tab.id,
    options: {
      includeToolActivity: optActivity.checked,
      timestamps: optTimestamps.checked,
    },
  });
}

async function downloadPrepared() {
  if (downloading || !prepared || !prepared.preview || prepared.previewMode !== compressionMode()) return;
  downloading = true;
  const snapshot = prepared, selectedMode = snapshot.previewMode;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const preview = snapshot.preview;
  const blob = new Blob([preview.markdown], { type: 'text/markdown;charset=utf-8' });
  preview.bytes = blob.size;
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename: snapshot.filename, saveAs: true });
    const savedFilename = snapshot.filename;
    const { messages, expandedSpoilers } = snapshot.stats;
    if (prepared === snapshot && compressionMode() === selectedMode) {
      sizeValue.textContent = kb(blob.size);
      sizeExactValue.textContent = AREX.formatByteCount(blob.size);
    }
    const details = [];
    if (preview.stats.deduplicated) details.push(preview.stats.deduplicated + ' duplicate output(s) linked');
    if (preview.stats.smartCompacted) details.push(preview.stats.smartCompacted + ' log block(s) compacted');
    if (preview.stats.stubbed) details.push(preview.stats.stubbed + ' earlier read(s) stubbed');
    const detailText = details.length ? '\n' + details.join(' · ') : '';
    say(
      'Saved as ' + savedFilename + '\n' + messages + ' messages · ' +
        expandedSpoilers + ' spoilers · ' + AREX.formatByteCount(blob.size) +
        ' (' + kb(blob.size) + ') · ~' + AREX.formatTokenCount(preview.estimatedTokens) + ' tokens' + detailText,
      'ok',
    );
  } catch (error) {
    say(String(error?.message || error), 'error');
  } finally {
    downloading = false;
    if (!preparing) {
      btn.disabled = Boolean(prepared && (!prepared.preview || prepared.previewMode !== compressionMode()));
      btn.textContent = prepared ? 'Download Markdown' : 'Prepare preview';
    }
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
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
  cancelBtn.textContent = 'Cancelling…';
  say('Cancelling the export…', 'warn');
  postToBackground({ type: 'AREX_EXPORT_CANCEL', tabId: currentTabId });
});

resnapshotBtn.addEventListener('click', () => {
  if (!preparing) void preparePreview();
});

[optActivity, optTimestamps, optCompress].forEach(control => control.addEventListener('change', () => {
  persistOptions();
  updateCompressionControls();
  if (prepared) renderSizePreview();
}));
modeButtons.forEach(button => button.addEventListener('click', () => {
  activeMode = button.dataset.mode;
  persistOptions();
  updateCompressionControls();
  if (prepared) renderSizePreview();
}));

async function restorePreviousSnapshot() {
  await optionsReady;
  try {
    const snapshot = await snapshotFromStore();
    if (snapshot) {
      await prepareFromSnapshot(snapshot, { restored: true });
      hideProgressChrome();
    } else {
      setPreparationControlsDisabled(false);
      resnapshotBtn.hidden = true;
      btn.textContent = 'Prepare preview';
    }
  } catch (error) {
    setPreparationControlsDisabled(false);
    resnapshotBtn.hidden = true;
    btn.textContent = 'Prepare preview';
    say('Could not restore the previous snapshot: ' + String(error?.message || error), 'warn');
  } finally {
    btn.disabled = preparing || downloading || Boolean(prepared && (!prepared.preview || prepared.previewMode !== compressionMode()));
  }
}

async function connectToCurrentTab() {
  try {
    const tab = await activeArenaTab();
    if (!tab) {
      // Not an Arena tab: listen for background activity and surface a switcher.
      const connection = ensureBackgroundPort();
      if (connection) {
        postToBackground({ type: 'AREX_HELLO' });
        postToBackground({ type: 'AREX_LIST_JOBS' });
      }
      return;
    }
    currentTabId = tab.id;
    const connection = ensureBackgroundPort();
    if (!connection) {
      say(prepared ? status.textContent : 'Could not reach the extension background worker.', prepared ? '' : 'warn');
      return;
    }
    postToBackground({ type: 'AREX_HELLO', tabId: tab.id });
  } catch (error) {
    const warning = 'Could not reconnect to the current Arena scan: ' + String(error?.message || error);
    say(prepared ? status.textContent + '\n⚠ ' + warning : warning, 'warn');
  }
}

async function initializePopup() {
  await restorePreviousSnapshot();
  await connectToCurrentTab();
}

void initializePopup();
