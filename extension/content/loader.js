// History gate: force-load earlier transcript pages (top sentinel + IntersectionObserver).
window.AREX = window.AREX || {};

(function () {
  const S = AREX.S, q = AREX.q;

  AREX.loadFullHistory = async function (log, { onProgress, maxRounds = 250, roundTimeoutMs = 8000 } = {}) {
    const count = () => AREX.messages(log).length;
    const firstId = () => AREX.msgId(AREX.messages(log)[0] || log);
    const retry = () => AREX.qq('button', log).find(b => S.RETRY_TEXT.test(AREX.text(b)));
    const emit = p => onProgress?.({ stage: 'history', ...p });

    let stagnant = 0, lastCount = count(), lastFirst = firstId(), pages = 0;
    for (let round = 0; round < maxRounds && stagnant < 3; round++) {
      if (retry()) { retry().click(); emit({ phase: 'retry', loaded: lastCount }); } // error-state recovery
      try { log.scrollTo?.({ top: 0, behavior: 'auto' }); } catch { /* jsdom: not implemented */ }
      log.scrollTop = 0;
      emit({ phase: 'scan', round: round + 1, loaded: lastCount, stagnant });
      await AREX.waitFor(
        () => count() !== lastCount || firstId() !== lastFirst || !!q(S.LOADER, log) || !!retry(),
        { timeoutMs: roundTimeoutMs },
      );
      const c = count(), f = firstId();
      if (c === lastCount && f === lastFirst) {
        if (q(S.LOADER, log)) {
          emit({ phase: 'loading', loaded: lastCount }); // older page in flight
          await AREX.waitFor(() => !q(S.LOADER, log) || !!retry(), { timeoutMs: roundTimeoutMs });
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
    return { messages: count(), stable: stagnant >= 3, pages };
  };
})();
