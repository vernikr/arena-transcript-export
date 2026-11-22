import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';

test('popup exposes compression modes, remembers selection, and disables them without tool activity', async () => {
  const dom = new JSDOM(readFileSync(new URL('../extension/popup/popup.html', import.meta.url), 'utf8'), {
    url: 'chrome-extension://test/popup/popup.html',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false });
  window.TextEncoder = TextEncoder;

  const stored = {};
  const chromeMock = {
    storage: {
      local: { set() {} },
      sync: {
        get(defaults, callback) { callback({ ...defaults, ...stored }); },
        set(value) { Object.assign(stored, value); },
      },
    },
    runtime: { sendMessage() { return Promise.resolve(); } },
    tabs: {
      async query() { return [{ id: 1, url: 'https://arena.ai/agent/test' }]; },
    },
  };
  window.chrome = chromeMock;
  let lastSavedSnapshot = null;
  let profileDoc = null;
  window.AREX_RESULT_STORE = {
    async load() { return lastSavedSnapshot; },
    async save(snapshot) { lastSavedSnapshot = { ...snapshot }; },
    async loadProfile() { return profileDoc; },
  };

  const context = dom.getInternalVMContext();
  for (const path of ['../extension/content/compress.js', '../extension/popup/popup.js']) {
    vm.runInContext(readFileSync(new URL(path, import.meta.url), 'utf8'), context, { filename: path });
  }

  const $ = selector => window.document.querySelector(selector);
  const profileSummaryEmpty = $ => !$('#profileSummary').textContent.trim();
  const lossless = $('[data-mode="lossless"]');
  const smart = $('[data-mode="smart"]');
  const stubs = $('[data-mode="stubs"]');
  const compress = $('#compressHistory');
  const toolActivity = $('#includeToolActivity');

  assert.equal(compress.checked, true);
  assert.equal(lossless.getAttribute('aria-pressed'), 'true');
  assert.equal(smart.getAttribute('aria-pressed'), 'false');
  assert.equal(stubs.getAttribute('aria-pressed'), 'false');

  smart.click();
  assert.equal(smart.getAttribute('aria-pressed'), 'true');
  assert.equal(stored.compressionMode, 'smart');

  toolActivity.click();
  assert.equal(compress.disabled, true);
  assert.equal(lossless.disabled, true);
  assert.match($('#modeDescription').textContent, /Enable tool activity/);

  toolActivity.click();
  assert.equal(compress.disabled, false);
  assert.equal(compress.checked, true);
  assert.equal(smart.getAttribute('aria-pressed'), 'true');

  compress.click();
  assert.equal(compress.checked, false);
  assert.equal(lossless.disabled, true);

  // Simulate the transcript result and verify that download uses the selected compressed variant.
  let onPortMessage = null;
  let downloadedFilename = '';
  let downloadedText = '';
  const objectUrls = new Map();
  let nextObjectUrl = 0;
  // The background coordinator is simulated: it answers AREX_EXPORT_START with
  // a running status followed by a done status, and persists the snapshot itself.
  chromeMock.runtime.connect = () => ({
    onDisconnect: { addListener() {} },
    onMessage: { addListener(listener) { onPortMessage = listener; } },
    postMessage(message) {
      if (message.type === 'AREX_EXPORT_START') {
        profileDoc = {
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
        };
        const passed = Array.from({ length: 12 }, (_, i) => '✓ suite > test-' + i + ' [1.00ms]').join('\n');
        const markdown = '**stdout:**\n\n' + String.fromCharCode(96).repeat(3) +
          'text\n' + passed + '\n' + String.fromCharCode(96).repeat(3);
        queueMicrotask(() => {
          lastSavedSnapshot = {
            markdown,
            filename: 'arena-preview-test.md',
            stats: { messages: 4, expandedSpoilers: 3 },
            warnings: [],
            createdAt: Date.now(),
          };
          onPortMessage({
            type: 'AREX_STATUS',
            job: {
              tabId: 1, status: 'running', startedAt: Date.now(), updatedAt: Date.now(),
              progress: [{ stage: 'history', phase: 'page', pages: 1, loaded: 12 }],
            },
          });
          onPortMessage({
            type: 'AREX_STATUS',
            job: {
              tabId: 1, status: 'done', startedAt: Date.now(), updatedAt: Date.now(),
              progress: [{ stage: 'history', phase: 'page', pages: 1, loaded: 12 }],
              resultMeta: { filename: 'arena-preview-test.md', bytes: markdown.length, stats: { messages: 4, expandedSpoilers: 3 }, warnings: [], createdAt: Date.now() },
            },
          });
        });
      }
    },
  });
  window.URL.createObjectURL = blob => {
    const url = 'blob:test-' + (++nextObjectUrl);
    objectUrls.set(url, blob);
    return url;
  };
  window.URL.revokeObjectURL = () => {};
  chromeMock.downloads = {
    async download({ url, filename }) {
      downloadedFilename = filename;
      const reader = new window.FileReader();
      downloadedText = await new Promise(resolve => {
        reader.onload = () => resolve(String(reader.result));
        reader.readAsText(objectUrls.get(url));
      });
      return 1;
    },
  };

  compress.click();
  $('[id="export"]').click();
  const deadline = Date.now() + 1500;
  while (!$('#sizeExactValue').textContent && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal($('#sizePreview').hidden, false);
  assert.match($('#savedValue').textContent, /from/);

  // The profile card is populated from the persisted profile record.
  const profileCard = $('#profileCard');
  const profileDownload = $('#profileDownload');
  const profileDeadline = Date.now() + 1500;
  while (!profileCard.hidden && profileSummaryEmpty($) && Date.now() < profileDeadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(profileCard.hidden, false);
  const profileTextBefore = $('#profileSummary').textContent;
  assert.match(profileTextBefore, /Total 1.8 s/);
  assert.match(profileTextBefore, /4 messages/);
  assert.match(profileTextBefore, /3 spoilers/);
  assert.match(profileTextBefore, /done/);
  assert.match(profileTextBefore, /history 210 ms/);
  assert.match(profileTextBefore, /expand 700 ms/);
  assert.match(profileTextBefore, /Slowest window #0/);
  assert.match(profileTextBefore, /p95 42 ms/);

  profileDownload.click();
  while ((!downloadedFilename || !downloadedText || !downloadedFilename.endsWith('-profile.json')) && Date.now() < deadline + 1500) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(downloadedFilename, 'arena-preview-test-profile.json');
  assert.match(downloadedText, /"profileVersion": 1/);
  assert.match(downloadedText, /"durationMs": 1834.2/);

  downloadedFilename = '';
  downloadedText = '';
  $('[id="export"]').click();
  while ((!downloadedFilename || !downloadedText) && Date.now() < deadline + 3000) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(downloadedFilename, 'arena-preview-test.md');
  assert.match(downloadedText, /collapsed 12 passing test lines/);
  assert.match($('#status').textContent, /Saved as arena-preview-test\.md/);
  assert.match($('#status').textContent, /4 messages · 3 spoilers/);
  assert.equal($('#sizeExactValue').textContent, new TextEncoder().encode(downloadedText).length.toLocaleString('en-US') + ' B');
  assert.equal($('[id="export"]').textContent, 'Download Markdown');
  assert.equal(lastSavedSnapshot.filename, 'arena-preview-test.md');

  // A new popup instance restores the last snapshot and allows another capture.
  dom.window.close();
  const reopened = new JSDOM(readFileSync(new URL('../extension/popup/popup.html', import.meta.url), 'utf8'), {
    url: 'chrome-extension://test/popup/popup.html',
    runScripts: 'outside-only',
  });
  reopened.window.matchMedia = () => ({ matches: false });
  reopened.window.HTMLElement.prototype.scrollIntoView = function () {};
  reopened.window.TextEncoder = TextEncoder;
  let retakeStarted = false;
  let resumedMessageHandler = null;
  const reopenedChrome = {
    storage: {
      local: { set() {} },
      sync: { get(defaults, callback) { callback({ ...defaults, ...stored }); }, set(value) { Object.assign(stored, value); } },
    },
    runtime: {
      sendMessage() { return Promise.resolve(); },
      connect() {
        return {
          onDisconnect: { addListener() {} },
          onMessage: { addListener(listener) { resumedMessageHandler = listener; } },
          postMessage(message) { if (message.type === 'AREX_EXPORT_START') retakeStarted = true; },
        };
      },
    },
    tabs: {
      async query() { return [{ id: 1, url: 'https://arena.ai/agent/test' }]; },
    },
  };
  reopened.window.chrome = reopenedChrome;
  reopened.window.AREX_RESULT_STORE = {
    async load() { return lastSavedSnapshot; },
    async save(snapshot) { lastSavedSnapshot = { ...snapshot }; },
  };
  const reopenedContext = reopened.getInternalVMContext();
  vm.runInContext(readFileSync(new URL('../extension/content/compress.js', import.meta.url), 'utf8'), reopenedContext);
  vm.runInContext(readFileSync(new URL('../extension/popup/popup.js', import.meta.url), 'utf8'), reopenedContext);
  const r$ = selector => reopened.window.document.querySelector(selector);
  const restoreDeadline = Date.now() + 1000;
  while (!r$('#sizeExactValue').textContent && Date.now() < restoreDeadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(r$('#export').textContent, 'Download Markdown');
  assert.equal(r$('#resnapshot').hidden, false);
  assert.ok(r$('#sizeExactValue').textContent.endsWith(' B'));
  r$('#resnapshot').click();
  const retakeDeadline = Date.now() + 1000;
  while (!retakeStarted && Date.now() < retakeDeadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(retakeStarted, true);

  // Reopening during an active scan replays its current stage and disables conflicting actions.
  resumedMessageHandler({
    type: 'AREX_STATUS',
    job: {
      tabId: 1,
      status: 'running',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      progress: [{ stage: 'history', phase: 'page', pages: 3, loaded: 60 }],
    },
  });
  assert.equal(r$('#progress').hidden, false);
  assert.equal(r$('#export').disabled, true);
  assert.equal(r$('#cancel').hidden, false);
  assert.match(r$('#log').textContent, /3 earlier page/);
  assert.match(r$('#status').textContent, /scan continued in the Arena tab/);
  resumedMessageHandler({
    type: 'AREX_PROGRESS', tabId: 1, stage: 'process', processedMessages: 2, totalMessages: 4,
    expandedSpoilers: 5, totalSpoilers: 9, percent: 42,
  });
  assert.match(r$('#log').textContent, /Scanning: 2\/4 messages · 5\/9 spoilers · 42%/);
  assert.equal(r$('#progressBar').getAttribute('aria-valuenow'), '42');

  reopened.window.close();
});
