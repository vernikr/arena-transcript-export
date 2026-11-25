// Context-aware execution-error classifier, wide-line trimmer, and
// byte-budgeted head/tail compactor for Smart v2 and Stubs v2 stdout blocks
// (Wave 2.1).
//
// Runs unchanged in window, service-worker, and dedicated-worker contexts:
// the only global touched is `globalThis.AREX`.
globalThis.AREX = globalThis.AREX || {};

(function () {
  'use strict';

  // --- UTF-8 byte measurement (TextEncoder-exact, standalone-safe) ----------

  const NON_ASCII = /[^\x00-\x7F]/;
  const fallbackUtf8Bytes = value => {
    const str = String(value);
    if (!NON_ASCII.test(str)) return str.length;
    let bytes = 0;
    const n = str.length;
    for (let i = 0; i < n; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x80) bytes += 1;
      else if (c < 0x800) bytes += 2;
      else if (c >= 0xD800 && c <= 0xDBFF) {
        const d = str.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) { bytes += 4; i++; }
        else bytes += 3;
      } else {
        bytes += 3;
      }
    }
    return bytes;
  };
  const utf8Bytes = value =>
    typeof AREX.utf8Bytes === 'function' ? AREX.utf8Bytes(String(value)) : fallbackUtf8Bytes(value);

  // --- Mode budgets ---------------------------------------------------------

  const SMART_LOG_BUDGETS = Object.freeze({
    smart: Object.freeze({
      maxLineChars: 240,
      triggerBytes: 2200,
      triggerLines: 55,
      headLines: 20,
      tailLines: 12,
      maxOutputBytes: 2400,
    }),
    stubs: Object.freeze({
      maxLineChars: 160,
      triggerBytes: 1000,
      triggerLines: 28,
      headLines: 10,
      tailLines: 6,
      maxOutputBytes: 1200,
    }),
    errorPreamble: Object.freeze({
      minCleanPreambleLines: 100,
      headLines: 15,
      minDiagnosticWindowLines: 80,
      preDiagnosticContextLines: 40,
      minOmittedLines: 10,
    }),
  });

  // --- Terminal noise stripping (ANSI CSI/OSC, CR overwrites, spinners) -----

  const TERMINAL_NOISE_FAST_RE = /[\x1b\r⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
  const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;?]*[\x20-\x2f]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;
  const SPINNER_LINE_RE = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?:\s.*)?$/;

  function stripTerminalNoise(raw) {
    const text = String(raw);
    if (!TERMINAL_NOISE_FAST_RE.test(text)) return text.trimEnd();
    const ansi = text.replace(ANSI_ESCAPE_RE, '');
    const result = [];
    for (const sourceLine of ansi.replace(/\r\n/g, '\n').split('\n')) {
      let line = sourceLine;
      if (line.indexOf('\r') !== -1) {
        if (line.endsWith('\r')) continue;
        const segments = line.split('\r').filter(Boolean);
        line = segments.length ? segments[segments.length - 1] : '';
      }
      if (SPINNER_LINE_RE.test(line.trimStart())) continue;
      result.push(line);
    }
    return result.join('\n').trimEnd();
  }

  // --- Execution diagnostic classifier --------------------------------------

  // Explicit non-zero exit headings (`Used Bash exit 1`, `exit 128`, `shell error`).
  const NON_ZERO_HEADING_RE = /\bexit\s+(?:[1-9]\d*|-\d+)\b|\bshell\s+error\b/i;
  const EXPLICIT_EXIT_ZERO_RE = /\bexit\s+0\b/i;

  // Narrow allowlist of purely informational non-error stderr lines (curl
  // transfer tables, git clone progress, npm/pip upgrade notices). Any other
  // non-empty stderr line (warnings, tool errors, tracebacks, unknown messages)
  // is treated as error-bearing.
  const BENIGN_STDERR_LINE_RE = /^(?:%\s*Total\s+%\s*Received\b.*|\d{1,3}\s+\S+\s+\d{1,3}\s+\S+.*(?:--:--:--|\d+:\d{2}:\d{2})\s*\S*|Dload\s+Upload\s+Total\s+Spent\b.*|npm\s+notice\b.*|\[notice\]\s+A new release of pip\b.*|(?:Cloning into|Enumerating objects:|Counting objects:|Compressing objects:|Receiving objects:|Resolving deltas:|Updating files:)\b.*)$/;

  function hasErrorBearingStderr(stderrTexts) {
    for (let s = 0; s < stderrTexts.length; s++) {
      const cleaned = stripTerminalNoise(stderrTexts[s]).trim();
      if (!cleaned) continue;
      const lines = cleaned.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        if (!BENIGN_STDERR_LINE_RE.test(trimmed)) return true;
      }
    }
    return false;
  }

  // Pure grep/rg search invocations print `file:line:matched_source`, which
  // must not be confused with compiler `file:line: error:` diagnostics.
  const PURE_SEARCH_CMD_RE = /^\s*\$\s*(?:cd\s+(?:"[^"\n]+"|'[^'\n]+'|[^\s;&|]+)\s*&&\s*)?(?:grep|egrep|fgrep|rg)\b/;
  const COMPOUND_EXEC_RE = /&&|\|\||;|\n/;

  function isPureSearchCommand(commandBody) {
    if (!commandBody) return false;
    const text = String(commandBody).trim();
    const withoutCd = text.replace(/^\$\s*cd\s+(?:"[^"\n]+"|'[^'\n]+'|[^\s;&|]+)\s*&&\s*/, '$ ');
    if (COMPOUND_EXEC_RE.test(withoutCd.replace(/\|\|\s*true\s*$/, ''))) return false;
    return PURE_SEARCH_CMD_RE.test(text);
  }

  // Per-line diagnostic regexes (all anchored near line start and evaluated on
  // a bounded prefix so wide single-line payloads stay strictly O(1) per line).
  const MAX_DIAG_PROBE_LEN = 4096;
  const CAT_N_PREFIX_RE = /^\s*\d+\t/;

  // 1. Python tracebacks & chained-exception headers.
  const PY_TRACEBACK_RE = /^(?:E\s+)?Traceback \(most recent call last\):\s*$/;
  const PY_CHAINED_EXC_RE = /^(?:E\s+)?(?:During handling of the above exception, another exception occurred:|The above exception was the direct cause of the following exception:)\s*$/;
  const PY_FRAME_RE = /^(?:E\s+)?  File "[^"\n]+", line \d+(?:, in \S.*)?$/;
  const BARE_PY_EXC_RE = /^(?:E\s+)?(?:[A-Z][A-Za-z0-9_]*(?:Error|Exception)|AssertionError|KeyboardInterrupt|SystemExit|GeneratorExit|StopIteration|StopAsyncIteration)\s*$/;

  // 2. Stack frames (V8/JS/Node, Go goroutines).
  const JS_STACK_FRAME_RE = /^ {2,}at (?:[^\n(]+\([^)\n]+:\d+:\d+\)|[^\s()]+\.[A-Za-z0-9]+:\d+:\d+)\s*$/;
  const GO_GOROUTINE_RE = /^goroutine \d+ \[[A-Za-z0-9 ,._-]+\]:\s*$/;

  // 3. Test-runner failure banners, failed test rows, pytest `E   ...` lines,
  //    and non-zero failure/error summary footers.
  const TEST_BANNER_RE = /^={3,}\s*(?:FAILURES|ERRORS)\s*={3,}\s*$/;
  const PYTEST_FAILED_LINE_RE = /^(?:FAILED\s+\S+|ERROR\s+(?:collecting\s+\S+|\S+::\S+|\S+\.(?:py|js|ts|mjs|cjs)\b)|\S+::\S+\s+(?:FAILED|ERROR)(?:\s+\[\s*\d+%\])?\s*$)/;
  const PYTEST_E_LINE_RE = /^E {2,}\S/;
  const PYTEST_FAIL_SUMMARY_RE = /^=*\s*(?:[^\n=]*,\s*)?[1-9]\d*\s+(?:failed|errors?)\b[^\n]*\bin\s+\d+(?:\.\d+)?s\b/i;
  const OTHER_TEST_FAIL_RE = /^(?:not ok\s+\d+\b|#\s*fail\s+[1-9]\d*\b|\s*[✖✗]\s+\S+|---\s*FAIL:\s+\S+|FAIL(?:\s+[A-Za-z0-9_./@-]+|\t\S+)|test\s+\S+\s+\.\.\.\s+FAILED\s*$)/;

  // 4. Uncaught Error/Exception types at column 0 (PascalCase `*Error:` /
  //    `*Exception:`, `Error:`, `Failed:`, `SystemExit:`, Rust `error[E0308]:` /
  //    `error:`), explicitly ignoring camelCase/snake_case identifiers and
  //    benign `error: null|false|0`.
  const BENIGN_ERROR_KEY_RE = /^(?:error|Error):\s*(?:null|false|none|0|""|''|\[\]|\{\})\s*$/;
  const LINE_START_EXC_RE = /^(?:Uncaught\s+)?(?:[A-Za-z_]\w*\.)*(?:[A-Z][A-Za-z0-9_]*(?:Error|Exception|Fault)|Error|Exception|BaseException|Failed|KeyboardInterrupt|SystemExit|GeneratorExit|StopIteration|StopAsyncIteration):\s+\S/;
  const RUST_ERROR_RE = /^error(?:\[E\d+\])?:\s+\S/;

  // 5. Package managers, Git, panics, crashes, assertions, build tools.
  const RUNTIME_FATAL_RE = /^(?:npm\s+(?:ERR!|error\b)|(?:pnpm|yarn)\s+ERR!?\b|ERR_PNPM_[A-Z0-9_]+\b|(?:fatal|panic|emerg)(?:\s*\[[^\]]+\])?:\s+\S|thread\s+'[^']+'\s+panicked\s+at\b|(?:Segmentation fault|Bus error|Aborted|Floating point exception|Illegal instruction)(?:\s*\(core dumped\))?\s*$|make(?:\[\d+\])?:\s+\*\*\*\s+\[|CMake Error\b|assertion\s+failed\s*:)/i;
  const C_ASSERTION_RE = /^[^\n]{1,200}:\s+Assertion\s+[`'"].+[`'"]\s+failed\.?\s*$/;

  // 6. POSIX / shell / CLI `<tool>: ...: No such file or directory` and known
  //    CLI tool execution diagnostics at column 0. Evaluated on <=512-char
  //    prefix so paths containing colons (URLs, Windows drives, `line N:`) are
  //    matched without backtracking risk.
  const POSIX_TOOL_ERRNO_RE = /^[A-Za-z0-9_./+-]{1,80}:\s+[^\n]{1,400}:\s*(?:No such file or directory|Permission denied|Is a directory|Not a directory|command not found|not found|Read-only file system|Operation not permitted|File exists|Broken pipe|Invalid argument|Directory not empty|Text file busy|Too many open files|Connection refused|Connection timed out|Network is unreachable|Name or service not known)\b/i;
  const KNOWN_CLI_ERR_RE = /^(?:bash|sh|zsh|dash|cat|sed|awk|grep|rg|find|head|tail|nl|wc|sort|uniq|cut|tr|xargs|ls|cp|mv|rm|mkdir|rmdir|chmod|chown|ln|tar|gzip|gunzip|unzip|curl|wget|ssh|scp|git|gh|docker|kubectl|make|cargo|go|rustc|gcc|g\+\+|clang|python3?|pip3?|pytest|mypy|ruff|flake8|node|npm|npx|pnpm|yarn|tsc):\s+(?:cannot\s+(?:access|open|stat|remove|create|read|write|move|copy|execute|find)\b|can't\s+(?:open|read|create|find|stat)\b|unable\s+to\s+(?:open|read|access|locate|resolve|connect|find)\b|(?:invalid|illegal|unrecognized|unknown)\s+(?:option|argument|flag|command|operator)\b|syntax\s+error\b|missing\s+(?:operand|argument|file)\b|[^\n]*\[Errno\s+\d+\]|'[^']+'\s+is\s+not\s+a\s+git\s+command\b)/i;
  const CAT_MISSING_RE = /^cat:\s+(?!null\b|true\b|false\b|\d+\s*$)[^\n]*(?:\bmissing\b|\bno such\b|\bdenied\b|\bdirectory\b|\bcannot\b|\bcan't\b|\berror\b|\binvalid\b|\bnot found\b|\bfailed\b)/i;

  // 7. Compiler / typechecker errors (`file:line:col: error:`, `mypy`
  //    `file:line: error:`, `tsc` `error TS...`).
  const COMPILER_COL_ERROR_RE = /^(?:[A-Za-z]:[\\/])?[^\s:*?"<>|]{1,300}:\d+:\d+:\s*(?:fatal\s+)?error(?:\[[^\]]+\])?:\s+\S/;
  const COMPILER_LINE_ERROR_RE = /^(?:[A-Za-z]:[\\/])?[^\s:*?"<>|]{1,300}:\d+:\s(?:fatal\s+)?error(?:\[[^\]]+\])?:\s+\S/;
  const TSC_ERROR_RE = /^(?:[A-Za-z]:[\\/])?[^\s:*?"<>|]{1,300}(?:\(\d+,\d+\):|:\d+:\d+\s+-)\s*error\s+TS\d+:\s+\S/;

  function isStdoutDiagnosticLine(rawLine, state) {
    if (!rawLine) return false;
    const c0 = rawLine.charCodeAt(0);
    // Quick exclusions for JSON structural characters and diff +/- lines.
    if (c0 === 123 || c0 === 125 || c0 === 93 || c0 === 34 || c0 === 39 || c0 === 43) {
      return false;
    }
    const probe = rawLine.length > MAX_DIAG_PROBE_LEN ? rawLine.slice(0, MAX_DIAG_PROBE_LEN) : rawLine;
    // `cat -n` / `nl` line-numbered source reads start with optional spaces + digits + tab.
    if ((c0 === 32 || (c0 >= 48 && c0 <= 57)) && CAT_N_PREFIX_RE.test(probe)) {
      return false;
    }

    if (PY_TRACEBACK_RE.test(probe) || PY_CHAINED_EXC_RE.test(probe)) {
      state.inTraceback = true;
      return true;
    }
    if (PY_FRAME_RE.test(probe)) {
      state.inTraceback = true;
      return true;
    }
    if (state.inTraceback && BARE_PY_EXC_RE.test(probe)) {
      state.inTraceback = false;
      return true;
    }
    // Reset bare-exception expectation once non-indented non-frame text passes.
    if (state.inTraceback && c0 !== 32 && c0 !== 9 && c0 !== 69 /* 'E' */) {
      state.inTraceback = false;
    }

    if (JS_STACK_FRAME_RE.test(probe) || GO_GOROUTINE_RE.test(probe)) return true;
    if (TEST_BANNER_RE.test(probe) || PYTEST_FAILED_LINE_RE.test(probe) ||
        PYTEST_E_LINE_RE.test(probe) || PYTEST_FAIL_SUMMARY_RE.test(probe) ||
        OTHER_TEST_FAIL_RE.test(probe)) {
      return true;
    }
    if ((LINE_START_EXC_RE.test(probe) || RUST_ERROR_RE.test(probe)) &&
        !BENIGN_ERROR_KEY_RE.test(probe)) {
      return true;
    }
    if (RUNTIME_FATAL_RE.test(probe) || C_ASSERTION_RE.test(probe)) return true;
    const shortProbe = probe.length > 512 ? probe.slice(0, 512) : probe;
    if (POSIX_TOOL_ERRNO_RE.test(shortProbe) || KNOWN_CLI_ERR_RE.test(shortProbe) || CAT_MISSING_RE.test(shortProbe)) {
      return true;
    }
    if (COMPILER_COL_ERROR_RE.test(probe) || TSC_ERROR_RE.test(probe)) return true;
    if (!state.isSearchCommand && COMPILER_LINE_ERROR_RE.test(probe)) return true;

    return false;
  }

  function scanStdoutDiagnosticLines(text, { isSearchCommand = false, stopOnFirst = false } = {}) {
    const str = String(text);
    const indices = [];
    if (!str) return indices;
    const state = { inTraceback: false, isSearchCommand: Boolean(isSearchCommand) };
    let lineIndex = 0;
    let start = 0;
    const len = str.length;
    while (start <= len) {
      const nl = str.indexOf('\n', start);
      const end = nl === -1 ? len : nl;
      const line = str.slice(start, end);
      if (isStdoutDiagnosticLine(line, state)) {
        indices.push(lineIndex);
        if (stopOnFirst) return indices;
      }
      if (nl === -1) break;
      start = nl + 1;
      lineIndex++;
    }
    return indices;
  }

  function resolveExecutionContext(blockOrText, context) {
    if (typeof blockOrText === 'string' || blockOrText == null) {
      return {
        label: 'stdout',
        body: blockOrText == null ? '' : String(blockOrText),
        exitStatus: context && typeof context.exitStatus === 'number' ? context.exitStatus : null,
        headings: context && context.activity ? [String(context.activity)] : [],
        pairedCommand: (context && context.pairedCommand) || null,
        hasStderrFlag: Boolean(context && context.hasStderr),
        stderrBodies: context && typeof context.stderr === 'string' ? [context.stderr] : [],
      };
    }

    const block = blockOrText;
    const sections = Array.isArray(context)
      ? context
      : (context && Array.isArray(context.sections) ? context.sections : (block.sections || null));
    const allBlocks = context && Array.isArray(context.blocks) ? context.blocks : null;

    let sec = (context && context.section) || block.section || null;
    if (!sec && sections && typeof block.sectionIndex === 'number' && block.sectionIndex >= 0) {
      sec = sections[block.sectionIndex] || null;
    }

    const headings = [];
    if (block.activity) headings.push(String(block.activity));
    if (block.heading) headings.push(String(block.heading));
    if (block.title) headings.push(String(block.title));
    if (context && context.activity) headings.push(String(context.activity));
    if (context && context.heading) headings.push(String(context.heading));

    let exitStatus = typeof block.exitStatus === 'number'
      ? block.exitStatus
      : (context && typeof context.exitStatus === 'number' ? context.exitStatus : null);

    let cursor = sec;
    let guard = 0;
    while (cursor && guard++ < 8) {
      if (cursor.title) headings.push(String(cursor.title));
      if (exitStatus === null && typeof cursor.exitStatus === 'number') {
        exitStatus = cursor.exitStatus;
      }
      if (sections && typeof cursor.parentIndex === 'number' && cursor.parentIndex >= 0) {
        cursor = sections[cursor.parentIndex] || null;
      } else {
        break;
      }
    }

    const pairedCommand = block.pairedCommand || (context && context.pairedCommand) || null;
    const stderrBodies = [];
    if (typeof block.stderr === 'string') stderrBodies.push(block.stderr);
    if (typeof block.stderrBody === 'string') stderrBodies.push(block.stderrBody);
    if (pairedCommand && typeof pairedCommand.stderr === 'string') stderrBodies.push(pairedCommand.stderr);
    if (pairedCommand && typeof pairedCommand.stderrBody === 'string') stderrBodies.push(pairedCommand.stderrBody);
    if (context && typeof context.stderr === 'string') stderrBodies.push(context.stderr);

    const hasStderrFlag = Boolean(
      block.hasStderr ||
      (pairedCommand && pairedCommand.hasStderr) ||
      (context && context.hasStderr)
    );

    // Only look up sibling stderr bodies when stderr was actually flagged (or
    // when unpaired inside a section); prefer `sec.blocks` (O(1) per section)
    // over scanning the full document block list.
    if (allBlocks && stderrBodies.length === 0 && (hasStderrFlag || !pairedCommand)) {
      const targetCmd = block.label === 'command' ? block : pairedCommand;
      if (sec && Array.isArray(sec.blocks)) {
        for (let k = 0; k < sec.blocks.length; k++) {
          const sibling = allBlocks[sec.blocks[k]];
          if (!sibling || sibling.label !== 'stderr' || !sibling.body) continue;
          if (!targetCmd || sibling.pairedCommand === targetCmd) {
            stderrBodies.push(sibling.body);
          }
        }
      } else if (targetCmd && hasStderrFlag) {
        for (let i = 0; i < allBlocks.length; i++) {
          const sibling = allBlocks[i];
          if (sibling && sibling.label === 'stderr' && sibling.pairedCommand === targetCmd && sibling.body) {
            stderrBodies.push(sibling.body);
          }
        }
      }
    }

    return {
      label: block.label || 'stdout',
      body: typeof block.body === 'string' ? block.body : '',
      exitStatus,
      headings,
      pairedCommand,
      hasStderrFlag,
      stderrBodies,
    };
  }

  function analyzeExecutionDiagnostics(blockOrText, context, options = {}) {
    const resolved = resolveExecutionContext(blockOrText, context);
    const stopOnFirst = Boolean(options && options.stopOnFirst);

    let nonZeroExit = typeof resolved.exitStatus === 'number' && resolved.exitStatus !== 0;
    let resolvedExitStatus = resolved.exitStatus;
    if (!nonZeroExit) {
      for (let i = 0; i < resolved.headings.length; i++) {
        const h = resolved.headings[i];
        if (NON_ZERO_HEADING_RE.test(h)) {
          nonZeroExit = true;
          break;
        }
        if (resolvedExitStatus === null && EXPLICIT_EXIT_ZERO_RE.test(h)) {
          resolvedExitStatus = 0;
        }
      }
    }

    let hasStderr = false;
    if (resolved.label === 'stderr') {
      hasStderr = hasErrorBearingStderr([resolved.body]);
    } else if (resolved.stderrBodies.length > 0) {
      hasStderr = hasErrorBearingStderr(resolved.stderrBodies);
    } else if (resolved.hasStderrFlag) {
      hasStderr = true;
    }

    if (stopOnFirst && (nonZeroExit || hasStderr)) {
      return {
        hasDiagnostic: true,
        nonZeroExit,
        hasStderr,
        hasStdoutDiagnostic: false,
        diagnosticLines: [],
        firstDiagnosticLine: -1,
        lastDiagnosticLine: -1,
        exitStatus: resolvedExitStatus,
      };
    }

    const shouldScanBody = resolved.label === 'stdout' || resolved.label === 'unlabeled' || resolved.label === '';
    const cleanedBody = options && typeof options.cleanedBody === 'string'
      ? options.cleanedBody
      : (shouldScanBody ? stripTerminalNoise(resolved.body) : '');
    const isSearchCommand = isPureSearchCommand(resolved.pairedCommand && resolved.pairedCommand.body);
    const diagnosticLines = shouldScanBody
      ? scanStdoutDiagnosticLines(cleanedBody, { isSearchCommand, stopOnFirst })
      : [];
    const hasStdoutDiagnostic = diagnosticLines.length > 0;

    return {
      hasDiagnostic: nonZeroExit || hasStderr || hasStdoutDiagnostic,
      nonZeroExit,
      hasStderr,
      hasStdoutDiagnostic,
      diagnosticLines,
      firstDiagnosticLine: hasStdoutDiagnostic ? diagnosticLines[0] : -1,
      lastDiagnosticLine: hasStdoutDiagnostic ? diagnosticLines[diagnosticLines.length - 1] : -1,
      exitStatus: resolvedExitStatus,
    };
  }

  function hasExecutionDiagnostic(blockOrText, context) {
    return analyzeExecutionDiagnostics(blockOrText, context, { stopOnFirst: true }).hasDiagnostic;
  }

  // --- Wide-line clipping ---------------------------------------------------

  const EXISTING_MARKER_LINE_RE = /^\s*(?:\[\.\.\.|<a\s+id="arex-)/;
  const PRIOR_CLIP_SUFFIX_RE = / … \[\+(\d+) chars\]$/;

  function safePrefixSlice(str, maxChars) {
    if (str.length <= maxChars) return str;
    let cut = maxChars;
    if (cut > 0) {
      const prev = str.charCodeAt(cut - 1);
      const next = str.charCodeAt(cut);
      if (prev >= 0xD800 && prev <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
        cut -= 1;
      }
    }
    return str.slice(0, cut);
  }

  function clipWideLine(line, maxChars = SMART_LOG_BUDGETS.smart.maxLineChars) {
    const str = String(line);
    const limit = Math.max(1, Number(maxChars) || SMART_LOG_BUDGETS.smart.maxLineChars);
    if (str.length <= limit || EXISTING_MARKER_LINE_RE.test(str)) return str;

    // Unwrap a prior wider clip suffix (e.g. Smart 240 -> Stubs 160) so the
    // [+N chars] count reflects the exact total omitted characters.
    let rawPrefix = str;
    let priorOmitted = 0;
    const priorMatch = PRIOR_CLIP_SUFFIX_RE.exec(str);
    if (priorMatch) {
      rawPrefix = str.slice(0, priorMatch.index);
      priorOmitted = Number(priorMatch[1]) || 0;
      if (rawPrefix.length <= limit) return str;
    }

    const prefix = safePrefixSlice(rawPrefix, limit);
    const omitted = (rawPrefix.length - prefix.length) + priorOmitted;
    if (omitted <= 0) return str;
    const candidate = prefix + ' … [+' + omitted + ' chars]';
    return utf8Bytes(candidate) < utf8Bytes(str) ? candidate : str;
  }

  function clipWideStdoutLines(text, options = {}) {
    const mode = typeof options === 'string' ? options : (options && options.mode) || 'smart';
    const maxChars = typeof options === 'number'
      ? options
      : (options && typeof options.maxChars === 'number'
        ? options.maxChars
        : (mode === 'stubs' ? SMART_LOG_BUDGETS.stubs.maxLineChars : SMART_LOG_BUDGETS.smart.maxLineChars));

    const str = String(text);
    if (str.length <= maxChars) {
      return { text: str, clippedLines: 0, omittedChars: 0, changed: false };
    }

    const lines = str.split('\n');
    let clippedLines = 0;
    let omittedChars = 0;
    for (let i = 0; i < lines.length; i++) {
      const orig = lines[i];
      if (orig.length <= maxChars) continue;
      const clipped = clipWideLine(orig, maxChars);
      if (clipped !== orig) {
        lines[i] = clipped;
        clippedLines++;
        const m = PRIOR_CLIP_SUFFIX_RE.exec(clipped);
        if (m) {
          const prior = PRIOR_CLIP_SUFFIX_RE.exec(orig);
          omittedChars += Number(m[1]) - (prior ? Number(prior[1]) : 0);
        }
      }
    }
    if (!clippedLines) {
      return { text: str, clippedLines: 0, omittedChars: 0, changed: false };
    }
    const joined = lines.join('\n');
    if (utf8Bytes(joined) >= utf8Bytes(str)) {
      return { text: str, clippedLines: 0, omittedChars: 0, changed: false };
    }
    return { text: joined, clippedLines, omittedChars, changed: true };
  }

  // --- Dual byte-and-line head/tail budget & error-preamble folding ---------

  const PRIOR_OMITTED_MIDDLE_RE = /^\[\.\.\. omitted (\d+) middle lines\b.* \.\.\.\]$/;
  const STUBS_RANGE_MARKER_RE = /^\s*\[\.\.\. identical to lines (\d+)[–-](\d+) of earlier output #arex-stubs-output-\d+\b.* \.\.\.\]\s*$/;

  function countLogicalLines(slice) {
    let count = 0;
    for (let i = 0; i < slice.length; i++) {
      const m = PRIOR_OMITTED_MIDDLE_RE.exec(slice[i]);
      if (m) {
        count += Number(m[1]);
        continue;
      }
      const s = STUBS_RANGE_MARKER_RE.exec(slice[i]);
      if (s) {
        count += Math.max(1, Number(s[2]) - Number(s[1]) + 1);
        continue;
      }
      count += 1;
    }
    return count;
  }

  function cleanMiddleMarker(omittedCount, exitStatus) {
    const statusNote = exitStatus === 0
      ? 'exit 0; no error markers detected'
      : 'exit status not reported; no error markers detected';
    return '[... omitted ' + omittedCount + ' middle lines (' + statusNote + ') ...]';
  }

  function selectByteBudgetedWindow(lines, lineBytes, maxHead, maxTail, byteCap) {
    const total = lines.length;
    if (total < 3) return null;

    const markerAllowance = 96;
    const contentBudget = Math.max(0, byteCap - markerAllowance);
    const headShare = maxHead / Math.max(1, maxHead + maxTail);
    const headBudget = Math.floor(contentBudget * headShare);

    let headCount = 0;
    let headBytes = 0;
    const headCap = Math.min(maxHead, total - 2);
    while (headCount < headCap) {
      const nextCost = (headCount > 0 ? 1 : 0) + lineBytes[headCount];
      if (headCount >= 1 && headBytes + nextCost > headBudget) break;
      headBytes += nextCost;
      headCount++;
    }

    const remTailBudget = Math.max(contentBudget - headBudget, contentBudget - headBytes);
    let tailCount = 0;
    let tailBytes = 0;
    const tailCap = Math.min(maxTail, total - headCount - 1);
    while (tailCount < tailCap) {
      const idx = total - 1 - tailCount;
      const nextCost = (tailCount > 0 ? 1 : 0) + lineBytes[idx];
      if (tailCount >= 1 && tailBytes + nextCost > remTailBudget) break;
      tailBytes += nextCost;
      tailCount++;
    }

    if (headCount + tailCount >= total) return null;
    return { headCount, tailCount };
  }

  function truncateCleanLines(lines, currentBytes, budget, exitStatus) {
    const triggeredByLines = lines.length > budget.triggerLines;
    const triggeredByBytes = currentBytes > budget.triggerBytes;
    if (!triggeredByLines && !triggeredByBytes) return null;
    if (lines.length < 3) return null;

    let headCount = Math.min(budget.headLines, lines.length - 2);
    let tailCount = Math.min(budget.tailLines, lines.length - headCount - 1);

    // First try the canonical head + tail line counts when they actually drop
    // middle lines and stay within the wide-block byte ceiling.
    if (lines.length > budget.headLines + budget.tailLines) {
      const omitted = countLogicalLines(lines.slice(headCount, lines.length - tailCount));
      const marker = cleanMiddleMarker(omitted, exitStatus);
      const candidate = lines.slice(0, headCount)
        .concat(marker, lines.slice(lines.length - tailCount))
        .join('\n');
      const candBytes = utf8Bytes(candidate);
      if (candBytes <= budget.maxOutputBytes && candBytes < currentBytes) {
        return { text: candidate, linesOmitted: omitted, bytes: candBytes };
      }
    }

    // Otherwise apply the byte-budgeted head/tail window so wide blocks (e.g.
    // 20–40 wide grep/JSON lines > triggerBytes) shrink below budget and never
    // exceed ~maxOutputBytes (~2.4 KB in Smart, ~1.2 KB in Stubs).
    const lineBytes = new Array(lines.length);
    for (let i = 0; i < lines.length; i++) lineBytes[i] = utf8Bytes(lines[i]);

    const targetCap = lines.length <= budget.headLines + budget.tailLines
      ? budget.triggerBytes
      : budget.maxOutputBytes;
    const sel = selectByteBudgetedWindow(lines, lineBytes, budget.headLines, budget.tailLines, targetCap);
    if (!sel) return null;

    const omitted = countLogicalLines(lines.slice(sel.headCount, lines.length - sel.tailCount));
    const marker = cleanMiddleMarker(omitted, exitStatus);
    const candidate = lines.slice(0, sel.headCount)
      .concat(marker, lines.slice(lines.length - sel.tailCount))
      .join('\n');
    const candBytes = utf8Bytes(candidate);
    if (candBytes >= currentBytes) return null;
    return { text: candidate, linesOmitted: omitted, bytes: candBytes };
  }

  function trimCleanErrorPreamble(lines, currentBytes, firstDiagnosticLine) {
    const cfg = SMART_LOG_BUDGETS.errorPreamble;
    if (firstDiagnosticLine <= cfg.minCleanPreambleLines) return null;
    if (lines.length <= cfg.headLines + cfg.minDiagnosticWindowLines) return null;

    const windowStart = Math.min(
      Math.max(0, firstDiagnosticLine - cfg.preDiagnosticContextLines),
      lines.length - cfg.minDiagnosticWindowLines
    );
    const omittedCount = windowStart - cfg.headLines;
    if (omittedCount < cfg.minOmittedLines) return null;

    const marker = '[... omitted ' + omittedCount +
      ' clean preamble lines (diagnostic window preserved below) ...]';
    const candidate = lines.slice(0, cfg.headLines)
      .concat(marker, lines.slice(windowStart))
      .join('\n');
    const candBytes = utf8Bytes(candidate);
    if (candBytes >= currentBytes) return null;
    return { text: candidate, linesOmitted: omittedCount, bytes: candBytes };
  }

  function compactStdoutInternal(rawText, blockForDiag, options = {}) {
    const mode = options && options.mode ? options.mode : 'smart';
    const original = String(rawText);
    const bytesBefore = utf8Bytes(original);
    if (mode !== 'smart' && mode !== 'stubs') {
      return {
        body: original,
        changed: false,
        kind: 'unchanged',
        bytesBefore,
        bytesAfter: bytesBefore,
        savedBytes: 0,
        linesClipped: 0,
        linesOmitted: 0,
        hasDiagnostic: false,
      };
    }

    const stripped = options.stripNoise === false ? original : stripTerminalNoise(original);
    const context = options.context || options.index || options;
    const diag = analyzeExecutionDiagnostics(blockForDiag, context, { cleanedBody: stripped });

    if (diag.hasDiagnostic) {
      let body = stripped;
      let kind = body !== original ? 'noise_stripped' : 'diagnostic_preserved';
      let linesOmitted = 0;

      if (diag.hasStdoutDiagnostic && diag.firstDiagnosticLine > SMART_LOG_BUDGETS.errorPreamble.minCleanPreambleLines) {
        const lines = body.split('\n');
        const strippedBytes = utf8Bytes(body);
        const trimmed = trimCleanErrorPreamble(lines, strippedBytes, diag.firstDiagnosticLine);
        if (trimmed) {
          body = trimmed.text;
          kind = 'diagnostic_preamble_trimmed';
          linesOmitted = trimmed.linesOmitted;
        }
      }

      const bytesAfter = utf8Bytes(body);
      if (body === original || bytesAfter >= bytesBefore) {
        return {
          body: original,
          changed: false,
          kind: 'diagnostic_preserved',
          bytesBefore,
          bytesAfter: bytesBefore,
          savedBytes: 0,
          linesClipped: 0,
          linesOmitted: 0,
          hasDiagnostic: true,
        };
      }
      return {
        body,
        changed: true,
        kind,
        bytesBefore,
        bytesAfter,
        savedBytes: bytesBefore - bytesAfter,
        linesClipped: 0,
        linesOmitted,
        hasDiagnostic: true,
      };
    }

    // Clean stdout path: wide-line clipping followed by dual byte/line budget.
    const budget = mode === 'stubs'
      ? {
          maxLineChars: options.maxLineChars ?? SMART_LOG_BUDGETS.stubs.maxLineChars,
          triggerBytes: options.triggerBytes ?? SMART_LOG_BUDGETS.stubs.triggerBytes,
          triggerLines: options.triggerLines ?? SMART_LOG_BUDGETS.stubs.triggerLines,
          headLines: options.headLines ?? SMART_LOG_BUDGETS.stubs.headLines,
          tailLines: options.tailLines ?? SMART_LOG_BUDGETS.stubs.tailLines,
          maxOutputBytes: options.maxOutputBytes ?? SMART_LOG_BUDGETS.stubs.maxOutputBytes,
        }
      : {
          maxLineChars: options.maxLineChars ?? SMART_LOG_BUDGETS.smart.maxLineChars,
          triggerBytes: options.triggerBytes ?? SMART_LOG_BUDGETS.smart.triggerBytes,
          triggerLines: options.triggerLines ?? SMART_LOG_BUDGETS.smart.triggerLines,
          headLines: options.headLines ?? SMART_LOG_BUDGETS.smart.headLines,
          tailLines: options.tailLines ?? SMART_LOG_BUDGETS.smart.tailLines,
          maxOutputBytes: options.maxOutputBytes ?? SMART_LOG_BUDGETS.smart.maxOutputBytes,
        };

    const runCleanBudget = (targetMode, targetBudget) => {
      const clipped = clipWideStdoutLines(stripped, { mode: targetMode, maxChars: targetBudget.maxLineChars });
      let nextBody = clipped.text;
      let nextBytes = utf8Bytes(nextBody);
      let nextOmitted = 0;
      let nextKind = clipped.changed ? 'wide_clipped' : (nextBody !== original ? 'noise_stripped' : 'unchanged');

      const lines = nextBody.split('\n');
      const truncated = truncateCleanLines(lines, nextBytes, targetBudget, diag.exitStatus);
      if (truncated) {
        nextBody = truncated.text;
        nextBytes = truncated.bytes;
        nextOmitted = truncated.linesOmitted;
        nextKind = clipped.changed ? 'wide_and_head_tail' : 'head_tail';
      }
      return {
        body: nextBody,
        bytes: nextBytes,
        linesClipped: clipped.clippedLines,
        linesOmitted: nextOmitted,
        kind: nextKind,
      };
    };

    const primary = runCleanBudget(mode, budget);
    let body = primary.body;
    let currentBytes = primary.bytes;
    let linesClipped = primary.linesClipped;
    let linesOmitted = primary.linesOmitted;
    let kind = primary.kind;

    // Guarantee Stubs <= Smart byte monotonicity on identical default budgets
    // without re-running terminal stripping or diagnostic classification.
    if (mode === 'stubs' &&
        options.maxLineChars === undefined &&
        options.triggerBytes === undefined &&
        options.triggerLines === undefined &&
        options.headLines === undefined &&
        options.tailLines === undefined &&
        options.maxOutputBytes === undefined) {
      const smartCheck = runCleanBudget('smart', SMART_LOG_BUDGETS.smart);
      if (smartCheck.bytes < currentBytes) {
        body = smartCheck.body;
        currentBytes = smartCheck.bytes;
        linesClipped = smartCheck.linesClipped;
        linesOmitted = smartCheck.linesOmitted;
        kind = smartCheck.kind;
      }
    }

    if (body === original || currentBytes >= bytesBefore) {
      return {
        body: original,
        changed: false,
        kind: 'unchanged',
        bytesBefore,
        bytesAfter: bytesBefore,
        savedBytes: 0,
        linesClipped: 0,
        linesOmitted: 0,
        hasDiagnostic: false,
      };
    }

    return {
      body,
      changed: true,
      kind,
      bytesBefore,
      bytesAfter: currentBytes,
      savedBytes: bytesBefore - currentBytes,
      linesClipped,
      linesOmitted,
      hasDiagnostic: false,
    };
  }

  function compactStdout(text, options = {}) {
    return compactStdoutInternal(text, text, options);
  }

  function isProtectedBlock(block, index, options) {
    if (!block || typeof block !== 'object') return false;
    if (block.immutable || block.anchor || block.stubAnchor || block.reference) return true;
    if (options && options.skipBlocks && options.skipBlocks.has && options.skipBlocks.has(block)) {
      return true;
    }
    if (index && Array.isArray(index.turns) && typeof block.turnIndex === 'number' && block.turnIndex >= 0) {
      const turn = index.turns[block.turnIndex];
      if (turn && turn.immutable) return true;
      if (turn && Array.isArray(turn.answerSpans)) {
        for (let i = 0; i < turn.answerSpans.length; i++) {
          const span = turn.answerSpans[i];
          if (block.startOffset < span.endOffset && span.startOffset < block.endOffset) {
            return true;
          }
        }
      }
    }
    return false;
  }

  function compactStdoutBlock(block, options = {}) {
    if (!block || typeof block !== 'object') {
      return compactStdout(block == null ? '' : String(block), options);
    }
    const body = typeof block.body === 'string' ? block.body : '';
    const bytesBefore = typeof block.bytes === 'number' ? block.bytes : utf8Bytes(body);
    const index = options.index || options.context || null;

    if (block.label !== 'stdout' || isProtectedBlock(block, index, options)) {
      return {
        body,
        changed: false,
        kind: 'skipped',
        bytesBefore,
        bytesAfter: bytesBefore,
        savedBytes: 0,
        linesClipped: 0,
        linesOmitted: 0,
        hasDiagnostic: false,
      };
    }

    const currentBody = typeof options.body === 'string' ? options.body : body;
    const blockView = currentBody === body ? block : { ...block, body: currentBody };
    return compactStdoutInternal(currentBody, blockView, options);
  }

  function renderBlockSlice(rawMarkdown, block, newBody) {
    if (typeof block.openLine === 'string' && typeof block.closeLine === 'string' && !block.merged) {
      return block.openLine + '\n' + newBody + '\n' + block.closeLine;
    }
    if (typeof rawMarkdown === 'string' &&
        Number.isInteger(block.startOffset) &&
        Number.isInteger(block.endOffset)) {
      const rawSlice = rawMarkdown.slice(block.startOffset, block.endOffset);
      const firstNl = rawSlice.indexOf('\n');
      const lastNl = rawSlice.lastIndexOf('\n');
      if (firstNl !== -1 && lastNl > firstNl) {
        const openLine = block.relabeled
          ? (block.fence || '`').repeat(block.fenceLength || 3) + 'text'
          : rawSlice.slice(0, firstNl);
        const closeLine = rawSlice.slice(lastNl + 1);
        return openLine + '\n' + newBody + '\n' + closeLine;
      }
    }
    const fence = (block.fence || '`').repeat(block.fenceLength || 3);
    const lang = block.relabeled ? 'text' : (block.lang || '');
    return fence + lang + '\n' + newBody + '\n' + fence;
  }

  // Batch-compact all eligible stdout blocks in a DocumentIndex / MarkdownIndex
  // and emit non-overlapping span edits compatible with AREX.applySpanEdits.
  function compactSmartLogs(index, options = {}) {
    const mode = options && options.mode ? options.mode : 'smart';
    const edits = [];
    const blockEdits = new Map();
    const stats = {
      blocksCompacted: 0,
      cleanTruncated: 0,
      preambleTrimmed: 0,
      wideLinesClipped: 0,
      diagnosticBlocksPreserved: 0,
      savedBytes: 0,
    };

    if (!index || !Array.isArray(index.blocks) || (mode !== 'smart' && mode !== 'stubs')) {
      return { edits, blockEdits, stats };
    }

    const raw = typeof index.markdown === 'string' ? index.markdown : null;
    for (let i = 0; i < index.blocks.length; i++) {
      const block = index.blocks[i];
      if (!block || block.label !== 'stdout' || isProtectedBlock(block, index, options)) continue;

      const priorBody = options.bodyByBlock && options.bodyByBlock.get
        ? options.bodyByBlock.get(block)
        : undefined;
      const res = compactStdoutBlock(block, {
        ...options,
        mode,
        index,
        context: index,
        body: priorBody,
      });

      if (res.hasDiagnostic && !res.changed) {
        stats.diagnosticBlocksPreserved++;
        continue;
      }
      if (!res.changed) continue;

      if (raw !== null && Number.isInteger(block.startOffset) && Number.isInteger(block.endOffset)) {
        const replacement = renderBlockSlice(raw, block, res.body);
        const beforeSliceBytes = typeof block.rawSliceBytes === 'number' && priorBody === undefined
          ? block.rawSliceBytes
          : utf8Bytes(raw.slice(block.startOffset, block.endOffset));
        const afterSliceBytes = utf8Bytes(replacement);
        if (afterSliceBytes >= beforeSliceBytes) continue;

        edits.push({
          start: block.startOffset,
          end: block.endOffset,
          text: replacement,
          blockIndex: i,
        });
        stats.savedBytes += beforeSliceBytes - afterSliceBytes;
      } else {
        stats.savedBytes += res.savedBytes;
      }

      blockEdits.set(block, { body: res.body, kind: res.kind });
      stats.blocksCompacted++;
      stats.wideLinesClipped += res.linesClipped;
      if (res.kind === 'diagnostic_preamble_trimmed') stats.preambleTrimmed++;
      else if (res.linesOmitted > 0) stats.cleanTruncated++;
    }

    return { edits, blockEdits, stats };
  }

  AREX.SMART_LOG_BUDGETS = SMART_LOG_BUDGETS;
  AREX.stripTerminalNoise = stripTerminalNoise;
  AREX.hasExecutionDiagnostic = hasExecutionDiagnostic;
  AREX.analyzeExecutionDiagnostics = analyzeExecutionDiagnostics;
  AREX.clipWideLine = clipWideLine;
  AREX.clipWideStdoutLines = clipWideStdoutLines;
  AREX.compactStdout = compactStdout;
  AREX.compactStdoutBlock = compactStdoutBlock;
  AREX.compactSmartLogs = compactSmartLogs;
})();
