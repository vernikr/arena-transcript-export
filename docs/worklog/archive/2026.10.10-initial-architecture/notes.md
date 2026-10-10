# 2026.10.10 — initial architecture & implementation

## Task
Design + build a Chrome extension exporting the current Arena.ai agent branch to Markdown with
all spoilers (reasoning, tool runs) pre-expanded, sidebar/preview panel excluded; verify the
suspected old-message unloading behavior; private GitHub repo.

## Research (inputs: user-provided saved page + its JS bundles)
- Confirmed paging: transcript loads 20-message cursor pages; earlier pages mount via a top
  sentinel (IntersectionObserver, rootMargin 200px) + "Load earlier messages" retry on error.
- No DOM windowing found (no virtualizer, no slice-based rendering) → loaded messages persist.
- Collapsed spoilers are fully unmounted from the DOM → expansion loop is mandatory; groups
  mount nested collapsed items → iterative passes.
- Stable selectors identified (`[role=log]`, `[data-agent-transcript-message]`,
  `[data-user-message-layout]`, `button[aria-expanded]`, panels `style*="overflow: clip"`).

## Decisions
- MV3, no build step, zero runtime deps (custom HTML→MD converter), classic content scripts
  sharing one `AREX` namespace; popup (options+progress+download) ↔ content via Port;
  in-page `<a download>` fallback if popup closes.
- DOM-based export (not the private JSON API): WYSIWYG parity with the UI, covers render-only
  blocks; API kept as a fallback idea if DOM scraping degrades.

## Verification
- 24 unit tests (node:test + jsdom) green: converter cases, serializer over the real 546 KB
  transcript fixture (snapshot-locked), loader/expander loops on behavior-emulated DOMs.
- Fixture serializer output eyeballed end-to-end: roles/order, nested headings, labeled fences,
  artifact document conversion, footer/sidebar residue absence.

## Follow-ups (not blocking)
- Live-run on arena.ai is the final check (selectors/options UI); sandbox has no browser.
- If Arena ships real message windowing: abort logic already in place; then serialize
  incrementally while force-loading.
