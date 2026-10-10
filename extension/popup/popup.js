/* Popup: options, staged progress log, download trigger. Talks to the content script via a Port. */
const $ = s => document.querySelector(s);
const status = $('#status');
const btn = $('#export');
const optActivity = $('#includeToolActivity');
const optTimestamps = $('#timestamps');
const progress = $('#progress');
const logEl = $('#log');

const CONTENT_FILES = [
  'content/selectors.js', 'content/util.js', 'content/markdown.js', 'content/serialize.js',
  'content/loader.js', 'content/expand.js', 'content/main.js',
];
const STAGE_ORDER = ['history', 'expand', 'serialize'];
const say = (text, cls = '') => { status.textContent = text; status.className = cls; };
const kb = n => n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' KB';

let port = null;
chrome.storage.sync.get({ includeToolActivity: true, timestamps: false }, o => {
  optActivity.checked = o.includeToolActivity;
  optTimestamps.checked = o.timestamps;
});
[optActivity, optTimestamps].forEach(c => c.addEventListener('change', () =>
  chrome.storage.sync.set({ includeToolActivity: optActivity.checked, timestamps: optTimestamps.checked })));

async function activeArenaTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/arena\.ai\/agent\//.test(tab.url || '')) {
    progress.hidden = false;
    logEl.replaceChildren();
    say('Open an Arena.ai agent conversation to export it.', 'error');
    btn.disabled = true;
    return null;
  }
  return tab;
}

async function ensurePort(tabId) {
  const alive = await new Promise(resolve => {
    let done = false;
    const fin = v => { if (!done) { done = true; resolve(v); } };
    try { chrome.tabs.sendMessage(tabId, { type: 'AREX_PING' }, r => fin(!!(r && r.ok))); } catch { fin(false); }
    setTimeout(() => fin(false), 800);
  });
  if (!alive) await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
  try { port?.disconnect(); } catch { /* stale */ }
  port = chrome.tabs.connect(tabId, { name: 'AREX' });
  return port;
}

/* ----- staged progress log ----- */
const lines = {};           // stage → {li, ic, txt}
let pagesLoaded = 0;

function stageLine(stage) {
  if (lines[stage]) return lines[stage];
  // stage becomes active → all earlier stages tick done
  for (const s of STAGE_ORDER) {
    if (s === stage) break;
    if (lines[s]) setIcon(lines[s], '✓', 'tick');
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
function setIcon(l, ch, cls) { l.ic.className = `ic ${cls}`; l.ic.textContent = ch; l.li.classList.remove('active'); l.li.classList.add('done'); }
function setText(stage, t) { const l = stageLine(stage); l.txt.textContent = t; l.li.scrollIntoView({ block: 'nearest' }); }

function onProgress(p) {
  switch (p.stage) {
    case 'history':
      if (p.phase === 'scan') setText('history', `History: Checking for earlier messages… (round ${p.round}, ${p.loaded})`);
      else if (p.phase === 'page') { pagesLoaded = p.pages; setText('history', `History: ${p.pages} earlier page(s) · ${p.loaded} messages…`); }
      else if (p.phase === 'loading') setText('history', 'History: receiving older messages…');
      else if (p.phase === 'retry') setText('history', 'History: retrying a failed page load…');
      else if (p.phase === 'settle') setText('history', `History: verifying top of branch (${p.stagnant}/${p.target || 2}) · ${p.loaded} messages`);
      else setText('history', 'History: settling…');
      break;
    case 'expand':
      setText('expand', p.phase === 'settle'
        ? `Spoilers: pass ${p.pass}, rendering… (${p.expanded} opened)`
        : `Spoilers: pass ${p.pass}, opening ${p.clicking}… (${p.expanded} opened)`);
      break;
    case 'serialize':
      setText('serialize', p.phase === 'done' ? `Markdown: ${kb(p.bytes)} assembled` : 'Markdown: converting…');
      break;
  }
}

function onResult(msg) {
  btn.disabled = false;
  if (!msg.ok) {
    say(msg.error, 'error');
    for (const s in lines) if (!lines[s].li.classList.contains('done')) {
      lines[s].ic.className = 'ic'; lines[s].ic.textContent = '✕'; lines[s].ic.style.color = 'var(--error)';
    }
    return;
  }
  for (const s of STAGE_ORDER) if (lines[s]) setIcon(lines[s], '✓', 'tick');
  const { messages, expandedSpoilers } = msg.stats;
  const warn = msg.warnings?.length ? `\n⚠ ${msg.warnings.join('\n⚠ ')}` : '';
  say(`Saved as ${msg.filename}\n${messages} messages · ${expandedSpoilers} spoilers · ${kb(msg.markdown.length)}${warn}`,
    msg.warnings?.length ? 'warn' : 'ok');
}

btn.addEventListener('click', async () => {
  const tab = await activeArenaTab();
  if (!tab) return;
  btn.disabled = true;
  logEl.replaceChildren();
  for (const k in lines) delete lines[k];
  pagesLoaded = 0;
  progress.hidden = false;
  say('');
  try {
    await ensurePort(tab.id);
    port.onMessage.addListener(async msg => {
      if (msg.type === 'AREX_PROGRESS') return onProgress(msg);
      if (msg.type !== 'AREX_RESULT') return;
      if (msg.ok) {
        const url = URL.createObjectURL(new Blob([msg.markdown], { type: 'text/markdown;charset=utf-8' }));
        try { await chrome.downloads.download({ url, filename: msg.filename, saveAs: true }); }
        finally { setTimeout(() => URL.revokeObjectURL(url), 30000); }
      }
      onResult(msg);
    });
    port.postMessage({
      type: 'AREX_EXPORT_START',
      options: { includeToolActivity: optActivity.checked, timestamps: optTimestamps.checked },
    });
  } catch (err) {
    btn.disabled = false;
    say(String(err?.message || err), 'error');
  }
});

activeArenaTab();
