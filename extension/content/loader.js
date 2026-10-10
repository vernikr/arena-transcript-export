// History gate: force-load earlier transcript pages (top sentinel + IntersectionObserver).
// Fast confirmation when everything is already loaded: sub-page branches (likely the server's
// non-paged "compat" mode) get two short quiet rounds instead of long detection windows.
window.AREX = window.AREX || {};

(function () {
  const S = AREX.S, q = AREX.q;

  AREX.loadFullHistory = function (log, opts = {}) {
    const {
      onProgress, maxRounds = 250, spinnerGoneMs = 12000,
      stagnantTarget = 2, smallThreshold = 20,
    } = opts;
    const detectMs = opts.detectMs ?? opts.roundTimeoutMs ?? 2500;
    const quickMs = opts.quickMs ?? opts.roundTimeoutMs ?? 1200;

    const count = () => AREX.messages(log).length;
    const firstId = () => AREX.msgId(AREX.messages(log)[0] || log);
    const retry = () => AREX.qq('button', log).find(b => S.RETRY_TEXT.test(AREX.text(b)));
    const emit = p => onProgress?.({ stage: 'history', target: stagnantTarget, ...p });

    let stagnant = 0, lastCount = count(), lastFirst = firstId(), pages = 0;
    const windowMs = lastCount < smallThreshold ? quickMs : detectMs;

    return (async () => {
      for (let round = 0; round < maxRounds && stagnant < stagnantTarget; round++) {
        if (retry()) { retry().click(); emit({ phase: 'retry', loaded: lastCount }); } // error-state recovery
        try { log.scrollTo?.({ top: 0, behavior: 'auto' }); } catch { /* jsdom: not implemented */ }
        log.scrollTop = 0;
        emit({ phase: 'scan', round: round + 1, loaded: lastCount, stagnant });
        await AREX.waitFor(
          () => count() !== lastCount || firstId() !== lastFirst || !!q(S.LOADER, log) || !!retry(),
          { timeoutMs: windowMs },
        );
        const c = count(), f = firstId();
        if (c === lastCount && f === lastFirst) {
          if (q(S.LOADER, log)) {
            emit({ phase: 'loading', loaded: lastCount }); // older page in flight
            await AREX.waitFor(() => !q(S.LOADER, log) || !!retry(), { timeoutMs: spinnerGoneMs });
            continue; // a load finished without change → re-evaluate next round
          }
          stagnant++;
          emit({ phase: 'settle', stagnant, loaded: lastCount });
        } else {
          stagnant = 0;
          pages++;
          emit({ phase: 'page', pages, added: c - lastCount, loaded: c });
          lastCount = c; lastFirst = f;
        }
      }
      emit({ phase: 'settling-dom' });
      await AREX.settle(log, { quietMs: 300 });
      return { messages: count(), stable: stagnant >= stagnantTarget, pages };
    })();
  };
})();
