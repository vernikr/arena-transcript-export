/* Popup: prepare once, preview compression modes locally, then download. */
(() => {
  const theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  chrome.storage.local.set({ theme });
  chrome.runtime.sendMessage({ arexTheme: theme }).catch(() => { });
})();

const $ = s => document.querySelector(s);
const status = $('#status');
const btn = $('#export');
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
const STAGE_ORDER = ['history', 'expand', 'serialize'];
const MODE_DESCRIPTIONS = {
  lossless: 'Exact duplicate outputs are kept once and replaced by links to the original block.',
  smart: 'Lossless + removes terminal noise, folds long passing-test runs and trims very long clean logs. Error output is preserved.',
  stubs: 'Smart + shortens earlier repeated file snapshots when a later read of the same file is included.',
};
const say = (text, cls = '') => { status.textContent = text; status.className = cls; };
const kb = n => AREX.formatBytes(n);

let port = null;
let prepared = null;
let downloaded = false;
let preparing = false;
let activeMode = 'lossless';

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
      btn.disabled = true;
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
  if (readiness?.ok && !readiness.compressionPreview) {
    throw new Error('Reload this Arena tab once to activate the updated export extension.');
  }
  if (!readiness?.ok) await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
  port = chrome.tabs.connect(tabId, { name: 'AREX' });
  port.onDisconnect.addListener(() => { port = null; });
  port.onMessage.addListener(msg => {
    if (msg.type === 'AREX_PROGRESS') onProgress(msg);
    if (msg.type === 'AREX_RESULT') onResult(msg);
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
        ? 'Markdown: ' + kb(message.bytes) + ' assembled'
        : 'Markdown: converting…');
      break;
  }
}

function compressionMode() {
  return optCompress.checked && optActivity.checked ? activeMode : 'off';
}

function renderSizePreview() {
  if (!prepared) return;
  const preview = AREX.compressMarkdown(prepared.markdown, { mode: compressionMode() });
  sizePreview.hidden = false;
  sizeValue.textContent = kb(preview.bytes);
  tokensValue.textContent = '~' + AREX.formatTokenCount(preview.estimatedTokens) + ' tokens';
  if (preview.savedBytes > 0) {
    const percent = Math.max(1, Math.round(preview.savedRatio * 100));
    savedValue.textContent = '−' + percent + '% from ' + kb(preview.baselineBytes);
  } else {
    savedValue.textContent = '';
  }
  prepared.preview = preview;
}

function onResult(message) {
  preparing = false;
  btn.disabled = false;
  if (!message.ok) {
    prepared = null;
    downloaded = false;
    btn.textContent = 'Prepare preview';
    setPreparationControlsDisabled(false);
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

  prepared = message;
  downloaded = false;
  for (const stage of STAGE_ORDER) if (lines[stage]) setIcon(lines[stage], '✓', 'tick');
  setPreparationControlsDisabled(true);
  btn.textContent = 'Download Markdown';
  renderSizePreview();
  const warnings = message.warnings?.length ? '\n⚠ ' + message.warnings.join('\n⚠ ') : '';
  say(
    'Preview ready · ' + message.stats.messages + ' messages · ' + message.stats.expandedSpoilers +
      ' spoilers\nSwitch compression modes to update the size, then download.' + warnings,
    message.warnings?.length ? 'warn' : '',
  );
}

async function preparePreview() {
  const tab = await activeArenaTab();
  if (!tab) return;
  prepared = null;
  downloaded = false;
  preparing = true;
  btn.disabled = true;
  btn.textContent = 'Preparing history…';
  setPreparationControlsDisabled(true);
  sizePreview.hidden = true;
  savedValue.textContent = '';
  progress.hidden = false;
  logEl.replaceChildren();
  for (const key in lines) delete lines[key];
  say('');
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
    btn.textContent = 'Prepare preview';
    setPreparationControlsDisabled(false);
    say(String(error?.message || error), 'error');
  }
}

async function downloadPrepared() {
  if (!prepared || !prepared.preview) return;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const preview = AREX.compressMarkdown(prepared.markdown, { mode: compressionMode() });
  const url = URL.createObjectURL(new Blob([preview.markdown], { type: 'text/markdown;charset=utf-8' }));
  try {
    await chrome.downloads.download({ url, filename: prepared.filename, saveAs: true });
    port?.postMessage({ type: 'AREX_DOWNLOAD_ACK' });
    const savedFilename = prepared.filename;
    const { messages, expandedSpoilers } = prepared.stats;
    downloaded = true;
    prepared = null;
    setPreparationControlsDisabled(false);
    sizePreview.hidden = true;
    btn.disabled = false;
    btn.textContent = 'Prepare another preview';
    const stats = preview.stats;
    const details = [];
    if (stats.deduplicated) details.push(stats.deduplicated + ' duplicate output(s) linked');
    if (stats.smartCompacted) details.push(stats.smartCompacted + ' log block(s) compacted');
    if (stats.stubbed) details.push(stats.stubbed + ' earlier read(s) stubbed');
    const detailText = details.length ? '\n' + details.join(' · ') : '';
    say(
      'Saved as ' + savedFilename + '\n' + messages + ' messages · ' +
        expandedSpoilers + ' spoilers · ' + kb(preview.bytes) +
        ' · ~' + AREX.formatTokenCount(preview.estimatedTokens) + ' tokens' + detailText,
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
  if (prepared && !downloaded) {
    await downloadPrepared();
    return;
  }
  await preparePreview();
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

activeArenaTab();