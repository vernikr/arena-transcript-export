// Section-aware DocumentIndex for transcript compression.
//
// Parses raw Arena transcript Markdown in a single linear O(N) pass and exposes
// exact UTF-16 string offsets plus UTF-8 byte counts for the three structural
// layers downstream transforms (Wave 2/3) need:
//
//   turns    — `## 👤 User` / `## 🤖 Assistant` message spans. User turns are
//              immutable by construction; assistant turns additionally split
//              into spoiler activity sections and immutable answer prose (the
//              prose outside H3–H6 activity spoilers, i.e. after the last
//              tool/thought spoiler in a turn).
//   sections — H3–H6 activity sections classified as thought,
//              ran_commands_wrapper, explored_wrapper, bash_run, edit_activity
//              or prose_heading, with nested `Ran commands N` -> `Used Bash`
//              wrappers resolved via parentIndex. Each section's span ends at
//              the end of its own activity content (fences, command/stdout/
//              stderr labels, file cards, `_(not expanded)_`), and the trailing
//              final-answer run of every assistant turn is carved out
//              explicitly, so answer prose is never swallowed into a spoiler
//              span. (A trailing pure-prose section such as a `Thought` is
//              indistinguishable from answer prose in raw Markdown; its
//              content is then treated as immutable answer, never modified.)
//   blocks   — fenced code blocks labelled command / stdout / stderr / file /
//              unlabeled, paired back to their command block, scoped by
//              turnIndex / sectionIndex. Consecutive `**command:**` blocks that
//              do not start with `$` are defensively relabelled/merged as stdout.
//
// `AREX.applySpanEdits(rawMarkdown, edits)` is the deterministic non-overlapping
// span-edit composer with byte-delta accounting, so independent transforms can
// propose block- or section-level edits without re-parsing Markdown.
//
// Runs unchanged in window, service-worker and dedicated-worker contexts:
// the only global touched is `globalThis.AREX`.
globalThis.AREX = globalThis.AREX || {};

(function () {
  // Exact UTF-8 byte count. Transcript content is overwhelmingly ASCII, so a
  // single anchored regex test short-circuits the common case at native scan
  // speed. For large non-ASCII strings a run-based scan skips ASCII stretches
  // (native regex) and only runs the char loop over the non-ASCII runs; small
  // strings use the direct loop. All paths give identical results.
  const NON_ASCII = /[^\x00-\x7F]/;
  const NON_ASCII_RUN = /[^\x00-\x7F]+/g;
  const BYTE_TABLE = new Uint8Array(65536);
  for (let c = 0; c < 65536; c++) BYTE_TABLE[c] = c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
  const utf8BytesDirect = value => {
    let bytes = 0;
    const n = value.length;
    for (let i = 0; i < n; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDFFF) {
        const d = value.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) { bytes += 4; i++; }
        else bytes += 3;
      } else bytes += BYTE_TABLE[c];
    }
    return bytes;
  };
  const utf8Bytes = value => {
    if (!NON_ASCII.test(value)) return value.length;
    if (value.length < 8192) return utf8BytesDirect(value);
    let bytes = 0, last = 0, m;
    NON_ASCII_RUN.lastIndex = 0;
    while ((m = NON_ASCII_RUN.exec(value))) {
      bytes += m.index - last + utf8BytesDirect(m[0]);
      last = m.index + m[0].length;
    }
    return bytes + value.length - last;
  };

  // --- lightweight line scanners (char-code based, linear per line) ----------

  const isSpace = c => c === 32 || c === 9; // ' ' or '\t'

  // `#`-prefixed heading. Returns { level, text } or null. `text` is the
  // trailing-whitespace-trimmed remainder; a char-code scan is used instead of
  // `/^ {0,3}(#{1,6})[ \t]+(.*)$/` so a long trailing space run can never
  // trigger quadratic backtracking.
  function headingInfo(line) {
    const n = line.length;
    let i = 0;
    while (i < 3 && line.charCodeAt(i) === 32) i++;
    if (line.charCodeAt(i) !== 35) return null; // '#'
    let level = 0;
    while (i < n && line.charCodeAt(i) === 35) { level++; i++; }
    if (level > 6) return null;
    while (i < n && isSpace(line.charCodeAt(i))) i++;
    return { level, text: line.slice(i).replace(/[ \t]+$/, '') };
  }

  // Fenced code block opener: ``` or ~~~ run of 3+ with an info string.
  function fenceInfo(line) {
    const n = line.length;
    let i = 0;
    while (i < 3 && line.charCodeAt(i) === 32) i++;
    const c = line.charCodeAt(i);
    if (c !== 96 && c !== 126) return null; // '`' or '~'
    let len = 0;
    while (i < n && line.charCodeAt(i) === c) { len++; i++; }
    if (len < 3) return null;
    return { char: c, len, info: line.slice(i) };
  }

  // --- section classification ------------------------------------------------

  function classifySection(text) {
    if (/^thought(\s+for\b)?/i.test(text)) return 'thought';
    if (/^ran\s+commands\b/i.test(text)) return 'ran_commands_wrapper';
    if (/^explored\s+/i.test(text)) return 'explored_wrapper';
    if (/^used\s+bash\b/i.test(text)) return 'bash_run';
    if (/^edit(s|ed)?\b/i.test(text)) return 'edit_activity';
    return 'prose_heading';
  }

  const EXIT_RE = /\bexit\s+(\d+)\b/i;
  const DURATION_RE = /(\d+(?:\.\d+)?)(ms|s|m|h)\b/g;

  function parseExitStatus(text) {
    const m = EXIT_RE.exec(text);
    return m ? Number(m[1]) : null;
  }

  function parseDurationMs(text) {
    DURATION_RE.lastIndex = 0;
    let m, last = null;
    while ((m = DURATION_RE.exec(text))) last = m;
    if (!last) return null;
    const value = parseFloat(last[1]);
    const unit = last[2];
    if (unit === 'ms') return value;
    if (unit === 's') return value * 1000;
    if (unit === 'm') return value * 60000;
    return value * 3600000;
  }

  // --- block labelling -------------------------------------------------------

  const LABEL_RE = /\*\*(command|stdout|stderr):\*\*/i;
  const FILE_RE = /\*\*📄\s*([^*]+)\*\*\s*_\(([^)]+)\)/i;
  const NOT_EXPANDED_RE = /^\s*_\(not expanded\)_\s*$/;

  // A card label belongs only to the immediately preceding fence, bounded by
  // the last heading or closed fence (never across unrelated prose/file blocks
  // after another fence or heading).
  function lookbackLabel(getLine, fenceLine, lastBoundary) {
    const minJ = Math.max(lastBoundary, fenceLine - 13) + 1;
    for (let j = fenceLine - 1; j >= minJ; j--) {
      const text = getLine(j);
      // Cheap pre-filter: label/card lines always carry `**`.
      if (text.indexOf('**') < 0) continue;
      const lm = LABEL_RE.exec(text);
      const fm = FILE_RE.exec(text);
      if (lm || fm) {
        if (fm && (!lm || fm.index > lm.index)) {
          return { label: 'file', fileName: fm[1].replace(/^\s+|\s+$/g, '') };
        }
        return { label: lm ? lm[1].toLowerCase() : 'unlabeled', fileName: null };
      }
    }
    return { label: 'unlabeled', fileName: null };
  }

  // --- main index ------------------------------------------------------------

  function buildDocumentIndex(rawMarkdown) {
    const raw = String(rawMarkdown);
    // Line-start offsets via native indexOf — no per-line string allocation.
    // raw.split('\n') would materialise every line as a separate string, which
    // dominates GC on multi-MB transcripts. Line i spans [lineStarts[i],
    // lineEnd(i)); getLine(i) slices it on demand, only for the rare lines that
    // need full text (headings, fences, labels, trim checks).
    const lineStarts = [0];
    let pos = raw.indexOf('\n', 0);
    while (pos !== -1) { lineStarts.push(pos + 1); pos = raw.indexOf('\n', pos + 1); }
    const lineCount = lineStarts.length;
    const lineEnd = i => (i + 1 < lineCount ? lineStarts[i + 1] - 1 : raw.length);
    const getLine = i => raw.slice(lineStarts[i], lineEnd(i));
    const offsets = lineStarts;

    const turns = [], sections = [], blocks = [];
    const sectionStack = []; // { index, level } of open sections
    const sectionAtLine = new Int32Array(lineCount).fill(-1);
    // Precomputed per-line activity flags (fence / label / file card / collapsed
    // marker) so the section-trimming passes read a byte instead of re-running
    // regexes over every line.
    const activityAtLine = new Uint8Array(lineCount);
    let open = null; // open fence: { char, len, info, startLine, startOffset, label, fileName }
    let turn = null; // current turn object
    let lastBoundary = -1; // line index of the last heading or closed fence
    let currentSectionIndex = -1; // index of the innermost open section (mirrors stack top)

    const closeTurn = (turnObj, boundaryLine, boundaryOffset) => {
      turnObj.endLine = boundaryLine - 1;
      turnObj.endOffset = boundaryOffset;
    };

    const closeSection = (sec, boundaryLine, boundaryOffset) => {
      sec.endLine = boundaryLine - 1;
      sec.endOffset = boundaryOffset;
    };

    for (let i = 0; i < lineCount; i++) {
      const lineStart = lineStarts[i];
      const lineLen = lineEnd(i) - lineStart;

      if (open) {
        // Inlined fence-close check (identical semantics to fenceCloses):
        // same char, run >= open length, only whitespace after.
        let j = 0;
        while (j < 3 && raw.charCodeAt(lineStart + j) === 32) j++;
        if (raw.charCodeAt(lineStart + j) === open.char) {
          let run = 0;
          while (j < lineLen && raw.charCodeAt(lineStart + j) === open.char) { run++; j++; }
          if (run >= open.len) {
            while (j < lineLen && (raw.charCodeAt(lineStart + j) === 32 || raw.charCodeAt(lineStart + j) === 9)) j++;
            if (j === lineLen) {
              // Body is the raw slice between the fence lines — one slice, no
              // intermediate line array (keeps the pass allocation-light).
              // `lineStarts[i] - 1` drops the newline that separates the body
              // from the closing fence line.
              const body = raw.slice(lineEnd(open.startLine) + 1, lineStarts[i] - 1);
              const bodyBytes = utf8Bytes(body);
              const endOffset = lineEnd(i);
              const sectionIndex = currentSectionIndex;
              if (sectionIndex >= 0) sectionAtLine[i] = sectionIndex;
              const block = {
                label: open.label,
                fileName: open.fileName,
                fence: open.char === 96 ? '`' : '~',
                fenceLength: open.len,
                lang: open.info.trim(),
                startLine: open.startLine,
                endLine: i,
                startOffset: open.startOffset,
                endOffset,
                body,
                bytes: bodyBytes,
                // Exact raw-slice bytes without a second full pass: the slice
                // is exactly openLine + '\n' + body + '\n' + closeLine.
                rawSliceBytes: utf8Bytes(getLine(open.startLine)) + 1 + bodyBytes + 1 + utf8Bytes(getLine(i)),
                turnIndex: turn ? turn.index : -1,
                sectionIndex,
                immutable: false,
                pairedCommand: null,
                hasStderr: false,
              };
              activityAtLine[i] = 1;
              if (sectionIndex >= 0) sections[sectionIndex].blocks.push(blocks.length);
              blocks.push(block);
              open = null;
              lastBoundary = i;
              continue;
            }
          }
        }
        if (currentSectionIndex >= 0) sectionAtLine[i] = currentSectionIndex;
        continue;
      }

      // First-char dispatch: only lines that can start a heading or a fence
      // pay for the scanners; plain content lines fall straight through.
      const c0 = raw.charCodeAt(lineStart);
      if (c0 === 35 || c0 === 32 || c0 === 9 || c0 === 96 || c0 === 126) {
        const line = getLine(i);
        const heading = (c0 === 35 || c0 === 32 || c0 === 9) ? headingInfo(line) : null;
        if (heading) {
          lastBoundary = i;
          // Any heading closes the open sections it outranks (or outranks all
          // sections for H1/H2), mirroring markdown section semantics.
          while (sectionStack.length && sectionStack[sectionStack.length - 1].level >= heading.level) {
            closeSection(sections[sectionStack.pop().index], i, lineStarts[i]);
          }
          currentSectionIndex = sectionStack.length ? sectionStack[sectionStack.length - 1].index : -1;
          const isTurn = heading.level === 2 && (heading.text === '\u{1F464} User' || heading.text === '\u{1F916} Assistant');
          if (isTurn) {
            if (turn) closeTurn(turn, i, lineStarts[i]);
            turn = {
              index: turns.length,
              kind: heading.text === '\u{1F464} User' ? 'user' : 'assistant',
              immutable: heading.text === '\u{1F464} User',
              heading: heading.text,
              startLine: i,
              startOffset: lineStarts[i],
              endLine: -1,
              endOffset: 0,
              bodyStartOffset: Math.min(lineEnd(i) + 1, raw.length),
              finalAnswer: null,
              answerSpans: [],
              sections: [],
            };
            turns.push(turn);
          } else if (heading.level >= 3 && heading.level <= 6 && turn) {
            const parentIndex = currentSectionIndex;
            const sec = {
              index: sections.length,
              turnIndex: turn.index,
              level: heading.level,
              kind: classifySection(heading.text),
              title: heading.text,
              parentIndex,
              startLine: i,
              startOffset: lineStarts[i],
              endLine: -1,
              endOffset: 0,
              rawEndLine: -1,
              rawEndOffset: 0,
              immutable: false,
              blocks: [],
              exitStatus: null,
              durationMs: null,
            };
            if (sec.kind === 'bash_run') {
              sec.exitStatus = parseExitStatus(heading.text);
              sec.durationMs = parseDurationMs(heading.text);
            }
            sections.push(sec);
            sectionStack.push({ index: sec.index, level: sec.level });
            currentSectionIndex = sec.index;
            sectionAtLine[i] = sec.index;
            turn.sections.push(sec.index);
          }
          continue;
        }

        const fence = (c0 === 96 || c0 === 126 || c0 === 32 || c0 === 9) ? fenceInfo(line) : null;
        if (fence) {
          const label = lookbackLabel(getLine, i, lastBoundary);
          if (currentSectionIndex >= 0) sectionAtLine[i] = currentSectionIndex;
          activityAtLine[i] = 1;
          open = {
            char: fence.char, len: fence.len, info: fence.info,
            startLine: i, startOffset: lineStarts[i],
            label: label.label, fileName: label.fileName,
          };
          continue;
        }
      }
      if (currentSectionIndex >= 0) sectionAtLine[i] = currentSectionIndex;
      // Classify activity-structure content lines (card labels, file cards,
      // collapsed markers) so the trimming passes can read the precomputed flag.
      // Card labels start with `**` and collapsed markers with `_(`, so a
      // first-char check skips the string scans on ordinary prose lines. Only
      // lines inside a section can be read back, so skip when no section is open.
      if (currentSectionIndex >= 0) {
        const ac = raw.charCodeAt(lineStart);
        if (ac === 42) { // '*' — card label or file card
          const text = getLine(i);
          if (LABEL_RE.test(text) || FILE_RE.test(text)) activityAtLine[i] = 1;
        } else if (ac === 95 && raw.indexOf('_(', lineStart, lineEnd(i)) >= 0) { // '_'
          const text = getLine(i);
          if (NOT_EXPANDED_RE.test(text)) activityAtLine[i] = 1;
        }
      }
    }

    // EOF: close everything still open, back to front.
    const docEnd = raw.length;
    const lastLine = lineCount - 1;
    while (sectionStack.length) closeSection(sections[sectionStack.pop().index], lastLine + 1, docEnd);
    currentSectionIndex = -1;
    if (turn) closeTurn(turn, lastLine + 1, docEnd);

    // Trim each assistant-turn section to the end of its own activity content
    // so trailing (and interleaved) answer prose stays outside every spoiler
    // span. Sections in user turns keep their full markdown-semantics span.
    for (const sec of sections) {
      sec.rawEndLine = sec.endLine;
      sec.rawEndOffset = sec.endOffset;
      if (sec.turnIndex < 0) continue;
      const turnObj = turns[sec.turnIndex];
      if (!turnObj || turnObj.kind !== 'assistant') continue;
      // Scan the section's own lines (not covered by child sections) from the
      // end backwards for the last activity-structure line.
      let ownEndLine = sec.endLine;
      let ownEndOffset = sec.endOffset;
      for (let i = sec.endLine; i > sec.startLine; i--) {
        if (sectionAtLine[i] !== sec.index) continue; // inside a child section
        if (activityAtLine[i]) {
          ownEndLine = i;
          ownEndOffset = lineEnd(i);
          break;
        }
      }
      sec.endLine = ownEndLine;
      sec.endOffset = ownEndOffset;
    }

    // Phase 2: guarantee the trailing final-answer run. Scan each assistant
    // turn backwards from its end over the maximal run of non-blank lines that
    // contains no heading and no activity structure; that run is the final
    // answer and is immutable by construction. Any section still overlapping it
    // (e.g. a trailing pure-prose `Thought` section, whose content is
    // indistinguishable from answer prose in raw Markdown) is trimmed to end
    // where the answer begins.
    for (const turnObj of turns) {
      if (turnObj.kind !== 'assistant') continue;
      let i = turnObj.endLine;
      while (i > turnObj.startLine && getLine(i).trim() === '') i--;
      if (i <= turnObj.startLine) continue;
      const runEndLine = i;
      while (i > turnObj.startLine) {
        const prev = getLine(i - 1);
        if (prev.trim() === '' || headingInfo(prev) || activityAtLine[i - 1]) break;
        i--;
      }
      if (i > runEndLine) continue; // empty run
      const answerStart = lineStarts[i];
      if (answerStart >= turnObj.endOffset) continue;
      for (const sec of sections) {
        if (sec.turnIndex !== turnObj.index) continue;
        if (sec.startOffset <= answerStart && answerStart < sec.endOffset) {
          sec.endLine = i - 1;
          sec.endOffset = answerStart;
          break;
        }
      }
    }

    // A parent section spans its children: extend its end to the last child's
    // trimmed end. Children start after their parent, so processing sections
    // in reverse startLine order finalises every child before its parent —
    // a single linear pass, no nested scan.
    const childrenByParent = new Map();
    for (const sec of sections) {
      if (sec.parentIndex < 0) continue;
      let list = childrenByParent.get(sec.parentIndex);
      if (!list) { list = []; childrenByParent.set(sec.parentIndex, list); }
      list.push(sec);
    }
    const byStart = sections.map((s, i) => i).sort((a, b) => sections[b].startLine - sections[a].startLine);
    for (const idx of byStart) {
      const sec = sections[idx];
      for (const child of childrenByParent.get(sec.index) || []) {
        if (child.endOffset > sec.endOffset) {
          sec.endOffset = child.endOffset;
          sec.endLine = child.endLine;
        }
      }
    }

    // Compute immutable answer spans for assistant turns: the prose regions
    // outside every (trimmed) section span. The trailing region is the final
    // answer; interleaved regions between activity sections are answer prose too.
    for (const turnObj of turns) {
      if (turnObj.kind !== 'assistant') continue;
      const spans = turnObj.sections
        .map(idx => sections[idx])
        .sort((a, b) => a.startOffset - b.startOffset);
      let coverageEnd = turnObj.bodyStartOffset;
      for (const sec of spans) {
        if (sec.startOffset > coverageEnd) {
          const gapStart = coverageEnd;
          const gapEnd = sec.startOffset;
          if (raw.slice(gapStart, gapEnd).trim() !== '') {
            turnObj.answerSpans.push({ startOffset: gapStart, endOffset: gapEnd, kind: 'assistant_answer', immutable: true });
          }
        }
        if (sec.endOffset > coverageEnd) coverageEnd = sec.endOffset;
      }
      if (coverageEnd < turnObj.endOffset && raw.slice(coverageEnd, turnObj.endOffset).trim() !== '') {
        turnObj.answerSpans.push({ startOffset: coverageEnd, endOffset: turnObj.endOffset, kind: 'assistant_answer', immutable: true });
      }
      turnObj.finalAnswer = turnObj.answerSpans.length ? turnObj.answerSpans[turnObj.answerSpans.length - 1] : null;
    }

    // Defensive fallback: consecutive `**command:**` blocks that do not start
    // with `$` are chunked stdout continuations, not real commands. Relabel
    // a lone mislabelled block and merge consecutive runs into one stdout
    // block so pairing and downstream transforms see them as output.
    const fixed = [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.label === 'command' && !/^\s*\$/.test(block.body)) {
        const run = [block];
        let j = i + 1;
        while (j < blocks.length && blocks[j].label === 'command' && !/^\s*\$/.test(blocks[j].body)) {
          run.push(blocks[j]);
          j++;
        }
        if (run.length > 1) {
          const mergedBody = run.map(r => r.body).join('\n\n');
          const last = run[run.length - 1];
          fixed.push({
            ...block,
            label: 'stdout',
            relabeled: true,
            merged: true,
            children: run,
            body: mergedBody,
            bytes: utf8Bytes(mergedBody),
            rawSliceBytes: utf8Bytes(raw.slice(block.startOffset, last.endOffset)),
            endLine: last.endLine,
            endOffset: last.endOffset,
            pairedCommand: null,
            hasStderr: false,
          });
        } else {
          fixed.push({ ...block, label: 'stdout', relabeled: true });
        }
        i = j - 1;
        continue;
      }
      fixed.push(block);
    }

    // Pair stdout/stderr blocks with their command block, scoped by
    // (turnIndex, sectionIndex) so labels never pair across sections.
    let lastCommand = null;
    const scopeKey = b => b.turnIndex + ':' + b.sectionIndex;
    for (const block of fixed) {
      if (block.label === 'command') {
        lastCommand = block;
      } else if ((block.label === 'stdout' || block.label === 'stderr') &&
                 lastCommand && scopeKey(lastCommand) === scopeKey(block)) {
        block.pairedCommand = lastCommand;
        if (block.label === 'stderr' && block.body.trim()) lastCommand.hasStderr = true;
      } else if (block.label === 'unlabeled') {
        lastCommand = null;
      }
    }

    return {
      markdown: raw,
      bytes: utf8Bytes(raw),
      turns,
      sections,
      blocks: fixed,
      stats: { turnCount: turns.length, sectionCount: sections.length, blockCount: fixed.length },
    };
  }

  // --- deterministic span-edit composer --------------------------------------

  function normalizeSpan(span, what) {
    const start = Number(span && span.start);
    const end = Number(span && span.end);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new TypeError('AREX.applySpanEdits: ' + what + ' spans need integer start/end offsets');
    }
    return { start, end };
  }

  // Apply non-overlapping { start, end, text } edits to rawMarkdown. Edits may
  // be supplied in any order; the composer sorts them and rejects overlaps,
  // out-of-bounds offsets or edits touching a protected (immutable) span with
  // a deterministic error. Returns the composed markdown plus exact UTF-8
  // byte-delta accounting.
  function applySpanEdits(rawMarkdown, edits, protectedSpans) {
    const raw = String(rawMarkdown);
    if (!Array.isArray(edits)) throw new TypeError('AREX.applySpanEdits: edits must be an array');
    const normalized = edits.map((edit, i) => {
      if (!edit || typeof edit !== 'object') throw new TypeError('AREX.applySpanEdits: edit ' + i + ' is not an object');
      const start = Number(edit.start), end = Number(edit.end);
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new TypeError('AREX.applySpanEdits: edit ' + i + ' needs integer start/end offsets');
      }
      if (start < 0 || end > raw.length || start > end) {
        throw new RangeError('AREX.applySpanEdits: edit ' + i + ' is out of bounds (start=' + start + ', end=' + end + ', length=' + raw.length + ')');
      }
      if (edit.text === undefined || edit.text === null) {
        throw new TypeError('AREX.applySpanEdits: edit ' + i + ' is missing required text');
      }
      return { start, end, text: String(edit.text) };
    });
    normalized.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < normalized.length; i++) {
      if (normalized[i].start < normalized[i - 1].end) {
        throw new RangeError('AREX.applySpanEdits: edits ' + (i - 1) + ' and ' + i + ' overlap');
      }
    }
    if (protectedSpans) {
      const protectedList = protectedSpans.map((span, i) => {
        const s = Array.isArray(span) ? { start: span[0], end: span[1] } : span;
        const p = normalizeSpan(s, 'protected ' + i);
        if (p.start > p.end || p.start < 0 || p.end > raw.length) {
          throw new RangeError('AREX.applySpanEdits: protected span ' + i + ' is out of bounds');
        }
        return p;
      });
      for (const edit of normalized) {
        for (let i = 0; i < protectedList.length; i++) {
          const p = protectedList[i];
          if (edit.start < p.end && p.start < edit.end) {
            throw new RangeError('AREX.applySpanEdits: edit overlaps immutable span ' + i +
              ' (edit ' + edit.start + '–' + edit.end + ', protected ' + p.start + '–' + p.end + ')');
          }
        }
      }
    }

    const parts = [];
    let last = 0;
    for (const edit of normalized) {
      parts.push(raw.slice(last, edit.start), edit.text);
      last = edit.end;
    }
    parts.push(raw.slice(last));
    const markdown = parts.join('');
    const baseBytes = utf8Bytes(raw);
    const afterBytes = utf8Bytes(markdown);
    return {
      markdown,
      bytes: afterBytes,
      baseBytes,
      byteDelta: afterBytes - baseBytes,
      stats: { applied: normalized.length },
    };
  }

  AREX.buildDocumentIndex = buildDocumentIndex;
  AREX.applySpanEdits = applySpanEdits;
  AREX.utf8Bytes = utf8Bytes;
})();
