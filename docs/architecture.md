# Architecture — Arena Transcript Export (Chrome extension, MV3)

Goal: one-click export of the **current Arena.ai agent branch** to a single `.md` file: full history
(pagination force-loaded), every spoiler expanded (reasoning/tool groups, nested), canonical
Markdown; sidebar, right preview panel and composer excluded.

Research evidence: `docs/research/arena-page-analysis.md`.

## Shape

Plain MV3 extension, no build step, zero runtime deps (custom ~200-line HTML→MD converter).
Dev-only deps: jsdom (saved transcript fixture) and fake-indexeddb (transaction tests).

```
extension/
  manifest.json            MV3: content scripts on https://arena.ai/agent/*, perms downloads+storage+scripting
  popup/popup.html|.js      UI: persistent preview, compression modes, progress, download/retake
  popup/compress-worker.js  one indexed snapshot + cached compression modes off the UI thread
  background.js            export coordinator, IndexedDB persistence and toolbar indicator
  shared/result-store.js   IndexedDB persistence for the latest raw Markdown snapshot
  content/selectors.js     AREX.S — all DOM queries in one place (page churn containment)
  content/util.js          mutation waits, scoped settle, cooperative yields, text extraction, slug
  content/loader.js        1️⃣ history gate: sentinel + mutation-driven page loading
  content/expand.js        2️⃣ scoped spoiler expansion and cleanup
  content/markdown.js      HTML → Markdown (block-level recursive)
  content/serialize.js     3️⃣ zero-clone, cooperative message walk → Markdown
  content/compress.js      deterministic Lossless/Smart/Stubs transforms + UTF-8/token metrics
  content/main.js          tab-resident window pipeline + reconnectable status/result API
```

Content scripts run in the isolated world and only touch the DOM; no `page JS` access needed.
All scripts share one global namespace `AREX` (manifest load order = init order).

## Pipeline (per export request)

```
EXPORT_START → load history (sentinel + MutationObserver)
             → for each window of ≤4 messages:
                  expand its spoilers → settle local DOM → serialize each message
                  → close only the spoilers opened by this export
             → background saves Markdown to IndexedDB → popup preview / download
```

1. **History gate** (`loader.js`). Scroll the Arena sentinel into view and observe mutations
   instead of polling. Once Arena unmounts its sentinel and boundary, finish without extra quiet
   rounds; an initially marker-free view receives a short 150 ms probe. If pagination is observed
   on an older marker-free page, use the legacy quiet-round fallback. A stuck loader or a still
   mounted sentinel when the retry limit is reached results in an incomplete-history warning.
   Because initial marker absence is indistinguishable from an old implementation that starts
   loading silently after the probe, the latter remains a compatibility limitation.
2. **Windowed spoiler processing** (`expand.js`, `main.js`). Expand only the current four
   messages, in batches, and observe their local DOM with attributes ignored. Serialize the
   window, then close only controls this export opened, in reverse order, even on error or cancel.
   Already-open controls remain open. Message identity/order is checked during processing to avoid
   silently exporting a branch which unloaded messages.
3. **Serialization** (`serialize.js` + `markdown.js`). Walk messages in order without cloning
   mounted panels; the synchronous compatibility API and cooperative async walker share the same
   rendering logic. The async walker yields on a ~20 ms budget between DOM nodes, using
   `scheduler.yield` or `MessageChannel` when available, and reports processed messages and bytes.
   Individual large text/code conversion operations still run synchronously.

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

The popup sends the raw snapshot once to `popup/compress-worker.js`, which builds a single
`BlockIndex` and caches each computed mode. `content/compress.js` works in both window and worker
contexts; transforms edit indexed blocks and assemble the output once per mode. The UI ignores
stale mode/snapshot replies and downloads the prepared result without recompression. If the worker
is unavailable or fails, a local fallback keeps exports usable but can block the popup temporarily.
Neither path revisits the Arena DOM or repeats history paging / spoiler expansion.

- **Lossless:** exact duplicate fenced tool/file outputs are anchored once; later copies become links.
- **Smart:** strips terminal ANSI/progress noise, folds runs of at least six recognised passing-test
  lines, and keeps the head/tail of very large clean stdout blocks. Error-signalled output is never
  head/tail-truncated.
- **Stubs:** when the same file appears more than once, earlier large reads or overwritten heredoc
  writes become four-line previews with an explicit superseded marker. The latest is not stubbed,
  but Smart may still shorten a long clean output. Simple `cat`, `sed -n`, `head`, `tail`, and `nl`
  commands are paired with their own stdout; ambiguous shell expressions are left unclassified.
- The size card uses the final download Blob's exact byte length, displays exact UTF-8 bytes
  plus decimal KB/MB, an approximate multilingual token count, and savings against raw Markdown.
  Finder's “size on disk” is a separate filesystem allocation figure. The token estimator is
  deliberately lightweight and is not a model-specific tokenizer.
- Each stage has a monotonicity guard: output cannot exceed the previous mode in UTF-8 bytes.
- The latest raw snapshot is persisted in extension IndexedDB, outside the popup's short-lived
  JavaScript memory. Reopening the popup restores it; the user can download again or retake it.
- The content script owns the task and retains up to 500 progress events plus the completed
  result in the Arena tab memory until the background worker saves it. Closing the popup disconnects
  only the UI port; it does not cancel the task. A reopened popup requests status, replays retained
  progress, and loads the saved snapshot if the scan has completed.
- The content script keeps the raw result until the background worker confirms a successful write to
  extension IndexedDB. If persistence fails, the result remains available in worker memory for popup
  recovery while that worker stays alive. If its port disconnects, the content script retries up to
  five times and resends any unacknowledged result; exhausted retries require a fresh snapshot.
- Result chunks must have unique consecutive sequence numbers and match the declared UTF-8 byte
  length. Invalid, incomplete or oversized transfers fail without an ACK or partial IndexedDB write.
  The size guard limits the assembled transfer to 64 Mi UTF-16 code units, not UTF-8 bytes.

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
| Huge branches (RAM, message-size limits) | hidden content is expanded in four-message windows and exporter-opened panels are closed after each window; the background worker saves the raw snapshot in IndexedDB |
| Popup closes during scan | task survives while the Arena tab remains open; popup reconnects and restores progress/result; closing or reloading the Arena tab ends the task |
| i18n of "Loading earlier messages" | status text is matched explicitly; keep it aligned with the active Arena locale |

## Testing

`npm test` (node:test + jsdom): markdown converter cases; serializer over the saved transcript
fixture (546 KB, 9 messages) asserting message order/roles, fences, exclusion of sidebar/panel
artifacts; loader/expander loops against synthetic DOMs that emulate Arena's mount-on-click and
prepend-on-scroll behavior with fake timers; popup-port reconnect tests cover scan continuation,
progress replay, result delivery and acknowledgement; fake IndexedDB verifies shared storage and
transaction behavior, and `npm run benchmark` records scoped fixture/token/compression measurements.
See `docs/performance-results.md` for methodology, limitations and measured results.
