// One snapshot/index per popup worker. Mode results are cached for its lifetime, keyed `${mode}:${condenseThoughts}`.
importScripts('../content/compress-index.js', '../content/compress-smart-log.js', '../content/compress-smart-cli.js',
  '../content/compress-framing.js', '../content/compress-commands.js', '../content/compress.js', '../content/compress-stubs.js',
  '../content/compress-thoughts.js');
let snapshotId = null, index = null, initError = null;
const compressed = new Map(), cache = new Map();

// Off/Lossless ignore the toggle, so it never splits their cache entries.
function resultFor(message) {
  if (message.snapshotId !== snapshotId || !index) throw new Error(initError || 'Snapshot is unavailable.');
  const { mode } = message;
  const condenseThoughts = (mode === 'smart' || mode === 'stubs') && message.condenseThoughts !== false;
  const key = `${mode}:${condenseThoughts}`;
  if (!cache.has(key)) {
    // The shared base stops before the reasoning stage, so the toggle only costs that stage.
    if (!compressed.has(mode)) compressed.set(mode, AREX.compressIndex(index, { mode, condenseThoughts: false }));
    cache.set(key, AREX.applyThoughtCondensation(compressed.get(mode), { mode, condenseThoughts }));
  }
  return { result: cache.get(key), condenseThoughts };
}

self.onmessage = event => {
  const message = event.data || {};
  if (message.type === 'INIT_SNAPSHOT') {
    snapshotId = message.snapshotId; index = null; initError = null; compressed.clear(); cache.clear();
    try { index = AREX.buildMarkdownIndex(message.markdown); }
    catch (error) { initError = String(error?.message || error); }
    return;
  }
  if (message.type === 'GET_MARKDOWN') {
    const { requestId, mode } = message;
    try {
      const { result, condenseThoughts } = resultFor(message);
      self.postMessage({ type: 'MARKDOWN_RESULT', snapshotId, requestId, mode, condenseThoughts, markdown: result.markdown });
    } catch (error) {
      self.postMessage({ type: 'MODE_ERROR', snapshotId: message.snapshotId, requestId, mode, error: String(error?.message || error) });
    }
    return;
  }
  if (message.type !== 'GET_MODE') return;
  const { requestId, mode } = message;
  try {
    const { result, condenseThoughts } = resultFor(message);
    if (message.includeMarkdown === false) {
      const { markdown, ...meta } = result;
      self.postMessage({ type: 'MODE_RESULT', snapshotId, requestId, mode, condenseThoughts, result: meta });
    } else {
      self.postMessage({ type: 'MODE_RESULT', snapshotId, requestId, mode, condenseThoughts, result });
    }
  } catch (error) {
    self.postMessage({ type: 'MODE_ERROR', snapshotId: message.snapshotId, requestId, mode, error: String(error?.message || error) });
  }
};
