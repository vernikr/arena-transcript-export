// Stubs-only command and diff edits against the section-aware DocumentIndex.
// Wave 4 wires this standalone transform into the compression pipeline.
globalThis.AREX = globalThis.AREX || {};

(function () {
  const executionError = /(?:^|\n)[ \t]*(?:Traceback \(most recent call last\):|(?:[\w.]+(?:Error|Exception)|error|fatal|panic|assertion failed)[ \t]*[:(]|not ok[ \t]+\d+\b|(?:FAILED|FAIL|ERROR)[ \t]+\S|={3,}[ \t]*(?:FAILURES|ERRORS)\b|E {2,}\S|npm ERR!|command failed\b)/i;
  const pathCall = /\b(?:Path|open|readFileSync|writeFileSync|appendFileSync|openSync|readFile|writeFile)\s*\(\s*/g;
  const redirection = /\bcat[ \t]+>[ \t]*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s<>|;&]+))/g;
  const heredoc = /^(?:python(?:3(?:\.\d+)?)?|node)(?:[ \t]+--?[A-Za-z][\w=-]*)*[ \t]+(?:-[ \t]+)?<<-?[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))[ \t]*$/;
  const inlineEval = /^(?:python(?:3(?:\.\d+)?)?[ \t]+-c|node[ \t]+(?:-e|--eval))[ \t]+(['"])/;
  const hunkHeader = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
  const changedBudget = 8000;

  function isInlineScript(lines) {
    if (lines[0].length > 4096 || !/^\$[ \t]+/.test(lines[0])) return false;
    const invocation = lines[0].replace(/^\$[ \t]+/, '')
      .replace(/^cd[ \t]+(?:"[^"\n]+"|'[^'\n]+'|[^\s;&]+)[ \t]*&&[ \t]*/, '');
    const match = heredoc.exec(invocation);
    if (match) return lines.at(-1).trim() === (match[1] || match[2] || match[3]);
    const evalMatch = inlineEval.exec(invocation);
    return !!evalMatch && lines.at(-1).trimEnd().endsWith(evalMatch[1]);
  }

  function touchedPaths(body) {
    const paths = new Set();
    pathCall.lastIndex = 0;
    let match;
    while ((match = pathCall.exec(body))) {
      if (match[0].startsWith('open') && body[match.index - 1] === '.') continue;
      let i = pathCall.lastIndex;
      const quote = body[i++];
      if (quote !== "'" && quote !== '"' && quote !== '`') return null;
      let path = '', closed = false;
      for (; i < body.length; i++) {
        if (body[i] === quote) { closed = true; i++; break; }
        if (body[i] === '\n' || body[i] === '\r') return null;
        if (body[i] === '\\' && i + 1 < body.length) path += body[i++] + body[i];
        else path += body[i];
        if (path.length > 1024) return null;
      }
      while (body[i] === ' ' || body[i] === '\t') i++;
      if (!closed || !path || (quote === '`' && path.includes('${')) ||
          (body[i] !== ',' && body[i] !== ')')) return null;
      paths.add(path);
    }
    redirection.lastIndex = 0;
    while ((match = redirection.exec(body))) paths.add(match[1] || match[2] || match[3]);
    return [...paths];
  }

  function shortenScript(block) {
    if (block.bytes <= 1500 || block.body.includes('\r')) return block.body;
    const lines = block.body.split('\n');
    if (lines.length <= 26 || !isInlineScript(lines)) return block.body;
    const paths = touchedPaths(block.body);
    if (!paths) return block.body; // An unresolved path call could hide a file edit.
    const marker = '# [... omitted ' + (lines.length - 16) +
      ' lines of clean inline script (touched: ' + (paths.join(', ') || 'none') + ') ...]';
    if (marker.includes(block.fence.repeat(block.fenceLength))) return block.body;
    const result = [...lines.slice(0, 10), marker, ...lines.slice(-6)].join('\n');
    return AREX.utf8Bytes(result) < block.bytes ? result : block.body;
  }

  function trimDiff(body) {
    if (body.includes('\r') || body.includes('[... omitted ')) return body;
    const lines = body.split('\n'), result = [];
    let inHunk = false, sawFile = false, sawHunk = false;
    let oldLeft = 0, newLeft = 0, changedBytes = 0, exhausted = false, omitted = 0;
    const flush = () => {
      if (omitted) result.push('[... omitted ' + omitted + ' changed +/- diff lines (budget) ...]');
      omitted = 0;
    };
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (line.startsWith('diff --git a/')) {
        if (inHunk && (oldLeft || newLeft)) return body;
        flush(); inHunk = false; sawFile = true;
        result.push(line); i++; continue;
      }
      const header = sawFile && hunkHeader.exec(line);
      if (header) {
        if (inHunk && (oldLeft || newLeft)) return body;
        flush(); inHunk = sawHunk = true;
        oldLeft = header[1] === undefined ? 1 : Number(header[1]);
        newLeft = header[2] === undefined ? 1 : Number(header[2]);
        result.push(line); i++; continue;
      }
      if (!inHunk || (!oldLeft && !newLeft)) {
        flush(); inHunk = false;
        result.push(line); i++; continue;
      }
      if (line[0] === ' ') {
        if (!oldLeft || !newLeft) return body;
        flush();
        const context = [];
        while (i < lines.length && lines[i][0] === ' ' && oldLeft && newLeft) {
          context.push(lines[i++]); oldLeft--; newLeft--;
        }
        const original = context.join('\n');
        const marker = ' [... omitted ' + (context.length - 2) + ' unchanged diff context lines ...]';
        const folded = context.length >= 3 &&
          (context.length >= 5 || AREX.utf8Bytes(original) >= 400) &&
          [context[0], marker, context.at(-1)].join('\n');
        if (folded && AREX.utf8Bytes(folded) < AREX.utf8Bytes(original)) {
          result.push(context[0], marker, context.at(-1));
        } else if (context.length === 1 && AREX.utf8Bytes(context[0]) > 1000) {
          result.push(' [... omitted 1 long unchanged diff context line ...]');
        } else result.push(...context);
        continue;
      }
      if (line[0] === '-' || line[0] === '+') {
        if (line[0] === '-') oldLeft--; else newLeft--;
        if (oldLeft < 0 || newLeft < 0) return body;
        const size = AREX.utf8Bytes(line) + 1;
        if (!exhausted && (changedBytes === 0 || changedBytes + size <= changedBudget)) {
          changedBytes += size; result.push(line);
        } else { exhausted = true; omitted++; }
        i++; continue;
      }
      if (line === '\\ No newline at end of file') {
        flush(); result.push(line); i++; continue;
      }
      return body; // Never shorten an incomplete or unrecognized diff hunk.
    }
    if (!sawHunk || (inHunk && (oldLeft || newLeft))) return body;
    flush();
    const shortened = result.join('\n');
    return AREX.utf8Bytes(shortened) < AREX.utf8Bytes(body) ? shortened : body;
  }

  function compactCommands(index, options = {}) {
    const raw = index.markdown, edits = [];
    const stats = { shortenedScripts: 0, trimmedDiffs: 0 };
    if (options.mode === 'stubs') {
      const unsafe = new Set();
      for (const block of index.blocks) {
        if (block.pairedCommand && ((block.label === 'stderr' && block.body.trim()) ||
            (block.label === 'stdout' && executionError.test(block.body)))) unsafe.add(block.pairedCommand);
      }
      for (const block of index.blocks) {
        const section = index.sections[block.sectionIndex];
        const turn = index.turns[block.turnIndex];
        const command = block.label === 'command' ? block : block.pairedCommand;
        if (!command || !section || !turn || turn.kind !== 'assistant' || turn.immutable ||
            section.kind !== 'bash_run' || section.turnIndex !== block.turnIndex ||
            section.exitStatus !== 0 || command.hasStderr || unsafe.has(command) ||
            block.startOffset < section.startOffset || block.endOffset > section.endOffset) continue;

        let body = block.body;
        if (block.label === 'command' && block.lang === 'bash') {
          body = shortenScript(block);
          if (body !== block.body) stats.shortenedScripts++;
        } else if (block.label === 'stdout' && block.bytes > 2500 &&
                   /^\$[ \t]+(?:cd[ \t]+(?:"[^"\n]+"|'[^'\n]+'|[^\s;&]+)[ \t]*&&[ \t]*)?git[ \t]+(?:--no-pager[ \t]+)?(?:diff|show)(?:[ \t]|$)/.test(command.body)) {
          body = trimDiff(block.body);
          if (body !== block.body) stats.trimmedDiffs++;
        }
        if (body !== block.body) {
          const start = raw.indexOf('\n', block.startOffset) + 1;
          edits.push({ start, end: start + block.body.length, text: body });
        }
      }
    }
    const protectedSpans = index.turns.flatMap(turn => turn.kind === 'user'
      ? [{ start: turn.startOffset, end: turn.endOffset }]
      : turn.answerSpans.map(span => ({ start: span.startOffset, end: span.endOffset })));
    return { ...AREX.applySpanEdits(raw, edits, protectedSpans), edits, stats };
  }

  AREX.compactCommands = compactCommands;
})();
