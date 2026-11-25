# Wave 4.1 — end-to-end integration gate, version sync, benchmark report & docs

Final sequential gate for the epic (#12). Waves 1–3 were already merged; this wave wires them
together, verifies the cross-module contracts, and updates durable documentation.

## Version metadata (0.4.1 → 0.5.0)

The whole 12-issue epic changed user-visible behaviour (tab-scoped snapshots, partial export,
anytime diagnostics, stress-hardened loader/serializer/compression), so the version moved to
**0.5.0** rather than a patch bump. All four literals moved together:

| Where | Literal |
|---|---|
| `package.json`, `package-lock.json` | `version` |
| `extension/manifest.json` | `version` |
| `extension/background.js` | `CONTENT_FEATURE_VERSION` |
| `extension/content/main.js` | `toolVersion`, `featureVersion` (AREX_PING reply) |

`test/version.test.mjs` now asserts *all* of them instead of only manifest/npm/lock. It parses the
constants out of the sources with explicit regexes, so renaming one fails the test loudly instead of
silently skipping the check. It also pins the script table (`test`, `benchmark`, `benchmark:archive`,
`benchmark:large`) and verifies every referenced `scripts/*.mjs` entry point exists.

## npm scripts & CI

- Added `"benchmark:large": "node --expose-gc scripts/benchmark-large-page.mjs"` to `package.json`
  (Wave 3.3 deliberately left `package.json` alone; wiring it was this wave's job).
- `ci.yml` now runs `npm run benchmark` **and** `npm run benchmark:large` after `npm test`, and
  checks out with `fetch-depth: 0` so the benchmark can still diff against its baseline ref. Both
  scripts assert invariants and exit non-zero on a regression, which is the point of a gate.

## End-to-end integration matrix (`test/integration-gate.test.mjs`, new)

Unlike the per-module suites, this file boots the **real** `background.js` coordinator against the
**real** `shared/result-store.js` on fake-indexeddb and drives a scripted multi-tab matrix through
the same ports the content script and popup use. Six tests:

1. **A done / B idle → running → stopped / C non-Arena.** Each scope reads only its own job and
   snapshot; tab B never sees A's Markdown, tab C never gets either, and `branch-1` never leaks into
   `branch-2` on the same tab. Terminal jobs may be archived, so restoration goes through the scoped
   IndexedDB snapshot — that is what the test asserts.
2. **Same-tab SPA navigation** `/agent/branch-1` → `/agent/branch-2`: `tabs.onUpdated` cancels the
   in-flight scan (the tab receives `AREX_EXPORT_CANCEL`), the stale branch serves no running job,
   and the new branch starts with a clean scope and no inherited snapshot.
3. **Stop during history paging** (nothing serialized yet): the job ends as `error`, nothing is
   ACKed and no snapshot is written. An empty file is *not* produced.
4. **Stop after K windows**: exactly the serialized prefix is persisted with `partial`,
   `completedMessages` and `totalMessages`, and the tab is ACKed only after the scoped write.
5. **`AREX_EXPORT_LOG` at idle / running / stopped / error / done**: always `schemaVersion: 1`,
   shipped tool version, live progress while running, partial metadata when stopped,
   coordinator status and result metadata otherwise.
6. **Fixture parity**: the full windowed pipeline still matches `test/snapshots/fixture-expected.md`
   byte for byte with zero warnings.

Writing it surfaced three behaviours worth knowing (each is now documented in
`docs/architecture.md`):

- A job entry is created as soon as the content script opens its `AREX_JOB` port, and a fresh job is
  born in `running` while it waits for `AREX_JOB_START`. "Idle" therefore means *no job port at
  all*; a tab that only had its port opened looks like a running job with no progress.
- Terminal jobs are archived out of the live map, so a finished tab's truth is its scoped
  IndexedDB snapshot, not the job object.
- Mock ports must keep directions apart. A naive mock that shares one listener list for both
  directions lets the test read its own outbound traffic as if it were the coordinator's reply —
  that cost an hour here, and the helper now documents the split.

## Benchmarks (recorded in `docs/performance-results.md`)

Sandbox numbers, Node 20.20.2 + jsdom, Intel Xeon @ 2.6 GHz:

- `npm run benchmark`: sync serializer 54.0 ms on the 546 KB fixture (byte parity), cooperative
  async walker 38.0 ms (same bytes), 6.35× vs. baseline `73a0cbb`; token estimate 3.73×; index
  115.9 ms; no-sentinel history probe 258.3 ms.
- `npm run benchmark:large`: 120 turns / 2,400 spoilers, whole windowed export 3,283 ms over 30
  windows; per-window expand p50 63.4 / p95 103.7 ms, serialize p50 3.1 / p95 7.0 ms, cleanup
  p50 16.2 / p95 29.9 ms; **120 DOM clicks for 2,400 opened controls** (2,280 pruned by their
  parent, a 20× reduction); heap delta 2.7 MiB with a 29.0 MiB sampled peak; diagnostic snapshots
  912 B → 6,759 B.
- Both are jsdom measurements of the *pipeline*, not real Chrome latency, and the synthetic page is
  not real Arena markup. Stated as such in the document.

## Documentation

- `README.md`: dev section rewritten as a command table (`test`, `benchmark`, `benchmark:large`,
  `benchmark:archive`) plus the version-lockstep rule; Markdown schema now documents the partial
  export header line; **two shipped facts were wrong and are fixed** — the transfer guard is 128 Mi
  UTF-16 code units (was documented as 64 Mi) and the profile document is capped at 128 KiB (was
  documented as 64 KiB).
- `docs/architecture.md`: new **Versions & consistency** section; storage/transfer invariants
  rewritten (128 Mi guard, code-point-aware byte counting, job lifecycle and archival); `Testing`
  section restructured around the three layers (module suites, integration gate, stress suite) and
  what they still do not cover; `dev-reload.js` added to the module map.
- `docs/performance-results.md`: new Wave 4.1 section with the large-page table, the recorded
  regression numbers, the integration matrix, the flake-hardening note and explicit limits.

## Flake hardening

`test/markdown.test.mjs`'s 5 MB `mdFence` timing test now takes the **best of five** runs instead of
one wall-clock sample. It failed CI once at 27.6 ms while local medians were ~13 ms; a linear
implementation should not fail on a single scheduler hiccup, while a real complexity regression
makes every run slow. The `result-store` LRU flake was left untouched: it is stable in isolation
(18/18) and across six consecutive full-suite runs, so the earlier failures are attributed — as a
hypothesis, not a proven fact — to CPU contention in the shared `node --test` pool.

## Verification

```
npm ci
npm test              # 172 tests, 0 failures
npm run benchmark     # snapshot + sync/async parity, all option combinations
npm run benchmark:large  # "All invariants hold.", under the 5 s budget
```
