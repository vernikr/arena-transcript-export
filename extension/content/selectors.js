// AREX shared namespace + all page DOM queries (single point of churn control).
window.AREX = window.AREX || {};

AREX.S = {
  LOG: 'div[role="log"]',                       // transcript scroll container
  MSG: '[data-agent-transcript-message]',       // one turn (user or assistant)
  MSG_ID: 'data-chat-message-id',
  USER: '[data-user-message-layout]',
  PROSE: '.prose',
  COLLAPSED: 'button[aria-expanded="false"]',   // closed spoiler (content unmounted)
  EXPANDABLE: 'button[aria-expanded]',          // spoiler header, any state
  PANEL: 'div[style*="overflow: clip"]',        // mounted spoiler content
  CARD_LABELS: ['command', 'stdout', 'stderr'], // uppercase chips on tool cards
  CARD_PRE: 'pre',
  FILE_CHIP: '[role="button"]',                 // file chip row (name + lang badge, click = preview panel)
  SKIP_GUTTER: '.select-none',                  // line-number gutter inside code previews
  ATTACH_NAME: 'span.truncate',
  FOOTER_COPY: 'button[aria-label="Copy"]',
  TIME: 'time',
  LOADER: '[role="status"]',                    // "Loading earlier messages" spinner
  RETRY_TEXT: /load earlier messages/i,         // error-state retry (lang-dependent recovery only)
  STREAMING: 'button[aria-label="Stop generating"]',
  OPEN_FILE: 'button[aria-label="Open file"]',
};

AREX.q = (sel, root = document) => root.querySelector(sel);
AREX.qq = (sel, root = document) => [...root.querySelectorAll(sel)];
AREX.logEl = () => AREX.q(AREX.S.LOG);
AREX.messages = log => AREX.qq(AREX.S.MSG, log);
