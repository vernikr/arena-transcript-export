// Bounded, low-overhead profiler for a single export run. Page module.
//
// Design goals:
//  - almost zero overhead on the happy path: no timers, no DOM reads, no storage,
//    no string building; only performance.now() calls and small object pushes.
//  - the finished log stays compact and easy to parse for an agent, even when the
//    source page is very large: per-window detail is kept only for the slowest
//    windows, per-message timing is kept as an aggregate, the JSON document is hard-capped,
//    and snapshots never change the recorder state.
//  - profiling is enabled by default; callers pass { enabled: false } (or omit the
//    profiler entirely) to keep the export path at zero profiling cost.
window.AREX = window.AREX || {};

(function () {
  const FINISH_VERSION = 1; // background.js still accepts only v1
  const SNAPSHOT_VERSION = 2;
  const EVENT_HEAD_SIZE = 16;
  const DEFAULT_MAX_EVENTS = EVENT_HEAD_SIZE + 64;
  const MAX_PROGRESS_ENTRIES = 64;
  const MAX_YIELD_STALLS = 8;
  const YIELD_STALL_MS = 100;
  const LONG_YIELD_MS = 250;
  const CURSOR_FIELDS = ['stage', 'phase', 'windowIndex', 'messageIndex', 'pass', 'spoilersOpened', 'spoilersClosed'];
  const DEFAULT_MAX_WINDOWS = 64;
  const DEFAULT_MAX_MESSAGE_SAMPLES = 512;
  const DEFAULT_MAX_MEMORY_SAMPLES = 8;
  const MAX_JSON_BYTES = 128 * 1024;

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

  // Copy structured diagnostic metadata, not arbitrary application state. Bound
  // the copy even for large/circular inputs; omit values that aren't JSON data.
  function copyMetadata(value) {
    let remaining = 64;
    function copy(item, depth) {
      if (remaining-- <= 0) return undefined;
      if (typeof item === 'string') return item.slice(0, 400);
      if (item == null || typeof item === 'boolean' || typeof item === 'number') return item;
      if (typeof item !== 'object' || depth === 0) return undefined;
      if (Array.isArray(item)) return item.slice(0, 32).map(child => copy(child, depth - 1));
      const result = Object.create(null);
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (remaining <= 0) break;
        const child = copy(item[key], depth - 1);
        if (child !== undefined) result[key.slice(0, 120)] = child;
      }
      return result;
    }
    return copy(value, 3);
  }

  // A fully inert recorder so disabled callers can use the same API.
  function noopProfiler() {
    return {
      enabled: false,
      now: () => 0,
      phase() {},
      window() {},
      message() {},
      event() {},
      sampleMemory() {},
      beginSpan() { return null; },
      endSpan() {},
      setCursor() {},
      sampleYield() {},
      snapshot() { return null; },
      finish() { return null; },
    };
  }

  function capDocument(doc, maxJSONBytes, headCount) {
    const encoder = new TextEncoder();
    const fit = () => {
      const json = JSON.stringify(doc);
      // Parsing also detaches the result from any nested recorder state.
      return encoder.encode(json).length <= maxJSONBytes ? JSON.parse(json) : null;
    };
    let result = fit();
    if (result) return result;

    doc.truncated = true;
    const trimWindows = keep => {
      doc.windowsOmitted += Math.max(0, doc.windows.length - keep);
      doc.windows = doc.windows.slice(0, keep);
    };
    const trimProgress = keep => {
      if (!doc.progressLog || doc.progressLog.length <= keep) return;
      doc.progressLogOmitted += doc.progressLog.length - keep;
      doc.progressLog = doc.progressLog.slice(doc.progressLog.length - keep);
    };
    trimWindows(8);
    trimProgress(16);
    if ((result = fit())) return result;
    doc.events = doc.events.map(({ tMs, phase }) => ({ tMs, phase }));
    if ((result = fit())) return result;

    trimWindows(0);
    trimProgress(4);
    doc.memory = [];
    doc.totals.warnings = [];
    if (doc.partialStats) doc.partialStats = null;
    if (doc.inFlight?.span) delete doc.inFlight.span.detail;
    for (const phase of Object.values(doc.phases)) delete phase.detail;
    if ((result = fit())) return result;

    // Large metadata and many distinct phase names should not crowd out the
    // milestone timeline. Keep the slowest phase summaries when space is tight.
    const slowestPhases = Object.entries(doc.phases).sort((a, b) => b[1].ms - a[1].ms);
    doc.phases = Object.fromEntries(slowestPhases.slice(0, 16));
    trimProgress(1);
    doc.sourceUrl = '';
    if ((result = fit())) return result;
    doc.phases = Object.fromEntries(slowestPhases.slice(0, 4));
    trimProgress(0);
    if ((result = fit())) return result;

    // Keep startup and latest milestones as long as possible. Never fall back
    // to drop-tail: under a very tight budget the newest record wins.
    let head = Math.min(headCount, Math.max(0, doc.events.length - 1));
    let tail = doc.events.length - head;
    while (head + tail > 0) {
      const nextHead = Math.floor(head / 2);
      const nextTail = tail > 1 ? Math.ceil(tail / 2) : head ? tail : 0;
      doc.events = doc.events.slice(0, nextHead).concat(doc.events.slice(doc.events.length - nextTail));
      doc.eventsDropped += head + tail - nextHead - nextTail;
      head = nextHead;
      tail = nextTail;
      if ((result = fit())) return result;
    }
    if (doc.yieldStalls) doc.yieldStalls = [];
    doc.phases = {};
    doc.chatUuid = null;
    doc.toolVersion = '';
    if ((result = fit())) return result;

    // A caller can request less space than an empty full-schema document.
    for (const minimal of [
      { profileVersion: doc.profileVersion, outcome: doc.outcome, durationMs: doc.durationMs, truncated: true },
      { profileVersion: doc.profileVersion, truncated: true },
      { profileVersion: doc.profileVersion },
    ]) {
      if (encoder.encode(JSON.stringify(minimal)).length <= maxJSONBytes) return minimal;
    }
    return {};
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
    maxJSONBytes = MAX_JSON_BYTES,
  } = {}) {
    if (!enabled) return noopProfiler();
    if (!(maxJSONBytes >= 2)) throw new RangeError('maxJSONBytes must fit at least an empty JSON object');
    const byteBudget = Math.min(maxJSONBytes, MAX_JSON_BYTES);
    const eventLimit = Math.max(0, Math.min(DEFAULT_MAX_EVENTS, Math.floor(maxEvents))) || 0;
    // A reduced custom limit still reserves space for recent events.
    const headLimit = Math.min(EVENT_HEAD_SIZE, Math.floor(eventLimit / 2));
    const tailLimit = eventLimit - headLimit;

    const startedAtEpoch = Date.now();
    const startMs = nowMs();
    const recordsOpts = {
      includeToolActivity: options.includeToolActivity !== false,
      timestamps: Boolean(options.timestamps),
      profile: true,
    };

    const eventHead = [];
    const eventTail = [];  // circular, with tailNext pointing at the oldest slot when full
    let tailNext = 0;
    let eventsSeen = 0;
    const activeSpans = new Map();
    let cursor = null;
    let lastYieldMs = startMs;
    let longYields = 0;
    const yieldStalls = [];
    const windows = [];    // slowest per-window records, capped
    let windowsSeen = 0;
    const phases = Object.create(null);     // name -> { ms, count, maxMs, detail? }
    const memorySamples = [];  // [{ tMs, phase, memory }] — capped
    const messageSamples = []; // capped — trimmed to p95 basis
    let messageCount = 0;
    let messageTotalMs = 0;
    let messageMaxMs = 0;
    let messageMaxIndex = null;
    let messageMaxWindowIndex = null;

    const now = () => nowMs();

    const recordPhase = (name, ms, detail) => {
      name = String(name).slice(0, 120);
      const rec = phases[name] || (phases[name] = { ms: 0, count: 0, maxMs: 0 });
      rec.ms += ms;
      rec.count += 1;
      if (ms > rec.maxMs) rec.maxMs = ms;
      if (detail) rec.lastDetail = String(detail).slice(0, 400);
    };

    const recordEvent = (phaseName, detail) => {
      eventsSeen += 1;
      if (!eventLimit) return;
      const entry = { tMs: round1(now() - startMs), phase: String(phaseName).slice(0, 120) };
      if (detail != null) entry.detail = String(detail).slice(0, 400);
      if (eventHead.length < headLimit) { eventHead.push(entry); return; }
      eventTail[tailNext] = entry;
      tailNext = (tailNext + 1) % tailLimit;
    };

    const beginSpan = (name, detail) => {
      const token = Symbol();
      activeSpans.set(token, { name: String(name).slice(0, 120), start: now(), detail: copyMetadata(detail) });
      return token;
    };

    // Closing a span records one completed phase. Unknown or reused tokens are inert.
    const endSpan = (token, extraDetail) => {
      const span = activeSpans.get(token);
      if (!span) return;
      const elapsed = now() - span.start;
      activeSpans.delete(token);
      const extra = copyMetadata(extraDetail);
      const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
      const detail = isRecord(span.detail) && isRecord(extra)
        ? { ...span.detail, ...extra }
        : extra ?? span.detail;
      recordPhase(span.name, elapsed, typeof detail === 'object' ? JSON.stringify(detail) : detail);
    };

    // Merge incremental cursor updates; setCursor(null) clears it. Snapshots
    // show the last started span that is still open, even after a child closes.
    const setCursor = update => {
      if (update == null) { cursor = null; return; }
      const next = { ...cursor };
      for (const key of CURSOR_FIELDS) {
        const value = update[key];
        if (value === null) delete next[key];
        else if (typeof value === 'number' && Number.isFinite(value)) next[key] = value;
        else if (typeof value === 'string') next[key] = value.slice(0, 120);
      }
      cursor = next;
    };

    // Call immediately before each cooperative yield. These are observed gaps,
    // not browser Long Tasks: an interval can also contain asynchronous waits.
    const sampleYield = () => {
      const at = now();
      const gap = at - lastYieldMs;
      lastYieldMs = at;
      if (gap > LONG_YIELD_MS) longYields += 1;
      if (gap <= YIELD_STALL_MS || (yieldStalls.length === MAX_YIELD_STALLS && gap <= yieldStalls.at(-1).gap)) return;
      yieldStalls.push({ tMs: round1(at - startMs), gap, cursor });
      yieldStalls.sort((a, b) => b.gap - a.gap);
      if (yieldStalls.length > MAX_YIELD_STALLS) yieldStalls.pop();
    };

    const recordWindow = (rec) => {
      windowsSeen += 1;
      if (maxWindows <= 0) return;
      let minPos = 0;
      if (windows.length >= maxWindows) {
        // Keep only the slowest windows. The rest are counted as omitted.
        for (let i = 1; i < windows.length; i++) if (windows[i].ms < windows[minPos].ms) minPos = i;
        if (rec.ms <= windows[minPos].ms) return;
      } else {
        minPos = windows.length;
      }
      windows[minPos] = copyMetadata(rec);
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

    const buildDocument = ({ version, outcome, error, warnings, totals, progressLog, partialStats }) => {
      const at = now();
      const events = eventHead.concat(eventTail.slice(tailNext), eventTail.slice(0, tailNext));
      const meanMs = messageCount ? messageTotalMs / messageCount : 0;
      const doc = {
        profileVersion: version,
        tool: 'arena-transcript-export',
        toolVersion: String(toolVersion || '').slice(0, 120),
        sourceUrl: String(sourceUrl || '').slice(0, 2048),
        chatUuid: chatUuid == null ? null : String(chatUuid).slice(0, 120),
        startedAt: new Date(startedAtEpoch).toISOString(),
        durationMs: round1(at - startMs),
        outcome: String(outcome || 'unknown').slice(0, 120),
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
        eventsDropped: eventsSeen - events.length,
      };
      if (version === SNAPSHOT_VERSION) {
        const span = Array.from(activeSpans.values()).at(-1);
        const progress = Array.isArray(progressLog) ? progressLog : [];
        doc.inFlight = {
          span: span ? { name: span.name, startedAtMs: round1(span.start - startMs), elapsedMs: round1(at - span.start), detail: span.detail } : null,
          cursor,
        };
        doc.longYields = longYields;
        doc.yieldStalls = yieldStalls.map(({ tMs, gap, cursor }) => ({ tMs, gapMs: round1(gap), cursor }));
        doc.sinceLastYieldMs = round1(at - lastYieldMs);
        doc.progressLog = progress.slice(-MAX_PROGRESS_ENTRIES).map(copyMetadata);
        doc.progressLogOmitted = progress.length - doc.progressLog.length;
        doc.partialStats = partialStats;
      }
      return capDocument(doc, byteBudget, eventHead.length);
    };

    const snapshot = ({ outcome = 'running', progressLog = [], warnings = [], partialStats = null } = {}) => {
      const stats = copyMetadata(partialStats) ?? null;
      return buildDocument({ version: SNAPSHOT_VERSION, outcome, progressLog, warnings, partialStats: stats, totals: stats ?? {} });
    };

    const finish = ({ outcome = 'done', error = null, warnings = [], totals = {} } = {}) => {
      recordMemorySample('export.finished');
      return buildDocument({ version: FINISH_VERSION, outcome, error, warnings, totals: copyMetadata(totals) ?? {} });
    };

    return {
      enabled: true,
      now: now,
      phase: recordPhase,
      event: recordEvent,
      window: recordWindow,
      message: recordMessage,
      sampleMemory: recordMemorySample,
      beginSpan,
      endSpan,
      setCursor,
      sampleYield,
      snapshot,
      finish,
    };
  };
})();
