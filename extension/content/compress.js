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

  // Same chunk boundaries and formula as the original Unicode regex estimate,
  // without constructing a potentially enormous array of matched substrings.
  function estimateTokens(value) {
    const unicodeWord = /[\p{L}\p{N}]/u, unicodeSpace = /\s/u;
    let total = 0, kind = 0, length = 0, cyrillic = 0, cjk = 0, latin = 0, digits = 0;
    const flush = () => {
      if (!length) return;
      if (cjk) { total += Math.ceil(cjk * 1.15); if (length > cjk) total += Math.ceil((length - cjk) / 4); }
      else if (cyrillic) { total += cyrillic <= 3 ? 1 : Math.ceil(cyrillic / 3.4); if (length > cyrillic) total += Math.ceil((length - cyrillic) / 4); }
      else if (latin) { total += latin <= 7 ? 1 : Math.ceil(latin / 4.5); if (length > latin) total += Math.ceil((length - latin) / 3); }
      else if (digits) total += Math.ceil(digits / 3);
      else total += Math.ceil(length / 4);
      length = cyrillic = cjk = latin = digits = 0;
    };
    for (let i = 0; i < value.length;) {
      const cp = value.codePointAt(i), width = cp > 0xffff ? 2 : 1;
      let next;
      if (cp < 128) {
        const word = (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || (cp >= 48 && cp <= 57) || cp === 95;
        next = word ? 1 : ((cp >= 9 && cp <= 13) || cp === 32 ? 0 : 2);
      } else {
        let cached = cp < 65536 ? unicodeClasses[cp] : nonBmpClasses.get(cp);
        if (!cached) {
          const ch = String.fromCodePoint(cp);
          cached = unicodeWord.test(ch) ? 1 : (unicodeSpace.test(ch) ? 2 : 3);
          if (cp < 65536) unicodeClasses[cp] = cached; else nonBmpClasses.set(cp, cached);
        }
        next = cached === 1 ? 1 : (cached === 2 ? 0 : 2);
      }
      if (next !== kind || next === 0) { flush(); kind = next; }
      if (next) {
        length += width;
        if (cp >= 0x400 && cp <= 0x52f) cyrillic++;
        if ((cp >= 0x3040 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af)) cjk++;
        if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) latin++;
        if (cp >= 48 && cp <= 57) digits++;
      }
      i += width;
    }
    flush(); return total;
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

  function compressIndex(index, options = {}) {
    const mode = ['off', 'lossless', 'smart', 'stubs'].includes(options.mode) ? options.mode : 'lossless';
    const raw = index.markdown, blocks = index.blocks, baseBytes = index.bytes;
    const baseTokens = index.baseTokens ?? estimateTokens(raw);
    const stats = { deduplicated: 0, smartCompacted: 0, stubbed: 0 };
    if (mode === 'off') return { markdown: raw, bytes: baseBytes, baselineBytes: baseBytes, savedBytes: 0, savedRatio: 0, estimatedTokens: baseTokens, stats };
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
      if (block.label === 'command' || (!block.label && !block.fileName) || block.bytes < 128) continue;
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

    if (mode === 'smart' || mode === 'stubs') {
      const smartEdits = new Map(edits); let smartBytes = bytes, smartTokens = tokens, count = 0;
      for (const block of blocks) {
        if ((block.label !== 'stdout' && block.label !== 'stderr') || edits.get(block)?.reference || edits.get(block)?.anchor) continue;
        let body = stripTerminalNoise(block.body);
        if (block.label === 'stdout') {
          body = collapsePassingRuns(body).text;
          const isRead = block.pairedCommand && commandInfo(block.pairedCommand.body)?.kind === 'read';
          const error = isRead ? (block.pairedCommand.hasStderr || EXECUTION_ERROR.test(block.body)) : ERROR_SIGNAL.test(block.body);
          if (!error && !failed(block)) {
            const lines = body.split('\n');
            if ((lines.length > 110 || utf8Bytes(body) > 5500) && lines.length > 88) {
              body = lines.slice(0, 45).concat('[... omitted ' + (lines.length - 80) + ' middle lines (exit status not reported; no error markers detected) ...]', lines.slice(-35)).join('\n');
            }
          }
        }
        if (body !== block.body && utf8Bytes(body) < block.bytes) {
          const [bd, td] = setEdit(smartEdits, block, { ...smartEdits.get(block), body });
          smartBytes += bd; smartTokens += td; count++;
        }
      }
      if (smartBytes <= bytes) { edits = smartEdits; bytes = smartBytes; tokens = smartTokens; stats.smartCompacted = count; }
    }

    if (mode === 'stubs') {
      // Reuse only byte-identical consecutive lines that remain visible in an
      // earlier output. Different reads/ranges and old file versions may contain
      // unique information; a later read does not prove they were superseded.
      const groups = new Map();
      for (const block of blocks) {
        if (edits.get(block)?.reference || failed(block)) continue;
        let identity = readIdentity(block), type = 'read';
        if (block.label === 'command') {
          const info = commandInfo(block.body);
          if (info?.kind !== 'write') continue;
          type = 'write'; identity = { key: (info.path.startsWith('/') ? '' : info.cwd) + '\0' + info.path };
        } else if (!safeRead(block) && ERROR_SIGNAL.test(block.body)) continue;
        if (!identity) continue;
        const key = type + '\0' + identity.key;
        const list = groups.get(key) || []; list.push(block); groups.set(key, list);
      }
      const stubEdits = new Map(edits), reservedIds = new Set();
      for (const match of raw.matchAll(/arex-stubs-output-(\d+)/g)) reservedIds.add(match[1]);
      let stubBytes = bytes, stubTokens = tokens, count = 0, nextStubId = 1;
      for (const entries of groups.values()) {
        if (entries.length < 2) continue;
        const seeds = new Map();
        for (const block of entries) {
          const current = stubEdits.get(block)?.body ?? block.body;
          const lines = current.split('\n');
          const pieces = []; let i = 0, used = new Set();
          while (i < lines.length) {
            // Bounded fingerprints are always verified with exact line equality.
            const key = lines.slice(i, i + 4).join('\n');
            const candidates = !stubEdits.get(block)?.anchor && i + 4 <= lines.length && key.length <= 2048 ? seeds.get(key) : null;
            let best = null;
            for (const source of candidates || []) {
              let n = 0;
              while (n < 4096 && i + n < lines.length && source.pos + n < source.lines.length &&
                     lines[i + n] === source.lines[source.pos + n]) n++;
              if (!best || n > best.n) best = { ...source, n };
            }
            if (best && best.n >= 5) {
              const marker = '[... identical to lines ' + (best.pos + 1) + '–' + (best.pos + best.n) +
                ' of earlier output #arex-stubs-output-' + best.id + ' ...]';
              const original = lines.slice(i, i + best.n).join('\n');
              if (utf8Bytes(original) >= utf8Bytes(marker) + 100) {
                pieces.push(marker); used.add(best); i += best.n; continue;
              }
            }
            pieces.push(lines[i++]);
          }
          const replacement = pieces.join('\n');
          if (used.size && utf8Bytes(replacement) < utf8Bytes(current)) {
            // Charge each newly inserted anchor before deciding to keep the edit.
            const undo = []; let delta = 0, tokenDelta = 0;
            for (const source of used) {
              const previous = stubEdits.get(source.block) || {};
              if (!previous.stubAnchor) {
                const had = stubEdits.has(source.block);
                const prev = stubEdits.get(source.block);
                const [bd, td] = setEdit(stubEdits, source.block, { ...previous, stubAnchor: source.id });
                undo.push({ b: source.block, had, prev });
                delta += bd; tokenDelta += td;
              }
            }
            {
              const had = stubEdits.has(block);
              const prev = stubEdits.get(block);
              const [bd, td] = setEdit(stubEdits, block, { ...stubEdits.get(block), body: replacement });
              undo.push({ b: block, had, prev });
              delta += bd; tokenDelta += td;
            }
            if (delta < 0) { stubBytes += delta; stubTokens += tokenDelta; count++; continue; }
            for (let u = undo.length - 1; u >= 0; u--) {
              const e = undo[u];
              if (e.had) stubEdits.set(e.b, e.prev); else stubEdits.delete(e.b);
            }
          }
          // Only unchanged blocks become sources, preventing reference chains
          // and ensuring line numbers remain valid even after later edits.
          while (reservedIds.has(String(nextStubId))) nextStubId++;
          const id = nextStubId++;
          for (let pos = 0; pos + 4 <= lines.length; pos++) {
            const key = lines.slice(pos, pos + 4).join('\n');
            if (key.length > 2048) continue;
            const values = seeds.get(key);
            if (!values && seeds.size >= 20000) continue;
            const slots = values || [];
            if (slots.length < 4) slots.push({ block, id, lines, pos });
            seeds.set(key, slots);
          }
        }
      }
      if (stubBytes <= bytes) { edits = stubEdits; bytes = stubBytes; tokens = stubTokens; stats.stubbed = count; }
    }

    const parts = []; let last = 0;
    for (const block of blocks) {
      const edit = edits.get(block);
      if (!edit) continue;
      parts.push(raw.slice(last, block.startOffset), renderBlock(block, edit)); last = block.endOffset;
    }
    parts.push(raw.slice(last));
    let markdown = parts.join('');
    if ((mode === 'smart' || mode === 'stubs') && AREX.compactFraming) {
      // Run after output/Stubs edits so framing sees the final fences and
      // anchors, never stale offsets or command sources referenced by Stubs.
      const framing = AREX.compactFraming(AREX.buildDocumentIndex(markdown), { mode });
      if (framing.byteDelta < 0) {
        markdown = framing.markdown;
        bytes = framing.bytes;
        tokens = estimateTokens(markdown);
      }
    }
    const savedBytes = baseBytes - bytes;
    return { markdown, bytes, baselineBytes: baseBytes, savedBytes, savedRatio: baseBytes ? savedBytes / baseBytes : 0, estimatedTokens: tokens, stats };
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
})();
