// Synthetic large Arena transcript shared by scripts/benchmark-large-page.mjs and
// test/large-page-stress.test.mjs. Deterministic: no randomness, no wall-clock input.
//
// Shape: `messages` assistant turns, each with one group spoiler ("Used 19 tools")
// whose panel mounts `leavesPerGroup` leaf spoilers ("Used Bash"), each leaf
// mounting a chunked stdout <pre>. Collapsed controls are unmounted, like Arena.
import { makeEnv } from './harness.mjs';

export const DEFAULTS = Object.freeze({
  messages: 120,
  leavesPerGroup: 19,        // 1 group + 19 leaves = 20 spoilers per turn
  stdoutChunks: 3,
  windowSize: 4,
});

export const PANEL_STYLE = 'overflow: clip; height: auto; opacity: 1';

// Stable per-turn marker text so a Markdown export can be checked for exact message coverage.
export const markerFor = index => `Turn marker ${String(index).padStart(3, '0')}`;

export function largePageHtml(opts = {}) {
  const { messages, leavesPerGroup } = { ...DEFAULTS, ...opts };
  const turns = [];
  for (let i = 0; i < messages; i += 1) {
    const leaves = [];
    for (let j = 0; j < leavesPerGroup; j += 1) {
      leaves.push(`<div><button aria-expanded="false" data-leaf="${i}-${j}">Used Bash ${j + 1}ms</button></div>`);
    }
    turns.push(
      `<div data-agent-transcript-message="true" data-chat-message-id="turn-${i}">` +
        `<div class="prose"><p>${markerFor(i)}</p></div>` +
        `<div><button aria-expanded="false" data-group="${i}">Used ${leavesPerGroup} tools</button>` +
        `<!--leaves:${leaves.join('')}--></div>` +
      `</div>`,
    );
  }
  return `<div role="log">${turns.join('')}</div>`;
}

// Attach Arena-like toggle behaviour. Opening mounts the panel as a sibling of the
// button; closing unmounts it (and with it, every nested spoiler inside).
// `onClick(button, opening)` is an optional hook for counting and fault injection.
export function wireSpoilers(document, { onClick } = {}) {
  let clicks = 0;
  const stats = { clicks: 0, opened: 0, closed: 0 };
  const openPanel = (button, html) => {
    const panel = document.createElement('div');
    panel.setAttribute('style', PANEL_STYLE);
    panel.innerHTML = html;
    button.parentElement.append(panel);
    wireAll(panel);
  };
  function toggle(button) {
    clicks += 1; stats.clicks += 1;
    const opening = button.getAttribute('aria-expanded') === 'false';
    onClick?.(button, opening);
    button.setAttribute('aria-expanded', String(opening));
    if (opening) {
      stats.opened += 1;
      if (button.dataset.group !== undefined) {
        const comment = button.parentElement.childNodes;
        const leafHtml = [...comment].find(n => n.nodeType === 8)?.nodeValue.replace(/^leaves:/, '') ?? '';
        openPanel(button, leafHtml);
      } else if (button.dataset.leaf !== undefined) {
        openPanel(button, `<div><span>command</span><pre>$ run ${button.dataset.leaf}</pre></div>` +
          `<div><span>stdout</span><pre>${'line of output\n'.repeat(4)}</pre></div>`);
      }
    } else {
      stats.closed += 1;
      button.parentElement.querySelector(`:scope > [style="${PANEL_STYLE}"]`)?.remove();
    }
  }
  function wireAll(root) {
    for (const button of root.querySelectorAll('button[aria-expanded]')) {
      if (button.dataset.wired) continue;
      button.dataset.wired = '1';
      button.addEventListener('click', () => toggle(button));
    }
  }
  wireAll(document);
  return { stats, clicks: () => clicks, wireAll };
}

// Build a fresh jsdom page for the large transcript. Returns the AREX env, the log,
// the spoiler stats, and a settle recorder with a bounded quiet/max window so that
// real settle() semantics stay in place but jsdom runs in benchmark time.
export function buildLargePage(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const env = makeEnv({ html: largePageHtml(cfg), url: 'https://arena.ai/agent/large-page' });
  const { document, AREX } = env;
  const log = document.querySelector('[role="log"]');
  // Comments hold the hidden leaf markup; restore it into the DOM as collapsed leaves
  // only when the group opens (handled by wireSpoilers).
  const spoilers = wireSpoilers(document, { onClick: cfg.onClick });
  const settleSamples = [];
  const realSettle = AREX.settle;
  AREX.settle = (root, o = {}) => {
    const t0 = performance.now();
    const cap = cfg.settleMaxMs ?? 3000;
    return realSettle(root, {
      ...o,
      quietMs: Math.min(o.quietMs ?? 250, cfg.settleQuietMs ?? 10),
      maxMs: Math.min(o.maxMs ?? 3000, cap),
    }).then(() => { settleSamples.push({ ms: performance.now() - t0, cap }); });
  };
  return { ...env, log, spoilers, settleSamples, cfg };
}

export const totalSpoilers = cfg => cfg.messages * (1 + cfg.leavesPerGroup);

// Continuous token churn in the final turn's prose, as while Arena streams a reply.
// Mutations are text-only, so settle() must ignore them (see AREX._isStreamingMutation).
export function startTailStreaming(document, { intervalMs = 2 } = {}) {
  const turns = document.querySelectorAll('[data-agent-transcript-message]');
  const prose = turns[turns.length - 1].querySelector('.prose');
  const token = document.createElement('span');
  token.className = 'tail-token';
  prose.append(token);
  let tokens = 0;
  const timer = setInterval(() => { token.textContent = ` tok${tokens += 1}`; }, intervalMs);
  return { tokens: () => tokens, stop: () => clearInterval(timer) };
}
