// Stress regressions on a synthetic 120-turn / 2,400-spoiler page (see large-page-fixture.mjs).
// Invariants are counted, not timed, so the assertions are deterministic. Timing
// lives in scripts/benchmark-large-page.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLargePage, startTailStreaming, totalSpoilers, DEFAULTS, markerFor } from './large-page-fixture.mjs';

const WINDOW = 4;
const cfg = { ...DEFAULTS, windowSize: WINDOW, settleQuietMs: 5, settleMaxMs: 500 };
const SPOILERS = totalSpoilers(cfg);
const normalize = md => md.replace(/^- Exported: .*$/m, '- Exported: <ts>');

// Returns the number of exporter-owned controls or panels still open on the page.
const leakedOpen = (AREX, log) =>
  AREX.qq('button[aria-expanded="true"]', log).length + AREX.qq('div[style*="overflow: clip"]', log).length;

// Turn markers that appear in a Markdown document, in order.
const turnsIn = md => [...md.matchAll(/Turn marker (\d{3})/g)].map(m => Number(m[1]));

function prepareExport(overrides = {}) {
  let page;
  const hook = overrides.onClick;
  page = buildLargePage({ ...cfg, ...overrides, onClick: (button, opening) => hook?.(button, opening, page) });
  const { AREX } = page;
  AREX._abortController = new page.window.AbortController();
  return page;
}

test('streaming tail turn never pins settle() to its cap and the export completes', async () => {
  const page = prepareExport();
  const { AREX, log, document, settleSamples } = page;
  const stream = startTailStreaming(document, { intervalMs: 1 });
  let result;
  try {
    result = await AREX.processMessagesInWindows(log, {}, { windowSize: WINDOW });
  } finally {
    stream.stop();
  }
  assert.ok(stream.tokens() > 50, `tail streamed only ${stream.tokens()} tokens`);
  assert.equal(result.expandedSpoilers, SPOILERS);
  assert.equal(result.stuckSpoilers, 0);
  assert.equal(result.leftCollapsed, 0);
  assert.equal(result.warnings.length, 0, 'no false "Page unloaded" or reorder warnings');
  assert.ok(settleSamples.length > 0);
  const pinned = settleSamples.filter(s => s.ms >= s.cap - 5);
  assert.equal(pinned.length, 0, `${pinned.length} settle() calls ran to maxMs under streaming`);
  assert.deepEqual(turnsIn(result.markdown), Array.from({ length: cfg.messages }, (_, i) => i));
  assert.equal(leakedOpen(AREX, log), 0);
});

test('export is deterministic: identical Markdown and leak-free DOM across runs', async () => {
  const outputs = [];
  for (let run = 0; run < 2; run += 1) {
    const { AREX, log } = prepareExport();
    const result = await AREX.processMessagesInWindows(log, {}, { windowSize: WINDOW });
    assert.equal(leakedOpen(AREX, log), 0);
    outputs.push(normalize(result.markdown));
  }
  assert.equal(outputs[0], outputs[1]);
});

test('mid-run Stop at window 10/30 leaves no exporter-opened spoilers and a valid partial export of 40 turns', async () => {
  const stopWindow = 10;
  const stopMessage = stopWindow * WINDOW; // first turn of window 10 (0-based)
  let fired = false;
  const page = prepareExport({
    onClick: (button, opening, p) => {
      if (opening && !fired && button.dataset.group === String(stopMessage)) {
        fired = true;
        p.AREX._abortController.abort();
      }
    },
  });
  const { AREX, log } = page;
  await assert.rejects(
    AREX.processMessagesInWindows(log, {}, { windowSize: WINDOW }),
    error => error.name === 'AbortError',
  );
  assert.equal(fired, true);
  assert.equal(leakedOpen(AREX, log), 0, 'stopped export leaked open spoilers or panels');

  const partial = AREX._job.partial;
  assert.equal(partial.completedMessages, stopMessage);
  const markdown = partial.parts.join('\n\n') + '\n';
  assert.match(markdown, /^# /m);
  assert.deepEqual(turnsIn(markdown), Array.from({ length: stopMessage }, (_, i) => i));
  assert.ok(!markdown.includes(markerFor(stopMessage)), 'partial export must not include the unfinished turn');
  assert.equal(markdown.split('\n## ').length - 1, stopMessage, 'one heading per completed turn');
});

test('diagnostic log snapshots at 0%, 50%, tail cleanup and stopped are bounded with accurate cursors', async () => {
  const captured = {};
  const capture = (profiler, label, outcome) => {
    const text = JSON.stringify(profiler.snapshot({ outcome })); // round-trip: plain serializable JSON
    captured[label] = { size: Buffer.byteLength(text), doc: JSON.parse(text) };
  };

  // Run A: complete export. Captures 0%, 50% and the tail window's cleanup.
  {
    const { AREX, log } = prepareExport();
    const profiler = AREX.createProfiler({ toolVersion: 'test', sourceUrl: 'https://arena.ai/agent/large-page' });
    capture(profiler, '0%', 'running');
    let halfway = false, tail = false;
    await AREX.processMessagesInWindows(log, {}, {
      windowSize: WINDOW,
      profiler,
      onProgress: event => {
        if (!halfway && event.percent >= 50) { halfway = true; capture(profiler, '50%', 'running'); }
      },
      onCleanup: event => {
        if (!tail && event.processedMessages >= cfg.messages) { tail = true; capture(profiler, 'tail cleanup', 'running'); }
      },
    });
    assert.equal(leakedOpen(AREX, log), 0);
  }

  // Run B: Stop at window 10/30.
  {
    const stopMessage = 10 * WINDOW;
    let fired = false;
    const { AREX, log } = prepareExport({
      onClick: (button, opening, p) => {
        if (opening && !fired && button.dataset.group === String(stopMessage)) { fired = true; p.AREX._abortController.abort(); }
      },
    });
    const profiler = AREX.createProfiler({ toolVersion: 'test', sourceUrl: 'https://arena.ai/agent/large-page' });
    await assert.rejects(AREX.processMessagesInWindows(log, {}, { windowSize: WINDOW, profiler }),
      error => error.name === 'AbortError');
    capture(profiler, 'stopped', 'stopped');
    assert.equal(leakedOpen(AREX, log), 0);
  }

  for (const [label, { size }] of Object.entries(captured))
    assert.ok(size <= 128 * 1024, `${label} snapshot is ${size} B`);

  assert.equal(captured['0%'].doc.outcome, 'running');
  assert.equal(captured['0%'].doc.inFlight.cursor, null);
  assert.equal(captured['50%'].doc.inFlight.cursor.stage, 'process');
  assert.equal(captured['tail cleanup'].doc.inFlight.cursor.stage, 'cleanup');
  assert.equal(captured['tail cleanup'].doc.inFlight.cursor.windowIndex, cfg.messages / WINDOW - 1);
  assert.equal(captured.stopped.doc.outcome, 'stopped');
  assert.equal(captured.stopped.doc.inFlight.cursor.windowIndex, 10);
});

test('large-page run keeps the expansion budget: one click per opened control, cleanup prunes nested children', async () => {
  const { AREX, log, spoilers } = prepareExport();
  await AREX.processMessagesInWindows(log, {}, { windowSize: WINDOW });
  const groups = cfg.messages;
  // Every group is opened once; each leaf is opened once as well. Cleanup clicks only the
  // outermost group per window, so leaves are unmounted rather than clicked closed.
  assert.equal(spoilers.stats.opened, SPOILERS);
  assert.equal(spoilers.stats.closed, groups);
  assert.equal(leakedOpen(AREX, log), 0);
});
