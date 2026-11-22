// Bounded, low-overhead profiler for a single export run. Page module.
//
// Design goals:
//  - almost zero overhead on the happy path: no timers, no DOM reads, no storage,
//    no string building; only performance.now() calls and small object pushes.
//  - the finished log stays compact and easy to parse for an agent, even when the
//    source page is very large: per-window detail is kept only for the slowest
//    windows, per-message timing is kept as an aggregate, the JSON document is hard-capped,
//    and the recorder writes nothing until finish() is called.
//  - profiling is enabled by default; callers pass { enabled: false } (or omit the
//    profiler entirely) to keep the export path at zero profiling cost.
window.AREX = window.AREX || {};

(function () {
  const VERSION = 1;
  const DEFAULT_MAX_EVENTS = 48;
  const DEFAULT_MAX_WINDOWS = 64;
  const DEFAULT_MAX_MESSAGE_SAMPLES = 512;
  const DEFAULT_MAX_MEMORY_SAMPLES = 8;
  const DEFAULT_MAX_JSON_BUDGET = 64 * 1024;

  const round1 = n => Math.round(n * 10) / 10;

  function nowMs() {
    try { return performance.now(); } catch { return Date.now(); }
  }

  // performance.memory is Chromium-only; treat it as best-effort.
  function memorySnapshot() {
    try {
      const m = performance.memory;
      if (m && typeof m.usedJSHeapSize === 'number') {
        return {
          usedJSHeapSizeBytes: m.usedJSHeapSize,
          totalJSHeapSizeBytes: m.totalJSHeapSize,
          jsHeapSizeLimitBytes: m.jsHeapSizeLimit,
        };
      }
    } catch { /* unavailable */ }
    return null;
  }

  function p95(samples) {
    if (!samples.length) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const index = Math.ceil(0.95 * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  function jsonBytes(doc) {
    try { return new TextEncoder().encode(JSON.stringify(doc)).length; }
    catch { return JSON.stringify(doc).length; }
  }

  // A fully inert recorder: nothing accumulates, finish() returns null. Used for
  // exports with profiling disabled, so callers never diverge on the hot path.
  function noopProfiler() {
    return {
      enabled: false,
      now: () => 0,
      phase() {},
      window() {},
      message() {},
      event() {},
      sampleMemory() {},
      finish() { return null; },
    };
  }

  function capDocument(doc, maxJSONBytes) {
    if (jsonBytes(doc) <= maxJSONBytes) return doc;
    // The budget is tight: drop the bulky per-window list and narrative events.
    doc.windows = (doc.windows || []).slice(0, 8);
    doc.events = (doc.events || []).slice(0, 16);
    doc.memory = (doc.memory || []).slice(0, 3);
    if (jsonBytes(doc) <= maxJSONBytes) return doc;
    // Last resort: drop the bulky arrays entirely. totals, phases and message
    // timing stay intact — those are the parts an agent needs to triage the run.
    doc.windows = [];
    doc.events = [];
    doc.memory = [];
    if (jsonBytes(doc) > maxJSONBytes) {
      doc.totals = Object.assign({}, doc.totals, { historyMessages: undefined, historyPages: undefined, historyStable: undefined });
      doc.options = {};
    }
    return doc;
  }

  AREX.createProfiler = function ({
    enabled = true,
    toolVersion = '',
    sourceUrl = '',
    chatUuid = null,
    options = {},
    maxEvents = DEFAULT_MAX_EVENTS,
    maxWindows = DEFAULT_MAX_WINDOWS,
    maxMessageSamples = DEFAULT_MAX_MESSAGE_SAMPLES,
    maxJSONBytes = DEFAULT_MAX_JSON_BUDGET,
  } = {}) {
    if (!enabled) return noopProfiler();

    const startedAtEpoch = Date.now();
    const startMs = nowMs();
    const recordsOpts = {
      includeToolActivity: options.includeToolActivity !== false,
      timestamps: Boolean(options.timestamps),
      profile: true,
    };

    const events = [];     // [{ tMs, phase, detail? }] — milestone events, capped
    let eventsDropped = 0;
    const windows = [];    // slowest per-window records, capped
    let windowsSeen = 0;
    const phases = {};     // name -> { ms, count, maxMs, detail? }
    const memorySamples = [];  // [{ tMs, phase, memory }] — capped
    const messageSamples = []; // capped — trimmed to p95 basis
    let messageCount = 0;
    let messageTotalMs = 0;
    let messageMaxMs = 0;
    let messageMaxIndex = null;
    let messageMaxWindowIndex = null;

    const now = () => nowMs();

    const recordPhase = (name, ms, detail) => {
      const rec = phases[name] || (phases[name] = { ms: 0, count: 0, maxMs: 0 });
      rec.ms += ms;
      rec.count += 1;
      if (ms > rec.maxMs) rec.maxMs = ms;
      if (detail) rec.lastDetail = String(detail).slice(0, 400);
    };

    const recordEvent = (phaseName, detail) => {
      if (events.length >= maxEvents) {
        eventsDropped += 1;
        return;
      }
      const entry = { tMs: round1(now() - startMs), phase: phaseName };
      if (detail != null) entry.detail = String(detail).slice(0, 400);
      events.push(entry);
    };

    const recordWindow = (rec) => {
      windowsSeen += 1;
      if (windows.length < maxWindows) { windows.push(rec); return; }
      // Bounded: keep only the slowest windows. The rest are counted as dropped.
      let minPos = 0;
      for (let i = 1; i < windows.length; i++) if (windows[i].ms < windows[minPos].ms) minPos = i;
      if (rec.ms > windows[minPos].ms) windows[minPos] = rec;
    };

    const recordMessage = (ms, index, windowIndex) => {
      messageCount += 1;
      messageTotalMs += ms;
      if (messageSamples.length < maxMessageSamples) messageSamples.push(ms);
      if (ms > messageMaxMs) {
        messageMaxMs = ms;
        messageMaxIndex = index;
        messageMaxWindowIndex = windowIndex;
      }
    };

    const recordMemorySample = (phaseName) => {
      if (memorySamples.length >= DEFAULT_MAX_MEMORY_SAMPLES) return;
      const memory = memorySnapshot();
      if (!memory) return; // Chromium-only signal; absent elsewhere is fine.
      memorySamples.push({ tMs: round1(now() - startMs), phase: phaseName, memory });
    };

    const finish = ({ outcome = 'done', error = null, warnings = [], totals = {} } = {}) => {
      recordMemorySample('export.finished');
      const durationMs = now() - startMs;
      const meanMs = messageCount ? messageTotalMs / messageCount : 0;
      const doc = {
        profileVersion: VERSION,
        tool: 'arena-transcript-export',
        toolVersion: String(toolVersion || ''),
        sourceUrl: String(sourceUrl || ''),
        chatUuid: chatUuid == null ? null : String(chatUuid),
        startedAt: new Date(startedAtEpoch).toISOString(),
        durationMs: round1(durationMs),
        outcome: String(outcome || 'unknown'),
        error: error ? String(error).slice(0, 500) : null,
        options: recordsOpts,
        totals: {
          messages: totals.messages != null ? totals.messages : messageCount,
          windows: totals.windows != null ? totals.windows : windowsSeen,
          expandedSpoilers: totals.expandedSpoilers != null ? totals.expandedSpoilers : 0,
          spoilersStuck: totals.spoilersStuck != null ? totals.spoilersStuck : 0,
          spoilersTotal: totals.spoilersTotal != null ? totals.spoilersTotal : 0,
          leftCollapsed: totals.leftCollapsed != null ? totals.leftCollapsed : 0,
          historyPages: totals.historyPages == null ? null : totals.historyPages,
          historyStable: totals.historyStable == null ? null : Boolean(totals.historyStable),
          historyMessages: totals.historyMessages == null ? null : totals.historyMessages,
          markdownChars: totals.markdownChars != null ? totals.markdownChars : 0,
          markdownBytes: totals.markdownBytes != null ? totals.markdownBytes : 0,
          warnings: Array.isArray(warnings) ? warnings.slice(0, 20).map(w => String(w).slice(0, 300)) : [],
        },
        phases: Object.fromEntries(Object.entries(phases).map(([name, rec]) => [name, {
          ms: round1(rec.ms),
          count: rec.count,
          maxMs: round1(rec.maxMs),
          ...(rec.lastDetail ? { detail: rec.lastDetail } : {}),
        }])),
        messageTiming: {
          count: messageCount,
          meanMs: round1(meanMs),
          p95Ms: round1(p95(messageSamples)),
          maxMs: round1(messageMaxMs),
          maxMessageIndex: messageMaxIndex,
          maxWindowIndex: messageMaxWindowIndex,
          samplesKept: messageSamples.length,
          samplesCapped: messageSamples.length < messageCount,
        },
        windows: windows.slice().sort((a, b) => b.ms - a.ms),
        windowsOmitted: windowsSeen - windows.length,
        memory: memorySamples,
        events,
        eventsDropped,
      };
      return capDocument(doc, maxJSONBytes);
    };

    return {
      enabled: true,
      now: now,
      phase: recordPhase,
      event: recordEvent,
      window: recordWindow,
      message: recordMessage,
      sampleMemory: recordMemorySample,
      finish,
    };
  };
})();
