// Force-load earlier pages via Arena's top sentinel, with a conservative
// fallback for older page versions which paginate without sentinel attributes.
window.AREX = window.AREX || {};

(function () {
  const S = AREX.S;

  AREX.loadFullHistory = async function (log, opts = {}) {
    const { onProgress, maxRounds = 250, spinnerGoneMs = 12000, stagnantTarget = 2, smallThreshold = 20 } = opts;
    const detectMs = opts.detectMs ?? opts.roundTimeoutMs ?? 2500;
    const quickMs = opts.quickMs ?? opts.roundTimeoutMs ?? 1200;
    const quietMs = opts.quietMs ?? 150;
    const count = () => AREX.messages(log).length;
    const firstId = () => AREX.msgId(AREX.messages(log)[0] || log);
    const retry = () => AREX.qq('button', log).find(b => S.RETRY_TEXT.test(AREX.text(b)));
    const loading = () => AREX.qq(S.LOADER, log).some(el => S.LOADING_TEXT.test(AREX.text(el)));
    const sentinel = () => AREX.q(S.SENTINEL, log);
    const boundary = () => AREX.q(S.BOUNDARY, log);
    const emit = p => onProgress?.({ stage: 'history', target: stagnantTarget, ...p });
    let stagnant = 0, lastCount = count(), lastFirst = firstId(), pages = 0;
    let seenMarker = Boolean(sentinel() || boundary()), legacyPaging = false;
    let stable = false;

    for (let round = 0; round < maxRounds; round++) {
      AREX.throwIfAborted?.();
      const marker = sentinel();
      if (marker || boundary()) seenMarker = true;
      const retryButton = retry();
      if (retryButton) { if (!seenMarker) legacyPaging = true; retryButton.click(); emit({ phase: 'retry', loaded: lastCount }); }
      const wasLoading = loading();
      if (wasLoading && !seenMarker) legacyPaging = true;
      const changed = () => count() !== lastCount || firstId() !== lastFirst;
      // An initially absent sentinel is ambiguous for older Arena builds. If
      // pagination was observed without the markers, keep the old quiet-round
      // fallback rather than mistaking a gap between requests for completion.
      const fastProbe = !marker && !boundary() && !legacyPaging && !wasLoading && !retryButton;
      const timeoutMs = fastProbe ? quietMs : (lastCount < smallThreshold ? quickMs : detectMs);
      emit({ phase: 'scan', round: round + 1, loaded: lastCount, stagnant });
      const wait = AREX.waitForDomChange(log, () => changed() || loading() || !!retry() ||
        (seenMarker && !sentinel() && !boundary()), { timeoutMs });
      try { marker?.scrollIntoView?.({ block: 'start' }); } catch { /* detached */ }
      try { log.scrollTo?.({ top: 0, behavior: 'auto' }); } catch { /* not supported */ }
      try { log.scrollTop = 0; } catch { /* detached */ }
      await wait;

      if (loading()) {
        emit({ phase: 'loading', loaded: lastCount });
        if (!seenMarker) legacyPaging = true;
        const finished = await AREX.waitForDomChange(log, () => !loading() || !!retry(), { timeoutMs: spinnerGoneMs });
        if (!finished) break; // never claim success while a request is stuck
      }
      const currentCount = count(), currentFirst = firstId();
      if (currentCount !== lastCount || currentFirst !== lastFirst) {
        if (!seenMarker) legacyPaging = true;
        stagnant = 0; pages++;
        emit({ phase: 'page', pages, added: currentCount - lastCount, loaded: currentCount });
        lastCount = currentCount; lastFirst = currentFirst;
        continue;
      }
      if (retry()) continue;
      if (!sentinel() && !boundary() && !legacyPaging) {
        // The sentinel unmounts when hasEarlierMessages is false. For initial
        // absence the 150 ms observation also supports unpaged legacy views.
        stable = true;
        break;
      }
      if (seenMarker && !sentinel() && !boundary()) { stable = true; break; }
      stagnant++;
      emit({ phase: 'settle', stagnant, loaded: lastCount });
      if (stagnant >= stagnantTarget) {
        // A still-mounted sentinel/boundary signals earlier messages may remain.
        stable = !sentinel() && !boundary();
        break;
      }
    }
    emit({ phase: 'settling-dom' });
    await AREX.settle(log, { quietMs: 100, maxMs: 1500, attributes: false });
    AREX.throwIfAborted?.();
    return { messages: count(), stable, pages };
  };
})();
