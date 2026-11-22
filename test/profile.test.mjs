import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './harness.mjs';

const opts = { includeToolActivity: true, timestamps: false };

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

test('event and window lists stay bounded and keep the slowest windows', () => {
  const { AREX } = env();
  const profiler = AREX.createProfiler({ toolVersion: '0.4.1', options: opts });
  for (let i = 0; i < 100; i++) profiler.event('phase-' + i, 'note');
  for (let i = 0; i < 200; i++) profiler.window({ index: i, from: i, to: i + 1, messages: 1, ms: i, expandMs: 1, serializeMs: 1, cleanupMs: 1, bytes: 10, spoilers: 0 });
  const doc = profiler.finish({ outcome: 'done', totals: { messages: 200, windows: 200 } });

  assert.equal(doc.events.length, 48);
  assert.equal(doc.eventsDropped, 52);
  // 200 windows recorded, 64 kept — the slowest (highest ms) ones.
  assert.equal(doc.windows.length, 64);
  assert.equal(doc.windowsOmitted, 136);
  assert.equal(JSON.stringify(doc.windows.map(w => w.index)), JSON.stringify(Array.from({ length: 64 }, (_, i) => 199 - i)));
  assert.equal(JSON.stringify(doc.windows.map(w => w.ms)), JSON.stringify(Array.from({ length: 64 }, (_, i) => 199 - i)));
});

test('the document stays inside a hard byte budget', () => {
  const { AREX } = env();
  const profiler = AREX.createProfiler({ toolVersion: '0.4.1', options: opts, maxJSONBytes: 2048 });
  for (let i = 0; i < 300; i++) profiler.event('e-' + i, 'detail '.repeat(40));
  for (let i = 0; i < 300; i++) profiler.message(1 + i / 100, i, Math.floor(i / 4));
  for (let i = 0; i < 300; i++) profiler.window({ index: i, from: i * 4, to: i * 4 + 4, messages: 4, ms: 100 + i, expandMs: 1, serializeMs: 1, cleanupMs: 1, bytes: 100, spoilers: 1 });
  const doc = profiler.finish({ outcome: 'done', totals: { messages: 300, windows: 300 } });
  assert.ok(JSON.stringify(doc).length <= 2048, 'JSON budget exceeded');
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
