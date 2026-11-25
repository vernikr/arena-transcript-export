import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';

const popupHtml = readFileSync(new URL('../extension/popup/popup.html', import.meta.url), 'utf8');
const contentScript = name => readFileSync(new URL('../extension/content/' + name, import.meta.url), 'utf8');
const popupSource = readFileSync(new URL('../extension/popup/popup.js', import.meta.url), 'utf8');
// Same scripts, same order as popup.html; the worker-less fallback needs all of them to condense reasoning.
const POPUP_SCRIPTS = ['compress-index.js', 'compress-framing.js', 'compress.js', 'compress-stubs.js', 'compress-thoughts.js'];

const PERFECT_PROFILE = () => ({
  profileVersion: 1,
  tool: 'arena-transcript-export',
  toolVersion: '0.4.1',
  sourceUrl: 'https://arena.ai/agent/test',
  chatUuid: 'test',
  startedAt: new Date().toISOString(),
  durationMs: 1834.2,
  outcome: 'done',
  error: null,
  options: { includeToolActivity: true, timestamps: false, profile: true },
  totals: { messages: 4, windows: 1, expandedSpoilers: 3, markdownBytes: 20480, spoilersStuck: 0, spoilersTotal: 3, leftCollapsed: 0 },
  phases: { history: { ms: 210, count: 1, maxMs: 210 }, expand: { ms: 700, count: 1, maxMs: 700 }, cleanup: { ms: 120, count: 1, maxMs: 120 } },
  messageTiming: { count: 4, meanMs: 30.5, p95Ms: 42.1, maxMs: 50.2, maxMessageIndex: 2, maxWindowIndex: 0, samplesKept: 4, samplesCapped: false },
  windows: [{ index: 0, from: 0, to: 4, messages: 4, spoilers: 3, ms: 900, expandMs: 700, serializeMs: 120, cleanupMs: 60, bytes: 20480 }],
  windowsOmitted: 0,
  memory: [],
  events: [{ tMs: 0, phase: 'export.start' }, { tMs: 1834.2, phase: 'export.done' }],
  eventsDropped: 0,
});

// A ready-to-compress transcript: one dedupable command block plus ten
// recognised passing-test lines, so Lossless/Smart/Stubs all have work to do.
function sampleMarkdown() {
  const fence = String.fromCharCode(96).repeat(3);
  const passed = Array.from({ length: 12 }, (_, i) => '✓ suite > test-' + i + ' [1.00ms]').join('\n');
  const output = '**stdout:**\n\n' + fence + '\ntext\n' + passed + '\n' + fence;
  return '# Test branch\n\n- Source: https://arena.ai/agent/test\n\n## 👤 User\n\nHi\n\n## 🤖 Assistant\n\n' +
    output + '\n\nmore\n\n' + output;
}

const waitUntil = async (predicate, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

// The popup is ready to accept progress once the compression section is shown
// for an Arena tab and the initial (empty) status roundtrip has settled.
const popupReady = async h => {
  await waitUntil(() => h.$('#compression').hidden === false && !h.$('#export').disabled);
};

// In-memory stand-in for AREX_RESULT_STORE v2, keyed exactly like result-store.js.
function createFakeStore({ snapshots = {}, logs = {}, legacySnapshot = null, legacyProfile = null } = {}) {
  const snapKey = (tabId, chatUuid) => 'tab:' + tabId + '|chat:' + chatUuid;
  const logKey = (tabId, chatUuid) => 'log|tab:' + tabId + '|chat:' + chatUuid;
  const store = {
    snapshots, logs, saves: [],
    async loadForTab(tabId, chatUuid) {
      const rec = snapshots[snapKey(tabId, chatUuid)];
      return rec ? rec.snapshot : null;
    },
    async loadMetaForTab(tabId, chatUuid) {
      const rec = snapshots[snapKey(tabId, chatUuid)];
      return rec ? rec.meta : null;
    },
    async loadDiagnosticLog(tabId, chatUuid) {
      const rec = logs[logKey(tabId, chatUuid)];
      return rec ? rec.log : null;
    },
    async saveForScope(scope, snapshot, options = {}) {
      const meta = {
        filename: snapshot.filename, stats: snapshot.stats, warnings: snapshot.warnings || [],
        createdAt: snapshot.createdAt, partial: Boolean(options.partial),
        completedMessages: snapshot.completedMessages ?? null, totalMessages: snapshot.totalMessages ?? null,
      };
      snapshots[snapKey(scope.tabId, scope.chatUuid)] = { snapshot, meta, profile: options.profile || null };
      this.saves.push({ scope, snapshot, options });
      return meta;
    },
    async load() { return legacySnapshot; },
    async loadProfile() { return legacyProfile; },
  };
  return store;
}

function setupPopup({
  tab = { id: 1, url: 'https://arena.ai/agent/test' },
  store = createFakeStore(),
  portHandler = () => {},
  scripts = ['compress.js'],
  stored: initialStored = {},
} = {}) {
  const dom = new JSDOM(popupHtml, { url: 'chrome-extension://test/popup/popup.html', runScripts: 'outside-only' });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false });
  window.TextEncoder = TextEncoder;
  window.HTMLElement.prototype.scrollIntoView = function () {};

  const stored = { ...initialStored };
  const sent = [];
  let messageListener = null;
  const downloads = [];
  const objectUrls = new Map();
  let nextObjectUrl = 0;
  const downloadListeners = [];
  let nextDownloadId = 1;

  const chromeMock = {
    storage: {
      local: { set() {} },
      sync: {
        get(defaults, callback) { callback({ ...defaults, ...stored }); },
        set(value) { Object.assign(stored, value); },
      },
    },
    runtime: {
      sendMessage() { return Promise.resolve(); },
      connect() {
        return {
          onDisconnect: { addListener() {} },
          onMessage: { addListener(listener) { messageListener = listener; } },
          postMessage(message) {
            sent.push(message);
            portHandler(message, emit);
          },
        };
      },
    },
    tabs: {
      async query() { return tab ? [{ ...tab }] : [{ id: 99, url: 'https://github.com/some/repo' }]; },
      update() {},
    },
    downloads: {
      async download({ url, filename }) {
        const id = nextDownloadId++;
        downloads.push({ id, url, filename });
        return id;
      },
      onChanged: {
        addListener(listener) { downloadListeners.push(listener); },
        removeListener(listener) {
          const index = downloadListeners.indexOf(listener);
          if (index >= 0) downloadListeners.splice(index, 1);
        },
      },
    },
  };

  window.chrome = chromeMock;
  window.AREX_RESULT_STORE = store;
  window.URL.createObjectURL = blob => {
    const url = 'blob:test-' + (++nextObjectUrl);
    objectUrls.set(url, blob);
    return url;
  };
  let revoked = 0;
  window.URL.revokeObjectURL = () => { revoked += 1; };

  const context = dom.getInternalVMContext();
  for (const script of scripts) vm.runInContext(contentScript(script), context, { filename: script });
  vm.runInContext(popupSource, context, { filename: 'popup.js' });

  function emit(message) { if (messageListener) messageListener(message); }

  const $ = selector => window.document.querySelector(selector);
  const readBlob = async url => {
    const blob = objectUrls.get(url);
    const reader = new window.FileReader();
    return new Promise(resolve => {
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
  };
  const lastDownload = () => downloads.at(-1);
  const completeDownload = id => {
    for (const listener of [...downloadListeners]) listener({ id, state: { current: 'complete' } });
  };

  return {
    dom, window, $, sent, stored, store, downloads, downloadListeners,
    emit, readBlob, lastDownload, completeDownload,
    revokedCount: () => revoked,
    close: () => dom.window.close(),
  };
}

test('popup exposes compression modes, remembers the selection, and disables them without tool activity', async () => {
  const h = setupPopup();
  const { $ } = h;
  const lossless = $('[data-mode="lossless"]');
  const smart = $('[data-mode="smart"]');
  const stubs = $('[data-mode="stubs"]');
  const off = $('[data-mode="off"]');
  const compress = $('#compressHistory');
  const toolActivity = $('#includeToolActivity');

  await waitUntil(() => $('#compression').hidden === false);
  assert.equal(compress.checked, true);
  assert.equal(lossless.getAttribute('aria-pressed'), 'true');
  assert.equal(smart.getAttribute('aria-pressed'), 'false');
  assert.equal(off.getAttribute('aria-pressed'), 'false');

  smart.click();
  assert.equal(smart.getAttribute('aria-pressed'), 'true');
  assert.equal(h.stored.compressionMode, 'smart');

  off.click();
  assert.equal(off.getAttribute('aria-pressed'), 'true');
  assert.equal(compress.checked, false, 'switching to Off turns compression off');
  assert.equal(h.stored.compressionMode, 'off');

  compress.click(); // re-enable compression: falls back to a real mode
  assert.equal(compress.checked, true);
  assert.equal(h.stored.compressionMode, 'lossless');

  toolActivity.click();
  assert.equal(compress.disabled, true);
  assert.equal(lossless.disabled, true);
  assert.match($('#modeDescription').textContent, /Enable tool activity/);

  toolActivity.click();
  assert.equal(compress.disabled, false);
  assert.equal(compress.checked, true);
  assert.equal(lossless.getAttribute('aria-pressed'), 'true');
  h.close();
});

test('prepared snapshot previews sizes in the worker-less fallback and downloads the selected mode', async () => {
  const markdown = sampleMarkdown();
  const store = createFakeStore({
    snapshots: {
      'tab:1|chat:test': {
        snapshot: {
          markdown,
          filename: 'arena-preview-test.md',
          stats: { messages: 4, expandedSpoilers: 3 },
          warnings: [],
          createdAt: 1700000000000,
          tabId: 1,
          chatUuid: 'test',
        },
        meta: { filename: 'arena-preview-test.md', partial: false, completedMessages: 4, totalMessages: 4 },
        profile: PERFECT_PROFILE(),
      },
    },
  });
  // Until the coordinator answers, the profile is looked up in the scoped record.
  const h = setupPopup({
    store,
    portHandler(message, emit) {
      if (message.type !== 'AREX_EXPORT_LOG') return;
      setTimeout(() => emit({
        type: 'AREX_LOG_BUNDLE', ok: true, requestId: message.requestId, timedOut: false,
        bundle: { status: 'done', coordinator: { status: 'done' }, profile: PERFECT_PROFILE() },
      }), 0);
    },
  });
  const { $ } = h;

  await waitUntil(() => $('#sizeExactValue').textContent.endsWith('B'), 4000);
  assert.equal($('#sizePreview').hidden, false);
  assert.match($('#savedValue').textContent, /from/);
  await waitUntil(() => $('#export').textContent === 'Download Markdown' && !$('#export').disabled, 4000);
  assert.equal($('#resnapshot').textContent, 'Retake snapshot');
  assert.equal($('#partialCallout').hidden, true);

  // The profile card is populated from the scoped diagnostic record.
  await waitUntil(() => /Total 1\.8 s/.test($('#profileSummary').textContent));
  const summary = $('#profileSummary').textContent;
  assert.match(summary, /4 messages/);
  assert.match(summary, /3 spoilers/);
  assert.match(summary, /done/);
  assert.match(summary, /history 210 ms/);
  assert.match(summary, /expand 700 ms/);
  assert.match(summary, /Slowest window #0/);
  assert.match(summary, /p95 42 ms/);
  assert.equal($('#diagnostics').hidden, false);
  assert.equal($('#profileDownload').hidden, false);

  $('#profileDownload').click();
  await waitUntil(() => h.lastDownload()?.filename === 'arena-preview-test-profile.json');
  assert.equal(h.lastDownload().filename, 'arena-preview-test-profile.json');
  const profileJson = await h.readBlob(h.lastDownload().url);
  assert.match(profileJson, /"profileVersion": 1/);
  assert.match(profileJson, /"durationMs": 1834.2/);

  await waitUntil(() => !$('#export').disabled);
  $('#export').click();
  await waitUntil(() => h.lastDownload()?.filename === 'arena-preview-test.md');
  const downloaded = await h.readBlob(h.lastDownload().url);
  assert.match(downloaded, /arex-output-/, 'Lossless replaced the duplicate block with a link to the original');
  assert.match($('#status').textContent, /Saved as arena-preview-test\.md/);
  assert.match($('#status').textContent, /4 messages · 3 spoilers/);
  assert.equal($('#sizeExactValue').textContent, new TextEncoder().encode(downloaded).length.toLocaleString('en-US') + ' B');
  assert.equal($('#export').textContent, 'Download Markdown');

  // The Blob URL is only revoked once the browser reports the download finished.
  const download = h.lastDownload();
  const listenersBefore = h.downloadListeners.length;
  assert.equal(h.revokedCount(), 0, 'URL survives a slow save-as dialog');
  h.completeDownload(download.id);
  assert.equal(h.revokedCount(), 1);
  assert.equal(h.downloadListeners.length, listenersBefore - 1, 'onChanged listener is removed after completion');
  // Duplicate state events for the same download are ignored.
  h.completeDownload(download.id);
  assert.equal(h.revokedCount(), 1);
  h.close();
});

test('interrupted downloads also release their Blob URL', async () => {
  const store = createFakeStore({
    snapshots: {
      'tab:1|chat:test': {
        snapshot: { markdown: '# A\n\ntext\n', filename: 'a.md', stats: { messages: 1, expandedSpoilers: 0 }, warnings: [], createdAt: 1 },
        meta: { filename: 'a.md', partial: false },
      },
    },
  });
  const h = setupPopup({ store });
  await waitUntil(() => !h.$('#export').disabled && h.$('#sizeExactValue').textContent.endsWith('B'), 4000);
  h.$('#export').click();
  await waitUntil(() => h.lastDownload()?.filename === 'a.md');
  const download = h.lastDownload();
  assert.equal(h.revokedCount(), 0);
  for (const listener of [...h.downloadListeners]) listener({ id: download.id, state: { current: 'interrupted' } });
  assert.equal(h.revokedCount(), 1);
  h.close();
});

test('popup scopes state strictly to the active tab: Tab B never sees Tab A\'s snapshot', async () => {
  const storeA = createFakeStore({
    snapshots: {
      'tab:1|chat:branch-1': {
        snapshot: { markdown: '# Branch one\n\nonly A\n', filename: 'branch-1.md', stats: { messages: 2, expandedSpoilers: 1 }, warnings: [], createdAt: 5 },
        meta: { filename: 'branch-1.md', partial: false },
      },
    },
  });
  // Same store contents, but the popup runs on Tab B (branch-2).
  const hB = setupPopup({ tab: { id: 2, url: 'https://arena.ai/agent/branch-2' }, store: storeA });
  await popupReady(hB);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(hB.$('#sizePreview').hidden, true, 'no size card for another branch');
  assert.equal(hB.$('#sizeValue').textContent, '—');
  assert.equal(hB.$('#export').textContent, 'Prepare preview');
  assert.equal(hB.$('#export').disabled, false);
  assert.equal(hB.$('#includeToolActivity').disabled, false, 'checkboxes stay usable');
  assert.equal(hB.$('#profileSummary').textContent, '');
  assert.equal(hB.$('#sizeLabel').textContent, 'Final Markdown size');
  assert.deepEqual({ ...hB.sent.find(m => m.type === 'AREX_HELLO') },
    { type: 'AREX_HELLO', tabId: 2, chatUuid: 'branch-2', tabUrl: 'https://arena.ai/agent/branch-2' });
  hB.close();

  // A non-Arena tab shows the clean "open an Arena conversation" state.
  const hNone = setupPopup({ tab: { id: 9, url: 'https://github.com/upper/repo' }, store: storeA });
  await waitUntil(() => hNone.$('#singleTabNotice').hidden === false);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(hNone.$('#compression').hidden, true);
  assert.equal(hNone.$('#sizePreview').hidden, true);
  assert.equal(hNone.$('#export').disabled, true);
  assert.equal(hNone.$('#exportLog').disabled, true, 'no diagnostic export without an Arena tab');
  assert.match(hNone.$('#singleTabNotice').textContent, /Open an Arena\.ai agent conversation/);
  assert.deepEqual({ ...hNone.sent.find(m => m.type === 'AREX_HELLO') }, { type: 'AREX_HELLO' });
  assert.deepEqual({ ...hNone.sent.find(m => m.type === 'AREX_LIST_JOBS') }, { type: 'AREX_LIST_JOBS' });
  hNone.close();
});

test('non-Arena tab surfaces another tab\'s background job through the banner', async () => {
  const h = setupPopup({
    tab: { id: 9, url: 'https://docs.example.com' },
    portHandler(message, emit) {
      if (message.type === 'AREX_LIST_JOBS') {
        setTimeout(() => emit({
          type: 'AREX_JOBS',
          jobs: [{ tabId: 4, chatUuid: 'busy-branch', status: 'running', progress: [] }],
        }), 0);
      }
    },
  });
  await waitUntil(() => h.$('#singleTabNotice').hidden === false);
  await waitUntil(() => h.$('#backgroundJobBanner').hidden === false);
  assert.match(h.$('#backgroundJobBannerText').textContent, /running in another Arena tab \(busy-branch\)/);
  h.close();
});

test('Stop on a running scan yields a downloadable, compressible partial snapshot', async () => {
  const partialMarkdown = '# Test branch\n\n- Status: Partial export (stopped at 2/4 messages)\n\n## 👤 User\n\n' +
    'Hi\n\n## 🤖 Assistant\n\nFirst answer\n';
  const store = createFakeStore();
  let cancelSeen = null;
  const h = setupPopup({
    store,
    portHandler(message, emit) {
      if (message.type === 'AREX_EXPORT_START') {
        setTimeout(() => emit({
          type: 'AREX_STATUS',
          job: {
            tabId: 1, chatUuid: 'test', status: 'running', startedAt: 1, updatedAt: 2,
            progress: [{ stage: 'process', processedMessages: 2, totalMessages: 4, expandedSpoilers: 5, totalSpoilers: 9, percent: 50 }],
          },
        }), 0);
      }
      if (message.type === 'AREX_EXPORT_CANCEL') {
        cancelSeen = message;
        setTimeout(() => emit({
          type: 'AREX_STATUS',
          job: {
            tabId: 1, chatUuid: 'test', status: 'stopped', startedAt: 1, updatedAt: 3, progress: [],
            resultMeta: {
              filename: 'arena-test-20261125-1010.md', partial: true,
              completedMessages: 2, totalMessages: 4, stats: { messages: 2, expandedSpoilers: 1 },
            },
          },
        }), 0);
      }
    },
  });
  const { $ } = h;

  await popupReady(h);
  assert.equal($('#export').textContent, 'Prepare preview');
  $('#export').click();
  await waitUntil(() => $('#cancel').hidden === false && $('#cancel').textContent === 'Stop & keep partial');
  await waitUntil(() => /Scanning: 2\/4 messages/.test($('#log').textContent));

  // Simulate the background persisting the stopped partial snapshot for (1, test).
  store.snapshots['tab:1|chat:test'] = {
    snapshot: {
      markdown: partialMarkdown,
      filename: 'arena-test-20261125-1010.md',
      stats: { messages: 2, expandedSpoilers: 1 },
      warnings: ['Partial export stopped at 2/4 messages.'],
      createdAt: 1700000000000,
      completedMessages: 2,
      totalMessages: 4,
      partial: true,
    },
    meta: {
      filename: 'arena-test-20261125-1010.md', partial: true,
      completedMessages: 2, totalMessages: 4, stats: { messages: 2, expandedSpoilers: 1 },
    },
    profile: null,
  };

  $('#cancel').click();
  await waitUntil(() => cancelSeen !== null);
  assert.equal(cancelSeen.tabId, 1);

  await waitUntil(() => h.$('#partialCallout').hidden === false, 4000);
  assert.match($('#partialTitle').textContent, /Partial snapshot · 2 of 4 messages captured before stop/);
  assert.equal($('#sizeLabel').textContent, 'Partial Markdown size');
  assert.equal($('#cancel').hidden, true);
  await waitUntil(() => $('#export').textContent === 'Download Partial Markdown' && !$('#export').disabled, 4000);
  assert.equal($('#resnapshot').hidden, false);
  assert.equal($('#resnapshot').textContent, 'Export full branch');

  // Every compression mode stays switchable on the partial snapshot.
  await waitUntil(() => $('#sizeExactValue').textContent.endsWith('B'), 4000);
  for (const mode of ['off', 'smart', 'stubs', 'lossless']) {
    const button = $('[data-mode="' + mode + '"]');
    assert.equal(button.disabled, false, mode + ' is switchable');
    button.click();
    await waitUntil(() => !$('#export').disabled && $('#sizeExactValue').textContent.endsWith('B'), 4000);
  }

  $('#export').click();
  await waitUntil(() => h.lastDownload() !== undefined);
  assert.equal(h.lastDownload().filename, 'arena-test-20261125-1010-partial.md', 'partial downloads use the -partial.md suffix');
  const downloaded = await h.readBlob(h.lastDownload().url);
  assert.match(downloaded, /Partial export \(stopped at 2\/4 messages\)/);
  assert.match($('#status').textContent, /Saved partial Markdown as arena-test-20261125-1010-partial\.md/);
  assert.match($('#status').textContent, /2 of 4 messages captured/);
  h.close();
});

test('Export log (JSON) works mid-run with status running and never touches the scan', async () => {
  const store = createFakeStore();
  const seen = [];
  const h = setupPopup({
    store,
    portHandler(message, emit) {
      seen.push(message.type);
      if (message.type === 'AREX_EXPORT_START') {
        setTimeout(() => emit({
          type: 'AREX_STATUS',
          job: { tabId: 1, chatUuid: 'test', status: 'running', startedAt: 1, updatedAt: 2, progress: [] },
        }), 0);
      }
      if (message.type === 'AREX_EXPORT_LOG') {
        setTimeout(() => emit({
          type: 'AREX_LOG_BUNDLE',
          ok: true,
          requestId: message.requestId,
          tabId: 1,
          chatUuid: 'test',
          timedOut: false,
          bundle: {
            schemaVersion: 1,
            status: 'running',
            tab: { responded: true },
            coordinator: { status: 'running', receivedChunks: 0, totalChunks: null },
            progress: [{ stage: 'process', processedMessages: 99, totalMessages: 100, percent: 99 }],
            profile: { profileVersion: 2, outcome: 'running', durationMs: 3450.5 },
          },
        }), 0);
      }
    },
  });
  const { $ } = h;

  await popupReady(h);
  $('#export').click();
  await waitUntil(() => h.sent.some(m => m.type === 'AREX_EXPORT_START'), 4000);
  await waitUntil(() => $('#cancel').hidden === false, 4000);
  // The scan is stuck at 99%: the log export must be available exactly then.
  h.emit({ type: 'AREX_PROGRESS', tabId: 1, stage: 'process', processedMessages: 99, totalMessages: 100, expandedSpoilers: 3, totalSpoilers: 3, percent: 99 });
  assert.match($('#log').textContent, /99\/100 messages · 3\/3 spoilers · 99%/);
  assert.equal($('#exportLog').disabled, false);
  assert.equal($('#diagnostics').hidden, false, 'log controls stay visible during a run');

  $('#exportLog').click();
  await waitUntil(() => /Exported diagnostic log as test-log-/.test($('#status').textContent), 4000);
  assert.match(h.lastDownload().filename, /^test-log-\d{8}-\d{4}\.json$/);
  const payload = JSON.parse(await h.readBlob(h.lastDownload().url));
  assert.equal(payload.status, 'running');
  assert.equal(payload.profile.profileVersion, 2);
  assert.equal(payload.progress[0].percent, 99);
  const logRequest = seen.filter(type => type === 'AREX_EXPORT_LOG').length;
  assert.equal(logRequest, 1);
  const requestMessage = h.sent.find(m => m.type === 'AREX_EXPORT_LOG');
  assert.equal(requestMessage.tabId, 1);
  assert.equal(requestMessage.chatUuid, 'test');
  assert.equal(typeof requestMessage.requestId, 'string');
  // The running scan is untouched: no cancel was sent and the stop button stays.
  assert.equal(h.sent.some(m => m.type === 'AREX_EXPORT_CANCEL'), false);
  assert.equal($('#cancel').hidden, false);
  assert.match($('#status').textContent, /Exported diagnostic log as test-log-/);
  assert.match($('#status').textContent, /Contains the live profiler snapshot/);
  h.close();
});

test('Export log (JSON) reports coordinator failures without breaking the popup', async () => {
  const h = setupPopup({
    portHandler(message, emit) {
      if (message.type === 'AREX_EXPORT_LOG') {
        setTimeout(() => emit({
          type: 'AREX_LOG_BUNDLE', ok: true, requestId: message.requestId, timedOut: true,
          bundle: { status: 'running', tab: { responded: false, timedOut: true }, coordinator: { status: 'running' }, profile: null },
        }), 0);
      }
    },
  });
  await waitUntil(() => h.$('#exportLog').disabled === false);
  h.$('#exportLog').click();
  await waitUntil(() => /did not answer in time/.test(h.$('#status').textContent), 4000);
  const payload = JSON.parse(await h.readBlob(h.lastDownload().url));
  assert.equal(payload.tab.timedOut, true);
  h.close();
});

test('progressive tail-end stages render cleanup and saving text instead of freezing at 99%', async () => {
  const h = setupPopup();
  const { $ } = h;
  await popupReady(h);
  // Replay events the way a reopened popup receives them from AREX_STATUS.
  h.emit({
    type: 'AREX_STATUS',
    job: {
      tabId: 1, status: 'running', progress: [
        { stage: 'history', phase: 'page', pages: 1, loaded: 12 },
        { stage: 'process', processedMessages: 4, totalMessages: 4, expandedSpoilers: 3, totalSpoilers: 3, percent: 99 },
        { stage: 'process', phase: 'cleanup', processedMessages: 4, totalMessages: 4, expandedSpoilers: 3, totalSpoilers: 3, closed: 2, total: 3, percent: 99 },
      ],
    },
  });
  await waitUntil(() => /Closing opened spoilers: 2\/3 spoilers · 4\/4 messages scanned · 99%/.test($('#log').textContent));
  h.emit({ type: 'AREX_PROGRESS', tabId: 1, stage: 'saving', sentChunks: 2, totalChunks: 5 });
  await waitUntil(() => /Saving snapshot chunk 2\/5 to storage/.test($('#log').textContent));
  h.emit({ type: 'AREX_PROGRESS', tabId: 1, stage: 'saving', phase: 'transfer', receivedChunks: 4, totalChunks: 5 });
  await waitUntil(() => /Saving snapshot chunk 4\/5 to storage/.test($('#log').textContent));
  assert.equal($('#progressBar').getAttribute('aria-valuenow'), '99');
  h.close();
});

test('reopening the popup during a scan reconnects to that tab\'s job and replays progress', async () => {
  const h = setupPopup({
    portHandler(message, emit) {
      if (message.type === 'AREX_HELLO') {
        setTimeout(() => emit({
          type: 'AREX_STATUS',
          job: {
            tabId: 1, chatUuid: 'test', status: 'running', startedAt: 1, updatedAt: 2,
            progress: [{ stage: 'history', phase: 'page', pages: 3, loaded: 60 }],
          },
        }), 0);
      }
    },
  });
  const { $ } = h;
  await waitUntil(() => $('#progress').hidden === false && $('#cancel').hidden === false);
  assert.equal($('#export').disabled, true);
  assert.match($('#log').textContent, /3 earlier page/);
  assert.match($('#status').textContent, /scan continued in the Arena tab/);
  h.emit({ type: 'AREX_PROGRESS', tabId: 1, stage: 'process', processedMessages: 2, totalMessages: 4, expandedSpoilers: 5, totalSpoilers: 9, percent: 42 });
  assert.match($('#log').textContent, /Scanning: 2\/4 messages · 5\/9 spoilers · 42%/);
  assert.equal($('#progressBar').getAttribute('aria-valuenow'), '42');
  h.close();
});

test('a restored snapshot allows another capture via Export full branch / Retake', async () => {
  const store = createFakeStore({
    snapshots: {
      'tab:1|chat:test': {
        snapshot: { markdown: '# A\n\ntext\n', filename: 'a.md', stats: { messages: 1, expandedSpoilers: 0 }, warnings: [], createdAt: 1 },
        meta: { filename: 'a.md', partial: false },
      },
    },
  });
  const h = setupPopup({ store });
  const { $ } = h;
  await waitUntil(() => $('#export').textContent === 'Download Markdown');
  assert.equal($('#resnapshot').hidden, false);
  $('#resnapshot').click();
  await waitUntil(() => h.sent.some(m => m.type === 'AREX_EXPORT_START'));
  const start = h.sent.find(m => m.type === 'AREX_EXPORT_START');
  assert.equal(start.tabId, 1);
  assert.equal(start.chatUuid, 'test');
  h.close();
});

// ----- Condense long reasoning -----

const fenceBlock = (body, lang = '') => String.fromCharCode(96).repeat(3) + lang + '\n' + body + '\n' + String.fromCharCode(96).repeat(3);

// Exactly `length` characters of filler that starts with `tag`.
const reasoningParagraph = (tag, length) => {
  let text = tag + ':';
  while (text.length < length - 1) text += ' reasoning';
  return text.slice(0, length - 1) + '.';
};

// One long Thought plus a duplicated listing, a passing-test run and a rewritten
// file, so every Smart and Stubs counter has exactly one thing to report.
function reasoningSession() {
  const paragraphs = Array.from({ length: 8 }, (_, i) => reasoningParagraph('step' + i, 400));
  const code = Array.from({ length: 30 }, (_, i) => 'def handler_' + i + '(request): return validate(request, limit=' + i * 7 + ')');
  const write = lines => '**command:**\n\n' + fenceBlock("$ cat > a.py <<'EOF'\n" + lines.join('\n') + '\nEOF', 'bash') +
    '\n\n**stdout:**\n\n' + fenceBlock('(no output)');
  const passed = Array.from({ length: 12 }, (_, i) => '✓ suite > unique-test-' + i + ' [1.00ms]').join('\n');
  const tests = '**command:**\n\n' + fenceBlock('$ npm test', 'bash') + '\n\n**stdout:**\n\n' + fenceBlock('text\n' + passed);
  const listing = Array.from({ length: 6 }, (_, i) => 'file-' + i + '.txt  4096  2025-01-01').join('\n');
  const ls = '**command:**\n\n' + fenceBlock('$ ls -l', 'bash') + '\n\n**stdout:**\n\n' + fenceBlock(listing);
  const ran = (n, body) => '#### Ran commands ' + n + '\n\n##### Used Bash 10ms\n\n' + body;
  const user = '## 👤 User\n\nFix the widget.';
  const final = 'All done.';
  const markdown = ['# Test branch', user, '## 🤖 Assistant\n\n#### Thought for 12s\n\n' + paragraphs.join('\n\n'),
    ran(1, write(code)), ran(2, write([...code.slice(0, 29), 'changed()'])), ran(3, tests), ran(4, ls), ran(5, ls), final].join('\n\n');
  return { markdown, user, final, paragraphs, reasoning: paragraphs.join('\n\n') };
}

const THOUGHT_HEADING = '#### Thought for 12s\n\n';
const CONDENSED_MARKER = {
  smart: '_[... condensed 4 intermediate reasoning blocks (1600 chars) ...]_',
  stubs: '_[... condensed 6 intermediate reasoning blocks (2400 chars) ...]_',
};

function reasoningStore(markdown) {
  return createFakeStore({
    snapshots: {
      'tab:1|chat:test': {
        snapshot: { markdown, filename: 'reasoning.md', stats: { messages: 2, expandedSpoilers: 0 }, warnings: [], createdAt: 1700000000000, tabId: 1, chatUuid: 'test' },
        meta: { filename: 'reasoning.md', partial: false, completedMessages: 2, totalMessages: 2 },
      },
    },
  });
}

async function openReasoningPopup(stored, markdown = reasoningSession().markdown) {
  const h = setupPopup({ store: reasoningStore(markdown), scripts: POPUP_SCRIPTS, stored });
  try {
    await waitUntil(() => !h.$('#export').disabled && h.$('#sizeExactValue').textContent.endsWith('B'), 4000);
  } catch (error) {
    h.close();
    throw error;
  }
  return h;
}

async function downloadReasoning(stored) {
  const h = await openReasoningPopup(stored);
  try {
    h.$('#export').click();
    await waitUntil(() => h.lastDownload() && /^Saved as/.test(h.$('#status').textContent));
    return { downloaded: await h.readBlob(h.lastDownload().url), status: h.$('#status').textContent };
  } finally {
    h.close();
  }
}

// Same compression stack as the popup, loaded separately to compute expected sizes.
function measureCompression(markdown, mode, condenseThoughts) {
  const context = vm.createContext({ TextEncoder });
  for (const script of POPUP_SCRIPTS) vm.runInContext(contentScript(script), context, { filename: script });
  const { AREX } = context;
  const base = AREX.compressIndex(AREX.buildMarkdownIndex(markdown), { mode });
  const { bytes, estimatedTokens } = AREX.applyThoughtCondensation(base, { mode, condenseThoughts });
  return { bytes, tokens: estimatedTokens };
}

const shownBytes = h => Number(h.$('#sizeExactValue').textContent.replace(/\D/g, ''));
const microtasks = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('popup.html hosts the reasoning toggle inside #compression and loads its scripts in dependency order', () => {
  const dom = new JSDOM(popupHtml);
  try {
    const { document } = dom.window;
    const checkbox = document.querySelector('#compression #condenseThoughts');
    assert.ok(checkbox, 'the checkbox lives inside #compression');
    assert.equal(checkbox.type, 'checkbox');
    assert.equal(checkbox.checked, true);
    assert.match(checkbox.closest('label').textContent, /Condense long reasoning/);

    const sources = [...document.querySelectorAll('script[src]')].map(script => script.getAttribute('src'));
    const order = ['../content/compress-index.js', '../content/compress-framing.js', '../content/compress.js',
      '../content/compress-stubs.js', '../content/compress-thoughts.js', '../shared/result-store.js', 'popup.js'];
    for (const source of order) {
      assert.ok(sources.includes(source), source + ' is loaded by the popup');
      assert.ok(existsSync(new URL('../extension/popup/' + source, import.meta.url)), source + ' exists');
    }
    const positions = order.map(source => sources.indexOf(source));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'scripts load in dependency order');
  } finally {
    dom.window.close();
  }
});

test('Condense long reasoning defaults on and is enabled only for Smart and Stubs with tool activity', async () => {
  const h = setupPopup({ scripts: POPUP_SCRIPTS });
  try {
    const { $ } = h;
    const condense = $('#condenseThoughts');
    await waitUntil(() => $('#compression').hidden === false);
    assert.equal(condense.checked, true, 'on by default');
    assert.equal(condense.disabled, true, 'Lossless ignores it');

    $('[data-mode="smart"]').click();
    assert.equal(condense.disabled, false);
    condense.click();
    assert.equal(condense.checked, false);
    assert.equal(h.stored.condenseThoughts, false, 'the choice is saved in chrome.storage.sync');

    $('[data-mode="stubs"]').click();
    assert.equal(condense.disabled, false);
    assert.equal(condense.checked, false, 'Smart and Stubs share one choice');

    $('[data-mode="lossless"]').click();
    assert.equal(condense.disabled, true);
    assert.equal(condense.checked, false, 'a disabled checkbox keeps the saved choice');
    $('[data-mode="off"]').click();
    assert.equal(condense.disabled, true);
    assert.equal(h.stored.condenseThoughts, false);

    $('[data-mode="smart"]').click();
    $('#includeToolActivity').click();
    assert.equal(condense.disabled, true, 'no tool activity, nothing to condense');
    $('#includeToolActivity').click();
    assert.equal(condense.disabled, false);
  } finally {
    h.close();
  }
});

test('the saved Condense choice is restored on open and survives Lossless and Off', async () => {
  const h = setupPopup({ scripts: POPUP_SCRIPTS, stored: { compressionMode: 'stubs', condenseThoughts: false } });
  try {
    const { $ } = h;
    await waitUntil(() => $('#compression').hidden === false);
    assert.equal($('#condenseThoughts').checked, false);
    assert.equal($('#condenseThoughts').disabled, false);
    assert.match($('#modeDescription').textContent, /Reasoning is kept in full\./);

    $('[data-mode="lossless"]').click();
    $('[data-mode="off"]').click();
    $('[data-mode="stubs"]').click();
    assert.equal($('#condenseThoughts').checked, false);
    assert.equal(h.stored.condenseThoughts, false);
  } finally {
    h.close();
  }

  const on = setupPopup({ scripts: POPUP_SCRIPTS, stored: { compressionMode: 'smart', condenseThoughts: true } });
  try {
    await waitUntil(() => on.$('#compression').hidden === false);
    assert.equal(on.$('#condenseThoughts').checked, true);
    assert.match(on.$('#modeDescription').textContent, /Long middle reasoning blocks are condensed/);
  } finally {
    on.close();
  }
});

test('mode descriptions say what happens to reasoning', async () => {
  const h = setupPopup({ scripts: POPUP_SCRIPTS });
  try {
    const { $ } = h;
    const description = () => $('#modeDescription').textContent;
    await waitUntil(() => $('#compression').hidden === false);

    $('[data-mode="off"]').click();
    assert.match(description(), /no deduplication, compaction or reasoning changes/);
    $('[data-mode="lossless"]').click();
    assert.match(description(), /Reasoning is never changed\./);
    assert.doesNotMatch(description(), /condensed/);

    $('[data-mode="smart"]').click();
    assert.match(description(), /Long middle reasoning blocks are condensed; your messages and final answers are never changed\./);
    $('#condenseThoughts').click();
    assert.match(description(), /Reasoning is kept in full\./);
    assert.doesNotMatch(description(), /condensed/);

    $('[data-mode="stubs"]').click();
    assert.match(description(), /Reasoning is kept in full\./);
    $('#condenseThoughts').click();
    assert.match(description(), /Long middle reasoning blocks are condensed/);
  } finally {
    h.close();
  }
});

test('toggling the checkbox re-measures from cached results without scanning the page again', async () => {
  const { markdown } = reasoningSession();
  const expected = {
    smartOn: measureCompression(markdown, 'smart', true),
    smartOff: measureCompression(markdown, 'smart', false),
    lossless: measureCompression(markdown, 'lossless', false),
    stubsOff: measureCompression(markdown, 'stubs', false),
  };
  assert.ok(expected.smartOn.bytes < expected.smartOff.bytes);

  const h = setupPopup({ store: reasoningStore(markdown), scripts: POPUP_SCRIPTS, stored: { compressionMode: 'smart' } });
  try {
    const { $ } = h;
    const { AREX } = h.window;
    const calls = { index: 0, compress: 0, condense: 0 };
    for (const [name, key] of [['buildMarkdownIndex', 'index'], ['compressIndex', 'compress'], ['applyThoughtCondensation', 'condense']]) {
      const original = AREX[name];
      AREX[name] = (...args) => { calls[key] += 1; return original(...args); };
    }
    await waitUntil(() => !$('#export').disabled && $('#sizeExactValue').textContent.endsWith('B'), 4000);
    assert.equal(shownBytes(h), expected.smartOn.bytes);
    assert.equal($('#tokensValue').textContent, '~' + AREX.formatTokenCount(expected.smartOn.tokens) + ' tokens');
    assert.deepEqual(calls, { index: 1, compress: 1, condense: 1 });
    const portMessages = h.sent.length;

    $('#condenseThoughts').click();
    assert.equal($('#sizeValue').textContent, 'Calculating…', 'the preview recalculates immediately');
    await waitUntil(() => !$('#export').disabled);
    assert.equal(shownBytes(h), expected.smartOff.bytes);
    assert.equal($('#tokensValue').textContent, '~' + AREX.formatTokenCount(expected.smartOff.tokens) + ' tokens');
    assert.deepEqual(calls, { index: 1, compress: 1, condense: 2 }, 'the Smart base result is reused');

    $('#condenseThoughts').click();
    await microtasks();
    assert.equal($('#export').disabled, false, 'a cached choice needs no timers');
    assert.equal(shownBytes(h), expected.smartOn.bytes);
    $('#condenseThoughts').click();
    await microtasks();
    assert.equal(shownBytes(h), expected.smartOff.bytes);
    assert.deepEqual(calls, { index: 1, compress: 1, condense: 2 }, 'each combination is computed once');

    $('[data-mode="lossless"]').click();
    await waitUntil(() => !$('#export').disabled);
    assert.equal(shownBytes(h), expected.lossless.bytes, 'Lossless ignores the checkbox');
    $('[data-mode="stubs"]').click();
    await waitUntil(() => !$('#export').disabled);
    assert.equal(shownBytes(h), expected.stubsOff.bytes, 'Stubs applies the shared unchecked choice');
    assert.equal(calls.index, 1, 'the transcript is indexed once for every mode and toggle');
    assert.equal(h.sent.length, portMessages, 'nothing was sent to the Arena tab');
  } finally {
    h.close();
  }
});

test('downloads never change user text or final answers, and only Smart and Stubs condense reasoning', async () => {
  const { markdown, user, final, paragraphs, reasoning } = reasoningSession();

  for (const [label, stored] of [
    ['Off with the saved choice on', { compressionMode: 'off', condenseThoughts: true }],
    ['Lossless with the saved choice on', { compressionMode: 'lossless', condenseThoughts: true }],
    ['Smart unchecked', { compressionMode: 'smart', condenseThoughts: false }],
    ['Stubs unchecked', { compressionMode: 'stubs', condenseThoughts: false }],
  ]) {
    const { downloaded } = await downloadReasoning(stored);
    assert.ok(downloaded.includes(user), label + ': user message is intact');
    assert.ok(downloaded.endsWith(final), label + ': final answer is intact');
    assert.ok(downloaded.includes(THOUGHT_HEADING + reasoning), label + ': reasoning is kept in full');
    assert.doesNotMatch(downloaded, /condensed \d+ intermediate reasoning blocks/, label);
    if (stored.compressionMode === 'off') assert.equal(downloaded, markdown, 'Off is byte-identical to the original');
  }

  for (const [mode, kept] of [
    ['smart', [paragraphs[0], paragraphs[1], CONDENSED_MARKER.smart, paragraphs[6], paragraphs[7]]],
    ['stubs', [paragraphs[0], CONDENSED_MARKER.stubs, paragraphs[7]]],
  ]) {
    const { downloaded } = await downloadReasoning({ compressionMode: mode, condenseThoughts: true });
    assert.ok(downloaded.includes(THOUGHT_HEADING + kept.join('\n\n')), mode + ': first and last blocks surround one marker');
    for (const dropped of paragraphs.slice(2, 6).filter(text => !kept.includes(text))) {
      assert.ok(!downloaded.includes(dropped), mode + ': middle block removed');
    }
    assert.ok(downloaded.includes(user), mode + ': user message is intact');
    assert.ok(downloaded.endsWith(final), mode + ': final answer is intact');
  }
});

test('the download summary reports each counter that applied', async () => {
  const detailsFor = async stored => {
    const { status } = await downloadReasoning(stored);
    const [saved, totals, details = ''] = status.split('\n');
    assert.match(saved, /^Saved as reasoning\.md$/);
    assert.match(totals, /^2 messages · 0 spoilers · /);
    return details;
  };
  const linked = '1 duplicate output(s) linked';
  const compacted = '1 log block(s) compacted';
  const referenced = '1 file output(s) with repeated lines referenced';
  const condensed = '1 reasoning section(s) condensed';

  assert.equal(await detailsFor({ compressionMode: 'stubs' }), [linked, compacted, referenced, condensed].join(' · '));
  assert.equal(await detailsFor({ compressionMode: 'smart' }), [linked, compacted, condensed].join(' · '));
  assert.equal(await detailsFor({ compressionMode: 'smart', condenseThoughts: false }), [linked, compacted].join(' · '));
  assert.equal(await detailsFor({ compressionMode: 'lossless' }), linked);
  assert.equal(await detailsFor({ compressionMode: 'off' }), '');
});
