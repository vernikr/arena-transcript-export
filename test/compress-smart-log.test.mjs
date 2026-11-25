import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { makeEnv } from './harness.mjs';
import {
  generateSyntheticCodingSession,
  extractInvariants,
} from './fixtures/synthetic-coding-session.mjs';

const INDEX_SRC = readFileSync(new URL('../extension/content/compress-index.js', import.meta.url), 'utf8');
const SMART_LOG_SRC = readFileSync(new URL('../extension/content/compress-smart-log.js', import.meta.url), 'utf8');

function loadBare({ withIndex = false } = {}) {
  const ctx = vm.createContext({});
  if (withIndex) vm.runInContext(INDEX_SRC, ctx, { filename: 'compress-index.js' });
  vm.runInContext(SMART_LOG_SRC, ctx, { filename: 'compress-smart-log.js' });
  return ctx.AREX;
}

const bt = String.fromCharCode(96);
const fence = (body, lang = 'text') => bt.repeat(3) + lang + '\n' + body + '\n' + bt.repeat(3);
const bashSection = ({ heading = 'used Bash 120ms', command = 'echo ok', stdout = null, stderr = null }) => {
  const parts = [
    '#### ' + heading,
    '**command:**\n\n' + fence('$ ' + command, 'bash'),
  ];
  if (stdout !== null) parts.push('**stdout:**\n\n' + fence(stdout, 'text'));
  if (stderr !== null) parts.push('**stderr:**\n\n' + fence(stderr, 'text'));
  return parts.join('\n\n');
};

test('loads standalone in a bare worker-like VM context and alongside window scripts', () => {
  const bare = loadBare({ withIndex: false });
  assert.equal(typeof bare.hasExecutionDiagnostic, 'function');
  assert.equal(typeof bare.analyzeExecutionDiagnostics, 'function');
  assert.equal(typeof bare.clipWideLine, 'function');
  assert.equal(typeof bare.clipWideStdoutLines, 'function');
  assert.equal(typeof bare.compactStdout, 'function');
  assert.equal(typeof bare.compactStdoutBlock, 'function');
  assert.equal(typeof bare.compactSmartLogs, 'function');
  assert.equal(bare.SMART_LOG_BUDGETS.smart.maxLineChars, 240);
  assert.equal(bare.SMART_LOG_BUDGETS.stubs.maxLineChars, 160);

  const { dom, AREX } = makeEnv();
  vm.runInContext(INDEX_SRC, dom.getInternalVMContext(), { filename: 'compress-index.js' });
  vm.runInContext(SMART_LOG_SRC, dom.getInternalVMContext(), { filename: 'compress-smart-log.js' });
  assert.equal(typeof AREX.buildDocumentIndex, 'function');
  assert.equal(typeof AREX.buildMarkdownIndex, 'function');
  assert.equal(typeof AREX.hasExecutionDiagnostic, 'function');
  dom.window.close();
});

test('hasExecutionDiagnostic detects non-zero exit headings, shell error, and error-bearing stderr', () => {
  const AREX = loadBare({ withIndex: true });

  const nonZeroMd = '## 🤖 Assistant\n\n' + bashSection({
    heading: 'Used Bash exit 2 45ms',
    command: 'ls missing',
    stdout: 'clean looking line\n'.repeat(20),
  });
  const idx1 = AREX.buildDocumentIndex(nonZeroMd);
  const out1 = idx1.blocks.find(b => b.label === 'stdout');
  assert.equal(AREX.hasExecutionDiagnostic(out1, idx1), true);
  assert.equal(AREX.hasExecutionDiagnostic({ body: 'ok', activity: 'Used Bash shell error' }), true);
  assert.equal(AREX.hasExecutionDiagnostic({ body: 'ok', exitStatus: 127 }), true);

  // Paired real warning/error stderr flags stdout as error-bearing.
  const stderrMd = '## 🤖 Assistant\n\n' + bashSection({
    heading: 'used Bash 30ms',
    command: 'cat partial.py',
    stdout: 'x = 1\n'.repeat(40),
    stderr: 'warning: failed to read entire file',
  });
  const idx2 = AREX.buildDocumentIndex(stderrMd);
  const out2 = idx2.blocks.find(b => b.label === 'stdout');
  assert.equal(AREX.hasExecutionDiagnostic(out2, idx2), true);
  assert.equal(AREX.hasExecutionDiagnostic({ body: 'x = 1', pairedCommand: { hasStderr: true } }), true);

  // Purely benign curl progress table on stderr does not block clean JSON stdout compaction.
  const curlMd = '## 🤖 Assistant\n\n' + bashSection({
    heading: 'used Bash exit 0 180ms',
    command: 'curl https://api.example.test/graphql',
    stdout: '{"data":{"items":[' + '"item",'.repeat(600) + '"last"]}}',
    stderr: [
      '  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current',
      '                                 Dload  Upload   Total   Spent    Left  Speed',
      '100 13600  100 13600    0     0  95000      0 --:--:-- --:--:-- --:--:-- 95000',
    ].join('\n'),
  });
  const idxCurl = AREX.buildDocumentIndex(curlMd);
  const outCurl = idxCurl.blocks.find(b => b.label === 'stdout');
  assert.equal(AREX.hasExecutionDiagnostic(outCurl, idxCurl), false);
});

test('hasExecutionDiagnostic matches real tracebacks, pytest failures, CLI & compiler errors on exit 0 / unreported stdout', () => {
  const AREX = loadBare({ withIndex: true });

  const realDiagnostics = [
    'Traceback (most recent call last):\n  File "src/app.py", line 14, in main\n    run()\nValueError: invalid size',
    'Traceback (most recent call last):\n  File "test_a.py", line 8, in test_x\n    assert False\nAssertionError',
    '=========================== FAILURES ===========================\n___ test_foo ___',
    '============================ ERRORS ============================\n_ ERROR collecting tests/test_bad.py _',
    'FAILED tests/test_widget.py::test_invalid_size - ValueError: bad size',
    'tests/test_widget.py::test_invalid_size FAILED [ 99%]',
    'E   TypeError: expected str, got int',
    '1 failed, 83 passed in 12.34s',
    'not ok 3 - background port reconnect',
    'npm ERR! code ELIFECYCLE',
    'fatal: not a git repository (or any of the parent directories): .git',
    'panic: runtime error: index out of range [3] with length 3',
    "thread 'main' panicked at src/lib.rs:42:9:",
    'cat: missing.py: No such file or directory',
    "ls: cannot access 'build/out': No such file or directory",
    'bash: line 1: rg: command not found',
    '/bin/sh: 1: pytest: not found',
    'curl: (7) Failed to connect to localhost:8080: Connection refused',
    'SyntaxError: Unexpected token } in JSON at position 42',
    'TypeError: Cannot read properties of undefined (reading "map")',
    'Error: compilation failed\n    at build (src/build.ts:12:3)',
    'error[E0382]: borrow of moved value: `buf`',
    'src/parser.c:42:10: error: expected ";" before "}" token',
    'src/widget.py:88: error: Incompatible return value type  [return-value]',
    'src/index.ts(19,7): error TS2322: Type "number" is not assignable to type "string".',
    'src/index.ts:19:7 - error TS2322: Type "number" is not assignable to type "string".',
    '\u001b[31mFAILED tests/test_color.py::test_ansi\u001b[0m',
  ];

  for (const sample of realDiagnostics) {
    assert.equal(
      AREX.hasExecutionDiagnostic({ label: 'stdout', body: 'setup ok\n' + sample }),
      true,
      'expected diagnostic match for:\n' + sample
    );
  }
});

test('hasExecutionDiagnostic ignores source-code identifiers, raise/class statements, grep matches & clean JSON', () => {
  const AREX = loadBare({ withIndex: true });

  const cleanSourceRead = [
    'class W0Error(Exception):',
    '    """Custom exception class."""',
    '    pass',
    '',
    'class MyError extends Error {',
    '  constructor(msg) { super(msg); this.pointError = null; }',
    '}',
    '',
    'def validate(payload, allow_failed_volume=False):',
    '    error_count = 0',
    '    if payload is None:',
    '        raise ValueError("payload required")',
    '    try:',
    '        return process(payload)',
    '    except (WidgetError, RuntimeError) as err:',
    '        throw_if_fatal(err)',
  ].join('\n');
  assert.equal(AREX.hasExecutionDiagnostic({
    label: 'stdout',
    body: cleanSourceRead,
    exitStatus: 0,
    pairedCommand: { body: '$ cat src/validator.py', hasStderr: false },
  }), false);

  const numberedRead = cleanSourceRead
    .split('\n')
    .map((l, i) => String(i + 1).padStart(5, ' ') + '\t' + l)
    .join('\n');
  assert.equal(AREX.hasExecutionDiagnostic({
    label: 'stdout',
    body: numberedRead,
    pairedCommand: { body: '$ cat -n src/validator.py', hasStderr: false },
  }), false);

  const grepHits = [
    'src/widget.py:18:        self.error_count = 0  # tracks failures across retries',
    'src/widget.py:19:        self.pointError = None  # last error seen',
    'src/widget.py:87:            raise ValueError("invalid widget size")',
    'src/errors.py:12: error: internal comment inside grep hit',
    'tests/test_widget.py:44:    # error path: invalid size must raise WidgetError',
  ].join('\n');
  assert.equal(AREX.hasExecutionDiagnostic({
    label: 'stdout',
    body: grepHits,
    pairedCommand: { body: '$ grep -rn "error" src/ tests/', hasStderr: false },
  }), false);

  const cleanJson = JSON.stringify({
    error: null,
    errors: [],
    allow_failed_volume: true,
    data: {
      issues: Array.from({ length: 40 }, (_, i) => ({
        id: 'I_' + i,
        title: `Fix TypeError and ValueError in handler ${i}`,
        state: 'OPEN',
      })),
    },
  });
  assert.equal(AREX.hasExecutionDiagnostic({ label: 'stdout', body: cleanJson, exitStatus: 0 }), false);

  const cleanPytest = [
    'tests/test_widget.py ............................ [ 50%]',
    'tests/test_client.py ............................ [100%]',
    '================ 56 passed, 1 xfailed, 2 warnings in 3.41s ================',
  ].join('\n');
  assert.equal(AREX.hasExecutionDiagnostic({ label: 'stdout', body: cleanPytest }), false);
});

test('wide-line clipping trims >240 chars in Smart and >160 chars in Stubs while skipping markers and errors', () => {
  const AREX = loadBare();

  // 13.6 KB single-line GraphQL JSON response.
  const graphql = '{"data":{"repository":{"issues":[' +
    Array.from({ length: 120 }, (_, i) =>
      `{"id":"IC_${i}","title":"Widget issue ${i} with pointError field","error":null,"url":"https://github.com/example/repo/issues/${i}"}`
    ).join(',') + ']}}}';
  assert.ok(Buffer.byteLength(graphql) > 13000);

  const smart = AREX.compactStdout(graphql, { mode: 'smart' });
  const stubs = AREX.compactStdout(graphql, { mode: 'stubs' });
  assert.equal(smart.changed, true);
  assert.equal(stubs.changed, true);
  assert.match(smart.body, /^.{240} … \[\+\d+ chars\]$/);
  assert.match(stubs.body, /^.{160} … \[\+\d+ chars\]$/);
  assert.equal(240 + Number(/\[\+(\d+) chars\]$/.exec(smart.body)[1]), graphql.length);
  assert.equal(160 + Number(/\[\+(\d+) chars\]$/.exec(stubs.body)[1]), graphql.length);
  assert.ok(stubs.bytesAfter < smart.bytesAfter);
  assert.ok(smart.bytesAfter < 300);

  // Chaining Smart -> Stubs yields exact same line and [+N chars] count as direct Stubs.
  const chained = AREX.compactStdout(smart.body, { mode: 'stubs' });
  assert.equal(chained.body, stubs.body);

  // Existing `[...` markers and anchors are never clipped even when >240 chars.
  const markerLine = '[... identical to lines 1–120 of earlier output #arex-stubs-output-42 ' + 'x'.repeat(260) + ' ...]';
  assert.equal(AREX.clipWideLine(markerLine, 160), markerLine);

  // Borderline 245-char line is not expanded by adding a 16-byte suffix.
  const borderline = 'a'.repeat(245);
  assert.equal(AREX.clipWideLine(borderline, 240), borderline);

  // Surrogate pairs across the 240/160 boundary never produce lone surrogates.
  const withSurrogateAtBoundary = 'a'.repeat(239) + '🌍' + 'b'.repeat(100);
  const clippedEmoji = AREX.clipWideLine(withSurrogateAtBoundary, 240);
  assert.equal(clippedEmoji, 'a'.repeat(239) + ' … [+102 chars]');
  assert.doesNotMatch(clippedEmoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);

  // Error blocks never have wide diagnostic lines clipped.
  const wideError = 'TypeError: ' + 'very_long_type_mismatch_detail_'.repeat(15);
  const errRes = AREX.compactStdout(wideError, { mode: 'stubs' });
  assert.equal(errRes.hasDiagnostic, true);
  assert.equal(errRes.body, wideError);
});

test('dual byte-and-line budget compacts Smart (>2,200 B or >55 lines) and Stubs (>1,000 B or >28 lines) within byte caps', () => {
  const AREX = loadBare();

  // 1) Line-triggered narrow block in Smart: 70 lines * 22 B (~1,540 B < 2,200 B, > 55 lines).
  const narrow70 = Array.from({ length: 70 }, (_, i) => `narrow step ${String(i).padStart(3, '0')} ok`).join('\n');
  assert.ok(Buffer.byteLength(narrow70) < 2200);
  const smartNarrow = AREX.compactStdout(narrow70, { mode: 'smart' });
  assert.equal(smartNarrow.changed, true);
  const smartNarrowLines = smartNarrow.body.split('\n');
  assert.equal(smartNarrowLines.length, 20 + 1 + 12);
  assert.equal(smartNarrowLines[0], 'narrow step 000 ok');
  assert.equal(smartNarrowLines[19], 'narrow step 019 ok');
  assert.match(smartNarrowLines[20], /^\[\.\.\. omitted 38 middle lines/);
  assert.equal(smartNarrowLines[21], 'narrow step 058 ok');
  assert.equal(smartNarrowLines[32], 'narrow step 069 ok');

  // 2) Byte-triggered medium block in Smart: 40 lines <= 55 lines, ~2,880 B > 2,200 B.
  const medium40 = Array.from({ length: 40 }, (_, i) =>
    `src/module_${String(i).padStart(2, '0')}.py:${i + 10}:    def compute_value_${i}(payload): return payload`
  ).join('\n');
  assert.ok(Buffer.byteLength(medium40) > 2200);
  const smartMed = AREX.compactStdout(medium40, { mode: 'smart', context: { exitStatus: 0 } });
  assert.equal(smartMed.changed, true);
  assert.ok(smartMed.bytesAfter <= 2400, `expected <= 2400 B, got ${smartMed.bytesAfter}`);
  assert.match(smartMed.body, /exit 0; no error markers detected/);

  // 3) Wide 40-line grep -rn block of ~15 KB is capped to <= 2,400 B in Smart and <= 1,200 B in Stubs.
  const wideGrep40 = Array.from({ length: 40 }, (_, i) =>
    `packages/service/src/deeply/nested/path/handler_${i}.py:${100 + i}:    ` +
    'result = transform_widget_payload_with_retry_policy(request_context, ' + 'x'.repeat(290) + ')'
  ).join('\n');
  assert.ok(Buffer.byteLength(wideGrep40) > 15000);
  const smartWide = AREX.compactStdout(wideGrep40, { mode: 'smart' });
  const stubsWide = AREX.compactStdout(wideGrep40, { mode: 'stubs' });
  assert.ok(smartWide.bytesAfter <= 2400, `Smart wide block ${smartWide.bytesAfter} B exceeded 2,400 B cap`);
  assert.ok(stubsWide.bytesAfter <= 1200, `Stubs wide block ${stubsWide.bytesAfter} B exceeded 1,200 B cap`);
  assert.ok(stubsWide.bytesAfter < smartWide.bytesAfter);

  // 4) Stubs 10 head + 6 tail on clean 40-line narrow output (> 28 lines, > 1,000 B),
  //    plus exact omitted-line accounting when chained after Smart.
  const clean100 = Array.from({ length: 100 }, (_, i) => `clean read line ${String(i).padStart(3, '0')} = ${i}`).join('\n');
  const smart100 = AREX.compactStdout(clean100, { mode: 'smart' });
  const stubsDirect = AREX.compactStdout(clean100, { mode: 'stubs' });
  const stubsChained = AREX.compactStdout(smart100.body, { mode: 'stubs' });
  assert.equal(stubsDirect.body.split('\n').length, 10 + 1 + 6);
  assert.match(stubsDirect.body, /\[\.\.\. omitted 84 middle lines/);
  assert.equal(stubsChained.body, stubsDirect.body);

  // 5) Clean code reads with `raise ValueError` and `class MyError` are compacted properly.
  const cleanCodeLines = Array.from({ length: 90 }, (_, i) =>
    i % 10 === 0
      ? `class MyError${i}(Exception): pass`
      : `    if x == ${i}: raise ValueError("invalid ${i}")`
  ).join('\n');
  const compactedCode = AREX.compactStdout(cleanCodeLines, { mode: 'smart', context: { exitStatus: 0 } });
  assert.equal(compactedCode.hasDiagnostic, false);
  assert.equal(compactedCode.changed, true);
  assert.match(compactedCode.body, /omitted 58 middle lines/);
});

test('error after >100 clean preamble lines preserves 15 head lines and >=80-line full failure window through EOF', () => {
  const AREX = loadBare();

  const preamble = Array.from({ length: 260 }, (_, i) => `[setup ${i}] building module_${i}.o ... ok`);
  const traceback = [
    '=================================== FAILURES ===================================',
    '______________________________ test_retry_policy _______________________________',
    'Traceback (most recent call last):',
    '  File "tests/test_widget.py", line 91, in test_retry_policy',
    '    service.run({"size": -5})',
    '  File "src/widget.py", line 42, in run',
    '    raise WidgetError("negative size")',
    'E   WidgetError: negative size',
    '=========================== short test summary info ============================',
    'FAILED tests/test_widget.py::test_retry_policy - WidgetError: negative size',
    '======================== 1 failed, 259 passed in 9.12s =========================',
  ];
  const full = preamble.concat(traceback).join('\n');

  const smart = AREX.compactStdout(full, { mode: 'smart' });
  const stubs = AREX.compactStdout(full, { mode: 'stubs' });
  assert.equal(smart.hasDiagnostic, true);
  assert.equal(smart.changed, true);
  assert.equal(smart.kind, 'diagnostic_preamble_trimmed');
  assert.equal(stubs.body, smart.body);

  // Idempotent on second pass.
  assert.equal(AREX.compactStdout(smart.body, { mode: 'smart' }).body, smart.body);

  const outLines = smart.body.split('\n');
  // First 15 head lines preserved verbatim.
  assert.deepEqual(outLines.slice(0, 15), preamble.slice(0, 15));
  assert.match(outLines[15], /^\[\.\.\. omitted \d+ clean preamble lines \(diagnostic window preserved below\) \.\.\.\]$/);

  // Tail window after the marker is >= 80 lines and contains every single traceback/failure line verbatim.
  const preservedWindow = outLines.slice(16);
  assert.ok(preservedWindow.length >= 80, `expected >= 80 lines in diagnostic window, got ${preservedWindow.length}`);
  for (const diagLine of traceback) {
    assert.ok(preservedWindow.includes(diagLine), 'missing diagnostic line: ' + diagLine);
  }

  // Error within the first <= 100 lines is preserved 100% verbatim without any omission marker.
  const earlyError = preamble.slice(0, 50).concat(traceback, preamble.slice(50, 180)).join('\n');
  const earlyRes = AREX.compactStdout(earlyError, { mode: 'smart' });
  assert.equal(earlyRes.body, earlyError);
  assert.equal(earlyRes.changed, false);

  // Non-zero exit without recognizable stdout diagnostic lines keeps 100% of stdout verbatim.
  const opaqueExit2 = AREX.compactStdoutBlock({
    label: 'stdout',
    body: preamble.slice(0, 180).join('\n'),
    exitStatus: 2,
  }, { mode: 'smart' });
  assert.equal(opaqueExit2.changed, false);
  assert.equal(opaqueExit2.body, preamble.slice(0, 180).join('\n'));
});

test('compactSmartLogs integrates with DocumentIndex + applySpanEdits and preserves all synthetic-session invariants', () => {
  const AREX = loadBare({ withIndex: true });
  const raw = generateSyntheticCodingSession();
  const baseInv = extractInvariants(raw);
  const index = AREX.buildDocumentIndex(raw);

  // Collect all immutable spans (User turns + Assistant prose answer spans).
  const protectedSpans = [];
  for (const turn of index.turns) {
    if (turn.immutable) {
      protectedSpans.push({ start: turn.startOffset, end: turn.endOffset });
    } else {
      for (const span of turn.answerSpans) {
        protectedSpans.push({ start: span.startOffset, end: span.endOffset });
      }
    }
  }

  const smartPlan = AREX.compactSmartLogs(index, { mode: 'smart' });
  const stubsPlan = AREX.compactSmartLogs(index, { mode: 'stubs' });
  assert.ok(smartPlan.stats.blocksCompacted > 0);
  assert.ok(stubsPlan.stats.blocksCompacted >= smartPlan.stats.blocksCompacted);

  const smartApplied = AREX.applySpanEdits(raw, smartPlan.edits, protectedSpans);
  const stubsApplied = AREX.applySpanEdits(raw, stubsPlan.edits, protectedSpans);

  assert.equal(smartApplied.bytes, Buffer.byteLength(smartApplied.markdown));
  assert.equal(stubsApplied.bytes, Buffer.byteLength(stubsApplied.markdown));
  assert.ok(smartApplied.bytes < index.bytes, 'Smart must reduce total bytes');
  assert.ok(stubsApplied.bytes < smartApplied.bytes, 'Stubs must reduce bytes further than Smart');

  for (const [mode, out] of [['smart', smartApplied.markdown], ['stubs', stubsApplied.markdown]]) {
    const inv = extractInvariants(out);
    assert.deepEqual(inv.userTurns, baseInv.userTurns, `${mode}: User turns must stay 100% intact`);
    assert.equal(inv.finalAssistant, baseInv.finalAssistant, `${mode}: final Assistant answer must stay byte-identical`);
    for (const diag of baseInv.diagnostics) {
      assert.ok(out.includes(diag), `${mode}: missing diagnostic line: ${diag}`);
    }
    for (const h of baseInv.exitHeadings) {
      assert.ok(out.includes(h), `${mode}: missing exit!=0 heading: ${h}`);
    }
  }
});

test('randomized fuzzing upholds strict Off >= Smart >= Stubs byte monotonicity and UTF-8 surrogate integrity', () => {
  const AREX = loadBare();
  let seed = 0x5EED2026;
  const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);

  const vocab = [
    '',
    'short ok',
    'class CustomError(Exception): pass',
    '  raise ValueError("simulated clean code")',
    '{"error":null,"status":"ok","items":[1,2,3]}',
    '🌍🚀✨ Unicode line with Кириллица and 漢字 '.repeat(8),
    'wide_payload_'.repeat(30),
    '[... identical to lines 1–20 of earlier output #arex-stubs-output-2 ...]',
    'Traceback (most recent call last):',
    'cat: missing_file.txt: No such file or directory',
    'src/core.c:12:4: error: undeclared identifier',
  ];

  for (let trial = 0; trial < 260; trial++) {
    const lineCount = 1 + (rand() % 180);
    const lines = [];
    for (let i = 0; i < lineCount; i++) {
      // Bias most blocks toward clean lines while mixing error blocks too.
      const poolLen = trial % 4 === 0 ? vocab.length : vocab.length - 3;
      const pick = vocab[rand() % poolLen];
      lines.push(pick + (rand() % 5 === 0 ? '_' + 'x'.repeat(rand() % 320) : ''));
    }
    const raw = lines.join('\n');
    const rawBytes = Buffer.byteLength(raw);
    const smart = AREX.compactStdout(raw, { mode: 'smart' });
    const stubs = AREX.compactStdout(raw, { mode: 'stubs' });

    assert.equal(smart.bytesAfter, Buffer.byteLength(smart.body));
    assert.equal(stubs.bytesAfter, Buffer.byteLength(stubs.body));
    assert.ok(smart.bytesAfter <= rawBytes, `trial ${trial}: Smart (${smart.bytesAfter}) > Raw (${rawBytes})`);
    assert.ok(stubs.bytesAfter <= smart.bytesAfter, `trial ${trial}: Stubs (${stubs.bytesAfter}) > Smart (${smart.bytesAfter})`);

    // Zero lone surrogates introduced.
    assert.doesNotMatch(smart.body, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    assert.doesNotMatch(stubs.body, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  }
});

test('remains linear O(N) on 3.5 MB multi-turn transcripts and 200 KB single-line JSON payloads', () => {
  const AREX = loadBare({ withIndex: true });

  // 200 KB single-line payload with colons/quotes (verifies zero quadratic regex backtracking).
  const giantLine = '{"data":[' + '"key:val:1234567890",'.repeat(10000) + '"end"]}';
  const t0 = performance.now();
  const singleRes = AREX.compactStdout(giantLine, { mode: 'smart' });
  const singleMs = performance.now() - t0;
  assert.equal(singleRes.changed, true);
  assert.ok(singleMs < 50, `200 KB single-line compaction took ${singleMs.toFixed(1)} ms`);

  // ~3.6 MB multi-turn session.
  const unit = generateSyntheticCodingSession();
  const largeMd = Array.from({ length: 7 }, () => unit).join('\n');
  assert.ok(Buffer.byteLength(largeMd) >= 3_500_000);
  const index = AREX.buildDocumentIndex(largeMd);
  // Warm-up once, then time.
  AREX.compactSmartLogs(index, { mode: 'smart' });
  const start = performance.now();
  const plan = AREX.compactSmartLogs(index, { mode: 'smart' });
  const elapsed = performance.now() - start;
  assert.ok(plan.stats.savedBytes > 500_000);
  assert.ok(elapsed < 120, `3.5 MB compactSmartLogs took ${elapsed.toFixed(1)} ms`);
});
