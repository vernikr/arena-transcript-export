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
  content/serialize.js     3️⃣ zero-clone, zero-generator iterative walk → Markdown
  content/compress.js      deterministic Lossless/Smart/Stubs transforms + UTF-8/token metrics
  content/compress-stubs.js  Stubs v2: path-agnostic content-defined line deduplication
  content/profile.js       bounded, zero-I/O profiling recorder for one export run
  content/main.js          tab-resident window pipeline + reconnectable status/result API
  dev-reload.js            dev-only: reload every profile when dev-version.txt changes
```

Content scripts run in the isolated world and only touch the DOM; no `page JS` access needed.
All scripts share one global namespace `AREX` (manifest load order = init order).

## Profiling log

`content/profile.js` records one bounded, JSON-serializable profile per export: phase timings
(`history`, `expand`, `cleanup`, `process`), per-message timing aggregates (count, mean, p95, max,
slowest message index), per-window records for the slowest windows only (capped, the rest is
counted), Chromium heap samples (best-effort), a short milestone event list, and per-run totals.
It performs no I/O or timers during the run — only `performance.now()` and small object pushes —
and writes one JSON document at the end (hard-capped at 128 KiB), so it stays cheap on very large
pages and the resulting log is easy for an agent to triage. Profiling is enabled by default; the
popup's **Performance profiling** option disables it for the run (`options.profile: false`). The
profile is persisted by the background worker next to the snapshot (`latest-profile`,
`result-store.js`) and surfaced in the popup alongside the snapshot.

## Pipeline (per export request)

```
EXPORT_START → load history (sentinel + MutationObserver)
             → for each window of ≤4 messages:
                  expand its spoilers → settle local DOM → serialize each message
                  → close only the spoilers opened by this export
             → background saves Markdown to IndexedDB → popup preview / download
             → bounded profile document → IndexedDB → popup summary + JSON download
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
   mounted panels. Both public APIs consume the same zero-generator iterative walker: an explicit
   frame stack (`CHILDREN` sibling cursors, one live frame per open nesting level, plus `ITEM`
   frames that compose spoiler groups once their panels drain) replaces per-element `yield*`
   delegation. The synchronous compatibility API never reads the clock; the cooperative async
   walker counts visited nodes and checks a ~20 ms budget once per 64 nodes, yields via
   `scheduler.yield` or `MessageChannel` when available, and reports processed messages and bytes.
   Individual large text/code conversion operations still run synchronously.
   `AREX.serializeHeader(count)` is byte-stable; `AREX.serializeHeader(count, { partial: true,
   totalMessages })` additionally marks a stopped export in the metadata block.

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
`BlockIndex` and caches each computed mode (and, for Smart/Stubs, each `${mode}:${condenseThoughts}`
result; see below). `content/compress.js` works in both window and worker
contexts; transforms edit indexed blocks and assemble the output once per mode. The UI ignores
stale mode/snapshot replies and downloads the prepared result without recompression. If the worker
is unavailable or fails, a local fallback keeps exports usable but can block the popup temporarily.
Neither path revisits the Arena DOM or repeats history paging / spoiler expansion.

`AREX.compressIndex` wires the whole pipeline. Each stage lives in its own module, is
feature-detected per call (a bundle without a module keeps the earlier behaviour for that stage) and
can only shrink the previous result, which is what makes `Off ≥ Lossless ≥ Smart ≥ Stubs` hold by
construction; Stubs is Smart plus extra guarded stages. In order:

| Stage | Modes | Module | What it does |
|---|---|---|---|
| Lossless | L S T | `compress.js` | first copy of an identical output (≥ 128 B) anchored, later copies link to it |
| Smart log stage | S T | `compress-smart-log.js`, `compress-smart-cli.js` | terminal noise, folded passing runs, JSON/search-hit reshaping (clean blocks only), error-aware wide-line clip and head/tail budget (≤ 2.4 KB) |
| Scripts and diffs | T | `compress-commands.js` | clean `exit 0` inline scripts and `git diff` context, kept only where they beat the Smart body |
| Line references | T | `compress-stubs.js` | content-defined cross-block references, run *before* the tighter budget can clip a source |
| Tight budget | T | `compress-smart-log.js` | head/tail budget ≤ 1.2 KB for blocks that are not reference sources |
| Framing | S T | `compress-framing.js` | redundant wrappers, single-line command callouts |
| Reasoning | S T | `compress-thoughts.js` | middle Thought blocks and drafts; skipped when `condenseThoughts` is `false` |

(L = Lossless, S = Smart, T = Stubs.) Guards the stages share:

- **Nothing the user wrote is edited.** `guardBlocks` fixes every block inside a User turn or an
  assistant answer span (from the `DocumentIndex`), and every bare fence that is not tool output.
  The serializer fences tool output as `text` directly under an activity heading
  (`used …`, `Ran commands`, `Explored`, `Edited`) or a 📄 file card; any other bare fence is code in
  prose or a Thought draft, which the section index cannot tell from tool output. Fixed blocks are
  neither a reference source nor a target. If indexing fails, nothing is edited.
- **Failing output stays whole.** The classifier in `compress-smart-log.js` keeps every line of a
  block whose heading has a non-zero exit, that has stderr, or whose body has a traceback, failing
  test or compiler error; reshaping (grouping, JSON) only touches blocks without diagnostics.
- **Anchored blocks never change.** Lossless anchors, Lossless references and Stubs sources are
  frozen for every later stage, so a line range in a marker always points at lines that exist.
- **Thoughts have one owner.** Block stages never edit a Thought; only the last stage does.
- **Exact accounting.** Bytes and estimated tokens are tracked per edit; the span-edit passes
  (framing, reasoning) add the exact token delta of their edits (`AREX.spanTokenDelta`, additive
  across whitespace) instead of re-estimating the whole document, and fall back to a full estimate
  when an edit could merge two token chunks.
- **A broken optional stage degrades.** Each module call is isolated: a failure skips that stage (the
  log stage falls back to the earlier clip) and the preview still renders.

The stages with their own contracts:

- **Stubs (v2):** after Smart, every eligible block (`stdout`/`stderr` output, 📄 file artifact
  cards, bare tool outputs and `command` write payloads; never a fixed block or a Thought fence) is
  matched against a single bounded
  global rolling 4-line seed index built in transcript order — so matching is *content-defined and
  path-agnostic*. Compound `for f in …; do cat "$f"; done` reads, 📄 file cards and later `sed -n`
  slices deduplicate shared ≥4-line chunks without `commandInfo()` path inference. Optional `cat -n`
  / `nl` line-number prefixes are normalized during lookup (the marker records when numbering
  differed). A block is replaced only with a marker `[... identical to lines A–B of earlier output
  #arex-stubs-output-K ...]` when the net UTF-8 delta is ≤ −80 B. Reference sources are never
  themselves stubbed (no reference chains), and different versions / non-overlapping ranges stay
  intact. Implementation lives in `extension/content/compress-stubs.js`.
- **Condense long reasoning (Smart/Stubs, `condenseThoughts`, default on):**
  `content/compress-thoughts.js` is the last stage of `compressIndex` (`condenseThoughts: false`
  stops before it). It indexes the Markdown the earlier stages produced with `AREX.buildDocumentIndex` and edits only assistant `Thought` / `Thought for …`
  sections through `AREX.applySpanEdits`. User turns and every assistant `answerSpan` are passed as
  protected spans, so an edit that touches them throws and the pass is dropped. A Thought is split
  into blank-line separated blocks with fenced code kept atomic. Smart (over 2,600 B, at least 5
  blocks) keeps the first and last two blocks; Stubs (over 900 B, at least 3) keeps the first and
  last one. Each run of middle blocks of at least 300 / 250 characters collapses to
  `_[... condensed N intermediate reasoning blocks (M chars) ...]_`. A Thought followed by no
  later activity in its turn is skipped, because prose glued to it could be the final answer.
  Stubs matching never sees a Thought fence, so a fenced draft in a Thought is replaced piecewise
  (runs of at least 5 identical lines saving at least 100 B) by `[... draft identical to lines A–B
  of later output #arex-stubs-output-ID ...]` when a later heredoc write or file artifact of the same
  turn repeats it; the target gets an `arex-stubs-output-ID` anchor, reusing an existing one. A block
  that carries an `arex-…output-N` anchor is never condensed or replaced, because other markers point
  at it. Assistant prose that directly follows a Thought without a heading of its own cannot be told
  from the Thought in Markdown, so it is treated as part of it; its code can become such a pointer
  when a later output repeats it verbatim, and nothing is lost either way.
  Only byte-reducing results are kept, and any failure returns the previous stage unchanged. The
  pass adds `thoughtsCondensed`, `blocksCondensed`, `charsCondensed` and `draftsDeduplicated` to
  the result stats; the popup's download summary reports `deduplicated`, `smartCompacted`,
  `stubbed` and `thoughtsCondensed`.
- The popup persists the checkbox in `chrome.storage.sync` and sends `{ mode, condenseThoughts }`
  with `GET_MODE` / `GET_MARKDOWN`. The worker ignores the flag for Off/Lossless (always keyed
  `:false`), computes each mode's base result once (`compressIndex` with `condenseThoughts: false`)
  and each `${mode}:${condenseThoughts}` result once by applying the last stage to that base, and
  echoes the effective flag in its replies. The popup keys its preview cache and
  stale-reply guards the same way, so toggling never rescans the Arena DOM.
- The size card uses the final download Blob's exact byte length, displays exact UTF-8 bytes
  plus decimal KB/MB, an approximate multilingual token count, and savings against raw Markdown.
  Finder's “size on disk” is a separate filesystem allocation figure. The token estimator is
  deliberately lightweight and is not a model-specific tokenizer.
- A stage is accepted only when it does not grow the result, so output never exceeds the previous
  mode in UTF-8 bytes. `test/compress.test.mjs` checks this, exact byte and token accounting, and the
  guards above on 220 generated multi-turn transcripts (`test/fixtures/random-transcript.mjs`), with
  and without the reasoning stage.
- The latest raw snapshot is persisted in extension IndexedDB, outside the popup's short-lived
  JavaScript memory, and keyed by `(tabId, chatUuid)` — never a global "latest". The popup queries
  `activeArenaTab()` first; a non-Arena tab gets a clean empty state (plus a banner for a job in
  another tab), and an Arena tab loads only `AREX_RESULT_STORE.loadForTab(tabId, chatUuid)` and the
  matching scoped diagnostic record. Opening the popup on another branch never shows the previous
  branch's size card, profile or download button. Reopening the popup restores the scoped snapshot;
  the user can download again or retake it.
- A stopped scan (`job.status === 'stopped'`, `snapshot.partial === true`) is a first-class preview:
  an amber callout reports `K of N messages captured before stop`, all compression modes stay
  switchable, the primary button becomes **Download Partial Markdown** (filename suffix `-partial.md`)
  and **Export full branch** stays available.
- `AREX_EXPORT_LOG` is always reachable from the popup (running, stuck at 99 %, stopped, error, done).
  The reply is a `schemaVersion: 1` bundle: timestamped progress/stage log, coordinator status and
  transfer counters, tab-side status (or its 1 200 ms timeout notice), and the profiler snapshot when
  profiling is on. The popup saves it as `<slug>-log-<YYYYMMDD-HHmm>.json`; the running scan is never
  paused, cancelled or re-queried for Markdown.
- Mode previews use `GET_MODE { includeMarkdown: false }`; the Markdown string is fetched from
  `popup/compress-worker.js` via `GET_MARKDOWN` only when **Download** is clicked, so switching modes
  never copies multiple megabytes across the UI thread.
- Download Blob URLs live until Chrome reports the download finished: the popup watches
  `chrome.downloads.onChanged` for `complete`/`interrupted` and only then calls
  `URL.revokeObjectURL(url)` (a 10-minute fallback timer guards against a missing event). A slow
  "Save as…" dialog can no longer revoke the URL out from under itself.
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
  The transfer guard is **128 Mi UTF-16 code units** (code-point aware, not a 128 MiB UTF-8 limit);
  byte counts are computed without allocating an encoded copy, including across chunk boundaries
  that split a surrogate pair.
- A job exists from the moment the content script opens its `AREX_JOB` port, and a fresh job is
  created in `running` state while it waits for `AREX_JOB_START`. A tab that never ran an export has
  no job entry, so popups see `job: null`; a tab that ran one keeps its terminal job
  (`done` / `stopped` / `error`) until it is archived by a branch switch, a tab close, or the LRU
  cap. Finished results are restored from the scoped IndexedDB snapshot, not from the job entry.

## Delivery & UX details

- The Arena tab keeps the run alive independently of the popup; result string → popup creates blob URL →
  `chrome.downloads.download({ saveAs: true })`, filename
  `arena-<slug(branch title|uuid)>-<YYYYMMDD-HHmm>.md`.
- The popup follows `prefers-color-scheme` with native-Chrome tokens and renders a staged
  progress log (`ul#log`): one line per stage (history / expand / process / serialize / saving), spinner → ✓;
  granular counters from pipeline events (history pages and message counts, per-pass spoiler
  counts, final markdown bytes) and an ok/warn summary. The scan percentage counts each serialized
  message and each spoiler to expand as one work unit; nested spoiler totals are added as their
  parent panels reveal them, while a high-water mark prevents percentage regressions. Options persist
  via `chrome.storage.sync`.
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

## Versions & consistency

Four literals carry the shipped version and must move together: `package.json` / `package-lock.json`
(`version`), `extension/manifest.json` (`version`), `background.js`
(`CONTENT_FEATURE_VERSION`) and `content/main.js` (`toolVersion` and the `featureVersion` returned by
the `AREX_PING` readiness probe). `test/version.test.mjs` parses all of them out of the sources and
fails on any drift, also failing loudly if a constant is renamed; it also pins the cross-cutting npm
scripts (`test`, `benchmark`, `benchmark:archive`, `benchmark:large`) and checks that the files they
reference exist. The feature string is a re-injection trigger: raising it makes an already-open tab
pick up the new content script instead of silently running stale code.

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

`npm test` (node:test + jsdom) runs per-module suites plus two integration layers:

- **Unit & module suites.** Markdown converter cases; serializer over the saved transcript fixture
  (546 KB, 9 messages) asserting message order/roles, fences and exclusion of sidebar/panel
  artifacts; loader/expander loops against synthetic DOMs that emulate Arena's mount-on-click and
  prepend-on-scroll with fake timers; popup-port reconnect tests for scan continuation, progress
  replay, result delivery and acknowledgement; fake IndexedDB for storage and transaction behavior;
  `test/version.test.mjs` for the cross-module version handshake.
- **Integration gate** (`test/integration-gate.test.mjs`). Real `background.js` + real
  `shared/result-store.js` on fake-indexeddb, driven through a synthetic three-tab matrix: scoped
  isolation of A/B/C, same-tab SPA branch switch, Stop during history paging vs. Stop after K
  windows, and `AREX_EXPORT_LOG` at idle / running / stopped / error / done. It also re-asserts
  byte parity of the full windowed pipeline against `test/snapshots/fixture-expected.md`.
- **Stress suite** (`test/large-page-stress.test.mjs`). 120 turns / 2,400 spoilers with streaming
  tail mutations: no `settle()` tail-stall, deterministic output, leak-free DOM after a mid-run stop,
  bounded diagnostic snapshots, one click per opened control.

Benchmarks: `npm run benchmark` (fixture/token/compression/history), `npm run benchmark:large`
(large-page window pipeline) and `npm run benchmark:archive -- <saved page>`. See
`docs/performance-results.md` for methodology, measured numbers and limitations — jsdom numbers are
not browser latency, and no Node test exercises real Chrome service-worker lifetimes, the rendered
popup or a live Arena page.
