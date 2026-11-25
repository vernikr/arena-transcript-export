import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './harness.mjs';

const opts = { includeToolActivity: true, timestamps: false };
const fromWindow = value => JSON.parse(JSON.stringify(value));

function env(html = '<div role="log"></div>') {
  return makeEnv({ html, url: 'https://arena.ai/agent/u-1' });
}

test('disabled profiler is a no-op throughout', () => {
  const { AREX } = env();
  const profiler = AREX.createProfiler({ enabled: false });
  assert.equal(profiler.enabled, false);
  profiler.event('x');
  profiler.phase('x', 10);
  profiler.window({ index: 0, ms: 5 });
  profiler.message(1, 0, 0);
  profiler.sampleMemory('x');
  assert.equal(profiler.now(), 0);
  const token = profiler.beginSpan('x', { windowIndex: 0 });
  assert.equal(token, null);
  profiler.setCursor({ stage: 'process' });
  profiler.sampleYield();
  profiler.endSpan(token, { finished: true });
  assert.equal(profiler.snapshot({ outcome: 'cancelling' }), null);
  assert.equal(profiler.finish({ outcome: 'done' }), null);
});

test('finish produces a bounded, machine-readable document', () => {
  const { AREX } = env();
  const profiler = AREX.createProfiler({
    toolVersion: '0.4.1',
    sourceUrl: 'https://arena.ai/agent/abc',
    chatUuid: 'abc',
    options: opts,
  });
  profiler.event('export.start');
  profiler.phase('history', 10.5, '1 page · 3 messages');
  profiler.message(4.2, 0, 0);
  profiler.message(9.8, 1, 0);
  profiler.message(2.1, 2, 0);
  profiler.window({ index: 0, from: 0, to: 4, messages: 3, ms: 20.2, expandMs: 5, serializeMs: 10, cleanupMs: 4, bytes: 123, spoilers: 2 });
  profiler.event('export.done', 'done');
  const doc = profiler.finish({
    outcome: 'done',
    totals: {
      messages: 3, windows: 1, markdownChars: 111, markdownBytes: 200, expandedSpoilers: 2,
      spoilersStuck: 0, spoilersTotal: 3, leftCollapsed: 0,
      historyPages: 1, historyStable: true, historyMessages: 3,
    },
  });

  assert.equal(doc.profileVersion, 1);
  assert.equal(doc.tool, 'arena-transcript-export');
  assert.equal(doc.toolVersion, '0.4.1');
  assert.equal(doc.sourceUrl, 'https://arena.ai/agent/abc');
  assert.equal(doc.chatUuid, 'abc');
  assert.equal(doc.outcome, 'done');
  assert.equal(doc.error, null);
  assert.equal(JSON.stringify(doc.options), JSON.stringify({ includeToolActivity: true, timestamps: false, profile: true }));
  assert.equal(doc.totals.messages, 3);
  assert.equal(doc.totals.windows, 1);
  assert.equal(doc.totals.expandedSpoilers, 2);
  assert.equal(doc.totals.markdownBytes, 200);
  assert.equal(doc.totals.historyStable, true);
  assert.equal(doc.phases.history.ms, 10.5);
  assert.equal(doc.phases.history.count, 1);
  assert.equal(doc.messageTiming.count, 3);
  assert.equal(doc.messageTiming.maxMs, 9.8);
  assert.equal(doc.messageTiming.maxMessageIndex, 1);
  assert.equal(doc.messageTiming.samplesKept, 3);
  assert.equal(doc.messageTiming.samplesCapped, false);
  assert.ok(doc.messageTiming.p95Ms <= 9.8 && doc.messageTiming.p95Ms >= 0);
  assert.equal(doc.windows.length, 1);
  assert.equal(doc.windows[0].index, 0);
  assert.equal(doc.windowsOmitted, 0);
  assert.ok(doc.durationMs >= 0);
  assert.equal(doc.events[0].phase, 'export.start');
  assert.equal(doc.events.at(-1).phase, 'export.done');
  // The logical summary lines stay short and agent-parseable.
  const json = JSON.stringify(doc);
  assert.ok(json.length < 4096, 'doc should stay compact');
});

test('head and tail survive a 520-event run, and only the slowest windows are kept', () => {
  const { AREX } = env();
  const profiler = AREX.createProfiler({ toolVersion: '0.4.1', options: opts });
  for (let i = 0; i < 520; i++) profiler.event('phase-' + i, 'note');
  for (let i = 0; i < 200; i++) profiler.window({ index: i, from: i, to: i + 1, messages: 1, ms: i, expandMs: 1, serializeMs: 1, cleanupMs: 1, bytes: 10, spoilers: 0 });
  const doc = profiler.finish({ outcome: 'done', totals: { messages: 200, windows: 200 } });

  const expected = [...Array.from({ length: 16 }, (_, i) => `phase-${i}`),
    ...Array.from({ length: 64 }, (_, i) => `phase-${456 + i}`)];
  for (const profile of [profiler.snapshot(), doc]) {
    assert.deepEqual(Array.from(profile.events, entry => entry.phase), expected);
    assert.equal(profile.eventsDropped, 440);
  }
  // 200 windows recorded, 64 kept — the slowest (highest ms) ones.
  assert.equal(doc.windows.length, 64);
  assert.equal(doc.windowsOmitted, 136);
  assert.equal(JSON.stringify(doc.windows.map(w => w.index)), JSON.stringify(Array.from({ length: 64 }, (_, i) => 199 - i)));
  assert.equal(JSON.stringify(doc.windows.map(w => w.ms)), JSON.stringify(Array.from({ length: 64 }, (_, i) => 199 - i)));
});

function timedEnv() {
  const { AREX, window } = env();
  let now = 0;
  let memoryReads = 0;
  Object.defineProperty(window.performance, 'now', { value: () => now });
  Object.defineProperty(window.performance, 'memory', {
    get() {
      memoryReads++;
      return { usedJSHeapSize: 100, totalJSHeapSize: 200, jsHeapSizeLimit: 1000 };
    },
  });
  return { AREX, tick: ms => { now += ms; }, memoryReads: () => memoryReads };
}

test('live snapshots neither mutate the run nor share mutable data with it', () => {
  const { AREX, tick, memoryReads } = timedEnv();
  const live = AREX.createProfiler();
  const control = AREX.createProfiler();
  const profilers = [live, control];
  for (const profiler of profilers) {
    profiler.event('export.start');
    profiler.phase('history', 10);
    profiler.window({ index: 0, ms: 10 });
    profiler.sampleMemory('history.done');
  }
  tick(10);
  const detail = { batch: 2 };
  const tokens = profilers.map(profiler => profiler.beginSpan('window', detail));
  detail.batch = 99;
  const progressLog = Array.from({ length: 90 }, (_, i) => ({ stage: 'process', at: i, percent: i, warnings: ['nested'] }));
  tick(20);
  const first = live.snapshot({ progressLog, warnings: ['warning'], partialStats: { messages: 3 } });
  assert.equal(first.profileVersion, 2);
  assert.equal(first.outcome, 'running');
  assert.equal(first.inFlight.span.elapsedMs, 20);
  assert.equal(first.inFlight.span.detail.batch, 2);
  assert.equal(first.durationMs, 30);
  assert.equal(first.phases.window, undefined);
  assert.equal(first.phases.history.ms, 10);
  assert.equal(first.totals.messages, 3);
  assert.equal(first.partialStats.messages, 3);
  assert.equal(first.totals.warnings[0], 'warning');
  assert.equal(first.progressLog.length, 64);
  assert.equal(first.progressLogOmitted, 26);
  assert.deepEqual(fromWindow(first.progressLog.at(-1)), progressLog.at(-1));
  first.events[0].phase = 'mutated';
  first.windows[0].ms = 999;
  first.memory[0].memory.usedJSHeapSizeBytes = 0;
  first.inFlight.span.detail.batch = 999;
  first.progressLog.at(-1).warnings[0] = 'changed';
  assert.equal(progressLog.at(-1).warnings[0], 'nested');

  tick(30);
  const second = live.snapshot({ outcome: 'cancelling' });
  assert.equal(second.outcome, 'cancelling');
  assert.equal(second.inFlight.span.elapsedMs, 50);
  assert.equal(second.inFlight.span.detail.batch, 2);
  assert.equal(first.inFlight.span.elapsedMs, 20);
  assert.equal(second.memory[0].memory.usedJSHeapSizeBytes, 100);
  assert.equal(memoryReads(), 2, 'snapshot must not take a memory sample');

  profilers.forEach((profiler, i) => {
    profiler.endSpan(tokens[i], { messages: 4 });
    profiler.endSpan(tokens[i]); // double end must not count twice
    profiler.window({ index: 1, ms: 50 });
    profiler.event('export.done');
  });
  tick(10);
  const finished = live.finish();
  const baseline = control.finish();
  const { startedAt: ignored, ...result } = finished;
  const { startedAt: alsoIgnored, ...expected } = baseline;
  assert.deepEqual(result, expected);
  assert.equal(finished.profileVersion, 1);
  assert.equal(finished.durationMs, 70);
  assert.equal(finished.phases.window.count, 1);
  assert.deepEqual(JSON.parse(finished.phases.window.detail), { batch: 2, messages: 4 });
  assert.equal(finished.memory.at(-1).phase, 'export.finished');
  assert.equal(first.memory.length, 1);
});

test('a stuck expand pass reports its current cursor, not a completed phase', () => {
  const { AREX, tick } = timedEnv();
  const profiler = AREX.createProfiler();
  const outer = profiler.beginSpan('window', { index: 29 });
  tick(5);
  const inner = profiler.beginSpan('expand', { limit: 30 });
  profiler.setCursor({ stage: 'process', phase: 'expand', windowIndex: 29, messageIndex: 117 });
  profiler.setCursor({ pass: 14, spoilersOpened: 5, spoilersClosed: 0 });
  tick(900);
  const stuck = profiler.snapshot();
  assert.equal(stuck.phases.expand, undefined);
  assert.equal(stuck.sinceLastYieldMs, 905);
  assert.deepEqual(fromWindow(stuck.inFlight), {
    span: { name: 'expand', startedAtMs: 5, elapsedMs: 900, detail: { limit: 30 } },
    cursor: { stage: 'process', phase: 'expand', windowIndex: 29, messageIndex: 117, pass: 14, spoilersOpened: 5, spoilersClosed: 0 },
  });
  profiler.endSpan(inner);
  profiler.setCursor({ phase: 'cleanup', pass: null });
  const cleaning = profiler.snapshot();
  assert.equal(cleaning.phases.expand.ms, 900);
  assert.equal(cleaning.inFlight.span.name, 'window');
  assert.equal(cleaning.inFlight.cursor.pass, undefined);
  assert.equal(stuck.inFlight.cursor.phase, 'expand');
  profiler.endSpan(outer);
  profiler.setCursor(null);
  for (const outcome of ['idle', 'cancelled_partial', 'error', 'done']) {
    const doc = profiler.snapshot({ outcome });
    assert.equal(doc.outcome, outcome);
    assert.deepEqual(fromWindow(doc.inFlight), { span: null, cursor: null });
  }
});

test('cooperative yield gaps count >250 ms and keep the eight longest gaps >100 ms', () => {
  const { AREX, tick } = timedEnv();
  const profiler = AREX.createProfiler();
  const gaps = [100, 250, 251, 900, 101, 300, 320, 150, 400, 180, 120, 170];
  for (const gap of gaps) {
    profiler.setCursor({ pass: gap });
    tick(gap);
    profiler.sampleYield();
  }
  const doc = profiler.snapshot();
  assert.equal(doc.longYields, 5);
  assert.deepEqual(Array.from(doc.yieldStalls, stall => stall.gapMs), [900, 400, 320, 300, 251, 250, 180, 170]);
  assert.equal(doc.yieldStalls[0].cursor.pass, 900);
  tick(20);
  assert.equal(profiler.snapshot().sinceLastYieldMs, 20);

  const threshold = AREX.createProfiler();
  tick(100);
  threshold.sampleYield();
  tick(101);
  threshold.sampleYield();
  assert.deepEqual(Array.from(threshold.snapshot().yieldStalls, stall => stall.gapMs), [101]);
});

const sizeOf = doc => Buffer.byteLength(JSON.stringify(doc), 'utf8');

test('snapshot and finish enforce the UTF-8 byte budget, even below the full schema size', () => {
  const { AREX } = env();
  assert.throws(() => AREX.createProfiler({ maxJSONBytes: 1 }), /maxJSONBytes/);
  for (const budget of [2, 128, 2048, 256 * 1024]) {
    const profiler = AREX.createProfiler({ maxJSONBytes: budget, sourceUrl: '🌐'.repeat(2048) });
    const text = '界'.repeat(400);
    profiler.beginSpan('cleanup', { note: text });
    for (let i = 0; i < 300; i++) {
      profiler.event('e-' + i, text);
      profiler.phase('p-' + i, i, text);
      profiler.window({ index: i, ms: i, note: text });
    }
    const limit = Math.min(budget, 128 * 1024);
    const snapshot = profiler.snapshot({ progressLog: Array.from({ length: 100 }, (_, i) => ({ at: i, detail: text })), warnings: [text] });
    const finish = profiler.finish({ warnings: [text] });
    for (const doc of [snapshot, finish]) {
      assert.ok(sizeOf(doc) <= limit, `JSON budget of ${limit} bytes exceeded`);
      if (doc.events) {
        assert.equal(doc.events.length + doc.eventsDropped, 300);
        assert.equal(doc.windows.length + doc.windowsOmitted, 300);
      }
    }
    if (budget > 128 * 1024) {
      assert.equal(snapshot.profileVersion, 2);
      assert.equal(snapshot.events.length, 80, 'drop bulky detail before losing milestones');
      assert.equal(snapshot.events.at(-1).phase, 'e-299');
      assert.equal(snapshot.progressLog.at(-1).at, 99);
      assert.equal(snapshot.progressLog.length + snapshot.progressLogOmitted, 100);
    }
  }
});

test('window process records per-window stats and message timings', async () => {
  const html = '<div role="log"><div data-agent-transcript-message><p class="prose">hi</p></div>' +
    '<div data-agent-transcript-message><p class="prose">there</p></div></div>';
  const { AREX } = env(html);
  const log = AREX.logEl();
  const profiler = AREX.createProfiler({ toolVersion: '0.4.1', sourceUrl: 'https://arena.ai/agent/u-1', chatUuid: 'u-1', options: { includeToolActivity: false } });
  const result = await AREX.processMessagesInWindows(log, { includeToolActivity: false }, { profiler });
  const doc = profiler.finish({
    outcome: 'done',
    totals: {
      messages: result.totalMessages,
      windows: result.windowCount,
      markdownChars: result.markdown.length,
      markdownBytes: new TextEncoder().encode(result.markdown).length,
      expandedSpoilers: result.expandedSpoilers,
      leftCollapsed: result.leftCollapsed,
    },
  });

  assert.equal(result.totalMessages, 2);
  assert.equal(result.windowCount, 1);
  assert.equal(doc.totals.messages, 2);
  assert.equal(doc.totals.windows, 1);
  assert.equal(doc.messageTiming.count, 2);
  assert.equal(doc.windows.length, 1);
  assert.equal(doc.windows[0].index, 0);
  assert.equal(doc.windows[0].from, 0);
  assert.equal(doc.windows[0].to, 2);
  assert.equal(doc.windows[0].messages, 2);
  assert.equal(doc.windows[0].expandMs, 0);
  assert.equal(doc.windows[0].cleanupMs, 0);
  assert.equal(doc.windows[0].spoilers, 0);
  assert.equal(typeof doc.windows[0].ms, 'number');
  assert.equal(typeof doc.windows[0].serializeMs, 'number');
  assert.equal(typeof doc.windows[0].bytes, 'number');
  assert.ok(doc.windows[0].ms >= 0);
  assert.ok(doc.windows[0].serializeMs >= 0);
});

test('processMessagesInWindows works without a profiler', async () => {
  const html = '<div role="log"><div data-agent-transcript-message><p class="prose">hi</p></div></div>';
  const { AREX } = env(html);
  const log = AREX.logEl();
  const result = await AREX.processMessagesInWindows(log, { includeToolActivity: false }, { profiler: null });
  assert.equal(result.totalMessages, 1);
  assert.equal(result.windowCount, 1);
});
