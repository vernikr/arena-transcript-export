/* Popup: prepare once, preview compression modes locally, then download. */
(() => {
  const theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  chrome.storage.local.set({ theme });
  chrome.runtime.sendMessage({ arexTheme: theme }).catch(() => { });
})();

const $ = s => document.querySelector(s);
const status = $('#status');
const btn = $('#export');
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
const logEl = $('#log');

const CONTENT_FILES = [
  'content/selectors.js', 'content/util.js', 'content/markdown.js', 'content/serialize.js',
  'content/loader.js', 'content/expand.js', 'content/compress.js', 'content/main.js',
];
const STAGE_ORDER = ['history', 'expand', 'serialize', 'cleanup'];
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
let activeMode = 'lossless';
let resolveOptionsReady;
const optionsReady = new Promise(resolve => { resolveOptionsReady = resolve; });

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
  resolveOptionsReady();
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

function activeArenaTab() {
  return chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (!tab || !/^https:\/\/arena\.ai\/agent\//.test(tab.url || '')) {
      progress.hidden = false;
      logEl.replaceChildren();
      say('Open an Arena.ai agent conversation to export it.', 'error');
      return null;
    }
    return tab;
  });
}

async function ensurePort(tabId) {
  if (port) return port;
  const readiness = await new Promise(resolve => {
    let done = false;
    const fin = value => { if (!done) { done = true; resolve(value); } };
    try { chrome.tabs.sendMessage(tabId, { type: 'AREX_PING' }, response => fin(response || null)); }
    catch { fin(null); }
    setTimeout(() => fin(null), 800);
  });
  if (readiness?.ok && readiness.featureVersion !== '0.3.0') {
    throw new Error('Reload this Arena tab once to activate the updated export extension.');
  }
  if (!readiness?.ok) await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
  port = chrome.tabs.connect(tabId, { name: 'AREX' });
  port.onDisconnect.addListener(() => { port = null; });
  port.onMessage.addListener(msg => {
    if (msg.type === 'AREX_STATUS') onRemoteStatus(msg);
    if (msg.type === 'AREX_PROGRESS') onProgress(msg);
    if (msg.type === 'AREX_RESULT') onResult(msg);
  });
  return port;
}

function onRemoteStatus(message) {
  for (const event of message.progress || []) onProgress(event);
  if (['running', 'done', 'error'].includes(message.status)) progress.hidden = false;
  if (message.status !== 'running') return;

  preparing = true;
  btn.disabled = true;
  resnapshotBtn.disabled = true;
  btn.textContent = 'Scanning…';
  setPreparationControlsDisabled(true);
  progress.hidden = false;
  say('The scan continued in the Arena tab. Live progress is restored below.');
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
  li.scrollIntoView({ block: 'nearest' });
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
  line.li.scrollIntoView({ block: 'nearest' });
}

function onProgress(message) {
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
    case 'serialize':
      setText('serialize', message.phase === 'done'
        ? 'Markdown: ' + AREX.formatByteCount(message.bytes) + ' assembled'
        : 'Markdown: converting…');
      break;
    case 'cleanup':
      setText('cleanup', 'Cleanup: closing ' + message.closed + '/' + message.total + ' expanded spoilers…');
      break;
  }
}

function compressionMode() {
  return optCompress.checked && optActivity.checked ? activeMode : 'off';
}

function renderSizePreview() {
  if (!prepared) return;
  const preview = AREX.compressMarkdown(prepared.markdown, { mode: compressionMode() });
  const outputBlob = new Blob([preview.markdown], { type: 'text/markdown;charset=utf-8' });
  preview.bytes = outputBlob.size;
  sizePreview.hidden = false;
  sizeValue.textContent = kb(preview.bytes);
  sizeExactValue.textContent = AREX.formatByteCount(preview.bytes);
  tokensValue.textContent = '~' + AREX.formatTokenCount(preview.estimatedTokens) + ' tokens';
  if (preview.savedBytes > 0) {
    const percent = Math.max(1, Math.round(preview.savedRatio * 100));
    savedValue.textContent = '−' + percent + '% from ' + kb(preview.baselineBytes);
  } else {
    savedValue.textContent = '';
  }
  prepared.preview = preview;
}

async function onResult(message) {
  preparing = false;
  btn.disabled = false;
  resnapshotBtn.disabled = false;
  if (!message.ok) {
    btn.textContent = prepared ? 'Download Markdown' : 'Prepare preview';
    setPreparationControlsDisabled(!!prepared);
    if (prepared) renderSizePreview();
    say(message.error, 'error');
    for (const stage in lines) {
      if (!lines[stage].li.classList.contains('done')) {
        lines[stage].ic.className = 'ic';
        lines[stage].ic.textContent = '✕';
        lines[stage].ic.style.color = 'var(--error)';
      }
    }
    return;
  }

  prepared = {
    markdown: message.markdown,
    filename: message.filename,
    stats: message.stats,
    warnings: message.warnings || [],
    createdAt: Date.now(),
  };
  let storageWarning = '';
  let snapshotStored = false;
  try {
    await AREX_RESULT_STORE.save(prepared);
    snapshotStored = true;
  } catch (error) {
    storageWarning = '\n⚠ Could not save this preview for the next popup opening: ' +
      String(error?.message || error);
  }
  // Release the in-tab copy only after the durable popup-origin IndexedDB write succeeds.
  if (snapshotStored) {
    try { port?.postMessage({ type: 'AREX_RESULT_ACK' }); } catch { }
  }

  for (const stage of STAGE_ORDER) if (lines[stage]) setIcon(lines[stage], '✓', 'tick');
  setPreparationControlsDisabled(true);
  resnapshotBtn.hidden = false;
  resnapshotBtn.disabled = false;
  btn.textContent = 'Download Markdown';
  renderSizePreview();
  const warnings = message.warnings?.length ? '\n⚠ ' + message.warnings.join('\n⚠ ') : '';
  say(
    'Preview ready · ' + message.stats.messages + ' messages · ' + message.stats.expandedSpoilers +
      ' spoilers\nSwitch compression modes to update the size, then download.' + warnings + storageWarning,
    message.warnings?.length || storageWarning ? 'warn' : '',
  );
}

async function preparePreview() {
  if (preparing) return;
  preparing = true;
  btn.disabled = true;
  resnapshotBtn.disabled = true;
  btn.textContent = 'Preparing history…';
  setPreparationControlsDisabled(true);
  resnapshotBtn.disabled = true;
  const tab = await activeArenaTab();
  if (!tab) {
    preparing = false;
    btn.disabled = false;
    resnapshotBtn.disabled = false;
    btn.textContent = prepared ? 'Download Markdown' : 'Prepare preview';
    setPreparationControlsDisabled(!!prepared);
    return;
  }
  setPreparationControlsDisabled(true);
  resnapshotBtn.disabled = true;
  progress.hidden = false;
  logEl.replaceChildren();
  for (const key in lines) delete lines[key];
  say(prepared ? 'Taking a fresh snapshot. The previous preview remains available until this one is ready.' : 'The scan continues in the Arena tab; you can close and reopen this popup.');
  try {
    const connection = await ensurePort(tab.id);
    connection.postMessage({
      type: 'AREX_EXPORT_START',
      options: {
        includeToolActivity: optActivity.checked,
        timestamps: optTimestamps.checked,
      },
    });
  } catch (error) {
    preparing = false;
    btn.disabled = false;
    resnapshotBtn.disabled = false;
    btn.textContent = prepared ? 'Download Markdown' : 'Prepare preview';
    setPreparationControlsDisabled(!!prepared);
    say(String(error?.message || error), 'error');
  }
}

async function downloadPrepared() {
  if (!prepared || !prepared.preview) return;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const preview = AREX.compressMarkdown(prepared.markdown, { mode: compressionMode() });
  const blob = new Blob([preview.markdown], { type: 'text/markdown;charset=utf-8' });
  preview.bytes = blob.size;
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename: prepared.filename, saveAs: true });
    const savedFilename = prepared.filename;
    const { messages, expandedSpoilers } = prepared.stats;
    sizeValue.textContent = kb(blob.size);
    sizeExactValue.textContent = AREX.formatByteCount(blob.size);
    btn.disabled = false;
    btn.textContent = 'Download Markdown';
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
    btn.disabled = false;
    btn.textContent = 'Download Markdown';
    say(String(error?.message || error), 'error');
  } finally {
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
    const snapshot = await AREX_RESULT_STORE.load();
    if (snapshot && typeof snapshot.markdown === 'string' && snapshot.filename) {
      prepared = snapshot;
      progress.hidden = false;
      resnapshotBtn.hidden = false;
      resnapshotBtn.disabled = false;
      btn.textContent = 'Download Markdown';
      setPreparationControlsDisabled(true);
      renderSizePreview();
      const when = snapshot.createdAt ? new Date(snapshot.createdAt).toLocaleString() : 'previous session';
      const warnings = snapshot.warnings?.length ? '\n⚠ ' + snapshot.warnings.join('\n⚠ ') : '';
      say('Previous snapshot restored · ' + when + '\nChoose a compression mode, download it, or retake the snapshot.' + warnings);
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
    btn.disabled = false;
  }
}

async function reconnectToCurrentExport() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/arena\.ai\/agent\//.test(tab.url || '')) return;
    const connection = await ensurePort(tab.id);
    connection.postMessage({ type: 'AREX_GET_STATUS' });
  } catch (error) {
    const warning = 'Could not reconnect to the current Arena scan: ' + String(error?.message || error);
    say(prepared ? status.textContent + '\n⚠ ' + warning : warning, 'warn');
  }
}

async function initializePopup() {
  await restorePreviousSnapshot();
  await reconnectToCurrentExport();
}

void initializePopup();
