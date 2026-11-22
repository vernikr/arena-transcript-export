// Orchestrator + chrome.runtime wiring (page module: EXPORT_START → markdown).
window.AREX = window.AREX || {};

AREX._port = null;
AREX._running = false;
AREX._pendingResult = null;

AREX.runExport = async function (options = {}) {
  if (AREX._running) throw new Error('Export is already running in this tab.');
  AREX._running = true;
  const progress = p => { try { AREX._port?.postMessage({ type: 'AREX_PROGRESS', ...p }); } catch { } };
  try {
    const found = await AREX.waitFor(() => AREX.logEl(), { timeoutMs: 15000 });
    if (!found) throw new Error('Transcript not found. Open an Arena agent conversation page and retry.');
    const log = AREX.logEl();

    const hist = await AREX.loadFullHistory(log, { onProgress: progress });
    let expand = { expanded: 0, stuck: [] };
    if (options.includeToolActivity !== false)
      expand = await AREX.expandAllSpoilers(log, { onProgress: progress });
    await AREX.settle(log, { quietMs: 400, maxMs: 6000 });

    progress({ stage: 'serialize', phase: 'start' });
    const markdown = AREX.serialize(log, options);
    const bytes = AREX.measureMarkdown(markdown).bytes;
    progress({ stage: 'serialize', phase: 'done', bytes });
    const leftCollapsed = options.includeToolActivity !== false ? AREX.qq(AREX.S.COLLAPSED, log).length : 0;

    const warnings = [];
    if (!hist.stable) warnings.push('History loading stopped before the oldest message was confirmed — the branch may be truncated.');
    if (leftCollapsed) warnings.push(leftCollapsed + ' spoiler(s) stayed collapsed (content unavailable).');

    const result = {
      markdown,
      filename: 'arena-' + AREX.slug(AREX.chatTitle()) + '-' + AREX.stamp() + '.md',
      stats: { messages: AREX.messages(log).length, expandedSpoilers: expand.expanded },
      warnings,
    };
    progress({ stage: 'done', ...result.stats, warnings });
    return result;
  } finally {
    AREX._running = false;
  }
};

AREX.directDownload = function (markdown, filename) {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
};

if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'AREX_PING') sendResponse({ ok: true, compressionPreview: true });
  });
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'AREX') return;
    AREX._port = port;
    port.onDisconnect.addListener(() => {
      const pending = AREX._pendingResult;
      AREX._port = null;
      if (pending) {
        AREX._pendingResult = null;
        AREX.directDownload(pending.markdown, pending.filename);
      }
    });
    port.onMessage.addListener(async msg => {
      if (msg?.type === 'AREX_DOWNLOAD_ACK') {
        AREX._pendingResult = null;
        return;
      }
      if (msg?.type !== 'AREX_EXPORT_START') return;
      try {
        const result = await AREX.runExport(msg.options || {});
        if (AREX._port) {
          AREX._pendingResult = result;
          AREX._port.postMessage({ type: 'AREX_RESULT', ok: true, ...result });
        } else {
          AREX.directDownload(result.markdown, result.filename);
        }
      } catch (err) {
        AREX._port?.postMessage({ type: 'AREX_RESULT', ok: false, error: String(err?.message || err) });
      }
    });
  });
}
