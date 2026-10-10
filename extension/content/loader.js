// History gate: force-load earlier transcript pages (top sentinel + IntersectionObserver).
window.AREX = window.AREX || {};

(function () {
  const S = AREX.S, q = AREX.q;

  AREX.loadFullHistory = async function (log, { onProgress, maxRounds = 250, roundTimeoutMs = 8000 } = {}) {
    const count = () => AREX.messages(log).length;
    const firstId = () => AREX.msgId(AREX.messages(log)[0] || log);
    const retry = () => qq_buttons(log).find(b => S.RETRY_TEXT.test(AREX.text(b)));
    function qq_buttons(root) { return AREX.qq('button', root); }

    let stagnant = 0, lastCount = count(), lastFirst = firstId();
    for (let round = 0; round < maxRounds && stagnant < 3; round++) {
      retry()?.click(); // recovery from a failed page load
      try { log.scrollTo?.({ top: 0, behavior: 'auto' }); } catch { /* jsdom: not implemented */ }
      log.scrollTop = 0;
      onProgress?.({ stage: 'history', round: round + 1, loaded: lastCount });
      await AREX.waitFor(
        () => count() !== lastCount || firstId() !== lastFirst || !!q(S.LOADER, log) || !!retry(),
        { timeoutMs: roundTimeoutMs },
      );
      const c = count(), f = firstId();
      if (c === lastCount && f === lastFirst) {
        if (q(S.LOADER, log)) {
          await AREX.waitFor(() => !q(S.LOADER, log) || !!retry(), { timeoutMs: roundTimeoutMs });
          continue; // a load finished without change → re-evaluate next round
        }
        stagnant++;
      } else {
        stagnant = 0;
        lastCount = c; lastFirst = f;
      }
    }
    await AREX.settle(log, { quietMs: 300 });
    return { messages: count(), stable: stagnant >= 3 };
  };
})();
