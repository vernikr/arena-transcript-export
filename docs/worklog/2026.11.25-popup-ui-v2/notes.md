# Popup UI v2 — strict current-tab state, Stop & Export Partial, anytime Export Log, safe Blob cleanup

- `popup.js` now resolves `activeArenaTab()` **before** touching storage. An Arena tab loads only
  `AREX_RESULT_STORE.loadForTab(tabId, chatUuid)` / `loadMetaForTab(...)` and the matching scoped
  diagnostic record; the global `load()` (`'latest'`) path is gone. A non-Arena tab renders a clean
  "Open an Arena.ai agent conversation to export it" state: no size card, no profile, no download
  button, and the compression section is hidden. A banner still surfaces a running (or unseen
  finished) job in another Arena tab with a **Switch** button, driven by `AREX_LIST_JOBS` and
  `AREX_STATUS`.
- `AREX_HELLO` now carries `{ tabId, chatUuid, tabUrl }`, so the coordinator can verify the branch
  before replaying progress. Status messages whose `chatUuid` differs from the active tab's branch
  are ignored. `AREX_EXPORT_START` / `AREX_EXPORT_LOG` pass the same scope, so the coordinator
  reconciles the tab before starting or dumping.
- **Stop & keep partial**: the stop button reads "Stop & keep partial"; `job.status === 'stopped'`
  (or `meta.partial`) renders an amber callout `Partial snapshot · K of N messages captured before
  stop`, keeps `Off / Lossless / Smart / Stubs` fully switchable (the `Off` mode is now a first-class
  radio in `#modes`, and also drives the existing **Compress history** checkbox), sets the primary
  button to **Download Partial Markdown** and downloads `…-partial.md`. `#resnapshot` becomes
  **Export full branch** while a partial preview is shown.
- **Anytime Export Log**: a collapsible **Log & diagnostics** drawer with **Export log (JSON)** and
  the profile summary is visible during running / stuck / stopped / error / done. The button requests
  `AREX_EXPORT_LOG { tabId, chatUuid, tabUrl, requestId }` over the `AREX_POPUP` port and downloads
  the returned `schemaVersion: 1` bundle as `<slug>-log-<YYYYMMDD-HHmm>.json`. No cancel is sent and
  the running scan keeps reporting; the 20 s port timeout only affects the popup side. The finished
  profile is resolved through the scoped diagnostic record first and then, quietly, through the same
  RPC (`quiet` requests are skipped while an explicit log export is in flight).
- **Tail-end visibility**: `stage: 'process', phase: 'cleanup'` renders `Closing opened spoilers:
  closed/total spoilers · processed/total messages scanned · NN%`; `stage: 'saving'` renders
  `Saving snapshot chunk X/Y to storage…` once per batch (and uses `receivedChunks` for the
  background's `phase: 'transfer'` telemetry). A superseded stage is marked ✓, the stage order is
  `history → expand → process → serialize → saving`, and a stopped run shows ⏸ instead of ✕.
- **Lazy worker Markdown**: mode previews send `GET_MODE { includeMarkdown: false }` (metadata +
  token estimate only); the string is produced by `GET_MARKDOWN` from the worker cache exactly once
  per download. The worker-less fallback keeps its own per-mode Markdown cache instead of copying the
  snapshot repeatedly.
- **Blob URL lifecycle**: a download URL is revoked on `chrome.downloads.onChanged`
  `complete`/`interrupted` (listener removed, duplicate events ignored) with a 10-minute fallback
  timer. The old 30 s `setTimeout` that could kill a slow "Save as…" dialog is gone.
- `test/popup-ui.test.mjs` is rewritten around a fake v2 store keyed `(tabId, chatUuid)` and a
  scriptable `AREX_POPUP` port; it covers Tab A vs Tab B isolation, the non-Arena tab state and
  banner, Stop → partial preview → `-partial.md` download with every mode switchable, mid-run
  `Export log (JSON)` while `status === 'running'` (including a wedged 99 % scan), coordinator
  timeout reporting, cleanup/saving progress rendering, reconnect replay, and the
  `downloads.onChanged` lifecycle (complete, interrupted, duplicate events).
  `test/compress-worker.test.mjs` was updated for the scoped hello and the no-Markdown preview
  contract; it now also asserts that every `GET_MODE` preview is metadata-only.
- Known, unchanged by this slice: `test/result-store.test.mjs` "LRU eviction caps scoped snapshots at
  8 and logs at 16" fails on `main` before this change (eviction keeps 8 scope groups, so the
  oldest one survives when exactly 8 exist); it belongs to Wave 1.1 file ownership.
