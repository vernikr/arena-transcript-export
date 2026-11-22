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

  const context = dom.getInternalVMContext();
  for (const path of ['../extension/content/compress.js', '../extension/popup/popup.js']) {
    vm.runInContext(readFileSync(new URL(path, import.meta.url), 'utf8'), context, { filename: path });
  }

  const $ = selector => window.document.querySelector(selector);
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
  chromeMock.tabs.sendMessage = (_tabId, _message, callback) =>
    callback({ ok: true, compressionPreview: true });
  chromeMock.tabs.connect = () => ({
    onDisconnect: { addListener() {} },
    onMessage: { addListener(listener) { onPortMessage = listener; } },
    postMessage(message) {
      if (message.type === 'AREX_EXPORT_START') {
        const passed = Array.from({ length: 12 }, (_, i) => '✓ suite > test-' + i + ' [1.00ms]').join('\n');
        const markdown = '**stdout:**\n\n' + String.fromCharCode(96).repeat(3) +
          'text\n' + passed + '\n' + String.fromCharCode(96).repeat(3);
        queueMicrotask(() => onPortMessage({
          type: 'AREX_RESULT',
          ok: true,
          markdown,
          filename: 'arena-preview-test.md',
          stats: { messages: 4, expandedSpoilers: 3 },
          warnings: [],
        }));
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
  while ($('#sizePreview').hidden && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal($('#sizePreview').hidden, false);
  assert.match($('#savedValue').textContent, /from/);

  $('[id="export"]').click();
  while ((!downloadedFilename || !downloadedText) && Date.now() < deadline + 1500) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(downloadedFilename, 'arena-preview-test.md');
  assert.match(downloadedText, /collapsed 12 passing test lines/);
  assert.match($('#status').textContent, /Saved as arena-preview-test\.md/);
  assert.match($('#status').textContent, /4 messages · 3 spoilers/);
  assert.equal($('[id="export"]').textContent, 'Prepare another preview');

  dom.window.close();
});