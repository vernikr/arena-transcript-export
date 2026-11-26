import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { generateSyntheticCodingSession, extractInvariants, sessionByteShares } from './fixtures/synthetic-coding-session.mjs';

const read = path => readFileSync(new URL('../extension/' + path, import.meta.url), 'utf8');
// The pipeline modules, in the order popup.html loads them.
const PIPELINE = [...read('popup/popup.html').matchAll(/<script src="\.\.\/content\/(compress[\w-]*\.js)"/g)].map(match => match[1]);
function load() {
  const ctx = vm.createContext({});
  for (const file of PIPELINE) vm.runInContext(read('content/' + file), ctx, { filename: file });
  return ctx.AREX;
}
const AREX = load();

// The result before the reasoning stage, which these tests apply themselves.
const baseResult = (raw, mode) => AREX.compressIndex(AREX.buildMarkdownIndex(raw), { mode, condenseThoughts: false });

const tick = '`';
const fence = (body, lang = 'text') => `${tick.repeat(3)}${lang}\n${body}\n${tick.repeat(3)}`;
const user = body => `## 👤 User\n\n${body}`;
const assistant = body => `## 🤖 Assistant\n\n${body}`;
const card = (command = '$ ls -la', output = 'file.txt') =>
  `**command:**\n\n${fence(command, 'bash')}\n\n**stdout:**\n\n${fence(output)}`;
const ran = (body = card()) => `#### Ran commands 1\n\n##### Used Bash 94ms\n\n${body}`;
const thought = (blocks, title = 'Thought for 12s') => `#### ${title}\n\n${blocks.join('\n\n')}`;
const marker = (count, chars) => `_[... condensed ${count} intermediate reasoning blocks (${chars} chars) ...]_`;
const bytes = text => Buffer.byteLength(text);

// Deterministic prose block of exactly `length` UTF-16 units.
const para = (tag, length, filler = ' reasoning') => {
  let text = tag + ':';
  for (let i = 0; text.length < length - 1; i++) text += filler + (i % 10);
  return text.slice(0, length - 1) + '.';
};
const paras = (tag, count, length) => Array.from({ length: count }, (_, i) => para(tag + i, length));

const condense = (raw, mode = 'smart', condenseThoughts) =>
  AREX.condenseThoughts(AREX.buildDocumentIndex(raw), { mode, condenseThoughts });

function protectedTexts(raw) {
  const index = AREX.buildDocumentIndex(raw);
  const texts = [];
  for (const turn of index.turns) {
    if (turn.kind === 'user') texts.push(raw.slice(turn.startOffset, turn.endOffset));
    else for (const span of turn.answerSpans) texts.push(raw.slice(span.startOffset, span.endOffset));
  }
  return texts;
}

function assertProtectedIntact(raw, markdown) {
  let cursor = 0;
  const texts = protectedTexts(raw);
  assert.ok(texts.length > 0);
  for (const text of texts) {
    const at = markdown.indexOf(text, cursor);
    assert.ok(at >= 0, 'protected span was altered: ' + JSON.stringify(text.slice(0, 80)));
    cursor = at + text.length;
  }
}

test('Smart keeps the first and last two blocks and condenses the middle ones', () => {
  const blocks = paras('smart', 8, 400);
  const tail = `\n\n${ran()}\n\nAll done.`;
  const raw = user('Fix it') + '\n\n' + assistant(thought(blocks) + tail);
  const result = condense(raw);
  const expected = user('Fix it') + '\n\n' +
    assistant(thought([blocks[0], blocks[1], marker(4, 1600), blocks[6], blocks[7]]) + tail);
  assert.equal(result.markdown, expected);
  assert.equal(result.stats.thoughtsCondensed, 1);
  assert.equal(result.stats.blocksCondensed, 4);
  assert.equal(result.stats.charsCondensed, 1600);
  assert.equal(result.stats.draftsDeduplicated, 0);
  assert.equal(result.bytes, bytes(expected));
  assert.equal(result.byteDelta, bytes(expected) - bytes(raw));
  assert.ok(result.byteDelta < 0);
  assert.equal(AREX.applySpanEdits(raw, [...result.edits].reverse()).markdown, expected);
  assertProtectedIntact(raw, result.markdown);
});

test('Stubs applies the lower thresholds and keeps only the first and last block', () => {
  const four = paras('four', 4, 800);
  const tail = `\n\n${ran()}\n\nDone.`;
  const rawFour = assistant(thought(four) + tail);
  assert.equal(condense(rawFour, 'smart').edits.length, 0, 'Smart needs at least five blocks');
  assert.equal(condense(rawFour, 'stubs').markdown, assistant(thought([four[0], marker(2, 1600), four[3]]) + tail));

  const five = paras('five', 5, 400);
  const rawFive = assistant(thought(five) + tail);
  assert.equal(condense(rawFive, 'smart').edits.length, 0, 'Smart needs more than 2,600 bytes');
  assert.equal(condense(rawFive, 'stubs').markdown, assistant(thought([five[0], marker(3, 1200), five[4]]) + tail));

  const small = paras('small', 3, 250);
  const rawSmall = assistant(thought(small) + tail);
  assert.equal(condense(rawSmall, 'stubs').edits.length, 0, 'Stubs needs more than 900 bytes');

  const two = paras('two', 2, 1000);
  assert.equal(condense(assistant(thought(two) + tail), 'stubs').edits.length, 0, 'Stubs needs at least three blocks');
});

test('only middle blocks that reach the minimum length are condensed', () => {
  const sizes = [400, 400, 400, 299, 400, 400, 400, 400];
  const blocks = sizes.map((size, i) => para('mix' + i, size));
  const tail = `\n\n${ran()}\n\nDone.`;
  const smart = condense(assistant(thought(blocks) + tail), 'smart');
  assert.equal(smart.markdown, assistant(thought([
    blocks[0], blocks[1], marker(1, 400), blocks[3], marker(2, 800), blocks[6], blocks[7],
  ]) + tail));
  assert.equal(smart.stats.thoughtsCondensed, 1);
  assert.equal(smart.stats.blocksCondensed, 3);

  // Stubs keeps one block at each end and its lower minimum (250) spans the 299-char block.
  const stubs = condense(assistant(thought(blocks) + tail), 'stubs');
  assert.equal(stubs.markdown, assistant(thought([blocks[0], marker(6, 2299), blocks[7]]) + tail));
});

test('the 2,600-byte Smart threshold is exclusive and measured on the Thought section', () => {
  const tail = `\n\n${ran()}\n\nDone.`;
  const build = extra => {
    const blocks = paras('edge', 5, 513);
    blocks[4] += 'x'.repeat(extra);
    return assistant(thought(blocks) + tail);
  };
  const sectionBytes = raw => {
    const section = AREX.buildDocumentIndex(raw).sections.find(s => s.kind === 'thought');
    return bytes(raw.slice(section.startOffset, section.endOffset));
  };
  let extra = 0;
  while (sectionBytes(build(extra)) < 2600) extra++;
  assert.equal(sectionBytes(build(extra)), 2600);
  assert.equal(condense(build(extra)).edits.length, 0, 'exactly 2,600 bytes is not condensed');
  assert.equal(sectionBytes(build(extra + 1)), 2601);
  assert.equal(condense(build(extra + 1)).stats.thoughtsCondensed, 1, '2,601 bytes is condensed');
});

test('block length is measured in characters, section size in bytes', () => {
  const tail = `\n\n${ran()}\n\nDone.`;
  const ru = (tag, length) => para(tag, length, ' слово');
  const long = Array.from({ length: 8 }, (_, i) => ru('р' + i, 300));
  const result = condense(assistant(thought(long) + tail));
  assert.equal(result.markdown, assistant(thought([long[0], long[1], marker(4, 1200), long[6], long[7]]) + tail));
  assert.equal(result.bytes, bytes(result.markdown));

  const shortChars = Array.from({ length: 8 }, (_, i) => ru('р' + i, 299));
  assert.ok(bytes(shortChars[0]) > 300, '299 Cyrillic characters exceed 300 bytes');
  assert.equal(condense(assistant(thought(shortChars) + tail)).edits.length, 0);
});

test('Off, Lossless and an unchecked toggle never touch a Thought', () => {
  const raw = assistant(thought(paras('noop', 8, 400)) + `\n\n${ran()}\n\nDone.`);
  const index = AREX.buildDocumentIndex(raw);
  for (const mode of ['off', 'lossless']) {
    for (const condenseThoughts of [undefined, true, false]) {
      const result = AREX.condenseThoughts(index, { mode, condenseThoughts });
      assert.equal(result.edits.length, 0, `${mode}/${condenseThoughts}`);
      assert.equal(result.markdown, raw);
      assert.equal(result.stats.thoughtsCondensed, 0);
    }
  }
  for (const mode of ['smart', 'stubs']) {
    const result = AREX.condenseThoughts(index, { mode, condenseThoughts: false });
    assert.equal(result.markdown, raw, mode + ' with the toggle off');
    assert.equal(AREX.condenseThoughts(index, { mode }).stats.thoughtsCondensed, 1, mode + ' defaults to on');
  }
  assert.equal(AREX.condenseThoughts(index).markdown, raw, 'no mode means no condensation');
});

test('User messages and final answers stay byte-identical', () => {
  const pasted = thought(paras('pasted', 8, 400), 'Thought for 3s');
  const answer = paras('answer', 6, 420).join('\n\n');
  const raw = [
    user(`Here is a trace I pasted:\n\n${pasted}\n\nWhy is it so long?`),
    assistant(`${thought(paras('real', 8, 400))}\n\n${ran()}\n\n${answer}`),
  ].join('\n\n');
  for (const mode of ['smart', 'stubs']) {
    const result = condense(raw, mode);
    assert.equal(result.stats.thoughtsCondensed, 1, mode);
    assert.ok(result.markdown.includes(pasted), mode + ' left the pasted Thought in the User turn alone');
    assert.ok(result.markdown.includes(answer), mode + ' left the final answer alone');
    assertProtectedIntact(raw, result.markdown);
  }
});

test('a Thought with no later activity may hold the final answer and is skipped', () => {
  const trailing = assistant(thought(paras('glued', 8, 400)));
  for (const mode of ['smart', 'stubs']) assert.equal(condense(trailing, mode).edits.length, 0, mode);

  const followed = assistant(`${thought(paras('glued', 8, 400))}\n\n${ran()}\n\nDone.`);
  assert.equal(condense(followed).stats.thoughtsCondensed, 1);

  // Activity in another turn does not count.
  const split = [
    assistant(thought(paras('first', 8, 400))),
    user('Next question'),
    assistant(`${thought(paras('second', 8, 400))}\n\n${ran()}\n\nDone.`),
  ].join('\n\n');
  const result = condense(split);
  assert.equal(result.stats.thoughtsCondensed, 1);
  assert.ok(result.markdown.startsWith(assistant(thought(paras('first', 8, 400)))), 'the first turn is untouched');
});

test('an earlier Thought is condensed when a later Thought proves more activity follows', () => {
  const first = thought(paras('early', 8, 400), 'Thought for 5s');
  const last = thought(paras('late', 8, 400), 'Thought for 7s');
  const result = condense(assistant(`${first}\n\n${last}`));
  assert.equal(result.stats.thoughtsCondensed, 1);
  assert.ok(result.markdown.endsWith(last), 'the trailing Thought keeps every block');
  assert.ok(!result.markdown.includes(paras('early', 8, 400)[3]));
});

test('only real Thought headings are condensed', () => {
  const tail = `\n\n${ran()}\n\nDone.`;
  for (const title of ['Thoughts on the design', 'Thought process notes', 'Thoughtful follow-ups']) {
    const raw = assistant(thought(paras('answer', 8, 400), title) + tail);
    assert.equal(condense(raw).edits.length, 0, title);
  }
  for (const title of ['Thought', 'Thought for 12s', 'thought for 1m 3s']) {
    const raw = assistant(thought(paras('real', 8, 400), title) + tail);
    assert.equal(condense(raw).stats.thoughtsCondensed, 1, title);
  }
});

test('fenced code inside reasoning is kept or dropped as a whole', () => {
  const tail = `\n\n${ran()}\n\nDone.`;
  const closing = `Final draft:\n${fence('done = True', 'python')}`;
  const snippet = fence(['def f():', '', '    return 1', '', '#### Thought for 1s', 'x'].join('\n'), 'python');
  const kept = [
    para('f0', 450), para('f1', 450), `Draft:\n${snippet}`, para('f3', 450),
    para('f4', 450), para('f5', 450), para('f6', 450), closing,
  ];
  const keptResult = condense(assistant(thought(kept) + tail));
  assert.equal(keptResult.markdown, assistant(thought([
    kept[0], kept[1], kept[2], marker(3, 1350), kept[6], kept[7],
  ]) + tail), 'a short fenced block stays and neither its blank lines nor its heading-like line split it');

  const bigSnippet = fence(Array.from({ length: 20 }, (_, i) => `    value_${i} = compute(${i})`).join('\n'), 'python');
  const bigBlock = `Draft:\n${bigSnippet}`;
  const dropped = [
    para('g0', 450), para('g1', 450), para('g2', 450), bigBlock,
    para('g4', 450), para('g5', 450), para('g6', 450), closing,
  ];
  const droppedResult = condense(assistant(thought(dropped) + tail));
  assert.equal(droppedResult.markdown, assistant(thought([
    dropped[0], dropped[1], marker(4, 450 + bigBlock.length + 450 + 450), dropped[6], dropped[7],
  ]) + tail), 'the long fenced block is replaced together with its fences');
  assert.ok(!droppedResult.markdown.includes('value_'));
  assert.equal((droppedResult.markdown.match(/^```/gm) || []).length % 2, 0, 'fences stay balanced');
  assert.equal(droppedResult.stats.blocksCondensed, 4);
});

test('prose after the last fence of a Thought is treated as possible answer text', () => {
  const tail = `\n\n${ran()}\n\nDone.`;
  const blocks = [
    para('p0', 400), para('p1', 400), `Draft:\n${fence('x = 1', 'python')}`, para('p3', 400),
    para('p4', 400), para('p5', 400), para('p6', 400), para('p7', 400),
  ];
  const raw = assistant(thought(blocks) + tail);
  assert.equal(condense(raw, 'smart').edits.length, 0, 'only three blocks precede the fence');
  const stubs = condense(raw, 'stubs');
  for (const block of blocks.slice(3)) assert.ok(stubs.markdown.includes(block), block.slice(0, 8));
  assertProtectedIntact(raw, stubs.markdown);
});

test('condensation is idempotent', () => {
  const raw = assistant(thought(paras('twice', 8, 400)) + `\n\n${ran()}\n\nDone.`);
  for (const mode of ['smart', 'stubs']) {
    const once = condense(raw, mode);
    const again = condense(once.markdown, mode);
    assert.equal(again.edits.length, 0, mode);
    assert.equal(again.markdown, once.markdown);
  }
});

// --- Stubs draft deduplication ---------------------------------------------

const codeLines = (count = 30, tag = 'handler') =>
  Array.from({ length: count }, (_, i) => `def ${tag}_${i}(request): return validate(request, limit=${i * 7})`);
const heredoc = (path, lines) => card(`$ cat > ${path} <<'EOF'\n${lines.join('\n')}\nEOF`, '(no output)');
const draftThought = (lines, lang = 'python') =>
  thought([para('intro', 300), para('plan', 300), `Draft:\n${fence(lines.join('\n'), lang)}`]);
const stubsPipeline = raw => {
  const base = baseResult(raw, 'stubs');
  return { base, result: AREX.applyThoughtCondensation(base, { mode: 'stubs' }) };
};
const danglingReferences = markdown => {
  const anchors = new Set([...markdown.matchAll(/<a id="(arex-[\w-]+)"><\/a>/g)].map(match => match[1]));
  return [...markdown.matchAll(/#(arex-(?:stubs-)?output-\d+)/g)].map(match => match[1]).filter(id => !anchors.has(id));
};
const MARKER_RE = /\[\.\.\. draft identical to lines (\d+)–(\d+) of later output #(arex-stubs-output-\d+) \.\.\.\]/;

// Resolves a draft marker to the lines it points at in the final Markdown.
function referencedLines(markdown) {
  const match = MARKER_RE.exec(markdown);
  assert.ok(match, 'draft marker present');
  const anchor = `<a id="${match[3]}"></a>\n`;
  assert.equal(markdown.split(anchor).length - 1, 1, 'exactly one anchor for the referenced output');
  const after = markdown.slice(markdown.indexOf(anchor) + anchor.length);
  const open = /^(`{3,}|~{3,})[^\n]*\n/.exec(after);
  assert.ok(open, 'the anchor sits directly above a fence');
  const body = after.slice(open[0].length, after.indexOf('\n' + open[1], open[0].length)).split('\n');
  return body.slice(Number(match[1]) - 1, Number(match[2]));
}

test('Stubs replaces a draft repeated in a later file write with a reference to a new anchor', () => {
  const lines = codeLines();
  const raw = assistant(`${draftThought(lines)}\n\n${ran(heredoc('src/widget.py', lines))}\n\nDone.`);
  const { base, result } = stubsPipeline(raw);
  assert.equal(base.stats.stubbed, 0, 'the single write has nothing to reference');
  assert.equal(result.stats.draftsDeduplicated, 1);
  assert.equal(result.stats.thoughtsCondensed, 1);
  assert.match(result.markdown, MARKER_RE);
  assert.deepEqual([...referencedLines(result.markdown)], lines);
  const anchorAt = result.markdown.indexOf('<a id="arex-stubs-output-1"></a>');
  assert.ok(anchorAt > result.markdown.indexOf('Draft:'), 'the anchor sits in the later file write');
  assert.ok(!result.markdown.slice(0, anchorAt).includes(lines[10]), 'the draft body is gone from the Thought');
  assert.ok(result.markdown.slice(anchorAt).includes(lines[10]), 'the file write keeps the code');
  assert.ok(result.bytes < base.bytes);
  assert.equal(result.bytes, bytes(result.markdown));
  assertProtectedIntact(raw, result.markdown);

  // Smart never references anything and the toggle can turn the whole pass off.
  const smart = AREX.applyThoughtCondensation(baseResult(raw, 'smart'), { mode: 'smart' });
  assert.doesNotMatch(smart.markdown, MARKER_RE);
  assert.equal(smart.stats.draftsDeduplicated, 0);
  const off = AREX.applyThoughtCondensation(base, { mode: 'stubs', condenseThoughts: false });
  assert.equal(off.markdown, base.markdown);
});

test('Stubs reuses an anchor that file-output deduplication already placed', () => {
  const lines = codeLines();
  const raw = assistant([
    draftThought(lines),
    ran(heredoc('src/widget.py', lines)),
    '#### Ran commands 2\n\n' + heredoc('src/widget.py', lines),
    'Done.',
  ].join('\n\n'));
  const { base, result } = stubsPipeline(raw);
  assert.equal(base.stats.stubbed, 1, 'the second write references the first');
  assert.match(base.markdown, /<a id="arex-stubs-output-1"><\/a>/);
  assert.match(result.markdown, /draft identical to lines 2–31 of later output #arex-stubs-output-1/);
  assert.equal(result.markdown.match(/arex-stubs-output-\d+"><\/a>/g).length, 1, 'no second anchor');
  assert.deepEqual([...referencedLines(result.markdown)], lines);
});

test('Stubs references file artifact cards and picks fresh anchor ids', () => {
  const lines = codeLines(24, 'artifact');
  const artifact = `#### Edited widget.py\n\n**📄 widget.py** _(python)_\n\n${fence(lines.join('\n'), 'python')}`;
  const other = codeLines(24, 'other');
  const raw = assistant([
    draftThought(lines),
    artifact,
    // An unrelated anchor with the next free number is already present.
    `<a id="arex-stubs-output-1"></a>\n${fence(other.join('\n'))}`,
    'Done.',
  ].join('\n\n'));
  const { result } = stubsPipeline(raw);
  const match = MARKER_RE.exec(result.markdown);
  assert.ok(match, 'draft marker present');
  assert.notEqual(match[3], 'arex-stubs-output-1');
  assert.deepEqual([...referencedLines(result.markdown)], lines);
});

test('draft deduplication only fires for long, worthwhile and later matches', () => {
  const tinyLines = Array.from({ length: 6 }, (_, i) => 'a=' + i);
  const tiny = assistant(`${draftThought(tinyLines)}\n\n${ran(heredoc('t.py', tinyLines))}\n\nDone.`);
  assert.equal(stubsPipeline(tiny).result.stats.draftsDeduplicated, 0, 'saving below 100 bytes');

  const lines = codeLines();
  const earlier = assistant(`${ran(heredoc('src/widget.py', lines))}\n\n${draftThought(lines)}\n\n${ran()}\n\nDone.`);
  assert.doesNotMatch(stubsPipeline(earlier).result.markdown, MARKER_RE, 'only later outputs are referenced');

  const differs = assistant(`${draftThought(codeLines(30, 'draft'))}\n\n${ran(heredoc('src/widget.py', lines))}\n\nDone.`);
  assert.doesNotMatch(stubsPipeline(differs).result.markdown, MARKER_RE, 'different lines never match');

  const otherTurn = [
    assistant(`${draftThought(lines)}\n\n${ran()}\n\nDone.`),
    user('Again'),
    assistant(`${ran(heredoc('src/widget.py', lines))}\n\nDone.`),
  ].join('\n\n');
  assert.doesNotMatch(stubsPipeline(otherTurn).result.markdown, MARKER_RE, 'sources stay inside the same turn');

  const partial = [...lines.slice(0, 20), 'unrelated_change()', ...lines.slice(21)];
  const partialRaw = assistant(`${draftThought(partial)}\n\n${ran(heredoc('src/widget.py', lines))}\n\nDone.`);
  const partialResult = stubsPipeline(partialRaw).result;
  assert.equal(partialResult.stats.draftsDeduplicated, 1);
  assert.ok(partialResult.markdown.includes('unrelated_change()'), 'unmatched lines stay in the draft');
  assert.equal((partialResult.markdown.match(/draft identical to lines/g) || []).length, 2, 'two separate runs');
});

test('Stubs v2 never touches a Thought: its drafts are left to the reasoning pass', () => {
  const lines = codeLines();
  const raw = assistant([
    thought([para('intro', 300), para('plan', 300), `Draft:\n${fence(lines.join('\n'), 'python')}`]),
    ran(heredoc('src/widget.py', lines)),
    'Done.',
  ].join('\n\n'));
  const { base, result } = stubsPipeline(raw);
  assert.equal(base.stats.stubbed, 0, 'the draft is neither a source nor a target of Stubs matching');
  assert.doesNotMatch(base.markdown, /arex-stubs-output/);
  assert.equal(base.markdown, AREX.compressIndex(AREX.buildMarkdownIndex(raw), { mode: 'stubs', condenseThoughts: false }).markdown);

  // The reasoning pass points the draft at the file write, which keeps every line.
  assert.equal(result.stats.draftsDeduplicated, 1);
  assert.match(result.markdown, /draft identical to lines 2–31 of later output #arex-stubs-output-1/, 'line 1 of the write is its `cat >` command');
  for (const line of lines) assert.equal(result.markdown.split(line).length - 1, 1, line);
  assert.deepEqual(danglingReferences(result.markdown), []);

  // With the toggle off the Thought stays exactly as exported, anchors included.
  const kept = AREX.compressIndex(AREX.buildMarkdownIndex(raw), { mode: 'stubs', condenseThoughts: false });
  assert.ok(kept.markdown.includes(`Draft:\n${fence(lines.join('\n'), 'python')}`), 'the draft stays whole and unanchored');
  assertProtectedIntact(raw, result.markdown);
});

test('a block that carries an output anchor is never swallowed by a condensed run', () => {
  const blocks = paras('anchor', 8, 500);
  blocks[3] = `<a id="arex-output-2"></a>\n${fence(para('kept', 500))}`;
  blocks[6] = 'Same as [output #2](#arex-output-2).';
  blocks[7] = `Last:\n${fence('done')}`;
  const tail = `\n\n${ran()}\n\nDone.`;
  const raw = assistant(thought(blocks) + tail);
  const smart = condense(raw, 'smart');
  assert.equal(smart.markdown, assistant(thought([
    blocks[0], blocks[1], marker(1, 500), blocks[3], marker(2, 1000), blocks[6], blocks[7],
  ]) + tail));
  assert.equal(smart.stats.blocksCondensed, 3);
  assert.deepEqual(danglingReferences(smart.markdown), []);
});

test('draft deduplication leaves a fence that carries an anchor alone', () => {
  const lines = codeLines();
  const build = anchored => assistant([
    thought([para('intro', 300), para('plan', 300),
      `Draft:\n${anchored ? '<a id="arex-stubs-output-3"></a>\n' : ''}${fence(lines.join('\n'), 'python')}`]),
    ran(heredoc('src/widget.py', lines)),
    'Done.',
  ].join('\n\n'));
  assert.equal(condense(build(false), 'stubs').stats.draftsDeduplicated, 1, 'control: the same fence without an anchor is referenced');
  const guarded = condense(build(true), 'stubs');
  assert.equal(guarded.stats.draftsDeduplicated, 0);
  assert.ok(guarded.markdown.includes(lines.join('\n')), 'the anchored draft keeps all of its lines');
  assert.deepEqual(danglingReferences(guarded.markdown), []);
});

const anchoredTexts = markdown => [...markdown.matchAll(/<a id="arex-[\w-]+"><\/a>\n(`{3,})[^\n]*\n/g)].map(match => {
  const close = markdown.indexOf('\n' + match[1], match.index + match[0].length);
  return markdown.slice(match.index, close < 0 ? markdown.length : close + 1 + match[1].length);
});

// Seeded transcripts mixing Thought drafts, heredoc writes, reads and artifact cards that repeat each other.
function randomTranscript(rnd) {
  const int = (low, high) => low + Math.floor(rnd() * (high - low + 1));
  const pick = list => list[int(0, list.length - 1)];
  const pool = Array.from({ length: 4 }, (_, k) => codeLines(int(8, 40), 'pool' + k));
  const snippet = () => {
    const lines = [...pick(pool)];
    if (rnd() < 0.5) lines[lines.length - 1] = "except Exception: log.error('failed')";
    if (rnd() < 0.3) lines[int(1, lines.length - 2)] = 'changed_' + int(0, 9) + '()';
    return lines;
  };
  const prose = () => para('p' + int(0, 9999), int(80, 700));
  const thoughtBlock = () => {
    const kind = rnd();
    if (kind < 0.4) return `${pick(['Draft:', 'Code:'])}\n${fence(snippet().join('\n'), 'python')}`;
    if (kind < 0.5) return `Snippet:\n${fence(snippet().join('\n'), 'python')}\n\nThen I will check it.`;
    return prose();
  };
  const activity = () => {
    const kind = rnd(), path = `src/a${int(0, 3)}.py`;
    if (kind < 0.35) return ran(heredoc(path, snippet()));
    if (kind < 0.6) return ran(card('$ cat ' + path, snippet().join('\n')));
    if (kind < 0.8) return `#### Edited ${path}\n\n**📄 ${path}** _(python)_\n\n${fence(snippet().join('\n'), 'python')}`;
    return ran(card('$ ls -l', Array.from({ length: int(2, 9) }, (_, i) => `file-${i}.txt 4096`).join('\n')));
  };
  const turns = [];
  for (let turn = 0, count = int(1, 3); turn < count; turn++) {
    const parts = [];
    for (let step = 0, steps = int(1, 7); step < steps; step++) {
      parts.push(rnd() < 0.5 ? thought(Array.from({ length: int(2, 9) }, thoughtBlock)) : activity());
    }
    if (rnd() < 0.8) parts.push(para('answer', int(60, 300)));
    turns.push(user(para('ask', int(40, 200))), assistant(parts.join('\n\n')));
  }
  return turns.join('\n\n');
}

test('random transcripts keep protected spans, anchored blocks and every reference target', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  let blocksCondensed = 0, draftsDeduplicated = 0;
  for (let n = 0; n < 150; n++) {
    const raw = randomTranscript(rnd);
    for (const mode of ['smart', 'stubs']) {
      const base = baseResult(raw, mode);
      const out = AREX.applyThoughtCondensation(base, { mode });
      const label = `transcript ${n} (${mode})`;
      assertProtectedIntact(base.markdown, out.markdown);
      for (const text of anchoredTexts(base.markdown)) assert.ok(out.markdown.includes(text), label + ': an anchored block changed');
      const known = new Set(danglingReferences(base.markdown));
      assert.deepEqual(danglingReferences(out.markdown).filter(id => !known.has(id)), [], label);
      assert.equal(out.bytes, bytes(out.markdown), label);
      assert.ok(out.bytes <= base.bytes, label);
      assert.equal(AREX.applyThoughtCondensation(out, { mode }).markdown, out.markdown, label + ' is idempotent');
      blocksCondensed += out.stats.blocksCondensed;
      draftsDeduplicated += out.stats.draftsDeduplicated;
    }
  }
  assert.ok(blocksCondensed > 100, 'the transcripts condense reasoning');
  assert.ok(draftsDeduplicated > 3, 'the transcripts repeat drafts in later writes');
});

// --- applyThoughtCondensation -----------------------------------------------

test('applyThoughtCondensation recomputes bytes, savings and tokens and keeps the other stats', () => {
  const raw = assistant(`${thought(paras('acct', 10, 450))}\n\n${ran()}\n\nDone.`);
  const base = baseResult(raw, 'smart');
  const out = AREX.applyThoughtCondensation(base, { mode: 'smart', condenseThoughts: true });
  assert.ok(out.markdown.length < base.markdown.length);
  assert.equal(out.bytes, bytes(out.markdown));
  assert.equal(out.baselineBytes, base.baselineBytes);
  assert.equal(out.savedBytes, out.baselineBytes - out.bytes);
  assert.equal(out.savedRatio, out.savedBytes / out.baselineBytes);
  assert.equal(out.estimatedTokens, AREX.measureMarkdown(out.markdown).estimatedTokens);
  assert.ok(out.estimatedTokens < base.estimatedTokens);
  assert.equal(out.stats.deduplicated, base.stats.deduplicated);
  assert.equal(out.stats.smartCompacted, base.stats.smartCompacted);
  assert.equal(out.stats.stubbed, base.stats.stubbed);
  assert.equal(out.stats.thoughtsCondensed, 1);
  assert.equal(out.stats.blocksCondensed, 6);
  assert.equal(base.stats.thoughtsCondensed, undefined, 'the input result is not mutated');
  assert.equal(AREX.applyThoughtCondensation(out, { mode: 'smart' }).markdown, out.markdown, 'idempotent');
});

test('applyThoughtCondensation reports zero for modes and toggles that do nothing', () => {
  const raw = assistant(`${thought(paras('zero', 8, 400))}\n\n${ran()}\n\nDone.`);
  for (const [mode, condenseThoughts] of [['off', true], ['lossless', true], ['lossless', false], ['smart', false], ['stubs', false]]) {
    const base = baseResult(raw, mode);
    const out = AREX.applyThoughtCondensation(base, { mode, condenseThoughts });
    assert.equal(out.markdown, base.markdown, `${mode}/${condenseThoughts}`);
    assert.equal(out.bytes, base.bytes);
    assert.equal(out.estimatedTokens, base.estimatedTokens);
    assert.equal(out.stats.thoughtsCondensed, 0);
  }
});

test('applyThoughtCondensation falls back to the unchanged result when indexing fails', () => {
  const raw = assistant(`${thought(paras('fail', 8, 400))}\n\n${ran()}\n\nDone.`);
  const base = baseResult(raw, 'smart');

  const failing = load();
  failing.buildDocumentIndex = () => { throw new Error('boom'); };
  const out = failing.applyThoughtCondensation(base, { mode: 'smart' });
  assert.equal(out.markdown, base.markdown);
  assert.equal(out.bytes, base.bytes);
  assert.equal(out.stats.thoughtsCondensed, 0);

  const missing = load();
  delete missing.buildDocumentIndex;
  assert.equal(missing.applyThoughtCondensation(base, { mode: 'smart' }).markdown, base.markdown);
});

// --- Synthetic coding session -----------------------------------------------

test('synthetic session: every mode and toggle state keeps User turns and final answers intact', () => {
  const raw = generateSyntheticCodingSession();
  const original = extractInvariants(raw);
  const index = AREX.buildMarkdownIndex(raw);
  const thoughtHeadings = markdown => (markdown.match(/^#### Thought for /gm) || []).length;
  for (const mode of ['off', 'lossless', 'smart', 'stubs']) {
    const base = AREX.compressIndex(index, { mode, condenseThoughts: false });
    for (const condenseThoughts of [true, false]) {
      const out = AREX.applyThoughtCondensation(base, { mode, condenseThoughts });
      const label = `${mode}/${condenseThoughts}`;
      const invariants = extractInvariants(out.markdown);
      const baseInvariants = extractInvariants(base.markdown);
      assert.deepEqual(invariants.userTurns, original.userTurns, label);
      assert.equal(invariants.finalAssistant, original.finalAssistant, label);
      assert.equal(invariants.userHeadingCount, original.userHeadingCount, label);
      assert.equal(invariants.assistantHeadingCount, original.assistantHeadingCount, label);
      assert.deepEqual(invariants.diagnostics, baseInvariants.diagnostics, label);
      assert.deepEqual(invariants.exitHeadings, baseInvariants.exitHeadings, label);
      assert.equal(thoughtHeadings(out.markdown), thoughtHeadings(base.markdown), label);
      assert.equal(out.bytes, bytes(out.markdown), label);
      const condensing = condenseThoughts && (mode === 'smart' || mode === 'stubs');
      if (!condensing) {
        assert.equal(out.markdown, base.markdown, label + ' is untouched');
        assert.equal(out.stats.thoughtsCondensed, 0, label);
      } else {
        assert.ok(out.stats.thoughtsCondensed > 0, label);
        assert.ok(out.bytes < base.bytes, label);
        assert.ok(out.estimatedTokens < base.estimatedTokens, label);
        assert.ok(sessionByteShares(out.markdown).thoughtBytes < sessionByteShares(base.markdown).thoughtBytes * 0.7, label);
      }
    }
  }
});

test('synthetic session: each condensed Thought keeps its head and tail blocks in order', () => {
  const raw = generateSyntheticCodingSession();
  const base = baseResult(raw, 'smart');
  const out = AREX.applyThoughtCondensation(base, { mode: 'smart' });
  const thoughts = markdown => AREX.buildDocumentIndex(markdown).sections
    .filter(section => section.kind === 'thought')
    .map(section => markdown.slice(section.startOffset, section.endOffset).trim().split('\n\n').slice(1));
  const before = thoughts(base.markdown), after = thoughts(out.markdown);
  assert.equal(after.length, before.length);
  assert.ok(before.length >= 10);
  before.forEach((blocks, i) => {
    assert.deepEqual(after[i].slice(0, 2), blocks.slice(0, 2), 'first two blocks of Thought ' + i);
    assert.deepEqual(after[i].slice(-2), blocks.slice(-2), 'last two blocks of Thought ' + i);
    assert.ok(after[i].some(block => /^_\[\.\.\. condensed \d+ intermediate reasoning blocks \(\d+ chars\) \.\.\.\]_$/.test(block)));
  });
});
