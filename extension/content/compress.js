// Deterministic transcript compression and size metrics. Runs unchanged in
// window, service-worker and dedicated-worker contexts.
globalThis.AREX = globalThis.AREX || {};

(function () {
  const tick = String.fromCharCode(96);
  const utf8Bytes = value => {
    let bytes = 0;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c < 0x80) bytes += 1;
      else if (c < 0x800) bytes += 2;
      else if (c >= 0xD800 && c <= 0xDBFF) {
        const next = value.charCodeAt(i + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) { bytes += 4; i++; }
        else bytes += 3;
      } else if (c >= 0xDC00 && c <= 0xDFFF) bytes += 3;
      else bytes += 3;
    }
    return bytes;
  };
  const fnv1a32 = str => {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  };
  const formatBytes = bytes => {
    const safe = Math.max(0, Math.round(bytes));
    if (safe < 1000) return safe + ' B';
    if (safe < 1000000) return (safe / 1000).toFixed(1) + ' KB';
    return (safe / 1000000).toFixed(2) + ' MB';
  };
  const formatByteCount = bytes => Math.max(0, Math.round(bytes)).toLocaleString('en-US') + ' B';

  const unicodeClasses = new Uint8Array(65536);
  const nonBmpClasses = new Map();
  const UNICODE_WORD = /[\p{L}\p{N}]/u, UNICODE_SPACE = /\s/u;
  // ASCII lookup: bits 0-1 are the class (0 space, 1 word, 2 other), bit 2 a Latin letter, bit 3 a digit.
  const ASCII_INFO = new Uint8Array(128);
  for (let c = 0; c < 128; c++) {
    const latin = (c >= 65 && c <= 90) || (c >= 97 && c <= 122), digit = c >= 48 && c <= 57;
    ASCII_INFO[c] = (latin || digit || c === 95 ? 1 : ((c >= 9 && c <= 13) || c === 32 ? 0 : 2)) | (latin ? 4 : 0) | (digit ? 8 : 0);
  }

  // Tokens of one chunk, from the counts of its characters by script.
  function chunkTokens(length, cyrillic, cjk, latin, digits) {
    if (cjk) return Math.ceil(cjk * 1.15) + (length > cjk ? Math.ceil((length - cjk) / 4) : 0);
    if (cyrillic) return (cyrillic <= 3 ? 1 : Math.ceil(cyrillic / 3.4)) + (length > cyrillic ? Math.ceil((length - cyrillic) / 4) : 0);
    if (latin) return (latin <= 7 ? 1 : Math.ceil(latin / 4.5)) + (length > latin ? Math.ceil((length - latin) / 3) : 0);
    return digits ? Math.ceil(digits / 3) : Math.ceil(length / 4);
  }

  // Same chunk boundaries and formula as the original Unicode regex estimate,
  // without constructing a potentially enormous array of matched substrings.
  // A chunk is a run of word or of other characters; whitespace separates chunks.
  function estimateTokens(value) {
    let total = 0, kind = 0, length = 0, cyrillic = 0, cjk = 0, latin = 0, digits = 0;
    for (let i = 0, n = value.length; i < n; i++) {
      let cp = value.charCodeAt(i);
      if (cp < 128) {
        const info = ASCII_INFO[cp], next = info & 3;
        if (next !== kind) {
          if (length) { total += chunkTokens(length, cyrillic, cjk, latin, digits); length = cyrillic = cjk = latin = digits = 0; }
          kind = next;
        }
        if (next) { length++; if (info & 4) latin++; else if (info & 8) digits++; }
        continue;
      }
      let width = 1;
      if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < n) {
        const low = value.charCodeAt(i + 1);
        if (low >= 0xDC00 && low <= 0xDFFF) { cp = ((cp - 0xD800) << 10) + (low - 0xDC00) + 0x10000; width = 2; i++; }
      }
      let cached = cp < 65536 ? unicodeClasses[cp] : nonBmpClasses.get(cp);
      if (!cached) {
        const ch = String.fromCodePoint(cp);
        cached = UNICODE_WORD.test(ch) ? 1 : (UNICODE_SPACE.test(ch) ? 2 : 3);
        if (cp < 65536) unicodeClasses[cp] = cached; else nonBmpClasses.set(cp, cached);
      }
      const next = cached === 1 ? 1 : (cached === 2 ? 0 : 2);
      if (next !== kind) {
        if (length) { total += chunkTokens(length, cyrillic, cjk, latin, digits); length = cyrillic = cjk = latin = digits = 0; }
        kind = next;
      }
      if (next) {
        length += width;
        if (cp >= 0x400 && cp <= 0x52f) cyrillic++;
        if ((cp >= 0x3040 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af)) cjk++;
      }
    }
    return length ? total + chunkTokens(length, cyrillic, cjk, latin, digits) : total;
  }

  // Split only once and retain offsets into the original. Fences are found in
  // one traversal; final edits splice original text by offsets, never reparsing.
  function buildMarkdownIndex(rawMarkdown) {
    const lines = rawMarkdown.split('\n'), offsets = new Array(lines.length);
    let offset = 0;
    for (let i = 0; i < lines.length; i++) { offsets[i] = offset; offset += lines[i].length + 1; }
    const blocks = [], openRe = /^(\s*)(`{3,}|~{3,})(.*)$/;
    let open = null, activityId = 0, activity = '', lastCommand = null, lastBoundary = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!open) {
        const heading = /^(#{2,6})\s+(.+)$/.exec(line);
        if (heading) { activityId++; activity = heading[1].length >= 3 ? heading[2].trim() : ''; lastCommand = null; lastBoundary = i; }
        const match = openRe.exec(line);
        if (!match) continue;
        const prefix = lines.slice(Math.max(0, i - 12), i).join('\n');
        let label = '', fileName = '';
        // A card label belongs only to the immediately following fence, never
        // a later unrelated prose/file block after another fence or heading.
        for (let j = i - 1; j > Math.max(lastBoundary, i - 13); j--) {
          const text = lines[j];
          const labels = text.includes('**') ? [...text.matchAll(/\*\*(stdout|stderr|command):\*\*/gi)] : [];
          const files = text.includes('📄') ? [...text.matchAll(/\*\*📄\s*([^*]+)\*\*\s*_\\(([^)]+)\\)_/gi)] : [];
          const l = labels.at(-1), f = files.at(-1);
          if (l || f) {
            if (f && (!l || f.index > l.index)) fileName = f[1].trim();
            else label = l[1].toLowerCase();
            break;
          }
        }
        open = { start: i, startOffset: offsets[i], fence: match[2],
          closeRe: new RegExp('^\\s*' + match[2][0] + '{' + match[2].length + ',}\\s*$'),
          openLine: line, label, fileName, activity, activityId, prefix };
        continue;
      }
      if (!open.closeRe.test(line)) continue;
      const body = lines.slice(open.start + 1, i).join('\n');
      const endOffset = offsets[i] + line.length;
      const rawSlice = rawMarkdown.slice(open.startOffset, endOffset);
      const block = { ...open, end: i, endOffset, closeLine: line, body,
        bytes: utf8Bytes(body), estimatedTokens: estimateTokens(body),
        rawSliceBytes: utf8Bytes(rawSlice), rawSliceTokens: estimateTokens(rawSlice),
        pairedCommand: null };
      if (block.label === 'command') lastCommand = block;
      else if ((block.label === 'stdout' || block.label === 'stderr') && lastCommand?.activityId === block.activityId) {
        block.pairedCommand = lastCommand;
        if (block.label === 'stderr' && block.body.trim()) lastCommand.hasStderr = true;
      }
      else if (!block.label) lastCommand = null;
      blocks.push(block); open = null; lastBoundary = i;
    }
    return { markdown: rawMarkdown, blocks, bytes: utf8Bytes(rawMarkdown), baseTokens: estimateTokens(rawMarkdown) };
  }
  const PASS_PATTERNS = [
    /^\(pass\)\s+\S.*$/,
    /^\s*[✓✔]\s+\S.*$/,
    /^test\s+\S+\s+\.\.\.\s+ok$/,
    /^[A-Za-z_][A-Za-z0-9_]*\s+\([A-Za-z0-9_.]+\)\s+\.\.\.\s+ok$/,
    /^\S+::\S+\s+PASSED(?:\s+\[\s*\d+%\])?$/,
    /^---\s+PASS:\s+\S+\s+\([0-9.]+s\)$/,
    /^ok\s+\d+\s+-\s+\S.*$/,
  ];

  function stripTerminalNoise(raw) {
    const ansi = raw.replace(/\x1b(?:\[[0-9;?]*[\x20-\x2f]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g, "");
    const result = [];
    for (const sourceLine of ansi.replace(/\r\n/g, "\n").split("\n")) {
      let line = sourceLine;
      if (line.includes("\r")) {
        if (line.endsWith("\r")) continue;
        const segments = line.split("\r").filter(Boolean);
        line = segments.length ? segments[segments.length - 1] : "";
      }
      if (line.trimStart().match(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?:\s.*)?$/)) continue;
      result.push(line);
    }
    return result.join("\n").trimEnd();
  }

  function collapsePassingRuns(text) {
    const lines = text.split("\n");
    const out = [];
    let collapsed = 0;
    const isPass = line => PASS_PATTERNS.some(pattern => pattern.test(line));
    for (let i = 0; i < lines.length;) {
      if (!isPass(lines[i])) { out.push(lines[i++]); continue; }
      let end = i + 1;
      while (end < lines.length && isPass(lines[end])) end += 1;
      const runLength = end - i;
      if (runLength >= 6) {
        out.push("[... collapsed " + runLength + " passing test lines ...]");
        collapsed += runLength;
      } else {
        out.push(...lines.slice(i, end));
      }
      i = end;
    }
    return { text: out.join("\n"), collapsed };
  }

  const ERROR_SIGNAL = /\b(?:error|failed|failure|exception|traceback|panic|fatal|segmentation fault|assertion failed)\b/i;

  // Do not infer paths from shell pipelines/redirections or dynamic expansion.
  // Relative paths are scoped by an explicit preceding `cd`, when present.
  function commandInfo(command) {
    const text = command.replace(/^\s*\$\s?/, '').trim();
    const cd = /^cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&]+))\s*&&\s*/.exec(text);
    const cwd = cd ? (cd[1] || cd[2] || cd[3]) : '';
    const firstLine = (cd ? text.slice(cd[0].length) : text).split('\n', 1)[0];
    const heredoc = /^cat\s+>\s*(?!>)(?:"([^"\n]+)"|'([^'\n]+)'|([^\s<>|;&]+))\s+<<-?\s*(?:'[^']+'|"[^"]+"|[A-Za-z_][\w]*)\s*$/.exec(firstLine);
    if (heredoc) return { kind: 'write', path: heredoc[1] || heredoc[2] || heredoc[3], cwd };
    if (/\n|\||[<>`$]/.test(text)) return null;
    const segments = text.split(/\s*(?:&&|;)\s*/);
    if (segments.length > 2 || (segments.length === 2 && !cd)) return null;
    const tokens = (segments.at(-1).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).map(t => t.replace(/^['"]|['"]$/g, ''));
    const tool = tokens.shift();
    if (!['cat', 'sed', 'head', 'tail', 'nl'].includes(tool)) return null;
    const args = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '--') { args.push(...tokens.slice(i + 1)); break; }
      if (['-n', '-c', '--lines', '--bytes', '-w', '-s', '-v', '-i', '-l'].includes(t) && tool !== 'sed') { i++; continue; }
      if (t.startsWith('-')) continue;
      args.push(t);
    }
    if (tool === 'sed') {
      // Only a simple printing expression is safely treated as a file read.
      const expression = args.shift();
      if (!expression || !/^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(expression)) return null;
    }
    if (args.length !== 1 || !args[0] || args[0] === '-') return null;
    return { kind: 'read', path: args[0], cwd };
  }

  const EXECUTION_ERROR = /(?:^|\n)\s*(?:(?:fatal|error|panic|traceback|assertion failed)\s*[:(]|(?:cat|sed|head|tail|nl):\s*[^\n]+|(?:[\w./-]+(?:error|exception)):\s+\S)/i;
  const failed = block => /\bexit\s+[1-9]\d*\b/i.test(block.activity) || /shell error/i.test(block.activity);
  const safeRead = block => {
    const info = block.pairedCommand && commandInfo(block.pairedCommand.body);
    return info?.kind === 'read' && !failed(block) && !block.pairedCommand.hasStderr && !EXECUTION_ERROR.test(block.body) ? info : null;
  };
  function readIdentity(block) {
    const info = safeRead(block);
    if (block.pairedCommand && commandInfo(block.pairedCommand.body)?.kind === 'read' && !info) return null;
    if (info) return { key: (info.path.startsWith('/') ? '' : info.cwd) + '\0' + info.path, path: info.path };
    const heading = /^(?:used\s+)?(?:read|open|cat|view)\s+(.+?)(?:\s+[-—·]?\s*\d+(?:\.\d+)?\s*(?:ms|s))?$/i.exec(block.activity);
    const pathBody = /^\s*(?:<path>|path:\s*|file:\s*)([^\n<]+)(?:<\/path>)?/i.exec(block.body);
    const path = block.fileName || heading?.[1] || pathBody?.[1];
    if (!path || block.label === 'command') return null;
    const clean = path.trim().replace(/^["']+|["']+$/g, '').replace(/[\\\/]+/g, '/');
    return { key: '\0' + clean, path: clean };
  }

  function renderBlock(block, edit) {
    if (!edit) return null;
    let content = edit.reference || (block.openLine + '\n' + (edit.body ?? block.body) + '\n' + block.closeLine);
    if (edit.anchor) content = '<a id="arex-output-' + edit.anchor + '"></a>\n' + content;
    if (edit.stubAnchor) content = '<a id="arex-stubs-output-' + edit.stubAnchor + '"></a>\n' + content;
    return content;
  }

  // A bare tool fence sits directly under a 📄 file card header or an activity heading, and the serializer
  // fences unlabeled tool output as `text`. Code in prose has another shape.
  const FILE_CARD = /^\*\*📄\s*[^*]+\*\*\s*_\([^)]+\)/;
  const ACTIVITY_HEADING = /^#{3,6}\s+(?:used\s+\S|ran\s+commands|explored\b|edited\b)/i;
  const TEXT_FENCE = /^(?:`{3,}|~{3,})text$/;
  const JSON_START = /^\s*[\[{]/;
  const SEARCH_HIT = /^[^\s:]+:\d+:/;
  // Every stage beyond Lossless lives in its own module and is feature-detected per call: a bundle that lacks
  // one keeps the previous behaviour for that stage instead of failing.
  const isCallable = name => typeof AREX[name] === 'function';

  // `fixed` blocks are never edited by a block stage: code inside User turns and assistant prose, which stay
  // byte-identical in every mode, and drafts inside Thoughts, which only compress-thoughts.js may change.
  // `doc` is the DocumentIndex of the raw Markdown, shared with later stages.
  function guardBlocks(raw, blocks) {
    const guard = { fixed: new Set(), doc: null };
    for (const block of blocks) {
      if (block.label || block.fileName) continue;
      // Anywhere else a bare fence is code in prose or a Thought draft, which the section index cannot tell
      // from tool output.
      const before = (block.prefix || '').trimEnd();
      const lead = before.slice(before.lastIndexOf('\n') + 1);
      if (!FILE_CARD.test(lead) && !(ACTIVITY_HEADING.test(lead) && TEXT_FENCE.test((block.openLine || '').trim()))) guard.fixed.add(block);
    }
    if (!isCallable('buildDocumentIndex')) return guard;
    try { guard.doc = AREX.buildDocumentIndex(raw); }
    catch (error) { guard.fixed = { has: () => true }; return guard; } // fail closed: edit nothing
    const ranges = [];
    for (const turn of guard.doc.turns) {
      if (turn.kind !== 'assistant') ranges.push(turn.startOffset, turn.endOffset);
      else for (const span of turn.answerSpans) ranges.push(span.startOffset, span.endOffset);
    }
    for (let b = 0, r = 0; b < blocks.length; b++) {
      while (r < ranges.length && ranges[r + 1] <= blocks[b].startOffset) r += 2;
      if (r < ranges.length && ranges[r] < blocks[b].endOffset) guard.fixed.add(blocks[b]);
    }
    return guard;
  }

  // Estimated tokens are additive across whitespace, so an edit between whitespace changes the total by
  // exactly estimate(new) - estimate(old). Returns null when an edit could merge two chunks.
  const isSpace = code => (code >= 9 && code <= 13) || code === 32 || (code > 127 && /\s/u.test(String.fromCharCode(code)));
  function spanTokenDelta(raw, edits) {
    const sorted = [...edits].sort((a, b) => a.start - b.start);
    let delta = 0, previousEnd = -1;
    for (const edit of sorted) {
      if (edit.start <= previousEnd) return null;
      const leftOpen = edit.start === 0 || isSpace(raw.charCodeAt(edit.start - 1));
      const rightOpen = edit.end >= raw.length || isSpace(raw.charCodeAt(edit.end));
      const oldClosed = edit.end > edit.start && isSpace(raw.charCodeAt(edit.end - 1));
      const newClosed = edit.text === '' || isSpace(edit.text.charCodeAt(edit.text.length - 1));
      if (!leftOpen || !(rightOpen || (oldClosed && newClosed))) return null;
      delta += estimateTokens(edit.text) - estimateTokens(raw.slice(edit.start, edit.end));
      previousEnd = edit.end;
    }
    return delta;
  }

  // Failed runs, stderr and diagnostics keep their lines: only noise and passing-test runs are folded there.
  function hasDiagnostic(block, body, index) {
    if (isCallable('analyzeExecutionDiagnostics')) {
      return AREX.analyzeExecutionDiagnostics(block, index, { cleanedBody: body, stopOnFirst: true }).hasDiagnostic;
    }
    return failed(block) || !!block.pairedCommand?.hasStderr || ERROR_SIGNAL.test(body);
  }

  function legacyClip(block, body) {
    const isRead = block.pairedCommand && commandInfo(block.pairedCommand.body)?.kind === 'read';
    const error = isRead ? (block.pairedCommand.hasStderr || EXECUTION_ERROR.test(block.body)) : ERROR_SIGNAL.test(block.body);
    if (!error && !failed(block)) {
      const lines = body.split('\n');
      if ((lines.length > 110 || utf8Bytes(body) > 5500) && lines.length > 88) {
        body = lines.slice(0, 45).concat('[... omitted ' + (lines.length - 80) + ' middle lines (exit status not reported; no error markers detected) ...]', lines.slice(-35)).join('\n');
      }
    }
    return body;
  }

  function legacySmartBody(block) {
    const body = stripTerminalNoise(block.body);
    return block.label === 'stdout' ? legacyClip(block, collapsePassingRuns(body).text) : body;
  }

  // Smart body of a stdout/stderr block, with the Smart budget in both modes: terminal noise, then folded test
  // runs, JSON and search hits, then the error-aware width and head/tail budget. Search and JSON reshaping is
  // limited to blocks without diagnostics.
  function smartBody(block, index) {
    const strip = isCallable('stripTerminalNoise') ? AREX.stripTerminalNoise : stripTerminalNoise;
    let body = strip(block.body);
    if (block.label !== 'stdout') return body;
    body = (isCallable('collapsePassingRuns') ? AREX.collapsePassingRuns : collapsePassingRuns)(body).text;
    if (isCallable('groupSearchHits') && isCallable('stripJsonBoilerplate') &&
        (JSON_START.test(body) || SEARCH_HIT.test(body)) && !hasDiagnostic(block, body, index)) {
      body = AREX.groupSearchHits(AREX.stripJsonBoilerplate(body));
    }
    if (!isCallable('compactStdoutBlock')) return legacyClip(block, body);
    const result = AREX.compactStdoutBlock(block, { mode: 'smart', index, body });
    return result.changed ? result.body : body;
  }

  // The pipeline, in order. Every stage after Lossless only ever shrinks the previous result, which is what keeps
  // Off >= Lossless >= Smart >= Stubs, and Stubs is Smart plus extra guarded stages.
  //   Lossless  exact duplicate outputs: the first copy is anchored, later copies link to it
  //   Smart     terminal noise, folded test runs, JSON and search hits, error-aware width and head/tail budget
  //   Stubs     clean scripts and diffs, content-defined line references, then a tighter head/tail budget
  //   framing   redundant wrappers and single-line command cards (Smart, Stubs)
  //   reasoning long middle Thought blocks and drafts (Smart, Stubs; `options.condenseThoughts !== false`)
  // User turns, assistant answers and code in prose are never edited, and Thoughts only by the last stage.
  function compressIndex(index, options = {}) {
    const mode = ['off', 'lossless', 'smart', 'stubs'].includes(options.mode) ? options.mode : 'lossless';
    const raw = index.markdown, blocks = index.blocks, baseBytes = index.bytes;
    const baseTokens = index.baseTokens ?? estimateTokens(raw);
    const stats = { deduplicated: 0, smartCompacted: 0, stubbed: 0 };
    if (mode === 'smart' || mode === 'stubs') stats.framingCompacted = 0;
    if (mode === 'stubs') stats.commandsShortened = 0;
    if (mode === 'off') return { markdown: raw, bytes: baseBytes, baselineBytes: baseBytes, savedBytes: 0, savedRatio: 0, estimatedTokens: baseTokens, stats };
    const guard = guardBlocks(raw, blocks);
    let edits = new Map(), bytes = baseBytes, tokens = baseTokens;
    const setEdit = (map, block, edit) => {
      const old = map.get(block);
      const originalBytes = block.rawSliceBytes ?? utf8Bytes(raw.slice(block.startOffset, block.endOffset));
      const originalTokens = block.rawSliceTokens ?? estimateTokens(raw.slice(block.startOffset, block.endOffset));
      const beforeStr = old ? renderBlock(block, old) : null;
      const afterStr = renderBlock(block, edit);
      const beforeBytes = beforeStr != null ? utf8Bytes(beforeStr) : originalBytes;
      const beforeTokens = beforeStr != null ? estimateTokens(beforeStr) : originalTokens;
      const afterBytes = utf8Bytes(afterStr);
      const afterTokens = estimateTokens(afterStr);
      map.set(block, edit);
      return [afterBytes - beforeBytes, afterTokens - beforeTokens];
    };

    const seen = new Map(); let nextId = 1;
    for (const block of blocks) {
      if (block.label === 'command' || (!block.label && !block.fileName) || block.bytes < 128 || guard.fixed.has(block)) continue;
      const h = fnv1a32(block.body);
      const key = block.bytes + ':' + h;
      const bucket = seen.get(key);
      let first = null;
      if (bucket) {
        for (let bi = 0; bi < bucket.length; bi++) {
          if (bucket[bi].block.body === block.body) { first = bucket[bi]; break; }
        }
      }
      if (!first) {
        const entry = { id: nextId++, block, anchored: false };
        if (bucket) bucket.push(entry); else seen.set(key, [entry]);
        continue;
      }
      if (!first.anchored) {
        const [bd, td] = setEdit(edits, first.block, { body: first.block.body, anchor: first.id });
        bytes += bd; tokens += td; first.anchored = true;
      }
      const [bd, td] = setEdit(edits, block, { reference: '_Identical to [output #' + first.id + '](#arex-output-' + first.id + ') — byte-for-byte match._' });
      bytes += bd; tokens += td;
      stats.deduplicated++;
    }
    if (bytes >= baseBytes) { edits = new Map(); bytes = baseBytes; tokens = baseTokens; stats.deduplicated = 0; }

    // Smart and Stubs share one log stage; Stubs only adds guarded stages on top of it, so each can
    // only shrink the Smart result.
    const compacted = new Set();
    // Lossless anchors and references are never touched; a Stubs source must stay intact for its references.
    const frozen = block => { const edit = edits.get(block); return guard.fixed.has(block) || !!(edit && (edit.reference || edit.anchor || edit.stubAnchor)); };
    if (mode === 'smart' || mode === 'stubs') {
      const smartEdits = new Map(edits); let smartBytes = bytes, smartTokens = tokens;
      for (const block of blocks) {
        if ((block.label !== 'stdout' && block.label !== 'stderr') || frozen(block)) continue;
        let body;
        try { body = smartBody(block, index); }
        catch (error) { body = legacySmartBody(block); }
        if (body !== block.body && utf8Bytes(body) < block.bytes) {
          const [bd, td] = setEdit(smartEdits, block, { ...smartEdits.get(block), body });
          smartBytes += bd; smartTokens += td; compacted.add(block);
        }
      }
      if (smartBytes <= bytes) { edits = smartEdits; bytes = smartBytes; tokens = smartTokens; stats.smartCompacted = compacted.size; }
      else compacted.clear();
    }

    if (mode === 'stubs') {
      // Clean inline scripts and git diffs: accepted only where they beat the body the Smart stage left.
      if (guard.doc && isCallable('compactCommands')) {
        try {
          const bodyAt = new Map();
          for (const block of blocks) bodyAt.set(raw.indexOf('\n', block.startOffset) + 1, block);
          const next = new Map(edits); let nextBytes = bytes, nextTokens = tokens, shortened = 0;
          for (const edit of AREX.compactCommands(guard.doc, { mode }).edits) {
            const block = bodyAt.get(edit.start);
            if (!block || frozen(block) || edit.end - edit.start !== block.body.length) continue;
            const current = next.get(block);
            if (utf8Bytes(edit.text) >= utf8Bytes(current?.body ?? block.body)) continue;
            const [bd, td] = setEdit(next, block, { ...current, body: edit.text });
            nextBytes += bd; nextTokens += td; shortened++;
          }
          if (shortened && nextBytes <= bytes) { edits = next; bytes = nextBytes; tokens = nextTokens; stats.commandsShortened = shortened; }
        } catch (error) { /* an optional stage never breaks the preview */ }
      }

      // Path-agnostic, content-defined line deduplication (Stubs v2, issue #8) runs before the tighter
      // Stubs budget so overlapping ranges become exact references rather than omissions. Thought drafts and
      // protected blocks take no part: they can be neither a source nor a target.
      if (isCallable('compressStubs')) {
        try {
          const reservedIds = new Set();
          for (const match of raw.matchAll(/arex-stubs-output-(\d+)/g)) reservedIds.add(match[1]);
          const eligible = blocks.filter(block => !guard.fixed.has(block));
          const stubbed = AREX.compressStubs(eligible, edits, bytes, tokens, setEdit, reservedIds, { mode });
          if (stubbed.bytes <= bytes) {
            edits = stubbed.edits; bytes = stubbed.bytes; tokens = stubbed.tokens; stats.stubbed = stubbed.stubbed;
          }
        } catch (error) { /* an optional stage never breaks the preview */ }
      }

      // Tighter Stubs head/tail budget for what is left. Sources of references keep every line.
      if (isCallable('compactStdoutBlock')) {
        const tight = new Map(edits); let tightBytes = bytes, tightTokens = tokens;
        for (const block of blocks) {
          if (block.label !== 'stdout' || frozen(block)) continue;
          const current = tight.get(block);
          let result;
          try { result = AREX.compactStdoutBlock(block, { mode, index, body: current?.body ?? block.body }); }
          catch (error) { continue; }
          if (!result.changed || result.bytesAfter >= result.bytesBefore) continue;
          const [bd, td] = setEdit(tight, block, { ...current, body: result.body });
          tightBytes += bd; tightTokens += td; compacted.add(block);
        }
        if (tightBytes <= bytes) { edits = tight; bytes = tightBytes; tokens = tightTokens; stats.smartCompacted = compacted.size; }
      }
    }

    const parts = []; let last = 0;
    for (const block of blocks) {
      const edit = edits.get(block);
      if (!edit) continue;
      parts.push(raw.slice(last, block.startOffset), renderBlock(block, edit)); last = block.endOffset;
    }
    parts.push(raw.slice(last));
    let markdown = parts.join('');
    if ((mode === 'smart' || mode === 'stubs') && isCallable('compactFraming') && isCallable('buildDocumentIndex')) {
      try {
        // Runs after output/Stubs edits so framing sees the final fences and anchors, never stale offsets
        // or command sources referenced by Stubs.
        const framing = AREX.compactFraming(AREX.buildDocumentIndex(markdown), { mode });
        if (framing.byteDelta < 0) {
          const delta = spanTokenDelta(markdown, framing.edits);
          tokens = delta === null ? estimateTokens(framing.markdown) : tokens + delta;
          markdown = framing.markdown;
          bytes = framing.bytes;
          stats.framingCompacted = framing.stats.collapsedWrappers + framing.stats.emptyExplored + framing.stats.compactCommands;
        }
      } catch (error) { /* an optional stage never breaks the preview */ }
    }
    const savedBytes = baseBytes - bytes;
    const result = { markdown, bytes, baselineBytes: baseBytes, savedBytes, savedRatio: baseBytes ? savedBytes / baseBytes : 0, estimatedTokens: tokens, stats };
    // Last stage, switched off with `condenseThoughts: false` (the popup worker caches that base and applies this itself).
    if ((mode === 'smart' || mode === 'stubs') && options.condenseThoughts !== false && isCallable('applyThoughtCondensation')) {
      try { return AREX.applyThoughtCondensation(result, { mode, condenseThoughts: options.condenseThoughts }); }
      catch (error) { /* an optional stage never breaks the preview */ }
    }
    return result;
  }

  AREX.buildMarkdownIndex = buildMarkdownIndex;
  AREX.compressIndex = compressIndex;
  AREX.compressMarkdown = (rawMarkdown, options = {}) => compressIndex(options.mode === 'off'
    ? { markdown: rawMarkdown, blocks: [], bytes: utf8Bytes(rawMarkdown), baseTokens: estimateTokens(rawMarkdown) } : buildMarkdownIndex(rawMarkdown), options);
  AREX.formatTokenCount = function (tokens) {
    const safe = Math.max(0, Math.round(tokens));
    if (safe === 0) return '0';
    if (safe < 1000) return String(safe);
    if (safe < 99950) return (safe / 1000).toFixed(1) + 'k';
    return Math.round(safe / 1000).toLocaleString('en-US') + 'k';
  };
  AREX.measureMarkdown = markdown => ({ bytes: utf8Bytes(markdown), estimatedTokens: estimateTokens(markdown) });
  AREX.formatBytes = formatBytes;
  AREX.formatByteCount = formatByteCount;

  // Exposed for the other pipeline modules: compress-stubs.js (issue #8) reuses the path / error helpers
  // for its eligibility check, compress-thoughts.js the exact token delta of its span edits.
  AREX.spanTokenDelta = spanTokenDelta;
  AREX.commandInfo = commandInfo;
  AREX.safeRead = safeRead;
  AREX.failed = failed;
  AREX.ERROR_SIGNAL = ERROR_SIGNAL;
  AREX.EXECUTION_ERROR = EXECUTION_ERROR;
})();
