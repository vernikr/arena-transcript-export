// Wave 3.1 — Stubs v2 (issue #8)
//
// Path-agnostic, content-defined 4-line rolling-window line deduplication for
// Stubs mode, with optional `cat -n` / `nl` line-number prefix normalization.
//
// This replaces the old per-path `groups` partitioning that used to live inline
// in compress.js. Every eligible block — `stdout`/`stderr` output, 📄 file
// artifact cards, unlabeled tool outputs and `command` write payloads — is
// matched against a single bounded global seed index built in transcript order.
// Because the index is content-defined and not keyed by file path, cross-command
// reads deduplicate shared ≥4-line chunks without any `commandInfo()` path
// inference:
//
//   * compound `for f in …; do cat "$f"; done` reads,
//   * 📄 file artifact cards,
//   * subsequent `sed -n 60,120p` slices of a file already read via `cat`,
//
// all collapse their shared lines onto the earlier full copy.
//
// Safety invariants preserved from the original stubs stage:
//   * No reference chains — a block shortened with stub markers is never
//     registered as a line-number source, so later references always point at
//     intact, pre-edit line offsets.
//   * Unique non-matching lines (distinct versions, non-overlapping ranges)
//     are never touched; only verified byte-identical (or gutter-stripped
//     identical) runs are replaced.
//   * An edit plus its `<a id="arex-stubs-output-K"></a>` anchor is applied only
//     when the net UTF-8 delta is strictly negative (≤ −80 B).
//
// The seed index is capped at ≤ 30,000 keys and ≤ 6 source slots per key so the
// worker stays O(N) (< 100 ms on 3.5 MB).

globalThis.AREX = globalThis.AREX || {};

(function () {
  // Mirror of compress.js utf8Bytes — used only for marker/run length checks.
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

  // `cat -n` / `nl` gutter: optional leading whitespace, one or more digits, a tab.
  const GUTTER_RE = /^\s*\d+\t/;
  const stripGutter = line => line.replace(GUTTER_RE, '');
  const hasGutter = line => GUTTER_RE.test(line);

  // Bounds mandated by issue #8.
  const MAX_SEED_KEYS = 30000;
  const MAX_SLOTS_PER_KEY = 6;
  const WINDOW = 4;                 // content-defined ≥4-line rolling window
  const MAX_KEY_BYTES = 2048;       // skip pathological wide lines
  const MIN_NET_SAVINGS = 80;       // only apply when net delta ≤ −80 B
  const MAX_RUN = 4096;             // cap a single matched run

  // blocks:      index.blocks in transcript order
  // edits:       Map<block, edit> produced by the dedup + smart stages (input)
  // bytes/tokens: running totals so far (input)
  // setEdit:     (map, block, edit) => [byteDelta, tokenDelta]; mutates `map`
  //              (provided by compress.js so byte/token accounting stays unified)
  // reservedIds: Set of stub anchor ids already present in the raw markdown
  // Returns { edits, bytes, tokens, stubbed }.
  function compressStubs(blocks, edits, bytes, tokens, setEdit, reservedIds, options) {
    const stubEdits = new Map(edits);        // single clone before the loop
    let stubBytes = bytes, stubTokens = tokens, count = 0;
    const seeds = new Map();                  // key -> [{ block, id, lines, rawLines, pos }]
    let nextStubId = 1;
    while (reservedIds.has(String(nextStubId))) nextStubId++;

    for (const block of blocks) {
      const existing = stubEdits.get(block);
      if (existing?.reference) continue;       // already a full dedup reference
      if (AREX.failed(block)) continue;

      // Eligibility — path-agnostic. Only read-like, non-error content is
      // deduplicated; command blocks must be file-write payloads (`cat > …`).
      if (block.label === 'command') {
        const info = AREX.commandInfo(block.body);
        if (info?.kind !== 'write') continue;
      } else if (!AREX.safeRead(block) && AREX.ERROR_SIGNAL.test(block.body)) {
        continue;
      }

      const current = existing?.body ?? block.body;
      const rawLines = current.split('\n');
      const lines = rawLines.map(stripGutter);  // normalized for matching & indexing
      const pieces = [];
      let i = 0, used = new Set();
      while (i < rawLines.length) {
        // Bounded fingerprints are always verified with exact line equality.
        const window = lines.slice(i, i + WINDOW).join('\n');
        const key = i + WINDOW <= rawLines.length && window.length <= MAX_KEY_BYTES ? window : null;
        // A block already carrying an anchor (e.g. a dedup source) is itself
        // never shortened — matching it would risk pointing at a block whose
        // offsets were already claimed. It is still registered as a source below.
        const candidates = key && !existing?.anchor ? seeds.get(key) : null;
        let best = null;
        if (candidates) {
          for (const source of candidates) {
            let n = 0, numbered = false;
            while (n < MAX_RUN && i + n < rawLines.length && source.pos + n < source.lines.length &&
                   lines[i + n] === source.lines[source.pos + n]) {
              const curRaw = rawLines[i + n], srcRaw = source.rawLines[source.pos + n];
              if (hasGutter(curRaw) !== hasGutter(srcRaw) ||
                  (hasGutter(curRaw) && hasGutter(srcRaw) && curRaw !== srcRaw)) numbered = true;
              n++;
            }
            if (!best || n > best.n) best = { ...source, n, numbered };
          }
        }
        if (best && best.n >= WINDOW) {
          const original = rawLines.slice(i, i + best.n).join('\n');
          const marker = '[... identical to lines ' + (best.pos + 1) + '–' + (best.pos + best.n) +
            ' of earlier output #arex-stubs-output-' + best.id +
            (best.numbered ? ' (excluding line numbers)' : '') + ' ...]';
          // Only replace a run when doing so is locally beneficial; the net gate
          // below is what guarantees the whole edit is worth keeping.
          if (utf8Bytes(original) > utf8Bytes(marker)) {
            pieces.push(marker); used.add(best); i += best.n; continue;
          }
        }
        pieces.push(rawLines[i++]);
      }

      const replacement = pieces.join('\n');
      let applied = false;
      if (used.size && utf8Bytes(replacement) < utf8Bytes(current)) {
        // Charge every newly inserted source anchor before deciding to keep the
        // edit, then roll everything back if the net UTF-8 delta is not strictly
        // negative by at least MIN_NET_SAVINGS bytes.
        const undo = [];
        let delta = 0, tokenDelta = 0;
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
        if (delta <= -MIN_NET_SAVINGS) {
          stubBytes += delta; stubTokens += tokenDelta; count++; applied = true;
        } else {
          for (let u = undo.length - 1; u >= 0; u--) {
            const e = undo[u];
            if (e.had) stubEdits.set(e.b, e.prev); else stubEdits.delete(e.b);
          }
        }
      }

      // Register this block as a future seed source ONLY when it stayed intact
      // (was not shortened with stub markers). A stubbed block must never become
      // a line-number source, or later references would form a chain and the
      // referenced offsets would no longer be valid.
      if (!applied) {
        const id = nextStubId++;
        while (reservedIds.has(String(nextStubId))) nextStubId++;
        for (let pos = 0; pos + WINDOW <= lines.length; pos++) {
          const key = lines.slice(pos, pos + WINDOW).join('\n');
          if (key.length > MAX_KEY_BYTES) continue;
          if (!seeds.has(key) && seeds.size >= MAX_SEED_KEYS) continue;
          const slots = seeds.get(key) || [];
          if (slots.length < MAX_SLOTS_PER_KEY) slots.push({ block, id, lines, rawLines, pos });
          seeds.set(key, slots);
        }
      }
    }

    return { edits: stubEdits, bytes: stubBytes, tokens: stubTokens, stubbed: count };
  }

  AREX.compressStubs = compressStubs;
})();
