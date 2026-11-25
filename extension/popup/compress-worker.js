// One snapshot/index per popup worker. Mode results are cached for its lifetime.
importScripts('../content/compress-index.js', '../content/compress-framing.js', '../content/compress.js', '../content/compress-stubs.js');
let snapshotId = null, index = null, initError = null;
const cache = new Map();
self.onmessage = event => {
  const message = event.data || {};
  if (message.type === 'INIT_SNAPSHOT') {
    snapshotId = message.snapshotId; index = null; initError = null; cache.clear();
    try { index = AREX.buildMarkdownIndex(message.markdown); }
    catch (error) { initError = String(error?.message || error); }
    return;
  }
  if (message.type === 'GET_MARKDOWN') {
    const { requestId, mode } = message;
    try {
      if (message.snapshotId !== snapshotId || !index) throw new Error(initError || 'Snapshot is unavailable.');
      if (!cache.has(mode)) cache.set(mode, AREX.compressIndex(index, { mode }));
      self.postMessage({ type: 'MARKDOWN_RESULT', snapshotId, requestId, mode, markdown: cache.get(mode).markdown });
    } catch (error) {
      self.postMessage({ type: 'MODE_ERROR', snapshotId: message.snapshotId, requestId, mode, error: String(error?.message || error) });
    }
    return;
  }
  if (message.type !== 'GET_MODE') return;
  const { requestId, mode } = message;
  try {
    if (message.snapshotId !== snapshotId || !index) throw new Error(initError || 'Snapshot is unavailable.');
    if (!cache.has(mode)) cache.set(mode, AREX.compressIndex(index, { mode }));
    const result = cache.get(mode);
    if (message.includeMarkdown === false) {
      const { markdown, ...meta } = result;
      self.postMessage({ type: 'MODE_RESULT', snapshotId, requestId, mode, result: meta });
    } else {
      self.postMessage({ type: 'MODE_RESULT', snapshotId, requestId, mode, result });
    }
  } catch (error) {
    self.postMessage({ type: 'MODE_ERROR', snapshotId: message.snapshotId, requestId, mode, error: String(error?.message || error) });
  }
};
