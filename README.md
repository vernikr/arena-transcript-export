# Arena Transcript Export

Chrome extension (MV3) that exports the **current Arena.ai agent branch** to a single Markdown
file: the full history is force-loaded first (Arena pages long transcripts and mounts older pages
on scroll-up), then spoilers are expanded and serialized in small message windows — reasoning
blocks, tool calls, command outputs — including nested groups. The left sidebar, the right preview panel and the composer are excluded
by construction: everything is scoped to the transcript container (`div[role="log"]`).

## Install

**From the release zip (recommended):** download `arena-transcript-export-*.zip` from the
[latest release](https://github.com/vernikr/arena-transcript-export/releases/latest), unzip it,
then `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the unzipped
folder.

**From source (dev):** clone this repo and load the `extension/` directory the same way.

Then open an agent branch on `https://arena.ai/agent/…`, click the extension icon →
**Export branch to Markdown**.

The scan runs in the Arena tab, so you can close the popup at any time. Reopen it from the
extension icon while the same Arena tab is still open: the popup reconnects to the active scan
and restores its progress. The background worker saves the completed snapshot to extension
IndexedDB even while the popup is closed. Keep the Arena tab open until the scan finishes; reloading or closing
that tab stops the in-tab task.

## Options

- **Expand & include tool activity** (default on) — click-open every spoiler and export its
  content as headed sections with fenced code. Off = prose only (fast).
- **Message timestamps** (default off) — append the visible message time to each heading.
- **Performance profiling** (default on) — a bounded, zero-I/O profiling record of the export is
  written to the tab and saved in IndexedDB next to the snapshot. It includes per-phase timings
  (history, expand, cleanup, process), per-message timing aggregates (count/mean/p95/max), the
  slowest windows, Chromium heap samples and a short milestone event list. It stays cheap even on
  very large pages (the document is hard-capped at 128 KiB) and is produced only for the run; nothing
  is logged during the export itself. The popup shows a compact summary and offers a
  **Download profile (JSON)** button. Disable it to keep a run free of profiling overhead.
- **Compress history** (default on) — choose one of three deterministic modes:
  - **Lossless** — exact duplicate tool outputs are kept once; repeated blocks link to the original.
  - **Smart** — Lossless plus ANSI/progress-noise removal, collapsing long consecutive passing-test
    runs, and head/tail previews for very large clean command logs. Error output is retained.
  - **Stubs** — Smart plus references to identical consecutive lines already present in an
    earlier read or heredoc write of the same file. Unlike the former version, it does not
    discard different file versions or non-overlapping ranges merely because the path matches.
    **Smart and Stubs are lossy**: Smart can still shorten unique long clean output.
  - **Off** — turn compression off to export the raw Markdown.

Click **Prepare preview** to load the full history and expand spoilers as each window is processed. The popup then shows the
exact UTF-8 Markdown size, an approximate token count, and savings against the raw export.
Compression and token estimates run in a background Web Worker; switching between **Off / Lossless /
Smart / Stubs** uses a per-snapshot cache after the first calculation. **Download Markdown** saves the
selected prepared result without recompressing it or loading the Arena history again. The selected
mode and options are remembered.

The popup is strictly scoped to the active tab: it only shows the snapshot saved for that tab and
conversation branch. On a non-Arena tab it shows a clean “open an Arena.ai agent conversation” state
instead of another tab's preview, and a banner points to a scan that is still running (or finished)
in a different Arena tab. Clicking **Stop & keep partial** during a scan keeps the messages captured
so far: the popup then shows an amber partial-snapshot card, keeps every compression mode switchable,
and **Download Partial Markdown** saves `…-partial.md`; **Export full branch** is one click away.

The prepared snapshot and its profiling record are saved in extension IndexedDB, scoped per tab and
branch. Reopening the popup restores that preview and lets you download it again or choose **Retake
snapshot** to capture the current branch. The size card shows exact UTF-8 bytes plus decimal MB;
Finder's separate “size on disk” value includes filesystem allocation overhead.

The **Log & diagnostics** drawer stays available while a scan runs, is stuck at 99 %, or ends with
stop / error / completion. **Export log (JSON)** saves `<slug>-log-<YYYYMMDD-HHmm>.json` with the
timestamped stage log, coordinator job and transfer diagnostics, and — when **Performance profiling**
is enabled — the live profiler snapshot, without stopping or disturbing the running scan.

The popup follows the system light/dark theme (`prefers-color-scheme`) and shows a staged
progress log. Reopening the popup during a scan reconnects to the task and replays retained
progress events; the content script keeps the completed result until the background worker confirms
that it has been saved to IndexedDB. The tail end of every scan is reported explicitly: the final
spoiler cleanup shows `Closing opened spoilers: closed/total spoilers…` and the result transfer shows
`Saving snapshot chunk X/Y to storage…` instead of a frozen 99 % line. During scanning, the percentage counts one work unit per
serialized message and per spoiler to expand; nested spoilers are added to the total when their
parent panels reveal them, without making the displayed percentage move backwards. The log includes
history paging (rounds/pages/message counts), per-message progress and spoiler counters, and the
assembled Markdown size. Spoilers opened by the export are closed after each window. The final
line lists messages, expanded spoilers and any warnings. Token counts are estimates intended for
comparison, not an exact model-specific tokenizer result.

The toolbar icon shows activity and stage progress during a scan. A green ✓ means an export
finished while the popup was closed; a red ! signals an error. Hover for details and open the
popup to clear these notifications. With multiple jobs, active scans take priority on the icon.

## Releases

Tags (`v*`) trigger a workflow that zips `extension/` and attaches the archive to the matching
GitHub Release; `ci.yml` runs the test suite on every push.

## Markdown schema

Document header: `# branch title`, source URL, export timestamp, message count. A stopped export adds
one line before the closing rule — `- Status: Partial export (<captured>/<total> messages)` — and is
otherwise identical to a complete export, so it stays a valid Markdown document. Each turn:

- `## 👤 User` — text (converted from the rendered markup) + `📎 **Attached:** …` chips.
- `## 🤖 Assistant` — answer prose; each activity item as `#### used Bash 143ms`-style heading
  (nested groups go one level down), cards as `**command:**`/`**stdout:**/`**stderr:**` +
  fenced blocks, file cards as `**📄 name** _(LANG)_` + fenced content, and document artifacts
  (e.g. written `.md` files) rendered as fully converted markdown.

## Limits

- Export is available while the agent is generating. It includes the transcript rendered when serialization runs; content generated afterward is omitted. Export again after completion to capture the final response.
- The right preview panel is out of scope per requirements; code that exists only behind
  "open file in preview" actions is exported as the inline preview embedded in the transcript.
- On older Arena page versions without pagination markers, a completely silent load that starts later
  than the initial 150 ms probe cannot be distinguished from a fully loaded history. If legacy paging
  is observed, the exporter falls back to quiet rounds; a visible stuck loader or sentinel produces a
  warning instead of silently claiming completion.
- The background coordinator rejects corrupted or oversized transfers rather than saving partial
  exports. The transfer guard is 128 Mi UTF-16 code units (roughly 256 MB UTF-8 for ASCII, more for
  CJK), checked with code-point-aware byte counting across chunk boundaries; larger exports are
  rejected with an explicit error rather than truncated.
  A disconnected worker is retried up to five times, including after scanning finishes; if retries
  are exhausted, keep the Arena tab open and retake the snapshot.
- If Arena eventually introduces real DOM windowing (unloading rendered messages — none today),
  the exporter aborts loudly instead of writing a partial file.

## Dev

No build step, no runtime dependencies. `npm install` once for the development dependencies, then:

| Command | What it does |
|---|---|
| `npm test` | `node:test` + jsdom: unit suites, the cross-module integration gate, and the large-page stress suite over a synthetic 120-turn / 2,400-spoiler transcript |
| `npm run benchmark` | reproducible jsdom/Node regression benchmark (serializer, token estimate, compression, history probe) with snapshot-parity checks |
| `npm run benchmark:large` | large-page pipeline benchmark: per-window expand/serialize/cleanup percentiles, cleanup click count, heap delta; exits non-zero if an invariant regresses |
| `npm run benchmark:archive -- /path/to/page.html` | the same serializer/compression measurements against a saved Arena page kept outside the repo |

The expected Markdown snapshot is `test/snapshots/fixture-expected.md` — regenerate it with
`UPDATE_SNAPSHOT=1 npm test` after an intentional output change. `docs/performance-results.md`
records the measured numbers and their scope.

Versions are kept in lockstep by `test/version.test.mjs`: `package.json`, `package-lock.json`,
`extension/manifest.json`, `background.js` (`CONTENT_FEATURE_VERSION`) and `content/main.js`
(`toolVersion` / `featureVersion`). Bump all of them together — the feature string is what makes an
already-open tab re-inject the new content script.

- `docs/architecture.md` — module design, pipeline, DOM→MD mapping, storage invariants, risks.
- `docs/research/arena-page-analysis.md` — how Arena loads/renders the transcript (evidence).
- `docs/performance-results.md` — measured benchmarks, the integration matrix, and their limits.

Page markup is obfuscated Tailwind CSS and may drift; all queries live in
`extension/content/selectors.js` and lean on `data-*`/`role` hooks. If export degrades after an
Arena update, start there and update the fixture.
