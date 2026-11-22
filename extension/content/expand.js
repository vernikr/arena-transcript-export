// Spoiler gate: click-expand every collapsed section inside the transcript.
// Collapsed spoilers have no DOM content; groups mount nested collapsed items when opened,
// so passes repeat until nothing collapsible remains.
window.AREX = window.AREX || {};

(function () {
  const S = AREX.S;

  AREX.expandAllSpoilers = async function (log, { onProgress, maxPasses = 60, batchSize = 10 } = {}) {
    let expanded = 0, passes = 0, stuck = [];
    let msgCount = AREX.messages(log).length;

    for (; passes < maxPasses; passes++) {
      const collapsed = AREX.qq(S.COLLAPSED, log).filter(b => {
        if (!b.isConnected) return false;
        const cs = typeof getComputedStyle === 'function' ? getComputedStyle(b) : null;
        return !cs || (cs.display !== 'none' && cs.visibility !== 'hidden');
      });
      if (!collapsed.length) return { expanded, stuck };

      let clicked = 0, openedThisPass = 0;
      for (let i = 0; i < collapsed.length; i++) {
        const button = collapsed[i];
        if (button.isConnected && button.getAttribute('aria-expanded') === 'false') {
          try { button.click(); clicked++; openedThisPass++; expanded++; } catch { /* detached mid-pass */ }
        }
        if ((i + 1) % batchSize === 0 || i === collapsed.length - 1) {
          onProgress?.({ stage: 'expand', phase: 'click', pass: passes + 1, clicking: clicked, openedThisPass, total: collapsed.length, expanded });
          await AREX.sleep(0);
          clicked = 0;
        }
      }
      await AREX.settle(log);
      onProgress?.({ stage: 'expand', phase: 'settle', pass: passes + 1, expanded });

      const now = AREX.messages(log).length;
      if (now < msgCount)
        throw new Error(`Page unloaded messages during export (${msgCount}→${now}); aborting to avoid a partial file.`);
      msgCount = now;

      stuck = collapsed.filter(b => b.isConnected && b.getAttribute('aria-expanded') === 'false');
      if (stuck.length === collapsed.length) break; // no progress (disabled/control-frozen)
    }
    return { expanded, stuck };
  };
})();
