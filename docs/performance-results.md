# Performance and regression report

Measurements recorded 2026-11-22 for the implementation targeting version 0.4.0. These are
**scoped regression measurements, not a claim that every target in the engineering plan has
been achieved**. Re-run with `npm ci && npm run benchmark`. The script accepts
`--baseline-ref=<git-ref>` after `--`; its default `73a0cbb` is the pre-windowing baseline. If that
commit is absent (for example in a shallow clone), baseline comparisons are skipped rather than
fetched from the network. Times are the median of three measured runs after a warm-up.

## Recorded run

On the project owner's Intel Core i7-9750H Mac, Node 22.22.2, jsdom (not a Chrome page):

| Measurement | Baseline | Current | Notes |
|---|---:|---:|---|
| Synchronous serializer, 545,831 B HTML fixture, 9 messages | 217.2 ms | 72.9 ms | 2.98×; normalized timestamp, byte-for-byte snapshot parity |
| Token estimate, 2,034,912 B synthetic Markdown | 323.2 ms | 93.3 ms | 3.46×; same estimate |
| Build Markdown index, 480 fenced blocks | — | 30.7 ms | Precomputed once per worker snapshot |
| Indexed mode: off / lossless / smart / stubs | — | 78.6 / 74.4 / 74.2 / 76.5 ms | First calculation, measured independently after index build |
| No-sentinel history confirmation | — | 254.2 ms | Includes the 150 ms probe and 100 ms settle |
| 100,000 in-process Map lookups | — | 0.5 ms | Only a cache lookup microbenchmark, **not** a worker/UI round trip |

## Supplied Archive.zip: earlier measurement (before the follow-up optimization)

A subsequent measurement used the supplied saved HTML (5,596,938 B), not the synthetic
fixture. The archive stays outside the repository; only aggregate data is recorded here. On the
same Intel i7-9750H Mac, Node 22.22.2, jsdom, baseline `73a0cbb`: median of 3 runs after one
warm-up. The saved DOM has 32,383 elements, including 31,329 in the transcript, 12 messages,
1,042 already expanded buttons and 1,155 fenced blocks. The URL is replaced with a fixed
benchmark URL, explaining the small difference in output bytes vs. the original plan.

| Measurement | Baseline | Before follow-up | Result |
|---|---:|---:|---|
| Synchronous serializer | 2,743.9 ms | 516.8 ms | **5.31×**; byte-identical after normalizing export timestamp |
| Build index | — | 78.7 ms | measured separately |
| Off | 302.3 ms / 1,612,422 B | 77.5 ms / 1,612,422 B | 0.00% reduction |
| Lossless | 309.4 ms / 1,612,422 B | 84.4 ms / 1,612,422 B | 0.00% reduction |
| Smart | 350.4 ms / 1,499,474 B | 90.6 ms / 1,470,678 B | 7.00% → **8.79%** reduction |
| Stubs | 593.2 ms / 1,495,753 B | 122.6 ms / 1,318,678 B | 7.24% → **18.22%** reduction |

The pre-follow-up compression times above **exclude** the separately measured index construction; baseline
mode times include their parsing. Numbers are not apples-to-apples cold end-to-end timings.
That implementation compacted 31 smart blocks and stubbed 54 earlier reads/writes. Lossless found
no byte-identical eligible blocks. The asynchronous message walker produced the same Markdown
as synchronous serialization on the static snapshot. This does not measure the real windowed
expand/serialize/collapse pipeline or the 175 panels closed in the saved page.

The earlier 5.31× fell short of the plan's 6–8× serializer target; the 8.79% and 18.22%
reductions fell short of the projected 25–45%. The former Stubs algorithm could discard distinct
versions and non-overlapping ranges, so its greater reduction must not be interpreted as an
unqualified advantage. See the follow-up below. Times depend on runtime and machine load.
To reproduce, extract the main saved HTML outside the repository and run
`npm run benchmark:archive -- /path/to/saved-page.html` (optional second argument: baseline git
ref). The benchmark does not execute page scripts and prints only aggregate measurements, but
the input itself may contain private conversation data: do not commit it or paste it into logs.

## Follow-up: faster traversal and safer Stubs

After CPU profiling, the serializer traverses DOM siblings directly instead of repeatedly
iterating live HTMLCollections in hot paths. On the same Mac, Node 22.22.2 and static Archive
snapshot, medians of three after a warm-up, in the same run:

| Comparison | Previous | Follow-up | Speedup |
|---|---:|---:|---:|
| Against immediately preceding commit `d1ef02a` | 1,067.9 ms | 716.0 ms | 1.49× |
| Against `d1ef02a`, repeated run | 1,193.7 ms | 641.8 ms | 1.86× |
| Against `d1ef02a`, final verification | 1,080.8 ms | 862.0 ms | 1.25× |
| Against pre-windowing `73a0cbb`, separate run | 6,663.0 ms | 837.3 ms | 7.96× |

The current and old synchronous outputs were byte-identical after timestamp normalization, and
the async message walker also matched on the static DOM. The relative 7.96× reached the plan's
6–8× range in this run, not a guarantee in Chrome or under other loads. The absolute timings
varied substantially compared with the earlier 2,743.9/516.8 ms run above. Neither run measures
real loading, expansion, window cleanup, browser main-thread latency or memory.

In the follow-up Stubs no longer assumes two reads of one path are interchangeable or that a
later write makes earlier content dispensable. It replaces only consecutive lines identical to
an earlier intact output, with an output identifier and line range; existing Lossless anchors
are kept intact through Smart and Stubs. On this archive, Smart remains **8.79%** smaller and
Stubs is **9.69%** smaller than raw Markdown (1,456,255 B). In Stubs, 22 outputs use 35 references
to 19 intact source blocks; expanding those references exactly reconstructs the Smart output.
That is less compression than the previous unsafe 18.22%, by design. **Smart and Stubs remain
lossy overall:** Smart can remove or abbreviate unique lines before Stubs runs. Use Off for full
raw content or Lossless for exact repeated-output references. The 25–45% compression target
remains unmet; don't trade away unique data without explicitly choosing a lossy behavior.

## Synthetic fixture caveats

The synthetic Markdown is the committed fixture snapshot repeated 24 times. It is deliberately
very repetitive, so its 7.7% reduction in all three compression modes is not a prediction for
real sessions. Timing depends on machine load, Node and jsdom. The 2.98× serializer result is only for the small fixture and does not validate the plan's 6–8× target on `Archive.zip`; the 3.46× token result
does not validate a 10× target either. The measured no-sentinel path exceeds the plan's `<50 ms`
target by design: it uses a 150 ms observation plus a 100 ms quiet settle. Optimizing it further
requires balancing speed against silent late legacy pagination.

## What is verified

- Synchronous and four-message windowed serializers produce byte-identical fixture output after
  substituting the dynamic export timestamp; options with timestamps and without tool activity
  are compared too. Tests reject DOM cloning and check that only exporter-opened panels are closed.
- Automated tests cover sentinel and legacy pagination, cancellation, popup disconnect/reopen,
  progress, multiple jobs, icon states, stale session restoration, lost ports, retries, missing or
  duplicate chunks, split Unicode surrogate pairs, and IndexedDB failure. `fake-indexeddb` tests
  the shared store and atomic transactions; these are not a substitute for full browser MV3 tests.
- The shared result store was also checked manually against real Chromium IndexedDB in an isolated
  headless **file-origin** profile: save, read-back, metadata read and clear succeeded. A dedicated
  worker was checked separately in headless Chromium using a blob-backed worker. These checks do
  not establish extension-origin behavior or a complete live Arena export.
- The compression tests cover Unicode token parity, file-read/stdout pairing, real execution errors,
  distinct file versions and ranges, repeated-line reconstruction, intact duplicate anchors,
  exact byte counts, and monotonic output size across modes.

## Remaining validation and limitations

- The static Archive snapshot has now been measured in jsdom (above); real browser memory,
  the expansion pipeline, main-thread behavior and the 25–45% compression target are **not**
  established by that measurement.
- The user reports manually checking the installed extension end-to-end in Chrome, including
  popup close/reopen, cancellation, saving and downloading. No detailed test log or browser
  performance profile was captured. The earlier automated headless launch did not load the
  unpacked extension; mocks and file-origin checks are not full MV3 integration tests.
- A four-message window limits panels opened by the exporter, not the size of one message or panels
  the user had already opened. Individual large Markdown conversions can still block synchronously.
- A marker-free legacy page which starts loading silently only after the initial probe can be
  mistaken for a fully loaded page. A visible stuck loader or remaining sentinel produces a warning.
- The completed result is retained until acknowledged; disconnections are retried at most five
  times. If retries are exhausted, retake the snapshot while the Arena tab is still open. The
  transfer guard raised to 128 Mi UTF-16 code units in Wave 2.1; it is a code-unit ceiling, not an
  exact 128 MiB UTF-8 limit.

## Wave 3.2: iterative (zero-generator) serializer walk

Issue #22 replaced the recursive `function*` / `yield*` message walk with an explicit frame stack
shared by the synchronous and cooperative async serializers, amortised the async budget check to
one clock read per 64 visited nodes, removed the `.filter(...).map(...)` arrays from `fileChip`,
and changed `footerSet` to climb from each `<time>` to the nearest `Copy`-bearing ancestor instead
of running four full-subtree selectors per ancestor. `npm run benchmark` additionally verifies
sync↔async parity on the fixture for every option combination.

Measured on the agent sandbox (Node 20.20.2, jsdom, Intel Xeon @ 2.6 GHz), median of fresh-DOM
runs, output byte-identical to the pre-change serializer after normalizing the export timestamp:

| Measurement | Before (generator walk) | After (iterative walk) | Notes |
|---|---:|---:|---|
| `AREX.serialize`, 73,524-element page (fixture ×4), 5 fresh processes | 242.2 ms | 218.1–234.6 ms | ~1.04–1.11×; output byte-identical |
| Sync / async walk, 73,524-element generated transcript | 1,004 / 330 ms | 914 / 257 ms | 1.10× / 1.29×; output byte-identical |
| `footerSet`, 9-message fixture | 3.35 ms | ~1.4 ms | Per-`<time>` ancestry instead of per-node selector scans |

These are jsdom numbers: the remaining time is dominated by jsdom's CSS engine (`matches`), DOM
accessors and GC, so the absolute speedup understates the browser effect of removing per-element
generator suspension and resume. A real Chrome page was not measured for this change.

## Wave 4.1: integration gate and the large-page benchmark

The Wave 4 gate does not change the pipeline; it wires the stress benchmark into npm scripts
(`npm run benchmark:large`), pins the cross-module version handshake with tests, and records the
large-page numbers below. Reproduce with `npm ci && npm test && npm run benchmark &&
npm run benchmark:large`.

### Large-page stress benchmark (`scripts/benchmark-large-page.mjs`)

Synthetic transcript: 120 turns, 2,400 spoilers (19 leaves per group: command/stdout cards, file
chips, nested groups), four-message windows, continuous token streaming on the final turn. Budget
is 5 s; the script exits non-zero if any invariant regresses. Node 20.20.2, jsdom, Intel Xeon
@ 2.6 GHz:

| Measurement | Value | Notes |
|---|---:|---|
| Synthetic page build | 176.8 ms | 85 k DOM elements; 120 collapsed controls |
| Whole windowed export (expand → serialize → cleanup) | 3,283 ms over 30 windows | 2,400 spoilers opened, 120 messages |
| Per-window expand | p50 63.4 ms · p95 103.7 ms · max 149.5 ms | includes local `settle()` |
| Per-message serialize | p50 3.1 ms · p95 7.0 ms · max 12.3 ms | cooperative walker |
| Per-window cleanup | p50 16.2 ms · p95 29.9 ms · max 37.0 ms | ancestor-pruned collapse |
| Cleanup DOM clicks | **120** for 2,400 opened controls | 2,280 controls closed by their parent — a 20× click reduction |
| Heap delta / peak | 2.7 MiB / 29.0 MiB | `process.memoryUsage().heapUsed` |
| Compression index + mode | 171 ms, 339,914 B in/out | single 1 MiB chunk transfer, reassembled exactly |
| Diagnostic log snapshots | 912 B @ 0 % → 1,518 B @ 50 % → 6,759 B @ done | bounded bundle stays KB-scale |

Caveats: jsdom and a synthetic page — the numbers scope the *pipeline*, not real Chrome latency or
real Arena markup. Streaming is simulated with text-node mutations, which is precisely the pattern
`settle()` must ignore; a real page can mount heavier subtrees.

### Recorded regression benchmark (`npm run benchmark`)

Same sandbox, median of three runs after a warm-up: synchronous serializer 54.0 ms on the 545,831 B
fixture (byte parity with the committed snapshot), cooperative async walker 38.0 ms (same bytes),
6.35× faster than the pre-windowing baseline `73a0cbb` (342.6 ms). Token estimate 81.6 ms vs
304.0 ms baseline (3.73×); index build 115.9 ms; no-sentinel history probe 258.3 ms.

### Integration matrix (`test/integration-gate.test.mjs`)

The gate boots the real `background.js` coordinator against the real v2 result store on
fake-indexeddb and drives a synthetic three-tab matrix. Six tests, stable across repeated runs
(~1.7 s total):

- Tab A (`branch-1`, done) + Tab B (`branch-2`, idle → running → stopped) + Tab C (`example.com`):
  every scope reads only its own job and snapshot; a non-Arena tab gets neither.
- Same-tab SPA `/agent/branch-1` → `/agent/branch-2`: the in-flight scan is cancelled and the new
  branch starts with a clean scope and no inherited snapshot.
- Stop during history paging (nothing serialized yet): the job ends as `error`, the transfer is not
  acknowledged, and no snapshot is written — no empty "partial" file.
- Stop after K windows: exactly the serialized prefix is persisted with `partial`,
  `completedMessages` and `totalMessages`, and only then ACKed.
- `AREX_EXPORT_LOG` answers at idle, running (with live progress), stopped (partial metadata),
  error and done, always with `schemaVersion: 1` and the shipped tool version.
- The full windowed pipeline on the committed fixture still matches
  `test/snapshots/fixture-expected.md` byte for byte with zero warnings.

Not covered by Node tests: real Chrome MV3 service-worker lifetimes, actual popup rendering, and a
live Arena page. Those remain manual checks.

### Flake hardening

Two timing-sensitive assertions used to fail intermittently on shared runners and produced red CI
twice during this wave while every local median passed. They were tightened, not weakened:

- `test/markdown.test.mjs` — the 5 MB `mdFence` case now takes the **best of five** runs instead of a
  single wall-clock sample. A one-off 27.6 ms scheduling hiccup no longer fails a linear implementation
  whose real cost is ~13 ms; a genuine complexity regression makes all five runs slow.
- `test/result-store.test.mjs` (LRU eviction) was **not modified**. It passes in isolation (18/18
  runs) and across six consecutive full-suite runs after the change above, so the earlier
  intermittent failures are attributed to CPU contention in the shared `node --test` process pool
  rather than to a storage defect — a hypothesis consistent with every observed pass/fail pattern,
  but not proven. If it recurs, capture `node --test test/result-store.test.mjs` output together
  with the failing assertion before touching the store.

## Compression v2 end to end (epic #1, Wave 4.1)

Recorded 2026-11-26 for version 0.6.0, after the last wave wired the whole pipeline into
`AREX.compressIndex` (Lossless → Smart log stage → scripts and diffs → line references → tight
budget → framing → reasoning; see `docs/architecture.md`). Reproduce with
`npm ci && npm test && npm run benchmark && node scripts/benchmark-compression.mjs`; pass
`--strict` to make a missed Worker budget fatal, or pass saved `.md` exports (files or directories)
to measure real transcripts locally — only aggregate numbers are printed.

**Methodology change.** `scripts/benchmark-compression.mjs` now loads the modules in `popup.html`
order into the main context, which behaves like a Worker's global scope. Inside a
`vm.createContext` sandbox, hot loops that touch globals (`Math.imul` in the Lossless hash) run about
60× slower, so the earlier indexed-mode timings in this file (taken in such a sandbox) inflate
compression latency and are not comparable with the table below. `npm run benchmark` and
`benchmark:archive` still use sandboxes for like-for-like comparison with their baseline ref.

Node 22.23.1, linux x64, Intel Xeon @ 2.6 GHz (a cloud sandbox, not the owner's Mac); median of
three to five runs after a warm-up. Worker message round trips and browser memory are not measured.

### Synthetic coding session (`test/fixtures/synthetic-coding-session.mjs`, 519,931 B, 125,723 est. tokens)

| Mode | Bytes | Tokens | Saved | Worker time |
|---|---:|---:|---:|---:|
| Lossless | 444,553 | 106,950 | 14.50 % | 5.5 ms |
| Smart, reasoning on (default) | 238,992 | 58,598 | **54.03 %** | 18.8 ms |
| Stubs, reasoning on (default) | 218,288 | 53,929 | **58.02 %** | 16.3 ms |
| Smart, reasoning kept | 340,421 | 81,067 | 34.53 % | 15.4 ms |
| Stubs, reasoning kept | 336,692 | 80,172 | 35.24 % | 12.9 ms |

The fixture is 26 % Thought, 47 % stdout, 19 % commands and 7 % framing by bytes. Before the wiring the
same code reached 14.5 % / 20.9 % / 21.6 % (Lossless / Smart / Stubs) with Smart and Stubs at 40.5 % and
44.4 % once reasoning was condensed. All four invariants of the benchmark hold in every mode and toggle
state: every User turn, the final assistant answer, every diagnostic line and every `exit ≠ 0` heading
survive; `Off ≥ Lossless ≥ Smart ≥ Stubs` by bytes with and without the reasoning stage; all four Stubs
references are sound.

### Worker work on a ~3.5 MB snapshot (seven distinct copies of the fixture, 3,771,783 B)

| Step | Time | Saved |
|---|---:|---:|
| Index build, once per snapshot at INIT | 94–100 ms | — |
| Lossless | 20–26 ms | 14.74 % |
| Smart (including reasoning) | 79 ms | 54.36 % |
| Stubs (including reasoning) | 98–99 ms | 58.27 % |
| Reasoning toggle on a cached base | 19 ms | — |

The budget is 120 ms per mode, and both lossy modes are within it with roughly 20 % margin on this
slower machine (a 3.5 MB snapshot is about 7 % smaller than this input). Getting there took three
changes inside `compress.js`: the exact token delta of the span-edit passes instead of two full-document
re-estimates, a table-driven `estimateTokens` that is bit-identical to the old formula (checked on
200,000 random strings) and about a quarter faster, and one shared `DocumentIndex` for the guard and
the script stage.

### What the tests pin

`test/compress.test.mjs` runs 220 seeded multi-turn transcripts (`test/fixtures/random-transcript.mjs`:
long and wide output, terminal noise, passing and failing test runs, search hits, JSON, tracebacks,
compiler errors, stderr, diffs, scripts, reads, writes and drafts, with User and assistant code that
repeats earlier output) through every mode and toggle state: strict byte monotonicity with exact byte
and token accounting, User turns / answers / code in prose byte-identical, Lossless recoverable to the
original byte for byte, no diagnostic line or failing output shortened, every Stubs and draft reference
sound (unique anchor on the right side, range inside the source, lines repeated in the Smart output),
Thoughts exactly as exported when the toggle is off, and a broken optional stage degrading instead of
failing. Mutation checks confirm the tests fail without the protection, with an early tight budget,
with a clipped reference source, and with inexact token deltas. A separate randomized test pins
`spanTokenDelta` against full re-estimation.

The generated corpus also found a real defect that predates this wave: Stubs v2 matched *any* fence, so
a code block in a User message or a final answer could receive an anchor or be replaced by a reference
to earlier tool output. Block stages now skip every block inside a User turn or an assistant answer and
every bare fence that is not tool output.

### Caveats and known limitations

- The figures above are for a **synthetic** session. The epic's real-world target (35–55 % on long
  Arena sessions) was not re-measured: no real exports are in the repository. Run
  `node scripts/benchmark-compression.mjs <dir>` on saved exports to check it on your own data.
- Without the reasoning stage Smart and Stubs reach 34.5 % and 35.2 % on this fixture, so most of the
  gap between Lossless and the targets is Thought condensation (26 % of the bytes) and log budgets.
- The script and diff stage (`compress-commands.js`) only fires on runs whose heading says
  `exit 0`. Real Arena exports print an exit code only on failure (in
  `test/snapshots/fixture-expected.md`, 16 of 96 Bash headings carry `exit N` and none carry
  `exit 0`), so on real data that stage is currently inactive; the fixture shows 0 shortened scripts
  for the same reason. The tests exercise it with explicit `exit 0` headings. Treating a heading without
  an exit marker as success would activate it, which is a decision for that module's owner.
- A bare fence counts as tool output only directly under an activity heading or a 📄 card. Output
  that Arena splits into further unlabeled chunks is left alone, which can forgo a reference but never
  rewrites prose.
- Assistant prose that directly follows a Thought has no heading of its own and is treated as part of
  the Thought (its code can become a pointer to an identical later output); the final answer after the
  last activity is never touched.
- Latency was measured on a cloud CPU in Node, not in Chrome; the Worker round trip and structured
  clone of results are additional.
