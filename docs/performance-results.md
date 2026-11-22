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

## Supplied Archive.zip: actual large snapshot

A subsequent measurement used the supplied saved HTML (5,596,938 B), not the synthetic
fixture. The archive stays outside the repository; only aggregate data is recorded here. On the
same Intel i7-9750H Mac, Node 22.22.2, jsdom, baseline `73a0cbb`: median of 3 runs after one
warm-up. The saved DOM has 32,383 elements, including 31,329 in the transcript, 12 messages,
1,042 already expanded buttons and 1,155 fenced blocks. The URL is replaced with a fixed
benchmark URL, explaining the small difference in output bytes vs. the original plan.

| Measurement | Baseline | Current | Result |
|---|---:|---:|---|
| Synchronous serializer | 2,743.9 ms | 516.8 ms | **5.31×**; byte-identical after normalizing export timestamp |
| Build index | — | 78.7 ms | measured separately |
| Off | 302.3 ms / 1,612,422 B | 77.5 ms / 1,612,422 B | 0.00% reduction |
| Lossless | 309.4 ms / 1,612,422 B | 84.4 ms / 1,612,422 B | 0.00% reduction |
| Smart | 350.4 ms / 1,499,474 B | 90.6 ms / 1,470,678 B | 7.00% → **8.79%** reduction |
| Stubs | 593.2 ms / 1,495,753 B | 122.6 ms / 1,318,678 B | 7.24% → **18.22%** reduction |

Current compression times above **exclude** the separately measured index construction; baseline
mode times include their parsing. Numbers are not apples-to-apples cold end-to-end timings.
Current smart compacted 31 blocks; stubs also replaced 54 earlier reads/writes. Lossless found
no byte-identical eligible blocks. The asynchronous message walker produced the same Markdown
as synchronous serialization on the static snapshot. This does not measure the real windowed
expand/serialize/collapse pipeline or the 175 panels closed in the saved page.

The measured 5.31× falls short of the plan's 6–8× serializer target on this machine; the 8.79%
and 18.22% reductions fall short of the projected 25–45%. These targets therefore remain unmet
in this measurement, not verified outcomes. Times depend on the runtime and machine load.
To reproduce, extract the main saved HTML outside the repository and run
`npm run benchmark:archive -- /path/to/saved-page.html` (optional second argument: baseline git
ref). The benchmark does not execute page scripts and prints only aggregate measurements, but
the input itself may contain private conversation data: do not commit it or paste it into logs.

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
  heredoc overwrites, exact byte counts, and monotonic output size across modes.

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
  transfer guard is 64 Mi UTF-16 code units, not an exact 64 MiB UTF-8 limit.
