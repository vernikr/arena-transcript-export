// Spoiler gate: expand every collapsed section, then close only the sections
// opened by this export after serialization has captured their content.
window.AREX = window.AREX || {};

(function () {
  const S = AREX.S;

  AREX.expandAllSpoilers = async function (log, { onProgress, maxPasses = 60, batchSize = 25, roots = [log], openedButtons = [], settleOptions, cooperative = false } = {}) {
    let expanded = 0, passes = 0, stuck = [];
    let msgCount = AREX.messages(log).length;

    for (; passes < maxPasses; passes++) {
      // Collapsed spoiler controls are the visible mounted representatives; their child
      // panels are unmounted while collapsed. Skip per-button computed-style reads here.
      const collapsed = roots.flatMap(root => AREX.qq(S.COLLAPSED, root)).filter(button =>
        button.isConnected && button.getAttribute('aria-expanded') === 'false'
      );
      if (!collapsed.length) return { expanded, stuck, openedButtons };

      let clicked = 0, openedThisPass = 0;
      for (let i = 0; i < collapsed.length; i += 1) {
        const button = collapsed[i];
        if (button.isConnected && button.getAttribute('aria-expanded') === 'false') {
          try {
            button.click();
            clicked += 1;
            openedThisPass += 1;
            expanded += 1;
            openedButtons.push(button);
          } catch { /* detached mid-pass */ }
        }
        if ((i + 1) % batchSize === 0 || i === collapsed.length - 1) {
          onProgress?.({ stage: 'expand', phase: 'click', pass: passes + 1, clicking: clicked, openedThisPass, total: collapsed.length, expanded });
          await (cooperative ? AREX.yieldToMain() : AREX.sleep(0));
          clicked = 0;
        }
      }
      await Promise.all(roots.map(root => AREX.settle(root, settleOptions)));
      onProgress?.({ stage: 'expand', phase: 'settle', pass: passes + 1, expanded });

      const now = AREX.messages(log).length;
      if (now < msgCount)
        throw new Error('Page unloaded messages during export (' + msgCount + '→' + now + '); aborting to avoid a partial file.');
      msgCount = now;

      stuck = collapsed.filter(button => button.isConnected && button.getAttribute('aria-expanded') === 'false');
      if (stuck.length === collapsed.length) break;
    }
    return { expanded, stuck, openedButtons };
  };

  AREX.collapseOpenedSpoilers = async function (openedButtons, { onProgress, batchSize = 25, roots, cooperative = false } = {}) {
    let closed = 0;
    let attempted = 0;
    for (let i = openedButtons.length - 1; i >= 0; i -= 1) {
      const button = openedButtons[i];
      attempted += 1;
      if (button.isConnected && button.getAttribute('aria-expanded') === 'true') {
        try {
          button.click();
          closed += 1;
        } catch { /* detached while its parent was collapsed */ }
      }
      if (attempted % batchSize === 0 || i === 0) {
        onProgress?.({ stage: 'cleanup', phase: 'close', closed, total: openedButtons.length });
        await (cooperative ? AREX.yieldToMain() : AREX.sleep(0));
      }
    }
    const log = AREX.logEl();
    if (closed && (roots?.length || log)) await Promise.all((roots || [log]).map(root => AREX.settle(root, { quietMs: 100, maxMs: 1500, attributes: false })));
    return { closed };
  };
})();