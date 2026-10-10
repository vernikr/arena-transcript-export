/* Popup: options, progress, download trigger. Talks to the content script over a port. */
const $ = s => document.querySelector(s);
const status = $('#status');
const btn = $('#export');
const optActivity = $('#includeToolActivity');
const optTimestamps = $('#timestamps');

const CONTENT_FILES = [
  'content/selectors.js', 'content/util.js', 'content/markdown.js', 'content/serialize.js',
  'content/loader.js', 'content/expand.js', 'content/main.js',
];
const say = (text, cls = '') => { status.textContent = text; status.className = cls; };

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

function describe(p) {
  switch (p.stage) {
    case 'history': return `Loading full history… ${p.loaded} messages`;
    case 'expand':  return `Expanding spoilers… pass ${p.pass}, ${p.expanded} opened`;
    case 'serialize': return 'Converting to Markdown…';
    case 'done':    return null; // handled with result
    default:        return 'Working…';
  }
}

btn.addEventListener('click', async () => {
  const tab = await activeArenaTab();
  if (!tab) return;
  btn.disabled = true;
  say('Connecting…');
  try {
    await ensurePort(tab.id);
    port.onMessage.addListener(async msg => {
      if (msg.type === 'AREX_PROGRESS') { const d = describe(msg); if (d) say(d); return; }
      if (msg.type !== 'AREX_RESULT') return;
      btn.disabled = false;
      if (!msg.ok) { say(msg.error, 'error'); return; }
      const url = URL.createObjectURL(new Blob([msg.markdown], { type: 'text/markdown;charset=utf-8' }));
      try {
        await chrome.downloads.download({ url, filename: msg.filename, saveAs: true });
        const warn = msg.warnings?.length ? `\n⚠ ${msg.warnings.join('\n⚠ ')}` : '';
        say(`Done: ${msg.filename}\n${msg.stats.messages} messages, ${msg.stats.expandedSpoilers} spoilers expanded.${warn}`, msg.warnings?.length ? 'warn' : '');
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
    });
    port.postMessage({
      type: 'AREX_EXPORT_START',
      options: { includeToolActivity: optActivity.checked, timestamps: optTimestamps.checked },
    });
    say('Starting…');
  } catch (err) {
    btn.disabled = false;
    say(String(err?.message || err), 'error');
  }
});

activeArenaTab();
