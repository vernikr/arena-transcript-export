// Condenses long reasoning in assistant Thought spoilers for Smart/Stubs. Off/Lossless never opt in.
globalThis.AREX = globalThis.AREX || {};

(function () {
  const RULES = {
    smart: { minBytes: 2600, minBlocks: 5, keep: 2, minChars: 300 },
    stubs: { minBytes: 900, minBlocks: 3, keep: 1, minChars: 250 },
  };
  const DRAFT = { minRun: 5, minSaving: 100, seedLines: 4, maxLines: 4096, maxSeeds: 20000, maxSourceBytes: 1 << 20 };
  // Stricter than the index's `thought` kind, which also matches answer headings like "Thoughts on X".
  const THOUGHT_TITLE = /^thought(?:\s+for\b|\s*$)/i;
  const CARD_LABEL = /\*\*(?:command|stdout|stderr):\*\*/i;
  const FILE_CARD = /\*\*📄\s*[^*]+\*\*\s*_\([^)]+\)/i;
  const NOT_EXPANDED = /^\s*_\(not expanded\)_\s*$/;
  const TOOL_LABELS = new Set(['command', 'stdout', 'stderr', 'file']);
  const HEREDOC_WRITE = /^cat\s+>\s*(?!>)(?:"[^"\n]+"|'[^'\n]+'|[^\s<>|;&]+)\s+<<-?\s*(?:'[^']+'|"[^"]+"|[A-Za-z_]\w*)\s*$/;
  const STUBS_ANCHOR = /^<a id="arex-stubs-output-(\d+)"><\/a>$/;
  const OUTPUT_ANCHOR = /^<a id="arex-output-\d+"><\/a>$/;
  const ANCHOR_PREFIX = '<a id="arex-';

  const isThought = section => section.kind === 'thought' && THOUGHT_TITLE.test(section.title);

  const afterLine = (raw, offset) => {
    const eol = raw.indexOf('\n', offset);
    return eol < 0 ? raw.length : eol + 1;
  };

  function isBlank(raw, start, end) {
    for (let i = start; i < end; i++) {
      const c = raw.charCodeAt(i);
      if (c === 32 || c === 9 || c === 13) continue;
      return c >= 128 && raw.slice(start, end).trim() === '';
    }
    return true;
  }

  function fenceOpen(raw, start, end) {
    let i = start;
    while (i < start + 3 && raw.charCodeAt(i) === 32) i++;
    const char = raw.charCodeAt(i);
    if (char !== 96 && char !== 126) return null;
    let len = 0;
    while (i + len < end && raw.charCodeAt(i + len) === char) len++;
    return len >= 3 ? { char, len } : null;
  }

  function fenceCloses(raw, start, end, fence) {
    let i = start;
    while (i < start + 3 && raw.charCodeAt(i) === 32) i++;
    let run = 0;
    while (i + run < end && raw.charCodeAt(i + run) === fence.char) run++;
    if (run < fence.len) return false;
    for (let j = i + run; j < end; j++) {
      const c = raw.charCodeAt(j);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }

  function isCardLine(raw, start, end) {
    const c = raw.charCodeAt(start);
    if (c !== 42 && c !== 95) return false;
    const text = raw.slice(start, end);
    return c === 42 ? CARD_LABEL.test(text) || FILE_CARD.test(text) : NOT_EXPANDED.test(text);
  }

  // Blank-line separated blocks with fences kept atomic. A glued tool card ends the region; an unterminated fence voids it.
  // Blocks carrying an output anchor are flagged: later markers may point at them.
  function scanRegion(raw, start, end) {
    const blocks = [], fences = [];
    let block = null, fence = null, limit = end;
    for (let pos = start; pos < end;) {
      let eol = raw.indexOf('\n', pos);
      if (eol < 0 || eol > end) eol = end;
      if (fence) {
        block.end = eol;
        if (raw.startsWith(ANCHOR_PREFIX, pos)) block.anchored = true;
        if (fenceCloses(raw, pos, eol, fence)) {
          fence.bodyEnd = pos - 1;
          fence.end = eol;
          fences.push(fence);
          fence = null;
        }
      } else if (isBlank(raw, pos, eol)) {
        if (block) { blocks.push(block); block = null; }
      } else if (isCardLine(raw, pos, eol)) {
        limit = pos;
        break;
      } else {
        if (!block) block = { start: pos, end: eol, anchored: false };
        block.end = eol;
        if (raw.startsWith(ANCHOR_PREFIX, pos)) block.anchored = true;
        const opener = fenceOpen(raw, pos, eol);
        if (opener) fence = { ...opener, block, bodyStart: eol + 1, bodyEnd: 0, end: 0 };
      }
      pos = eol + 1;
    }
    if (fence) return null;
    if (block) blocks.push(block);
    return { blocks, fences, limit };
  }

  function planRuns(blocks, sectionBytes, rule) {
    const runs = [];
    if (blocks.length < rule.minBlocks || sectionBytes <= rule.minBytes) return runs;
    let run = null;
    for (let i = rule.keep; i < blocks.length - rule.keep; i++) {
      const chars = blocks[i].end - blocks[i].start;
      if (chars < rule.minChars || blocks[i].anchored) { run = null; continue; }
      if (!run) runs.push(run = { first: i, last: i, chars: 0 });
      run.last = i;
      run.chars += chars;
    }
    return runs;
  }

  function seedIndex(lines) {
    const seeds = new Map();
    for (let pos = 0; pos + DRAFT.seedLines <= lines.length; pos++) {
      const key = lines.slice(pos, pos + DRAFT.seedLines).join('\n');
      if (key.length > 2048) continue;
      const slots = seeds.get(key);
      if (slots) { if (slots.length < 4) slots.push(pos); }
      else if (seeds.size < DRAFT.maxSeeds) seeds.set(key, [pos]);
    }
    return seeds;
  }

  function heredocWrite(block) {
    if (block.label !== 'command' || block.merged || block.relabeled) return false;
    const text = block.body.replace(/^\s*\$\s?/, '').trim();
    const cd = /^cd\s+(?:"[^"]+"|'[^']+'|[^\s;&]+)\s*&&\s*/.exec(text);
    return HEREDOC_WRITE.test((cd ? text.slice(cd[0].length) : text).split('\n', 1)[0]);
  }

  // Reuses a Stubs anchor already placed directly above the source fence.
  function anchorAbove(raw, fenceStart) {
    let end = fenceStart - 1;
    for (let hops = 0; hops < 2 && end > 0; hops++) {
      const start = raw.lastIndexOf('\n', end - 1) + 1;
      const line = raw.slice(start, end);
      const stubs = STUBS_ANCHOR.exec(line);
      if (stubs) return Number(stubs[1]);
      if (!OUTPUT_ANCHOR.test(line)) return null;
      end = start - 1;
    }
    return null;
  }

  function isEnabled(options) {
    return (options.mode === 'smart' || options.mode === 'stubs') && options.condenseThoughts !== false;
  }

  function condenseThoughts(index, options = {}) {
    const raw = index.markdown;
    const edits = [];
    const stats = { thoughtsCondensed: 0, blocksCondensed: 0, charsCondensed: 0, draftsDeduplicated: 0 };
    if (!isEnabled(options)) return { ...AREX.applySpanEdits(raw, edits), edits, stats };
    const rule = RULES[options.mode];
    const { sections, turns, blocks } = index;
    const utf8 = AREX.utf8Bytes;

    const answers = [], protectedSpans = [];
    for (const turn of turns) {
      if (turn.kind !== 'assistant') { protectedSpans.push([turn.startOffset, turn.endOffset]); continue; }
      for (const span of turn.answerSpans) {
        answers.push(span);
        protectedSpans.push([span.startOffset, span.endOffset]);
      }
    }
    const inAnswer = (start, end) => {
      let lo = 0, hi = answers.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (answers[mid].endOffset <= start) lo = mid + 1; else hi = mid;
      }
      return lo < answers.length && answers[lo].startOffset < end;
    };

    const lastTool = new Map();
    for (const block of blocks) if (TOOL_LABELS.has(block.label)) lastTool.set(block.turnIndex, block.startOffset);

    // 2 = later activity in the turn proves glued prose is not the final answer; 1 = needs a later tool card.
    const eligible = new Uint8Array(sections.length);
    for (let i = sections.length - 1, turn = -1, activity = false; i >= 0; i--) {
      const section = sections[i];
      if (section.turnIndex !== turn) { turn = section.turnIndex; activity = false; }
      if (isThought(section) && turns[turn]?.kind === 'assistant') eligible[i] = activity ? 2 : 1;
      if (section.kind !== 'prose_heading' && (section.kind !== 'thought' || isThought(section))) activity = true;
    }

    let sources = null;
    const sourcesFor = turnIndex => {
      if (!sources) {
        sources = new Map();
        for (const block of blocks) {
          const write = block.label === 'file' && !block.merged ? true : heredocWrite(block);
          if (!write || block.bytes > DRAFT.maxSourceBytes || sections[block.sectionIndex]?.kind === 'thought') continue;
          if (!sources.has(block.turnIndex)) sources.set(block.turnIndex, []);
          sources.get(block.turnIndex).push({ block, lines: null, seeds: null, anchor: undefined });
        }
      }
      return sources.get(turnIndex) || [];
    };

    let reserved = null, nextId = 1;
    const peekId = () => {
      if (!reserved) {
        reserved = new Set();
        for (const match of raw.matchAll(/arex-stubs-output-(\d+)/g)) reserved.add(Number(match[1]));
      }
      while (reserved.has(nextId)) nextId++;
      return nextId;
    };
    const anchorText = id => '<a id="arex-stubs-output-' + id + '"></a>\n';

    function matchDraft(lines, source, id) {
      source.lines ||= source.block.body.split('\n');
      const seeds = source.seeds ||= seedIndex(source.lines);
      const pieces = [];
      let saved = 0, used = 0;
      for (let i = 0; i < lines.length;) {
        let best = null;
        if (i + DRAFT.seedLines <= lines.length) {
          const key = lines.slice(i, i + DRAFT.seedLines).join('\n');
          for (const pos of (key.length <= 2048 && seeds.get(key)) || []) {
            let n = 0;
            while (i + n < lines.length && pos + n < source.lines.length && lines[i + n] === source.lines[pos + n]) n++;
            if (!best || n > best.n) best = { pos, n };
          }
        }
        if (best && best.n >= DRAFT.minRun) {
          const marker = '[... draft identical to lines ' + (best.pos + 1) + '–' + (best.pos + best.n) +
            ' of later output #arex-stubs-output-' + id + ' ...]';
          const gain = utf8(lines.slice(i, i + best.n).join('\n')) - utf8(marker);
          if (gain >= DRAFT.minSaving) {
            pieces.push(marker);
            saved += gain;
            used++;
            i += best.n;
            continue;
          }
        }
        pieces.push(lines[i++]);
      }
      return used ? { body: pieces.join('\n'), saved } : null;
    }

    function dedupeDraft(fence, turnIndex) {
      if (fence.bodyEnd <= fence.bodyStart) return null;
      const lines = raw.slice(fence.bodyStart, fence.bodyEnd).split('\n');
      if (lines.length < DRAFT.minRun || lines.length > DRAFT.maxLines) return null;
      let best = null;
      for (const source of sourcesFor(turnIndex)) {
        if (source.block.startOffset < fence.end || inAnswer(source.block.startOffset, source.block.endOffset)) continue;
        if (source.anchor === undefined) source.anchor = anchorAbove(raw, source.block.startOffset);
        const id = source.anchor ?? peekId();
        const match = matchDraft(lines, source, id);
        if (!match) continue;
        const net = match.saved - (source.anchor == null ? utf8(anchorText(id)) : 0);
        if (net > 0 && (!best || net > best.net)) best = { ...match, net, source, id };
      }
      if (!best) return null;
      const out = [{ start: fence.bodyStart, end: fence.bodyEnd, text: best.body }];
      if (best.source.anchor == null) {
        reserved.add(best.id);
        best.source.anchor = best.id;
        const at = best.source.block.startOffset;
        out.push({ start: at, end: at, text: anchorText(best.id) });
      }
      return out;
    }

    for (let i = 0; i < sections.length; i++) {
      if (!eligible[i]) continue;
      const section = sections[i], next = sections[i + 1];
      const ownEnd = Math.min(section.endOffset, section.rawEndOffset, next ? next.startOffset : raw.length);
      const region = scanRegion(raw, afterLine(raw, section.startOffset), ownEnd);
      if (!region) continue;
      // Without later activity, prose glued to this Thought may be the final answer.
      const followed = eligible[i] === 2 || region.limit < ownEnd || (lastTool.get(section.turnIndex) ?? -1) >= ownEnd;
      if (!followed) continue;

      const found = [], condensed = [];
      let blocksCondensed = 0, charsCondensed = 0, drafts = 0;
      const sectionBytes = utf8(raw.slice(section.startOffset, region.limit));
      for (const run of planRuns(region.blocks, sectionBytes, rule)) {
        const start = region.blocks[run.first].start, end = region.blocks[run.last].end;
        const count = run.last - run.first + 1;
        const text = '_[... condensed ' + count + ' intermediate reasoning blocks (' + run.chars + ' chars) ...]_';
        if (inAnswer(start, end) || utf8(text) >= utf8(raw.slice(start, end))) continue;
        found.push({ start, end, text });
        condensed.push({ start, end });
        blocksCondensed += count;
        charsCondensed += run.chars;
      }
      if (options.mode === 'stubs') {
        for (const fence of region.fences) {
          const start = fence.bodyStart, end = fence.end;
          if (fence.block.anchored || condensed.some(run => start < run.end && run.start < end) || inAnswer(start, end)) continue;
          const result = dedupeDraft(fence, section.turnIndex);
          if (result) { found.push(...result); drafts++; }
        }
      }
      if (!found.length) continue;
      edits.push(...found);
      stats.thoughtsCondensed++;
      stats.blocksCondensed += blocksCondensed;
      stats.charsCondensed += charsCondensed;
      stats.draftsDeduplicated += drafts;
    }

    return { ...AREX.applySpanEdits(raw, edits, protectedSpans), edits, stats };
  }

  // Post-processes an AREX.compressIndex result; an optional pass never breaks the preview.
  function applyThoughtCondensation(result, options = {}) {
    const stats = { ...result.stats, thoughtsCondensed: 0, blocksCondensed: 0, charsCondensed: 0, draftsDeduplicated: 0 };
    const unchanged = { ...result, stats };
    if (!isEnabled(options) || typeof AREX.buildDocumentIndex !== 'function') return unchanged;
    let condensed;
    try {
      condensed = condenseThoughts(AREX.buildDocumentIndex(result.markdown), options);
    } catch {
      return unchanged;
    }
    if (!condensed.stats.thoughtsCondensed || condensed.byteDelta >= 0) return unchanged;
    const measured = AREX.measureMarkdown(condensed.markdown);
    const savedBytes = result.baselineBytes - measured.bytes;
    return {
      ...result,
      markdown: condensed.markdown,
      bytes: measured.bytes,
      savedBytes,
      savedRatio: result.baselineBytes ? savedBytes / result.baselineBytes : 0,
      estimatedTokens: measured.estimatedTokens,
      stats: { ...stats, ...condensed.stats },
    };
  }

  AREX.condenseThoughts = condenseThoughts;
  AREX.applyThoughtCondensation = applyThoughtCondensation;
})();
