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

The synthetic Markdown is the committed fixture snapshot repeated 24 times. It is deliberately
very repetitive, so its 7.7% reduction in all three compression modes is not a prediction for
real sessions. Timing depends on machine load, Node and jsdom. The 2.98× serializer result does
not validate the plan's 6–8× target on its 1.6 MB `Archive.zip` example; the 3.46× token result
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

- The `Archive.zip` dataset from the plan was not supplied for this run. Its actual speedup,
  25–45% compression target, very large DOM memory footprint, and browser main-thread behavior
  have **not** been measured.
- The installed unpacked extension was not exercised end-to-end against a logged-in Arena session
  in this run. A headless Google Chrome launch did not load the unpacked extension from CLI flags;
  do not infer full MV3 lifecycle coverage from the mocks or separate file-origin IndexedDB check.
- A four-message window limits panels opened by the exporter, not the size of one message or panels
  the user had already opened. Individual large Markdown conversions can still block synchronously.
- A marker-free legacy page which starts loading silently only after the initial probe can be
  mistaken for a fully loaded page. A visible stuck loader or remaining sentinel produces a warning.
- The completed result is retained until acknowledged; disconnections are retried at most five
  times. If retries are exhausted, retake the snapshot while the Arena tab is still open. The
  transfer guard is 64 Mi UTF-16 code units, not an exact 64 MiB UTF-8 limit.
