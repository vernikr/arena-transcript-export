// Large-page benchmark: a synthetic 120-turn / 2,400-spoiler Arena transcript run
// through the real windowed export pipeline (expand -> serialize -> ancestor-pruned
// cleanup) under simulated streaming on the final turn.
//
// Usage: node scripts/benchmark-large-page.mjs
// Exits non-zero if any invariant regresses or the run exceeds the 5 s budget.
// jsdom/Node timings only: not real-browser latency.
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { buildLargePage, startTailStreaming, totalSpoilers, DEFAULTS } from '../test/large-page-fixture.mjs';

const BUDGET_MS = 5000;
const CHUNK_BYTES = 1024 * 1024;
const cfg = { ...DEFAULTS, settleQuietMs: 5, settleMaxMs: 500 };
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const ms = n => `${n.toFixed(1)} ms`;
const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: pct(sorted, 0.5), p95: pct(sorted, 0.95), max: sorted.at(-1) ?? 0 };
};
const fmt = s => `p50 ${ms(s.p50)}, p95 ${ms(s.p95)}, max ${ms(s.max)}`;

const runStart = performance.now();
console.log('Arena large-page benchmark');
console.log(`Node ${process.version}; ${os.platform()} ${os.arch()}; ${os.cpus()[0]?.model || 'CPU unknown'}`);
console.log(`Synthetic page: ${cfg.messages} turns, ${totalSpoilers(cfg)} spoilers (${cfg.leavesPerGroup} leaves per group), windows of ${cfg.windowSize}.`);

// ---- build ---------------------------------------------------------------
const buildStart = performance.now();
const page = buildLargePage(cfg);
const { AREX, log, spoilers, document } = page;
const buildMs = performance.now() - buildStart;
const expectedSpoilers = totalSpoilers(cfg);
console.log(`Build: ${ms(buildMs)}; collapsed controls: ${AREX.qq('button[aria-expanded="false"]', log).length}.`);

// ---- instrumented export -------------------------------------------------
const expandMs = [], cleanupMs = [], serializeMs = [];
const cleanup = { clicks: 0, pruned: 0, closed: 0, total: 0 };
let inCleanup = false;
const wrap = (name, onCall) => {
  const original = AREX[name];
  AREX[name] = function (...args) { return onCall(original, args); };
};
wrap('expandAllSpoilers', async (fn, args) => {
  const t0 = performance.now();
  try { return await fn(...args); } finally { expandMs.push(performance.now() - t0); }
});
wrap('collapseOpenedSpoilers', async (fn, args) => {
  inCleanup = true;
  const clicksBefore = spoilers.clicks();
  const t0 = performance.now();
  try {
    const result = await fn(...args);
    cleanup.pruned += result.pruned; cleanup.closed += result.closed; cleanup.total += result.total;
    return result;
  } finally {
    cleanupMs.push(performance.now() - t0);
    cleanup.clicks += spoilers.clicks() - clicksBefore;
    inCleanup = false;
  }
});
wrap('serializeMessageAsync', async (fn, args) => {
  const t0 = performance.now();
  try { return await fn(...args); } finally { serializeMs.push(performance.now() - t0); }
});

const profiler = AREX.createProfiler({ toolVersion: 'benchmark', sourceUrl: 'https://arena.ai/agent/large-page', options: {} });
const snapshots = {};
const takeSnapshot = (label, outcome = 'running') => {
  const snapshot = profiler.snapshot({ outcome });
  snapshots[label] = snapshot;
  return snapshot;
};
takeSnapshot('0%');

const heapBefore = process.memoryUsage().heapUsed;
const stream = startTailStreaming(document);
let peakHeap = heapBefore;
let halfway = false;
const exportStart = performance.now();
const result = await AREX.processMessagesInWindows(log, {}, {
  windowSize: cfg.windowSize,
  profiler,
  onProgress: event => {
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    if (!halfway && event.percent >= 50) { halfway = true; takeSnapshot('50%'); }
  },
  onCleanup: event => {
    // Progress never reaches 99% before the final window (each turn is worth ~1/120
    // of the bar), so the cleanup snapshot is taken at the tail window's cleanup.
    if (!snapshots['tail cleanup'] && inCleanup && event.processedMessages >= cfg.messages)
      takeSnapshot('tail cleanup');
  },
});
const exportMs = performance.now() - exportStart;
stream.stop();
takeSnapshot('finished', 'done');
const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / 1048576;

const leakedOpen = AREX.qq('button[aria-expanded="true"]', log).length
  + AREX.qq('div[style*="overflow: clip"]', log).length;
const sameFlow = expandMs.length === cfg.messages / cfg.windowSize;
check(Boolean(snapshots['tail cleanup']), 'no tail-window cleanup snapshot was captured');
console.log(`Export: ${ms(exportMs)} over ${result.windowCount} windows; ${result.expandedSpoilers} spoilers opened; ${result.totalMessages} messages; tail tokens streamed: ${stream.tokens()}.`);
console.log(`  per-window expand:  ${fmt(stats(expandMs))}`);
console.log(`  per-message serialize: ${fmt(stats(serializeMs))}`);
console.log(`  per-window cleanup: ${fmt(stats(cleanupMs))}`);
console.log(`  cleanup DOM clicks: ${cleanup.clicks} for ${cleanup.total} opened controls (${cleanup.pruned} pruned by ancestor, ${cleanup.closed} closed directly).`);
console.log(`  heap delta: ${heapDeltaMb.toFixed(1)} MiB (peak sampled delta ${((peakHeap - heapBefore) / 1048576).toFixed(1)} MiB).`);

// ---- invariants ------------------------------------------------------------
check(result.expandedSpoilers === expectedSpoilers,
  `expanded ${result.expandedSpoilers} of ${expectedSpoilers} spoilers`);
check(result.leftCollapsed === 0 && result.stuckSpoilers === 0,
  `left collapsed ${result.leftCollapsed}, stuck ${result.stuckSpoilers}`);
check(leakedOpen === 0, `${leakedOpen} exporter-opened spoiler control/panel(s) leaked open`);
check(result.totalMessages === cfg.messages && result.warnings.length === 0,
  `unexpected message count or warnings: ${result.totalMessages}, ${result.warnings.join('; ')}`);
check(sameFlow, `expected ${cfg.messages / cfg.windowSize} windows, saw ${expandMs.length}`);
const markers = [...result.markdown.matchAll(/Turn marker (\d{3})/g)].map(m => Number(m[1]));
check(markers.length === cfg.messages && markers.every((n, i) => n === i),
  `markdown does not contain the ${cfg.messages} turns in order (found ${markers.length})`);
check(cleanup.total === expectedSpoilers, `cleanup saw ${cleanup.total} opened controls, expected ${expectedSpoilers}`);
const settleCapped = page.settleSamples.filter(s => s.ms >= s.cap - 5).length;
check(settleCapped === 0, `${settleCapped} settle() call(s) pinned to the cap under streaming`);

// ---- chunked transfer and compression -------------------------------------
const transferStart = performance.now();
const chunks = [];
for (let offset = 0; offset < result.markdown.length; offset += CHUNK_BYTES)
  chunks.push(result.markdown.slice(offset, offset + CHUNK_BYTES));
const reassembled = chunks.join('');
const transferMs = performance.now() - transferStart;
check(reassembled === result.markdown, 'chunked transfer reassembly differs from source');
console.log(`Chunked transfer: ${chunks.length} x ${CHUNK_BYTES / 1024} KiB chunks, reassembled exactly in ${ms(transferMs)}.`);

const compressStart = performance.now();
const compressed = AREX.compressMarkdown(result.markdown, { mode: 'smart' });
const compressMs = performance.now() - compressStart;
console.log(`Compression: ${ms(compressMs)}; ${compressed.bytes} B out of ${Buffer.byteLength(result.markdown)} B input (saved ${compressed.savedBytes} B).`);

// ---- diagnostic log snapshots ----------------------------------------------
for (const [label, snapshot] of Object.entries(snapshots)) {
  const size = Buffer.byteLength(JSON.stringify(snapshot));
  check(size <= 128 * 1024, `snapshot "${label}" is ${size} B, above the 128 KiB cap`);
  console.log(`Log snapshot ${label.padEnd(15)} ${size} B.`);
}

// ---- budget ----------------------------------------------------------------
const totalMs = performance.now() - runStart;
console.log(`Total end-to-end: ${ms(totalMs)} (budget ${BUDGET_MS} ms).`);
check(totalMs < BUDGET_MS, `total ${ms(totalMs)} exceeds the ${BUDGET_MS} ms budget`);

if (failures.length) {
  console.error('\nInvariant regressions:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nAll invariants hold.');
