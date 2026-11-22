# Architecture — Arena Transcript Export (Chrome extension, MV3)

Goal: one-click export of the **current Arena.ai agent branch** to a single `.md` file: full history
(pagination force-loaded), every spoiler expanded (reasoning/tool groups, nested), canonical
Markdown; sidebar, right preview panel and composer excluded.

Research evidence: `docs/research/arena-page-analysis.md`.

## Shape

Plain MV3 extension, no build step, zero runtime deps (custom ~200-line HTML→MD converter).
Dev-only dep: jsdom (unit tests against a saved transcript fixture).

```
extension/
  manifest.json            MV3: content scripts on https://arena.ai/agent/*, perms downloads+storage+scripting
  popup/popup.html|.js      UI: persistent preview, compression modes, progress, download/retake
  background.js            export coordinator, IndexedDB persistence and toolbar indicator
  shared/result-store.js   IndexedDB persistence for the latest raw Markdown snapshot
  content/selectors.js     AREX.S — all DOM queries in one place (page churn containment)
  content/util.js          sleep, settle (MutationObserver quiet window), text extraction, slug
  content/loader.js        1️⃣ history gate: force-load earlier pages via scroll-to-top
  content/expand.js        2️⃣ spoiler gate: click-expand loop until zero collapsed
  content/markdown.js      HTML → Markdown (block-level recursive)
  content/serialize.js     3️⃣ message walk: roles, activity items, code cards → md
  content/compress.js      deterministic Lossless/Smart/Stubs transforms + UTF-8/token metrics
  content/main.js          tab-resident orchestrator + reconnectable status/result API
```

Content scripts run in the isolated world and only touch the DOM; no `page JS` access needed.
All scripts share one global namespace `AREX` (manifest load order = init order).

## Pipeline (per export request)

```
EXPORT_START ─▶ page ready ─▶ 1 loadFullHistory ─▶ 2 expandAllSpoilers ─▶ 3 serialize
                  │                 │                      │                    │
        on /agent/* page?    scroll top until        until no            raw Markdown
        [role=log] ready     message count/          button[aria-              │
                             first-id stable ×N      expanded=false]    popup size preview
                             (+ retry button)        remains (nested)    + compression
                                                                                │
                                                        IndexedDB snapshot ←───┤
                                                                                │
                                                    download selected / retake
```

1. **History gate** (`loader.js`). Arena pages the transcript (20/turn page, earlier pages mount
   above on demand — see research). Loop: `log.scrollTo({top:0})` → the top sentinel's
   IntersectionObserver (rootMargin 200px) fires `loadEarlierMessages`; wait (≤8 s) for the message
   count or the first message id to change; click the "Load earlier messages" retry button if the
   loader failed; only the matching loading-status text counts as an active request; finish after 2
   quiet rounds (windows are short: sub-page branches — likely the
   server's non-paged "compat" mode — get quick rounds, so a fully-loaded branch is confirmed in
   ~2–3 s instead of waiting out long timeouts).
2. **Spoiler gate** (`expand.js`). Collapsed spoilers don't exist in the DOM (unmounted, not
   hidden), and groups mount nested collapsed children when opened → iterative passes:
   click `button[aria-expanded="false"]` inside `div[role="log"]` in batches of 25, yielding
   between batches so the page can render and report progress; avoid a computed-style read per
   button. Wait for the DOM to settle (MutationObserver quiet ≥250 ms, cap 3 s), then repeat.
   Stop on an empty pass; bail with a warning if a pass makes no progress (stuck/disabled buttons).
   Message count is re-checked after each pass — a change signals unexpected remounting (future
   windowing) and aborts export loudly. Keep the references to buttons opened by this run.
3. **Serialization** (`serialize.js` + `markdown.js`). Order-preserving walk over
   `[data-agent-transcript-message]`, role by presence of `[data-user-message-layout]`.
   Everything stays inside `[role="log"]` ⇒ sidebar/preview/composer never enter the output.

### DOM → Markdown mapping

| DOM (inside log)                                             | Markdown |
|---|---|
| message wrapper (user)                                       | `## 👤 User` (+ `📎 **Attached:** …` chips) |
| message wrapper (assistant)                                  | `## 🤖 Assistant` |
| `.prose`                                                     | converted HTML→MD (headings, lists, code, tables, links) |
| activity header `button[aria-expanded]` text                 | `#### used Bash — 143ms` (nested → one level deeper each, min heading 6, then indents) |
| labeled card (`command`/`stdout`/`stderr` + `pre`)           | `**command:**` + fenced block (`command`→` ```bash `, others ` ```text `) |
| file chip `[role="button"]` + preview (`SHELLSCRIPT`,`MD`,…) | `**📄 name**` + fenced block, lang mapped, `.select-none` gutter stripped |
| leaf row in panel ("Read x.sh")                              | `- Read x.sh` |
| footer (Copy/time/duration)                                  | skipped; optional `*4:49 PM*` with `timestamps: true` |

Fence size auto-extends when content contains backticks. Option `includeToolActivity: false`
exports prose only (spoilers then skipped entirely). After serialization, the exporter closes only
the spoiler controls it opened, in reverse order, so nested DOM panels are unmounted and memory can
be reclaimed; spoilers that were already open before export remain open.

## Compression preview

The popup prepares the raw transcript once, then keeps that Markdown in memory while the user
switches compression modes. `content/compress.js` applies the deterministic transforms locally;
it does not revisit the Arena DOM or repeat history paging / spoiler expansion.

- **Lossless:** exact duplicate fenced tool/file outputs are anchored once; later copies become links.
- **Smart:** strips terminal ANSI/progress noise, folds runs of at least six recognised passing-test
  lines, and keeps the head/tail of very large clean stdout blocks. Error-signalled output is never
  head/tail-truncated.
- **Stubs:** when the same file appears more than once, earlier large snapshots become four-line
  previews with an explicit superseded-read marker; the last snapshot stays complete.
- The size card uses the final download Blob's exact byte length, displays exact UTF-8 bytes
  plus decimal KB/MB, an approximate multilingual token count, and savings against raw Markdown.
  Finder's “size on disk” is a separate filesystem allocation figure. The token estimator is
  deliberately lightweight and is not a model-specific tokenizer.
- A monotonicity guard falls back to raw Markdown if a selected transform would increase file size.
- The latest raw snapshot is persisted in extension IndexedDB, outside the popup's short-lived
  JavaScript memory. Reopening the popup restores it; the user can download again or retake it.
- The content script owns the task and retains up to 500 progress events plus the completed
  result in the Arena tab memory until the background worker saves it. Closing the popup disconnects
  only the UI port; it does not cancel the task. A reopened popup requests status, replays retained
  progress, and loads the saved snapshot if the scan has completed.
- The content script keeps the raw result until the background worker confirms a successful write to
  extension IndexedDB. If persistence fails, the result remains available for a later popup session.

## Delivery & UX details

- The Arena tab keeps the run alive independently of the popup; result string → popup creates blob URL →
  `chrome.downloads.download({ saveAs: true })`, filename
  `arena-<slug(branch title|uuid)>-<YYYYMMDD-HHmm>.md`.
- The popup follows `prefers-color-scheme` with native-Chrome tokens and renders a staged
  progress log (`ul#log`): one line per stage (history / expand / serialize / cleanup), spinner → ✓,
  granular counters from pipeline events (history pages and message counts, per-pass spoiler
  counts, final markdown bytes) and an ok/warn summary. Options persist via `chrome.storage.sync`.
- Progress is emitted by every pipeline stage over the port and retained in the tab; reconnecting
  popups receive a status snapshot plus the retained event list. The loader reports
  scan/page(+delta)/loading/settle/retry phases so the first (history) stage never sits silently.
- Export is allowed while the agent is generating. The file contains the DOM state read during serialization; later generated content requires another export.
- Toolbar icon is theme-adaptive: Lucide `file-down` glyph (stroke `#5f6368` light / `#c7c7c7`
  dark) rasterized per size to PNG. MV3 service workers have no `matchMedia`, so the theme is
  probed in window contexts (`content/theme.js` on arena.ai pages + the popup on open) and
  bridged to `background.js` via messages; the value is cached in `chrome.storage.local` so the
  correct icon is restored on service-worker restart/browser startup. Manifest `icons`
  (management page, not runtime-adaptable) use a neutral `#80868b` set readable on any card
  theme. Sources live as themed SVGs in `extension/icons/`.
- The toolbar indicator renders cached theme-specific PNGs with `OffscreenCanvas` for active,
  completed and failed jobs. It uses a single 180 ms timer only while at least one job is running;
  running takes precedence over unseen errors and successes. Terminal notifications are persisted
  in session storage and cleared on popup open. Badge text and title show stage/counters; known
  percentages are shown when available, while history uses an indeterminate spinner.
- Distribution: git tag `v*` → `release.yml` zips `extension/` and uploads
  `arena-transcript-export-<tag>.zip` to the GitHub Release (`--clobber`); `ci.yml` runs
  `npm test` on every push. Users install the release zip as an unpacked extension.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Tailwind class churn (`prose`, `max-w-3xl`, card colors) | depend on stable data/aria hooks only; classes used solely within fixture-tested heuristics with fallbacks |
| Arena adds DOM windowing later | abort if message count shrinks mid-run; research shows none today |
| Unknown activity block types (plans, diffs, reasoning variants) | generic fallbacks: labeled-card, any-`pre`, text-row; headers are free-text |
| Huge branches (RAM, message-size limits) | expansion is still needed for hidden content; process in batches, then close exporter-opened panels immediately after serialization; the background worker saves the raw snapshot in IndexedDB |
| Popup closes during scan | task survives while the Arena tab remains open; popup reconnects and restores progress/result; closing or reloading the Arena tab ends the task |
| i18n of "Loading earlier messages" | status text is matched explicitly; keep it aligned with the active Arena locale |

## Testing

`npm test` (node:test + jsdom): markdown converter cases; serializer over the saved transcript
fixture (546 KB, 9 messages) asserting message order/roles, fences, exclusion of sidebar/panel
artifacts; loader/expander loops against synthetic DOMs that emulate Arena's mount-on-click and
prepend-on-scroll behavior with fake timers; popup-port reconnect tests cover scan continuation,
progress replay, result delivery and acknowledgement.
