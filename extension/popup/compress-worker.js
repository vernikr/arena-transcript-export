// One snapshot/index per popup worker. Mode results are cached for its lifetime.
importScripts('../content/compress.js');
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
  if (message.type !== 'GET_MODE') return;
  const { requestId, mode } = message;
  try {
    if (message.snapshotId !== snapshotId || !index) throw new Error(initError || 'Snapshot is unavailable.');
    if (!cache.has(mode)) cache.set(mode, AREX.compressIndex(index, { mode }));
    self.postMessage({ type: 'MODE_RESULT', snapshotId, requestId, mode, result: cache.get(mode) });
  } catch (error) {
    self.postMessage({ type: 'MODE_ERROR', snapshotId: message.snapshotId, requestId, mode, error: String(error?.message || error) });
  }
};
