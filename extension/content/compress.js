// Deterministic transcript compression + live size metrics.
// Modes mirror OmniRush Markdown export: Lossless -> Smart -> Compact Stubs.
window.AREX = window.AREX || {};

(function () {
  const tick = String.fromCharCode(96);

  function utf8Bytes(value) { return new TextEncoder().encode(value).length; }
  function formatBytes(bytes) {
    const safe = Math.max(0, Math.round(bytes));
    if (safe < 1000) return safe + " B";
    if (safe < 1000000) return (safe / 1000).toFixed(1) + " KB";
    return (safe / 1000000).toFixed(2) + " MB";
  }

  function formatByteCount(bytes) {
    return Math.max(0, Math.round(bytes)).toLocaleString("en-US") + " B";
  }

  // Lightweight multilingual estimate for preview; this is not an exact tokenizer.
  function estimateTokens(value) {
    const chunks = value.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu) || [];
    let total = 0;
    for (const chunk of chunks) {
      const cyrillic = (chunk.match(/[\u0400-\u052f]/g) || []).length;
      const cjk = (chunk.match(/[\u3040-\u9fff\uac00-\ud7af]/g) || []).length;
      const latin = (chunk.match(/[A-Za-z]/g) || []).length;
      const digits = (chunk.match(/[0-9]/g) || []).length;
      if (cjk) {
        total += Math.ceil(cjk * 1.15);
        if (chunk.length > cjk) total += Math.ceil((chunk.length - cjk) / 4);
      } else if (cyrillic) {
        total += cyrillic <= 3 ? 1 : Math.ceil(cyrillic / 3.4);
        if (chunk.length > cyrillic) total += Math.ceil((chunk.length - cyrillic) / 4);
      } else if (latin) {
        total += latin <= 7 ? 1 : Math.ceil(latin / 4.5);
        if (chunk.length > latin) total += Math.ceil((chunk.length - latin) / 3);
      } else if (digits) {
        total += Math.ceil(digits / 3);
      } else {
        total += Math.ceil(chunk.length / 4);
      }
    }
    return total;
  }

  function parseFencedBlocks(markdown) {
    const lines = markdown.split("\n");
    const blocks = [];
    const openRe = new RegExp("^(\\s*)(" + tick + "{3,}|~{3,})(.*)$");
    for (let i = 0; i < lines.length; i += 1) {
      const open = openRe.exec(lines[i]);
      if (!open) continue;
      const fence = open[2];
      const fenceChar = fence[0];
      const closeRe = new RegExp("^\\s*" + fenceChar + "{" + fence.length + ",}\\s*$");
      let end = i + 1;
      while (end < lines.length && !closeRe.test(lines[end])) end += 1;
      if (end >= lines.length) continue;

      const prefix = lines.slice(Math.max(0, i - 12), i).join("\n");
      const labelMatches = [...prefix.matchAll(/\*\*(stdout|stderr|command):\*\*/gi)];
      const fileMatches = [...prefix.matchAll(/\*\*📄\s*([^*]+)\*\*\s*_\(([^)]+)\)_/gi)];
      const labelMatch = labelMatches.length ? labelMatches[labelMatches.length - 1] : null;
      const fileMatch = fileMatches.length ? fileMatches[fileMatches.length - 1] : null;
      const headings = [...prefix.matchAll(/^#{3,6}\s+(.+)$/gm)];
      const activity = headings.length ? headings[headings.length - 1][1].trim() : "";
      const body = lines.slice(i + 1, end).join("\n");
      blocks.push({
        start: i, end, openLine: lines[i], closeLine: lines[end], body,
        label: labelMatch ? labelMatch[1].toLowerCase() : "",
        fileName: fileMatch ? fileMatch[1].trim() : "",
        activity, prefix,
      });
      i = end;
    }
    return { lines, blocks };
  }

  function applyBlockEdits(markdown, edits) {
    if (!edits.length) return markdown;
    const parsed = parseFencedBlocks(markdown);
    const byStart = new Map(edits.map(edit => [edit.start, edit]));
    const blocks = parsed.blocks.filter(block => byStart.has(block.start)).sort((a, b) => b.start - a.start);
    for (const block of blocks) {
      const edit = byStart.get(block.start);
      let replacement;
      if (edit.reference) {
        replacement = [edit.reference];
      } else {
        replacement = [block.openLine, ...edit.body.split("\n"), block.closeLine];
      }
      if (edit.anchor) replacement.unshift('<a id="arex-output-' + edit.anchor + '"></a>');
      parsed.lines.splice(block.start, block.end - block.start + 1, ...replacement);
    }
    return parsed.lines.join("\n");
  }

  function deduplicateOutputs(markdown) {
    const parsed = parseFencedBlocks(markdown);
    const seen = new Map();
    const edits = [];
    let nextId = 1;
    let count = 0;
    for (const block of parsed.blocks) {
      if (block.label === "command" || (!block.label && !block.fileName)) continue;
      if (utf8Bytes(block.body) < 128) continue;
      const first = seen.get(block.body);
      if (!first) {
        seen.set(block.body, { id: nextId++, block, anchor: false });
        continue;
      }
      first.anchor = true;
      edits.push({
        start: block.start,
        reference: '_Identical to [output #' + first.id + '](#arex-output-' + first.id + ') — byte-for-byte match._',
      });
      count += 1;
    }
    for (const entry of seen.values()) {
      if (entry.anchor) edits.push({ start: entry.block.start, anchor: entry.id, body: entry.block.body });
    }
    return { markdown: applyBlockEdits(markdown, edits), count };
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

  function smartCompact(markdown) {
    const parsed = parseFencedBlocks(markdown);
    const edits = [];
    let compacted = 0;
    for (const block of parsed.blocks) {
      if (block.label !== "stdout" && block.label !== "stderr") continue;
      let body = stripTerminalNoise(block.body);
      if (block.label === "stdout") {
        body = collapsePassingRuns(body).text;
        if (!ERROR_SIGNAL.test(block.body) && !/exit\s+[1-9]\d*/i.test(block.prefix)) {
          const lines = body.split("\n");
          if (lines.length > 110 || utf8Bytes(body) > 5500) {
            const headCount = 45;
            const tailCount = 35;
            if (lines.length > headCount + tailCount + 8) {
              const omitted = lines.length - headCount - tailCount;
              body = lines.slice(0, headCount).concat(
                "[... omitted " + omitted + " middle lines (exit status not reported; no error markers detected) ...]",
                lines.slice(-tailCount),
              ).join("\n");
            }
          }
        }
      }
      if (body !== block.body && utf8Bytes(body) < utf8Bytes(block.body)) {
        edits.push({ start: block.start, body });
        compacted += 1;
      }
    }
    return { markdown: applyBlockEdits(markdown, edits), count: compacted };
  }

  function compactReadStubs(markdown) {
    const parsed = parseFencedBlocks(markdown);
    const groups = new Map();
    for (const block of parsed.blocks) {
      const readHeading = /^(?:used\s+)?(?:read|open|cat|view)\s+(.+?)(?:\s+[-—·]?\s*\d+(?:\.\d+)?\s*(?:ms|s))?$/i.exec(block.activity);
      const readBodyPath = /^\s*(?:<path>|path:\s*|file:\s*)([^\n<]+)(?:<\/path>)?/i.exec(block.body);
      const commandPath = /(?:^|\s)(?:cat|head|tail|less|sed)\s+(?:-[^\s]+\s+)*["']?([^\s"'<>|;&]+)/i.exec(block.body);
      const candidate = block.fileName || (readHeading ? readHeading[1] : "") ||
        (readBodyPath ? readBodyPath[1] : "") || (commandPath ? commandPath[1] : "");
      const key = candidate.trim().replace(/^["']+|["']+$/g, "").replace(/[\\/]+/g, "/").toLowerCase();
      if (!key || (block.label === "command" && !readHeading && !block.fileName)) continue;
      const list = groups.get(key) || [];
      list.push(block);
      groups.set(key, list);
    }

    const edits = [];
    let count = 0;
    for (const [key, blocks] of groups) {
      if (blocks.length < 2) continue;
      const latest = blocks[blocks.length - 1];
      if (ERROR_SIGNAL.test(latest.body)) continue;
      for (const earlier of blocks.slice(0, -1)) {
        const lines = earlier.body.split("\n");
        if (utf8Bytes(earlier.body) < 800 && lines.length < 25) continue;
        if (ERROR_SIGNAL.test(earlier.body)) continue;
        const preview = lines.slice(0, 4);
        const omitted = Math.max(0, lines.length - preview.length);
        const body = preview.concat(
          "[... compact stub: earlier read of " + key + " superseded by a later read; " + omitted + " lines omitted ...]",
        ).join("\n");
        if (utf8Bytes(body) >= utf8Bytes(earlier.body)) continue;
        edits.push({ start: earlier.start, body });
        count += 1;
      }
    }
    return { markdown: applyBlockEdits(markdown, edits), count };
  }

  function compressMarkdown(rawMarkdown, options = {}) {
    const mode = options.mode || "lossless";
    const baseBytes = utf8Bytes(rawMarkdown);
    if (mode === "off") {
      return {
        markdown: rawMarkdown, bytes: baseBytes, baselineBytes: baseBytes, savedBytes: 0,
        savedRatio: 0, estimatedTokens: estimateTokens(rawMarkdown),
        stats: { deduplicated: 0, smartCompacted: 0, stubbed: 0 },
      };
    }

    let markdown = rawMarkdown;
    const stats = { deduplicated: 0, smartCompacted: 0, stubbed: 0 };
    const lossless = deduplicateOutputs(markdown);
    markdown = lossless.markdown;
    stats.deduplicated = lossless.count;
    if (mode === "smart" || mode === "stubs") {
      const smart = smartCompact(markdown);
      markdown = smart.markdown;
      stats.smartCompacted = smart.count;
    }
    if (mode === "stubs") {
      const stubs = compactReadStubs(markdown);
      markdown = stubs.markdown;
      stats.stubbed = stubs.count;
    }

    let bytes = utf8Bytes(markdown);
    if (bytes >= baseBytes) {
      markdown = rawMarkdown;
      bytes = baseBytes;
      stats.deduplicated = 0;
      stats.smartCompacted = 0;
      stats.stubbed = 0;
    }
    const savedBytes = Math.max(0, baseBytes - bytes);
    return {
      markdown, bytes, baselineBytes: baseBytes, savedBytes,
      savedRatio: baseBytes ? savedBytes / baseBytes : 0,
      estimatedTokens: estimateTokens(markdown), stats,
    };
  }

  AREX.compressMarkdown = compressMarkdown;
  AREX.formatTokenCount = function (tokens) {
    const safe = Math.max(0, Math.round(tokens));
    if (safe === 0) return "0";
    if (safe < 1000) return String(safe);
    if (safe < 99950) return (safe / 1000).toFixed(1) + "k";
    return Math.round(safe / 1000).toLocaleString("en-US") + "k";
  };
  AREX.measureMarkdown = function (markdown) {
    return { bytes: utf8Bytes(markdown), estimatedTokens: estimateTokens(markdown) };
  };
  AREX.formatBytes = formatBytes;
  AREX.formatByteCount = formatByteCount;
})();
