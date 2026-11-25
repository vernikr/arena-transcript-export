// Spoiler gate: expand every collapsed section, then close only the sections
// opened by this export after serialization has captured their content.
window.AREX = window.AREX || {};

(function () {
  const S = AREX.S;

  const depthOf = el => {
    let depth = 0;
    for (let p = el.parentElement; p; p = p.parentElement) depth += 1;
    return depth;
  };

  // Mounted panels are siblings of their toggle inside the same wrapper.
  const panelsOf = button => {
    const parent = button.parentElement;
    if (!parent) return [];
    return AREX.qq(S.PANEL, parent).filter(panel => panel.parentElement === parent);
  };

  const describeStuck = button => ({
    messageId: button.closest(S.MSG) ? AREX.msgId(button.closest(S.MSG)) : '',
    header: AREX.text(button).slice(0, 120),
  });

  // Watch the outermost wrappers actually opened in this pass instead of the
  // whole log: streaming text elsewhere in the branch cannot stall a pass.
  const settleRootsFor = (roots, openedButtons) => {
    const wrappers = new Set();
    for (const button of openedButtons) {
      const wrapper = button.parentElement;
      if (button.isConnected && wrapper && roots.some(root => root === wrapper || root.contains(wrapper)))
        wrappers.add(wrapper);
    }
    const all = [...wrappers];
    return all.length ? all.filter(w => !all.some(other => other !== w && other.contains(w))) : roots;
  };

  const settleExpansion = (roots, openedButtons, settleOptions) => {
    const custom = settleOptions?.ignorePredicate;
    const options = {
      ...settleOptions,
      ignorePredicate: record => {
        if (typeof custom === 'function' && custom(record) === true) return true;
        const el = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        // Token streams in prose outside a mounted panel are not spoiler work.
        return Boolean(el?.closest(S.PROSE) && !el.closest(S.PANEL));
      },
    };
    return Promise.all(settleRootsFor(roots, openedButtons).map(root => AREX.settle(root, options)));
  };

  AREX.expandAllSpoilers = async function (log, { onProgress, maxPasses = 60, batchSize = 25, roots = [log], openedButtons = [], settleOptions, cooperative = false, stuckSampleLimit = 10 } = {}) {
    let expanded = 0, passes = 0, stuck = [], stuckSamples = [];
    let msgCount = AREX.messages(log).length;

    const finish = () => ({ expanded, stuck, stuckSamples, openedButtons });
    const recordStuck = () => {
      stuckSamples = stuck.slice(0, stuckSampleLimit).map(describeStuck);
    };

    for (; passes < maxPasses; passes++) {
      // Collapsed spoiler controls are the visible mounted representatives; their child
      // panels are unmounted while collapsed. Skip per-button computed-style reads here.
      const collapsed = roots.flatMap(root => AREX.qq(S.COLLAPSED, root)).filter(button =>
        button.isConnected && button.getAttribute('aria-expanded') === 'false'
      );
      if (!collapsed.length) return finish();

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
      const openedThisRound = openedThisPass ? openedButtons.slice(-openedThisPass) : [];
      await settleExpansion(roots, openedThisRound, settleOptions);
      onProgress?.({ stage: 'expand', phase: 'settle', pass: passes + 1, expanded });

      const now = AREX.messages(log).length;
      if (now < msgCount)
        throw new Error('Page unloaded messages during export (' + msgCount + '→' + now + '); aborting to avoid a partial file.');
      msgCount = now;

      stuck = collapsed.filter(button => button.isConnected && button.getAttribute('aria-expanded') === 'false');
      if (stuck.length === collapsed.length) break;
    }
    recordStuck();
    return finish();
  };

  AREX.collapseOpenedSpoilers = async function (openedButtons, { onProgress, batchSize = 25, roots, cooperative = false } = {}) {
    const buttons = [...new Set(openedButtons)].filter(button => button && button.isConnected);
    const total = openedButtons.length;
    const active = new Set(buttons);
    const panelOwners = new Map();
    for (const button of buttons) for (const panel of panelsOf(button)) panelOwners.set(panel, button);

    const hasOpenedAncestor = button => {
      for (let el = button.parentElement; el; el = el.parentElement) {
        if (el !== button && active.has(el)) return true;
        const owner = panelOwners.get(el);
        if (owner && owner !== button && active.has(owner)) return true;
      }
      return false;
    };

    // Outermost first: one group click unmounts the whole nested subtree in a
    // single React commit instead of one click+re-render per child.
    const ordered = buttons.slice().sort((a, b) =>
      depthOf(a) - depthOf(b) || ((a.compareDocumentPosition(b) & 4) ? -1 : 1));

    let closed = 0, pruned = 0, attempted = 0;
    const prunedButtons = [];
    const report = () => onProgress?.({ stage: 'cleanup', phase: 'close', closed, pruned, total });
    for (const button of ordered) {
      attempted += 1;
      if (button.getAttribute('aria-expanded') === 'true') {
        if (hasOpenedAncestor(button)) {
          // Count children removed by an ancestor click even after they detach:
          // progress must explain why 81 opened controls took a single click.
          pruned += 1;
          prunedButtons.push(button);
        } else if (button.isConnected) {
          try {
            button.click();
            if (!button.isConnected || button.getAttribute('aria-expanded') !== 'true') closed += 1;
          } catch { /* detached while its parent was collapsed */ }
        }
      }
      if (attempted % batchSize === 0 || attempted === ordered.length) {
        report();
        await (cooperative ? AREX.yieldToMain() : AREX.sleep(0));
      }
    }

    // An ancestor may be a sibling wrapper rather than a controlling panel;
    // close whichever pruned controls survived so no panel leaks open.
    for (const button of prunedButtons) {
      if (button.isConnected && button.getAttribute('aria-expanded') === 'true') {
        try {
          button.click();
          if (!button.isConnected || button.getAttribute('aria-expanded') !== 'true') {
            closed += 1;
            pruned -= 1;
          }
        } catch { /* detached meanwhile */ }
      }
    }
    report();

    const log = AREX.logEl();
    if (closed && (roots?.length || log)) await Promise.all((roots || [log]).map(root => AREX.settle(root, { quietMs: 100, maxMs: 1500, attributes: false })));
    return { closed, pruned, total };
  };
})();
