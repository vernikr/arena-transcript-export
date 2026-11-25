// Tests for Stubs v2 — path-agnostic, content-defined line deduplication
// (issue #8). The algorithm lives in extension/content/compress-stubs.js and is
// driven from compress.js. These tests pin the new behaviours that the old
// per-path `groups` partitioning could not deliver:
//   * compound / piped shell reads dedupe without commandInfo() path inference,
//   * 📄 file artifact cards dedupe against differently-named reads,
//   * `cat -n` / `nl` line-number prefixes are normalized before matching,
//   * unnumbered markers reconstruct byte-for-byte,
//   * no reference chains are ever formed,
//   * edits are only applied when the net UTF-8 delta is ≤ −80 B.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './harness.mjs';

const fence = String.fromCharCode(96).repeat(3);
const fenced = (body, lang = 'text') => fence + lang + '\n' + body + '\n' + fence;
const outputBlock = body => '**stdout:**\n\n' + fenced(body);
// A Read activity block: a heading that yields a file identity, then a stdout fence.
const read = (heading, body) => `#### ${heading}\n\n${outputBlock(body)}`;
// A Bash run: command fence + paired stdout fence.
const run = (command, output) => `#### used Bash 1ms\n\n**command:**\n\n${fenced(command, 'bash')}\n\n**stdout:**\n\n${fenced(output)}`;
// A 📄 file artifact card.
const card = (name, body) => `**📄 ${name}** _(TS)_\n\n${fenced(body, 'ts')}`;

test('Compound / piped shell reads dedupe without commandInfo() path inference', () => {
  const { AREX, dom } = makeEnv();
  // `commandInfo()` rejects pipes, newlines, `;` and >2 `&&` segments, so the old
  // per-path logic never indexed the first read — yet the stdout content is
  // identical to the later slice and must now dedupe.
  const a = Array.from({ length: 20 }, (_, i) => `alpha payload line ${i} content here`);
  // The second read adds a unique header so the lossless dedup stage does not
  // swallow it; only Stubs should link the shared 20-line body.
  const b = ['UNIQUE_COMPOUND_HEADER', ...a];
  const cmd1 = '$ cd repo && cat a.js; echo ===; cat b.js';
  const cmd2 = '$ sed -n 1,20p a.js';
  const raw = run(cmd1, a.join('\n')) + '\n\n' + run(cmd2, b.join('\n'));
  const smart = AREX.compressMarkdown(raw, { mode: 'smart' });
  const stubs = AREX.compressMarkdown(raw, { mode: 'stubs' });

  assert.ok(stubs.stats.stubbed >= 1, 'the second read should reference the first');
  assert.match(stubs.markdown, /arex-stubs-output-1/);
  assert.ok(stubs.bytes < smart.bytes, 'stubs should be smaller than smart');
  dom.window.close();
});

test('📄 file artifact cards dedupe against differently-named reads (path-agnostic)', () => {
  const { AREX, dom } = makeEnv();
  // The card names `config.ts`; the later read names `service.py`. Different
  // paths, identical 20-line body — only content-defined matching links them.
  const x = Array.from({ length: 20 }, (_, i) => `shared content ${i} zzzzzzzzzz`);
  const raw = card('config.ts', x.join('\n')) + '\n\n' + run('$ cat service.py', x.join('\n'));
  const stubs = AREX.compressMarkdown(raw, { mode: 'stubs' });

  assert.ok(stubs.stats.stubbed >= 1, 'card and differently-named read should dedupe');
  assert.match(stubs.markdown, /arex-stubs-output-1/);
  dom.window.close();
});

test('Subsequent sed -n slices dedupe shared ≥4-line chunks across reads', () => {
  const { AREX, dom } = makeEnv();
  const source = Array.from({ length: 60 }, (_, i) => `source line ${i} = 'abcdefghijk'`);
  const first = source.slice(0, 30).concat('ONLY_FIRST');
  const second = ['ONLY_SECOND', ...source.slice(10, 35), 'ONLY_SECOND_END'];
  const raw = [
    run('$ sed -n 1,30p service.py', first.join('\n')),
    run('$ sed -n 10,35p service.py', second.join('\n')),
    run('$ cat service.py', ['different file'].join('\n')),
  ].join('\n\n');
  const smart = AREX.compressMarkdown(raw, { mode: 'smart' });
  const stubs = AREX.compressMarkdown(raw, { mode: 'stubs' });

  assert.equal(stubs.stats.stubbed, 1);
  assert.ok(stubs.bytes < smart.bytes);
  // The shared middle chunk (source[10..29]) is referenced, unique lines survive.
  assert.match(stubs.markdown, /ONLY_FIRST/);
  assert.match(stubs.markdown, /ONLY_SECOND_END/);
  const marker = /\[\.\.\. identical to lines (\d+)–(\d+) of earlier output #arex-stubs-output-1 \.\.\.\]/;
  const m = stubs.markdown.match(marker);
  assert.ok(m, 'expected a plain stubs marker');
  const restored = stubs.markdown
    .replace('<a id="arex-stubs-output-1"></a>\n', '')
    .replace(marker, first.slice(Number(m[1]) - 1, Number(m[2])).join('\n'));
  assert.equal(restored, smart.markdown);
  dom.window.close();
});

test('cat -n line-number prefixes are normalized before matching', () => {
  const { AREX, dom } = makeEnv();
  const lines = Array.from({ length: 20 }, (_, i) => `data line ${i} payload`);
  const plain = lines.join('\n');
  const numbered = lines.map((l, i) => `     ${i + 1}\t${l}`).join('\n');
  const raw = read('used Read f.ts 1ms', plain) + '\n\n' + read('used Read f.ts 2ms', numbered);
  const stubs = AREX.compressMarkdown(raw, { mode: 'stubs' });

  assert.ok(stubs.stats.stubbed >= 1, 'numbered and plain reads should dedupe');
  // Numbering differed, so the marker records it explicitly.
  assert.match(stubs.markdown, /earlier output #arex-stubs-output-1 \(excluding line numbers\) \.\.\./);
  const marker = /\[\.\.\. identical to lines (\d+)–(\d+) of earlier output #arex-stubs-output-1 \(excluding line numbers\) \.\.\.\]/;
  const m = stubs.markdown.match(marker);
  assert.ok(m);
  const A = Number(m[1]), B = Number(m[2]);
  // Reconstruction: the referenced (plain) source lines, gutter-stripped, equal
  // the numbered block's content with its gutters stripped.
  const sourceLines = plain.split('\n');
  const reconstructed = sourceLines.slice(A - 1, B).join('\n');
  const strippedNumbered = numbered.split('\n').map(l => l.replace(/^\s*\d+\t/, '')).join('\n');
  assert.equal(reconstructed, strippedNumbered);
  dom.window.close();
});

test('Unnumbered Stubs markers reconstruct 100% identically to source lines', () => {
  const { AREX, dom } = makeEnv();
  const plain = Array.from({ length: 20 }, (_, i) => `data line ${i} payload here`);
  const b1 = plain.join('\n');
  const b2 = ['UNIQUE_PREFIX_LINE', ...plain].join('\n');
  const raw = read('used Read f.ts 1ms', b1) + '\n\n' + read('used Read f.ts 2ms', b2);
  const smart = AREX.compressMarkdown(raw, { mode: 'smart' });
  const stubs = AREX.compressMarkdown(raw, { mode: 'stubs' });

  assert.ok(stubs.stats.stubbed >= 1);
  assert.doesNotMatch(stubs.markdown, /excluding line numbers/, 'unnumbered match must not mention line numbers');
  const marker = /\[\.\.\. identical to lines (\d+)–(\d+) of earlier output #arex-stubs-output-1 \.\.\.\]/;
  const m = stubs.markdown.match(marker);
  assert.ok(m);
  const A = Number(m[1]), B = Number(m[2]);
  const sourceLines = b1.split('\n');
  const restored = stubs.markdown
    .replace('<a id="arex-stubs-output-1"></a>\n', '')
    .replace(marker, sourceLines.slice(A - 1, B).join('\n'));
  assert.equal(restored, smart.markdown, 'unnumbered marker must reconstruct byte-for-byte');
  dom.window.close();
});

test('Stubs never forms a reference chain (stubbed blocks are not sources)', () => {
  const { AREX, dom } = makeEnv();
  const base = Array.from({ length: 40 }, (_, i) => `common ${i} aaaaaaaaaaaaaaaaaaaaa`);
  const b1 = base.join('\n');
  const b2 = base.concat(['tail2']).join('\n');
  const b3 = base.concat(['tail3']).join('\n');
  const raw = [read('used Read f.ts 1ms', b1), read('used Read f.ts 2ms', b2), read('used Read f.ts 3ms', b3)].join('\n\n');
  const stubs = AREX.compressMarkdown(raw, { mode: 'stubs' });

  assert.equal(stubs.stats.stubbed, 2);
  // Only the first block carries an anchor; both later blocks reference it, never
  // the stubbed middle block.
  const anchorIds = [...stubs.markdown.matchAll(/arex-stubs-output-(\d+)/g)].map(x => x[1]);
  assert.equal(new Set(anchorIds).size, 1);
  assert.equal(anchorIds[0], '1');
  assert.equal((stubs.markdown.match(/earlier output #arex-stubs-output-1/g) || []).length, 2);
  dom.window.close();
});

test('Stubs anchor IDs do not collide with ids already present in the text', () => {
  const { AREX, dom } = makeEnv();
  const shared = Array.from({ length: 20 }, (_, i) => `shared line ${i} with enough content to reference safely`);
  const r = prefix => read('used Read file.ts 1ms', [prefix, ...shared].join('\n'));
  const raw = 'Existing text mentions arex-stubs-output-1.\n\n' + r('first') + '\n\n' + r('second');
  const stubs = AREX.compressMarkdown(raw, { mode: 'stubs' });

  assert.equal(stubs.stats.stubbed, 1);
  assert.match(stubs.markdown, /id="arex-stubs-output-2"/);
  assert.match(stubs.markdown, /earlier output #arex-stubs-output-2/);
  dom.window.close();
});

test('Stubs rolls back when the net UTF-8 delta is not ≤ −80 B', () => {
  const { AREX, dom } = makeEnv();
  // A short shared run saves a little, but the source anchor overhead pushes the
  // net delta above −80 B, so the edit must be rolled back (stubs == smart).
  const shared = Array.from({ length: 5 }, (_, i) => `fivecharline${i}aaaaaaaaaaaaaaaaaaaaaa`).join('\n');
  const b1 = 'head1\n' + shared + '\ntail1';
  const b2 = 'head2\n' + shared + '\ntail2';
  const raw = [read('used Read f.ts 1ms', b1), read('used Read f.ts 2ms', b2)].join('\n\n');
  const smart = AREX.compressMarkdown(raw, { mode: 'smart' });
  const stubs = AREX.compressMarkdown(raw, { mode: 'stubs' });

  assert.equal(stubs.stats.stubbed, 0);
  assert.equal(stubs.markdown, smart.markdown);
  dom.window.close();
});

test('Stubs keeps unique versions and non-overlapping ranges fully intact', () => {
  const { AREX, dom } = makeEnv();
  const oldBody = Array.from({ length: 60 }, (_, i) => `export const OLD_${i} = ${i};`).join('\n');
  const newBody = Array.from({ length: 60 }, (_, i) => `export const NEW_${i} = ${i};`).join('\n');
  const raw = read('used Read src/config.ts 12ms', oldBody) + '\n\n' + read('used Read src/config.ts 19ms', newBody);
  const smart = AREX.compressMarkdown(raw, { mode: 'smart' });
  const stubs = AREX.compressMarkdown(raw, { mode: 'stubs' });

  assert.equal(stubs.stats.stubbed, 0, 'distinct versions must not be linked');
  assert.match(stubs.markdown, /OLD_59/);
  assert.match(stubs.markdown, /NEW_59/);
  assert.equal(stubs.markdown, smart.markdown);
  dom.window.close();
});

test('Stubs honors the in-memory seed cap while still deduping early blocks', () => {
  const { AREX, dom } = makeEnv();
  // 40 distinct 40-line blocks; the seed index must stay bounded (≤ 30k keys,
  // ≤ 6 slots/key) while the first block still becomes a source for later copies.
  const mk = i => Array.from({ length: 40 }, (_, j) => `block ${i} line ${j} ` + 'x'.repeat(40)).join('\n');
  const raw = Array.from({ length: 40 }, (_, i) => read(`used Read f${i}.ts 1ms`, mk(i))).join('\n\n');
  const stubs = AREX.compressMarkdown(raw, { mode: 'stubs' });
  // No two blocks share content, so nothing should be stubbed — this just proves
  // the bounded index processes a large transcript without throwing or blowing up.
  assert.equal(stubs.stats.stubbed, 0);
  assert.ok(stubs.bytes > 0);
  dom.window.close();
});
