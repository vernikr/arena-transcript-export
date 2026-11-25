// Force-load earlier pages via Arena's top sentinel, with a conservative
// fallback for older page versions which paginate without sentinel attributes.
//
// Hot MutationObserver checks are bounded: they never descend into a
// [data-agent-transcript-message] card (where thousands of spoiler buttons and
// unrelated role="status" notices live) and never run a full-DOM button or
// message query. One authoritative rescan per round keeps counts exact.
window.AREX = window.AREX || {};

(function () {
  const S = AREX.S;
  const CONTROL_NODE_CAP = 96;  // hard bound on shallow header nodes visited
  const CHILD_CAP = 12;         // children inspected at each end of a container
  const MAX_DEPTH = 3;

  const isEl = node => node?.nodeType === 1;

  // Pagination UI lives in the log header: the boundary subtree, direct
  // non-message children of the log, and the first/last few children of the
  // message-list wrapper. Message cards are pruned on sight — descending into
  // one used to make retry()/loading() O(N) on every streamed DOM mutation.
  function headerNodes(log, boundary) {
    const nodes = [], seen = new Set();
    const visit = (el, depth) => {
      if (!isEl(el) || nodes.length >= CONTROL_NODE_CAP || el.matches(S.MSG)) return;
      if (!seen.has(el)) { seen.add(el); nodes.push(el); }
      if (depth >= MAX_DEPTH) return;
      const kids = el.children, n = kids.length;
      for (let i = 0; i < Math.min(n, CHILD_CAP) && nodes.length < CONTROL_NODE_CAP; i += 1) visit(kids[i], depth + 1);
      if (n > CHILD_CAP * 2) {
        for (let i = Math.max(CHILD_CAP, n - CHILD_CAP); i < n && nodes.length < CONTROL_NODE_CAP; i += 1) visit(kids[i], depth + 1);
      }
    };
    if (boundary?.isConnected) visit(boundary, 0);
    visit(log, 0);
    return nodes;
  }

  // Scoped controls only: no AREX.qq('button', log), no text reads on spoilers.
  function scanHeader(log, boundary) {
    let retryEl = null, spinner = false;
    for (const el of headerNodes(log, boundary)) {
      if (!retryEl && el.matches('button') && S.RETRY_TEXT.test(AREX.text(el))) retryEl = el;
      if (!spinner && el.matches(S.LOADER) && S.LOADING_TEXT.test(AREX.text(el))) spinner = true;
      if (retryEl && spinner) break;
    }
    return { retryEl, spinner };
  }

  AREX.loadFullHistory = async function (log, opts = {}) {
    const { onProgress, maxRounds = 250, spinnerGoneMs = 12000, stagnantTarget = 2,
      smallThreshold = 20, maxRetries = 5 } = opts;
    const detectMs = opts.detectMs ?? opts.roundTimeoutMs ?? 2500;
    const quickMs = opts.quickMs ?? opts.roundTimeoutMs ?? 1200;
    const quietMs = opts.quietMs ?? 150;
    const emit = p => onProgress?.({ stage: 'history', target: stagnantTarget, ...p });

    const state = { count: 0, firstEl: null, firstId: '', sentinelEl: null, boundaryEl: null, retryEl: null, spinner: false };
    const syncControls = () => {
      const header = scanHeader(log, state.boundaryEl);
      state.retryEl = header.retryEl;
      state.spinner = header.spinner;
    };
    // Bounded hot-path refresh: querySelector stops at the first message
    // (no full-DOM array), plus the capped shallow header scan.
    const poll = () => {
      const first = AREX.q(S.MSG, log);
      state.firstEl = first;
      state.firstId = AREX.msgId(first || log);
      syncControls();
    };
    // Authoritative rescan: count() + firstId() coalesced into one query, once
    // per round instead of once per mutation.
    const resync = () => {
      const msgs = AREX.messages(log);
      state.count = msgs.length;
      state.firstEl = msgs[0] || null;
      state.firstId = AREX.msgId(state.firstEl || log);
      state.sentinelEl = AREX.q(S.SENTINEL, log);
      state.boundaryEl = AREX.q(S.BOUNDARY, log);
      syncControls();
    };
    const markersGone = () => !state.sentinelEl && !state.boundaryEl;
    // Cached marker refs + isConnected: an unmount is detected in O(1) without
    // re-running a querySelector over the whole transcript on every mutation.
    const markersLive = () => Boolean(state.sentinelEl?.isConnected || state.boundaryEl?.isConnected);

    const scrollEvent = () => {
      const win = log.ownerDocument?.defaultView;
      if (win?.Event) { try { log.dispatchEvent(new win.Event('scroll')); } catch { /* detached */ } }
    };
    const scrollToTop = () => {
      try { log.scrollTo?.({ top: 0, behavior: 'auto' }); } catch { /* not supported */ }
      try { log.scrollTop = 0; } catch { /* detached */ }
    };
    // scrollTop === 0 is a no-op: no scroll event and no fresh intersection
    // transition when the sentinel stayed intersecting across pages (or in a
    // throttled background tab). Nudge out of the 200px rootMargin and back.
    const armScroll = (sentinel, rearm) => {
      try { sentinel?.scrollIntoView?.({ block: 'start' }); } catch { /* detached */ }
      scrollToTop();
      if (!rearm || !sentinel) return;
      try { log.scrollTop = Math.min(250, log.scrollHeight || 250); } catch { /* detached */ }
      scrollEvent();
      scrollToTop();
      scrollEvent();
      try { sentinel.scrollIntoView?.({ block: 'start' }); } catch { /* detached */ }
    };

    let stagnant = 0, pages = 0, stable = false, stopReason = 'max_rounds';
    let consecutiveRetries = 0, seenMarker = false, legacyPaging = false;
    resync();
    let lastCount = state.count, lastFirst = state.firstId, lastFirstEl = state.firstEl;
    seenMarker = Boolean(state.sentinelEl || state.boundaryEl);

    for (let round = 0; round < maxRounds; round++) {
      AREX.throwIfAborted?.();
      resync();
      const marker = state.sentinelEl, boundary = state.boundaryEl;
      if (marker || boundary) seenMarker = true;
      const retryButton = state.retryEl;
      if (retryButton) {
        // A permanently failing endpoint must not be clicked 250 times.
        if (consecutiveRetries >= maxRetries) {
          stable = false; stopReason = 'retry_exhausted';
          emit({ phase: 'stop', loaded: lastCount, retries: consecutiveRetries, stopReason });
          break;
        }
        consecutiveRetries += 1;
        if (!seenMarker) legacyPaging = true;
        try { retryButton.click(); } catch { /* detached */ }
        emit({ phase: 'retry', loaded: lastCount, retries: consecutiveRetries });
        resync(); // a click can synchronously mount/unmount the control
      }
      const wasLoading = state.spinner;
      if (wasLoading && !seenMarker) legacyPaging = true;
      // An initially absent sentinel is ambiguous for older Arena builds. If
      // pagination was observed without the markers, keep the old quiet-round
      // fallback rather than mistaking a gap between requests for completion.
      const fastProbe = !marker && !boundary && !legacyPaging && !wasLoading && !retryButton;
      const timeoutMs = fastProbe ? quietMs : (lastCount < smallThreshold ? quickMs : detectMs);
      emit({ phase: 'scan', round: round + 1, loaded: lastCount, stagnant });
      const wait = AREX.waitForDomChange(log, () => {
        poll();
        return state.firstId !== lastFirst || state.firstEl !== lastFirstEl ||
          state.spinner || !!state.retryEl || (seenMarker && !markersLive());
      }, { timeoutMs });
      armScroll(marker, stagnant >= 1 && Boolean(marker?.isConnected));
      await wait;
      resync();

      if (state.spinner) {
        emit({ phase: 'loading', loaded: lastCount });
        if (!seenMarker) legacyPaging = true;
        const finished = await AREX.waitForDomChange(log, () => {
          poll();
          return !state.spinner || !!state.retryEl;
        }, { timeoutMs: spinnerGoneMs });
        resync();
        if (!finished) { stable = false; stopReason = 'spinner_timeout'; break; } // never claim success while a request is stuck
      }
      if (state.count !== lastCount || state.firstId !== lastFirst || state.firstEl !== lastFirstEl) {
        if (!seenMarker) legacyPaging = true;
        stagnant = 0; consecutiveRetries = 0; pages += 1;
        emit({ phase: 'page', pages, added: state.count - lastCount, loaded: state.count });
        lastCount = state.count; lastFirst = state.firstId; lastFirstEl = state.firstEl;
        continue;
      }
      if (state.retryEl) continue;
      // The sentinel unmounts when hasEarlierMessages is false. For initial
      // absence the 150 ms observation also supports unpaged legacy views.
      const gone = markersGone();
      if (gone && !legacyPaging) { stable = true; stopReason = seenMarker ? 'complete' : 'no_marker_probe'; break; }
      if (seenMarker && gone) { stable = true; stopReason = 'complete'; break; }
      stagnant += 1;
      emit({ phase: 'settle', stagnant, loaded: lastCount });
      if (stagnant >= stagnantTarget) {
        // A still-mounted sentinel/boundary signals earlier messages may remain.
        stable = gone;
        stopReason = gone ? (seenMarker ? 'complete' : 'no_marker_probe') : 'sentinel_stagnant';
        break;
      }
    }
    emit({ phase: 'settling-dom', stopReason, stable });
    await AREX.settle(log, { quietMs: 100, maxMs: 1500, attributes: false });
    AREX.throwIfAborted?.();
    resync();
    // stopReason is additive: { messages, stable, pages } stays backward compatible.
    return { messages: state.count, stable, pages, stopReason };
  };
})();
