import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeEnv } from './harness.mjs';
import { randomTranscriptWithMeta } from './fixtures/random-transcript.mjs';

const fence = String.fromCharCode(96).repeat(3);
const fenced = (body, lang = 'text') => fence + lang + '\n' + body + '\n' + fence;
const outputBlock = body => '**stdout:**\n\n' + fenced(body);

test('Lossless links repeated tool output to the first full copy', () => {
  const { AREX, dom } = makeEnv();
  const body = Array.from({ length: 30 }, (_, i) => 'same output line ' + i).join('\n');
  const raw = outputBlock(body) + '\n\n#### second run\n\n' + outputBlock(body);
  const result = AREX.compressMarkdown(raw, { mode: 'lossless' });

  assert.equal(result.stats.deduplicated, 1);
  assert.ok(result.bytes < result.baselineBytes);
  assert.match(result.markdown, /arex-output-1/);
  assert.match(result.markdown, /Identical to \[output #1\]/);
  assert.equal((result.markdown.match(/same output line 0/g) || []).length, 1);
  dom.window.close();
});

test('Smart removes terminal noise and collapses long successful test runs', () => {
  const { AREX, dom } = makeEnv();
  const passes = Array.from({ length: 12 }, (_, i) => '✓ suite > test-' + i + ' [1.00ms]').join('\n');
  const raw = outputBlock('\u001b[32m' + passes + '\u001b[0m\n⠋ running tests\r⠙ running tests\rDone');
  const result = AREX.compressMarkdown(raw, { mode: 'smart' });

  assert.equal(result.stats.smartCompacted, 1);
  assert.match(result.markdown, /collapsed 12 passing test lines/);
  assert.doesNotMatch(result.markdown, /\u001b\[32m/);
  assert.doesNotMatch(result.markdown, /⠋|⠙/);
  assert.ok(result.bytes < result.baselineBytes);
  dom.window.close();
});

test('Smart preserves error output and clips only large clean command output', () => {
  const { AREX, dom } = makeEnv();
  const cleanLines = Array.from({ length: 140 }, (_, i) => 'build step ' + i + ' completed').join('\n');
  const clean = AREX.compressMarkdown(outputBlock(cleanLines), { mode: 'smart' });
  assert.match(clean.markdown, /omitted \d+ middle lines/);
  assert.match(clean.markdown, /build step 0 completed/);
  assert.match(clean.markdown, /build step 139 completed/);

  const errorLines = cleanLines + '\nError: compilation failed\nat build (src/build.ts:12:3)';
  const withError = AREX.compressMarkdown(outputBlock(errorLines), { mode: 'smart' });
  assert.doesNotMatch(withError.markdown, /omitted \d+ middle lines/);
  assert.match(withError.markdown, /compilation failed/);
  assert.match(withError.markdown, /src\/build\.ts:12:3/);
  dom.window.close();
});

test('Compact Stubs preserves distinct versions in ordinary Read activity blocks', () => {
  const { AREX, dom } = makeEnv();
  const nl = String.fromCharCode(10);
  const oldBody = Array.from({ length: 60 }, (_, i) => 'export const OLD_' + i + ' = ' + i + ';').join(nl);
  const newBody = Array.from({ length: 60 }, (_, i) => 'export const NEW_' + i + ' = ' + i + ';').join(nl);
  const read = (body, elapsed) => '#### used Read src/config.ts ' + elapsed + 'ms' + nl + nl + fenced(body, 'text');
  const raw = read(oldBody, 12) + nl + nl + read(newBody, 19);
  const smart = AREX.compressMarkdown(raw, { mode: 'smart' });
  const stubs = AREX.compressMarkdown(raw, { mode: 'stubs' });

  assert.equal(stubs.stats.stubbed, 0);
  assert.match(stubs.markdown, /NEW_59/);
  assert.match(stubs.markdown, /OLD_59/);
  assert.equal(stubs.markdown, smart.markdown);
  dom.window.close();
});

test('Compact Stubs preserves distinct file artifact card content', () => {
  const { AREX, dom } = makeEnv();
  const nl = String.fromCharCode(10);
  const filename = name => '**📄 ' + name + '** _(TS)_' + nl + nl;
  const oldBody = Array.from({ length: 60 }, (_, i) => 'export const OLD_' + i + ' = ' + i + ';').join(nl);
  const newBody = Array.from({ length: 60 }, (_, i) => 'export const NEW_' + i + ' = ' + i + ';').join(nl);
  const raw = filename('config.ts') + fenced(oldBody, 'ts') + nl + nl +
    filename('config.ts') + fenced(newBody, 'ts');
  const result = AREX.compressMarkdown(raw, { mode: 'stubs' });
  assert.equal(result.stats.stubbed, 0);
  assert.match(result.markdown, /OLD_59/);
  assert.match(result.markdown, /NEW_59/);
  dom.window.close();
});

test('size preview reports UTF-8 bytes and a multilingual token estimate', () => {
  const { AREX, dom } = makeEnv();
  const metrics = AREX.measureMarkdown('Hello мир 🌍');
  assert.equal(metrics.bytes, new TextEncoder().encode('Hello мир 🌍').length);
  assert.ok(metrics.estimatedTokens > 0);
  assert.equal(AREX.formatBytes(2048), '2.0 KB');
  assert.equal(AREX.formatBytes(1754125), '1.75 MB');
  assert.equal(AREX.formatByteCount(1754125), '1,754,125 B');
  assert.match(AREX.formatTokenCount(12460), /^12\.5k$/);
  dom.window.close();
});

test('BlockIndex pairs Bash reads with stdout, keeps paths case-sensitive and respects cwd', () => {
  const { AREX } = makeEnv();
  const body = name => Array.from({ length: 150 }, (_, i) => `class ${name}${i}Error(Exception): pass  # assertion failures`).join('\n');
  const run = (heading, command, output) => `#### ${heading}\n\n**command:**\n\n${fenced(command, 'bash')}\n\n**stdout:**\n\n${fenced(output)}`;
  const raw = [run('used Bash 1ms', '$ cd /repo && sed -n 1,150p service.py', body('OLD')),
    run('used Bash 2ms', '$ cd /repo && cat service.py', body('NEW')),
    run('used Bash 3ms', '$ cd /other && cat service.py', body('OTHER')),
    run('used Bash 4ms', '$ cd /repo && cat Service.py', body('UPPER'))].join('\n\n');
  const index = AREX.buildMarkdownIndex(raw);
  const outputs = index.blocks.filter(b => b.label === 'stdout');
  assert.equal(outputs.length, 4); assert.match(outputs[0].pairedCommand.body, /sed -n/);
  assert.ok(outputs[0].bytes > 800 && outputs[0].estimatedTokens > 0);
  const results = ['off', 'lossless', 'smart', 'stubs'].map(mode => AREX.compressIndex(index, { mode }));
  for (const r of results) assert.equal(r.bytes, new TextEncoder().encode(r.markdown).length);
  assert.ok(results.every((r, i) => i === 0 || r.bytes <= results[i - 1].bytes));
  assert.match(results[2].markdown, /omitted \d+ middle lines/);
  assert.equal(results[3].stats.stubbed, 0);
  assert.match(results[3].markdown, /NEW149Error/);
  assert.match(results[3].markdown, /OTHER149Error/);
  assert.match(results[3].markdown, /UPPER149Error/);
});

test('Bash file reads still preserve actual errors and explicit non-zero exit output', () => {
  const { AREX } = makeEnv();
  const lines = Array.from({ length: 150 }, (_, i) => `source line ${i}`).join('\n');
  const run = (heading, text) => `#### ${heading}\n\n**command:**\n\n${fenced('$ cat missing.py', 'bash')}\n\n**stdout:**\n\n${fenced(text)}`;
  const missing = AREX.compressMarkdown(run('used Bash 1ms', lines + '\ncat: missing.py: No such file or directory'), { mode: 'smart' });
  assert.doesNotMatch(missing.markdown, /omitted \d+ middle lines/);
  const failed = AREX.compressMarkdown(run('used Bash exit 2 1ms', lines), { mode: 'smart' });
  assert.doesNotMatch(failed.markdown, /omitted \d+ middle lines/);
});

test('Stubs preserves unique earlier heredoc writes of the same target', () => {
  const { AREX } = makeEnv();
  const body = word => Array.from({ length: 90 }, (_, i) => `${word}_line_${i} = ${i}`).join('\n');
  const write = (path, word, cwd = '/repo') => `#### used Bash 1ms\n\n**command:**\n\n${fenced(`$ cd ${cwd} && cat > ${path} << 'PY'\n${body(word)}\nPY`, 'bash')}`;
  const raw = [write('file.py', 'OLD'), write('file.py', 'NEW'), write('file.py', 'OTHER', '/other')].join('\n\n');
  const result = AREX.compressMarkdown(raw, { mode: 'stubs' });
  assert.equal(result.stats.stubbed, 0);
  assert.match(result.markdown, /OLD_line_89/);
  assert.match(result.markdown, /NEW_line_89/);
  assert.match(result.markdown, /OTHER_line_89/);
});

test('single-pass token estimate agrees with the original Unicode formula', () => {
  const { AREX } = makeEnv();
  const oldEstimate = value => {
    let total = 0;
    for (const chunk of value.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu) || []) {
      const cyrillic = (chunk.match(/[\u0400-\u052f]/g) || []).length;
      const cjk = (chunk.match(/[\u3040-\u9fff\uac00-\ud7af]/g) || []).length;
      const latin = (chunk.match(/[A-Za-z]/g) || []).length;
      const digits = (chunk.match(/[0-9]/g) || []).length;
      if (cjk) { total += Math.ceil(cjk * 1.15); if (chunk.length > cjk) total += Math.ceil((chunk.length - cjk) / 4); }
      else if (cyrillic) { total += cyrillic <= 3 ? 1 : Math.ceil(cyrillic / 3.4); if (chunk.length > cyrillic) total += Math.ceil((chunk.length - cyrillic) / 4); }
      else if (latin) { total += latin <= 7 ? 1 : Math.ceil(latin / 4.5); if (chunk.length > latin) total += Math.ceil((chunk.length - latin) / 3); }
      else if (digits) total += Math.ceil(digits / 3);
      else total += Math.ceil(chunk.length / 4);
    }
    return total;
  };
  const chars = ['a', 'Z', '_', '9', ' ', '\n', '\u00a0', 'ё', 'Ж', 'я', '漢', 'あ', '한', 'é', '٣', '𝒜', '🌍', '!', '.', '\u0301', '\ud800'];
  let seed = 991; const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  for (let sample = 0; sample < 400; sample++) {
    let text = ''; for (let i = 0; i < sample % 80; i++) text += chars[random() % chars.length];
    assert.equal(AREX.measureMarkdown(text).estimatedTokens, oldEstimate(text), JSON.stringify(text));
  }
});

test('labels do not leak across fences or message headings into unrelated prose', () => {
  const { AREX } = makeEnv();
  const body = 'a'.repeat(200);
  const raw = '**stdout:**\n\n' + fenced(body) + '\n\n## 👤 User\n\n' + fenced(body);
  const index = AREX.buildMarkdownIndex(raw);
  assert.equal(index.blocks[0].label, 'stdout');
  assert.equal(index.blocks[1].label, '');
  const result = AREX.compressIndex(index, { mode: 'lossless' });
  assert.equal(result.stats.deduplicated, 0);
  assert.equal(result.markdown, raw);
});

test('all modes preserve byte accounting and monotonically decrease size across mixed blocks', () => {
  const { AREX } = makeEnv(); let seed = 145;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  const sample = ['small', '🌍 текст', 'line with 0123456789', 'Error: failed', '✓ suite > test [1ms]', 'repeat '.repeat(35)];
  for (let run = 0; run < 60; run++) {
    let raw = '';
    for (let i = 0; i < 5 + random() % 8; i++) {
      const body = Array.from({ length: 1 + random() % 35 }, () => sample[random() % sample.length]).join('\n');
      raw += `\n\n#### used Bash ${i}ms\n\n${outputBlock(body)}`;
    }
    const index = AREX.buildMarkdownIndex(raw);
    const results = ['off', 'lossless', 'smart', 'stubs'].map(mode => AREX.compressIndex(index, { mode }));
    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].bytes, new TextEncoder().encode(results[i].markdown).length);
      assert.ok(i === 0 || results[i].bytes <= results[i - 1].bytes);
    }
  }
});

test('a paired stderr prevents shortening stdout of an otherwise plausible file read', () => {
  const { AREX } = makeEnv();
  const body = Array.from({ length: 150 }, (_, i) => `source line ${i}`).join('\n');
  const raw = `#### used Bash 1ms\n\n**command:**\n\n${fenced('$ cat file.py', 'bash')}\n\n**stdout:**\n\n${fenced(body)}\n\n**stderr:**\n\n${fenced('warning: failed to read entire file')}`;
  const result = AREX.compressMarkdown(raw, { mode: 'smart' });
  assert.doesNotMatch(result.markdown, /omitted \d+ middle lines/);
  assert.match(result.markdown, /source line 90/);
});

test('Stubs references only identical consecutive lines and preserves unique ranges and versions', () => {
  const { AREX, dom } = makeEnv();
  const source = Array.from({ length: 40 }, (_, i) => `shared source line ${i} = 'abcdefghijk'`);
  const first = source.slice(0, 30).concat('ONLY_FIRST');
  const second = ['ONLY_SECOND', ...source.slice(10, 35), 'ONLY_SECOND_END'];
  const run = (command, lines, cwd = '/repo') => `#### used Bash 1ms\n\n**command:**\n\n${fenced(`$ cd ${cwd} && ${command}`, 'bash')}\n\n**stdout:**\n\n${fenced(lines.join('\n'))}`;
  const raw = [run('sed -n 1,30p service.py', first), run('sed -n 10,35p service.py', second),
    run('cat service.py', ['different file'], '/other')].join('\n\n');
  const smart = AREX.compressMarkdown(raw, { mode: 'smart' });
  const result = AREX.compressMarkdown(raw, { mode: 'stubs' });
  assert.equal(result.stats.stubbed, 1);
  assert.ok(result.bytes < smart.bytes);
  assert.match(result.markdown, /ONLY_FIRST/); assert.match(result.markdown, /ONLY_SECOND_END/);
  assert.match(result.markdown, /<a id="arex-stubs-output-1"><\/a>/);
  const marker = /\[\.\.\. identical to lines (\d+)–(\d+) of earlier output #arex-stubs-output-1 \.\.\.\]/;
  const match = result.markdown.match(marker); assert.ok(match);
  const restored = result.markdown.replace('<a id="arex-stubs-output-1"></a>\n', '')
    .replace(marker, first.slice(Number(match[1]) - 1, Number(match[2])).join('\n'));
  assert.equal(restored, smart.markdown);
  dom.window.close();
});

test('Stubs never references an output that is itself a shortened reference', () => {
  const { AREX, dom } = makeEnv();
  const shared = Array.from({ length: 35 }, (_, i) => `common line ${i} a long enough piece of text`);
  const read = (prefix, content) => `#### used Read file.ts 1ms\n\n${fenced([prefix, ...content].join('\n'))}`;
  const raw = [read('first', shared), read('second', shared), read('third', shared)].join('\n\n');
  const result = AREX.compressMarkdown(raw, { mode: 'stubs' });
  assert.equal(result.stats.stubbed, 2);
  assert.equal((result.markdown.match(/id="arex-stubs-output-/g) || []).length, 1);
  assert.equal((result.markdown.match(/earlier output #arex-stubs-output-1/g) || []).length, 2);
  for (const word of ['first', 'second', 'third']) assert.match(result.markdown, new RegExp(word));
  dom.window.close();
});

test('duplicate anchors retain the complete original output in Smart and Stubs', () => {
  const { AREX, dom } = makeEnv();
  const lines = Array.from({ length: 150 }, (_, i) => `build output ${i} ${'a'.repeat(50)}`);
  const partial = lines.slice(0, 80).join('\n');
  const full = lines.join('\n');
  const read = body => `#### used Read file.ts 1ms\n\n${outputBlock(body)}`;
  const raw = [read(partial), read(full), read(full)].join('\n\n');
  for (const mode of ['lossless', 'smart', 'stubs']) {
    const result = AREX.compressMarkdown(raw, { mode });
    assert.equal(result.stats.deduplicated, 1);
    assert.match(result.markdown, /<a id="arex-output-2"><\/a>\n```text\n/);
    assert.match(result.markdown, /build output 90/);
    const afterAnchor = result.markdown.split('<a id="arex-output-2"></a>\n')[1].split('\n```')[0];
    assert.equal(afterAnchor, '```text\n' + full);
  }
  dom.window.close();
});

test('Stubs chooses anchor IDs that do not collide with original content', () => {
  const { AREX, dom } = makeEnv();
  const shared = Array.from({ length: 20 }, (_, i) => `shared line ${i} with enough content to reference safely`);
  const read = prefix => `#### used Read file.ts 1ms\n\n${fenced([prefix, ...shared].join('\n'))}`;
  const raw = 'Existing text mentions arex-stubs-output-1.\n\n' + read('first') + '\n\n' + read('second');
  const result = AREX.compressMarkdown(raw, { mode: 'stubs' });
  assert.equal(result.stats.stubbed, 1);
  assert.match(result.markdown, /id="arex-stubs-output-2"/);
  assert.match(result.markdown, /earlier output #arex-stubs-output-2/);
  dom.window.close();
});

test('Lossless dedup handles FNV-1a hash collisions without false matches', () => {
  const { AREX, dom } = makeEnv();
  // Same length (128) and same FNV-1a 32-bit hash, different content.
  const a = 'gs1kez4aolnz5vqjf16znry06ufctkjocawc74qbw3g8xlak6ylv6036xi1uod8qq4yubpe35arnsi58htprdm1tuioub3utdbhj54whchjn1k5libjrknonckp9wgrd';
  const b = 'bbvgrdlvgw8ug9anojhr89f4g1vu6akl5eu053nbxt50tmvpwy7zv9qk62jvugqbqa1c5x2xg3ah362ipotwvqjtz3zhg3q1u87gqzaudmqrz7vwqkvr77kz8n3o153a';
  assert.notEqual(a, b);
  assert.equal(a.length, b.length);
  // Verify collision with the same algorithm used in compress.js
  const fnv1a32 = str => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
  assert.equal(fnv1a32(a), fnv1a32(b));

  const raw = outputBlock(a) + '\n\n#### second\n\n' + outputBlock(b) + '\n\n#### third\n\n' + outputBlock(a);
  const result = AREX.compressMarkdown(raw, { mode: 'lossless' });
  // Only the identical a/a pair should dedup; b must remain distinct.
  assert.equal(result.stats.deduplicated, 1);
  assert.match(result.markdown, /Identical to \[output #1\]/);
  assert.ok(result.markdown.includes(b));
  // The b block should not be replaced by a reference.
  const refCount = (result.markdown.match(/Identical to \[output #/g) || []).length;
  assert.equal(refCount, 1);
  dom.window.close();
});

test('utf8Bytes has exact Unicode/surrogate parity with TextEncoder', () => {
  const { AREX, dom } = makeEnv();
  const enc = new TextEncoder();
  const cases = [
    '', 'ascii', 'Hello мир 🌍', '漢字かなカナ', 'é\u0301', '𝒜𝒞𝒢',
    '\uD800', '\uDC00', 'a\uD800b', 'a\uDC00b', '\uD800\uDC00', '\uD800\uD800',
    '\uDC00\uD800', '\uDBFF\uDFFF', '\uD800\uDFFF', '\u0000\u007f\u0080\u07ff\u0800\uffff',
    'line\nwith\r\nnewlines\tand\0null',
  ];
  // Also random BMP + astral + lone surrogates
  let seed = 0xC0FFEE;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  for (let i = 0; i < 200; i++) {
    let s = '';
    for (let j = 0; j < 40; j++) {
      const r = rnd() % 5;
      if (r === 0) s += String.fromCharCode(rnd() % 0x80);
      else if (r === 1) s += String.fromCharCode(0x80 + rnd() % 0x700);
      else if (r === 2) s += String.fromCharCode(0x800 + rnd() % 0xF800);
      else if (r === 3) s += String.fromCodePoint(0x10000 + (rnd() % 0x1000));
      else s += String.fromCharCode(0xD800 + (rnd() % 0x800)); // surrogates, including lone
    }
    cases.push(s);
  }
  for (const value of cases) {
    assert.equal(AREX.measureMarkdown(value).bytes, enc.encode(value).length, JSON.stringify(value.slice(0, 20)));
  }
  dom.window.close();
});

test('Stubs rollback preserves correctness when trial increases bytes', () => {
  const { AREX, dom } = makeEnv();
  // Build a case where a stubs reference would be attempted but the anchor overhead
  // makes it not beneficial, forcing rollback. The block must remain unchanged.
  const nl = String.fromCharCode(10);
  const shared = Array.from({ length: 6 }, (_, i) => `shared-${i}-${'x'.repeat(20)}`);
  // First block: has the shared lines (will become a source if unchanged)
  const first = ['header', ...shared, 'tail1'].join(nl);
  // Second block: shares lines but is small enough that adding anchor+marker is not worth it
  // Make replacement barely not beneficial by using short unique prefix and short body
  const second = ['unique', ...shared, 'tail2'].join(nl);
  const raw = `#### used Read a.ts 1ms\n\n${fenced(first)}\n\n#### used Read a.ts 2ms\n\n${fenced(second)}`;
  const smart = AREX.compressMarkdown(raw, { mode: 'smart' });
  const stubs = AREX.compressMarkdown(raw, { mode: 'stubs' });
  // Either stubs applied (bytes < smart) or it rolled back correctly (equal to smart).
  assert.ok(stubs.bytes <= smart.bytes);
  // Content integrity: unique lines must survive
  assert.match(stubs.markdown, /header/);
  assert.match(stubs.markdown, /unique/);
  assert.match(stubs.markdown, /tail1/);
  assert.match(stubs.markdown, /tail2/);
  // If rolled back, markdown should be identical to smart
  if (stubs.stats.stubbed === 0) {
    assert.equal(stubs.markdown, smart.markdown);
  }
  dom.window.close();
});

test('Stubs does not clone Maps inside the stub loop', () => {
  const { AREX, dom } = makeEnv();
  const nl = String.fromCharCode(10);
  // Create a case with many groups/blocks to exercise the stubs loop.
  const shared = Array.from({ length: 40 }, (_, i) => `shared line ${i} = 'abcdefghijk'`);
  const mk = (name, extra) => `#### used Read ${name}.ts 1ms\n\n${fenced([extra, ...shared, extra + '-end'].join(nl))}`;
  const raw = [mk('a', 'A'), mk('a', 'B'), mk('a', 'C'), mk('b', 'D'), mk('b', 'E')].join('\n\n');

  const RealMap = dom.window.Map;
  let clones = 0;
  class SpyMap extends RealMap {
    constructor(arg) {
      super(arg);
      // A clone-from-map with existing size is what we're forbidding inside the loop.
      if (arg instanceof RealMap && arg.size > 0) clones++;
    }
  }
  dom.window.Map = SpyMap;
  globalThis.Map = SpyMap;
  try {
    const result = AREX.compressIndex(AREX.buildMarkdownIndex(raw), { mode: 'stubs' });
    assert.ok(result.stats.stubbed > 0);
  } finally {
    dom.window.Map = RealMap;
    globalThis.Map = RealMap;
  }
  // Allow the expected small fixed number of clones (smartEdits clone, stubEdits clone) but not per-block.
  assert.ok(clones <= 2, 'expected <= 2 Map clones, got ' + clones);
  dom.window.close();
});

test('incremental token delta matches estimateTokens(markdown) for all modes', () => {
  const { AREX, dom } = makeEnv();
  const nl = String.fromCharCode(10);
  const body = Array.from({ length: 30 }, (_, i) => 'same output line ' + i + ' with enough text').join(nl);
  const passes = Array.from({ length: 12 }, (_, i) => '✓ suite > test-' + i + ' [1.00ms]').join(nl);
  const raw = [
    outputBlock(body),
    '#### second\n\n' + outputBlock(body),
    '#### third\n\n' + outputBlock(passes),
    '#### used Read f.ts 1ms\n\n' + fenced(Array.from({ length: 40 }, (_, i) => `line ${i} abcdefghijk`).join(nl)),
    '#### used Read f.ts 2ms\n\n' + fenced(Array.from({ length: 40 }, (_, i) => `line ${i} abcdefghijk`).join(nl).replace('line 39', 'line 39 changed')),
  ].join('\n\n');
  const index = AREX.buildMarkdownIndex(raw);
  for (const mode of ['off', 'lossless', 'smart', 'stubs']) {
    const result = AREX.compressIndex(index, { mode });
    const fresh = AREX.measureMarkdown(result.markdown).estimatedTokens;
    assert.equal(result.estimatedTokens, fresh, mode + ' token parity');
  }
  dom.window.close();
});

test('no TextEncoder.encode Uint8Array allocations during buildMarkdownIndex and compressIndex', () => {
  const { AREX, dom } = makeEnv();
  const nl = String.fromCharCode(10);
  const body = Array.from({ length: 30 }, (_, i) => 'output ' + i + ' мир 🌍').join(nl);
  const raw = outputBlock(body) + '\n\n#### second\n\n' + outputBlock(body);
  const RealTE = dom.window.TextEncoder;
  // Our implementation must not rely on TextEncoder.encode in hot paths.
  dom.window.TextEncoder = class { encode() { throw new Error('TextEncoder.encode should not be called'); } };
  globalThis.TextEncoder = dom.window.TextEncoder;
  try {
    const index = AREX.buildMarkdownIndex(raw);
    for (const mode of ['off', 'lossless', 'smart', 'stubs']) AREX.compressIndex(index, { mode });
    AREX.measureMarkdown(raw);
  } finally {
    dom.window.TextEncoder = RealTE;
    globalThis.TextEncoder = RealTE;
  }
  dom.window.close();
});

test('strict byte monotonicity Off >= Lossless >= Smart >= Stubs', () => {
  const { AREX, dom } = makeEnv();
  const nl = String.fromCharCode(10);
  const cases = [];
  // repeated output
  const body = Array.from({ length: 30 }, (_, i) => 'same line ' + i).join(nl);
  cases.push(outputBlock(body) + '\n\n#### b\n\n' + outputBlock(body));
  // noisy test run
  const passes = Array.from({ length: 12 }, (_, i) => '✓ suite > t-' + i + ' [1ms]').join(nl);
  cases.push(outputBlock(passes));
  // stubs-eligible reads
  const shared = Array.from({ length: 40 }, (_, i) => `shared ${i} abcdefghijk`).join(nl);
  cases.push(`#### used Read a.ts 1ms\n\n${fenced(shared)}\n\n#### used Read a.ts 2ms\n\n${fenced(shared + nl + 'extra')}`);
  for (const raw of cases) {
    const index = AREX.buildMarkdownIndex(raw);
    const results = ['off', 'lossless', 'smart', 'stubs'].map(mode => AREX.compressIndex(index, { mode }));
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i].bytes <= results[i - 1].bytes, `monotonicity at ${i} for case`);
      assert.equal(results[i].bytes, AREX.measureMarkdown(results[i].markdown).bytes, 'byte accounting');
    }
  }
  dom.window.close();
});

// --- End-to-end pipeline (Wave 4.1) ----------------------------------------------------------------------------
//
// The whole stack is loaded the way popup.html loads it, into the main context, which behaves like a Worker's
// global scope: hot loops stay fast, so a few hundred generated transcripts run in seconds.

const extensionFile = path => readFileSync(new URL('../extension/' + path, import.meta.url), 'utf8');
const scriptsOf = (source, pattern) => [...source.matchAll(pattern)].map(match => match[1]);
const PIPELINE = scriptsOf(extensionFile('popup/popup.html'), /<script src="\.\.\/content\/(compress[\w-]*\.js)"/g);
for (const file of PIPELINE) vm.runInThisContext(extensionFile('content/' + file), { filename: file });
const P = globalThis.AREX;

const MODES = ['off', 'lossless', 'smart', 'stubs'];
const utf8 = text => Buffer.byteLength(text);
const CORPUS_SIZE = 220;

// Every transcript is compressed once per mode and per toggle state, then shared by the property tests below.
const corpus = new Map();
function sample(seed) {
  if (!corpus.has(seed)) {
    const { markdown: raw, proseFences, gluedFences } = randomTranscriptWithMeta(seed);
    const index = P.buildMarkdownIndex(raw);
    const doc = P.buildDocumentIndex(raw);
    const results = Object.fromEntries(MODES.map(mode => [mode, P.compressIndex(index, { mode })]));
    const kept = Object.fromEntries(['smart', 'stubs'].map(mode => [mode, P.compressIndex(index, { mode, condenseThoughts: false })]));
    corpus.set(seed, { seed, raw, proseFences, gluedFences, index, doc, results, kept });
  }
  return corpus.get(seed);
}
const eachSample = fn => { for (let seed = 1; seed <= CORPUS_SIZE; seed++) fn(sample(seed)); };

// The text no mode may change: User turns and assistant answer spans, in document order.
function protectedTexts({ raw, doc }) {
  const texts = [];
  for (const turn of doc.turns) {
    if (turn.kind === 'user') texts.push(raw.slice(turn.startOffset, turn.endOffset));
    else for (const span of turn.answerSpans) texts.push(raw.slice(span.startOffset, span.endOffset));
  }
  return texts;
}

test('the pipeline modules load in dependency order and match across manifest, background, popup, worker and harness', () => {
  const wanted = ['compress-index.js', 'compress-smart-log.js', 'compress-smart-cli.js', 'compress-framing.js',
    'compress-commands.js', 'compress.js', 'compress-stubs.js', 'compress-thoughts.js'];
  assert.deepEqual(PIPELINE, wanted, 'popup.html');
  const manifest = JSON.parse(extensionFile('manifest.json')).content_scripts[0].js;
  const lists = {
    manifest: manifest.filter(file => /compress/.test(file)).map(file => file.replace('content/', '')),
    background: scriptsOf(extensionFile('background.js').match(/const CONTENT_FILES = \[[\s\S]*?\];/)[0], /'content\/(compress[\w-]*\.js)'/g),
    worker: scriptsOf(extensionFile('popup/compress-worker.js').match(/importScripts\([\s\S]*?\);/)[0], /'\.\.\/content\/(compress[\w-]*\.js)'/g),
    harness: scriptsOf(readFileSync(new URL('./harness.mjs', import.meta.url), 'utf8').match(/const FILES = \[[\s\S]*?\];/)[0], /'(compress[\w-]*)'/g).map(name => name + '.js'),
  };
  for (const [where, list] of Object.entries(lists)) assert.deepEqual(list, wanted, where);
  for (const file of wanted) assert.ok(extensionFile('content/' + file).length > 0, file);
  // The in-tab bundle keeps compress.js after the modules it feature-detects and before profile.js and main.js.
  assert.ok(manifest.indexOf('content/compress-thoughts.js') < manifest.indexOf('content/profile.js'));
});

test('a generated corpus exercises every stage', () => {
  const totals = { deduplicated: 0, smartCompacted: 0, stubbed: 0, framingCompacted: 0, commandsShortened: 0, thoughtsCondensed: 0, draftsDeduplicated: 0 };
  eachSample(({ results }) => {
    for (const key of Object.keys(totals)) totals[key] += results.stubs.stats[key] || 0;
  });
  for (const [key, value] of Object.entries(totals)) assert.ok(value >= 10, `${key} fired ${value} times`);
});

test('strict byte monotonicity Off >= Lossless >= Smart >= Stubs holds with exact accounting on generated transcripts', () => {
  eachSample(({ seed, raw, results, kept }) => {
    const label = 'transcript ' + seed;
    assert.equal(results.off.markdown, raw, label + ': Off is the raw Markdown');
    for (const mode of MODES) {
      const result = results[mode];
      assert.equal(result.bytes, utf8(result.markdown), `${label} ${mode}: bytes`);
      assert.equal(result.baselineBytes, utf8(raw), `${label} ${mode}: baseline`);
      assert.equal(result.savedBytes, result.baselineBytes - result.bytes, `${label} ${mode}: saved`);
      assert.equal(result.estimatedTokens, P.measureMarkdown(result.markdown).estimatedTokens, `${label} ${mode}: tokens`);
    }
    for (let i = 1; i < MODES.length; i++) {
      assert.ok(results[MODES[i]].bytes <= results[MODES[i - 1]].bytes, `${label}: ${MODES[i]} <= ${MODES[i - 1]}`);
    }
    // The same chain holds without the reasoning stage, which can only add savings on top.
    assert.ok(kept.smart.bytes <= results.lossless.bytes, label + ': Smart without reasoning <= Lossless');
    assert.ok(kept.stubs.bytes <= kept.smart.bytes, label + ': Stubs without reasoning <= Smart without reasoning');
    assert.ok(results.smart.bytes <= kept.smart.bytes && results.stubs.bytes <= kept.stubs.bytes, label + ': reasoning only shrinks');
    assert.equal(kept.stubs.estimatedTokens, P.measureMarkdown(kept.stubs.markdown).estimatedTokens, label + ': tokens without reasoning');
  });
});

test('User turns, final answers and code in prose stay byte-identical in every mode and toggle state', () => {
  eachSample(sampleData => {
    const { seed, raw, proseFences, results, kept } = sampleData;
    const texts = protectedTexts(sampleData);
    assert.ok(texts.length > 0 && proseFences.length >= 0);
    for (const [name, result] of [...Object.entries(results), ['smart (reasoning kept)', kept.smart], ['stubs (reasoning kept)', kept.stubs]]) {
      let cursor = 0;
      for (const text of texts) {
        const at = result.markdown.indexOf(text, cursor);
        assert.ok(at >= 0, `transcript ${seed} ${name}: protected text changed: ${JSON.stringify(text.slice(0, 70))}`);
        cursor = at + text.length;
      }
      for (const fence of proseFences) {
        assert.ok(result.markdown.includes(fence), `transcript ${seed} ${name}: code in prose changed: ${JSON.stringify(fence.slice(0, 70))}`);
      }
    }
  });
});

test('Stubs never rewrites code in a User message or a final answer, even when it repeats earlier output', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `def handler_${i}(request): return validate(request, limit=${i * 7})`);
  const code = fenced(lines.join('\n'), 'python');
  const raw = [
    '# Branch',
    `## 👤 User\n\nHere is the file:\n\n${code}\n\nplease review it`,
    `## 🤖 Assistant\n\n#### Used Read src/widget.py 5ms\n\n${fenced(lines.join('\n'))}\n\nLooks fine. Here it is again:\n\n${code}\n\nDone.`,
  ].join('\n\n');
  const index = P.buildMarkdownIndex(raw);
  for (const mode of MODES) {
    const { markdown } = P.compressIndex(index, { mode });
    assert.equal(markdown.split(code).length - 1, 2, `${mode}: both quotes of the code are intact`);
    assert.ok(markdown.includes('please review it') && markdown.endsWith('Done.'), mode);
    assert.doesNotMatch(markdown, /identical to lines/, mode);
  }
  // The Read output on its own is still a legitimate source: nothing in this transcript repeats it as tool output.
  assert.equal(P.compressIndex(index, { mode: 'stubs' }).stats.stubbed, 0);
});

test('a tool card pasted into a User message is never linked, anchored or clipped', () => {
  const log = Array.from({ length: 140 }, (_, i) => `build step ${i} finished ${'ok'.repeat(10)}`).join('\n');
  const card = `**stdout:**\n\n${fenced(log)}`;
  const raw = [
    '## 👤 User',
    `This is what the build printed:\n\n${card}\n\nWhy is it slow?`,
    '## 🤖 Assistant',
    `#### used Bash 90ms\n\n${card}`,
    `#### used Bash 91ms\n\n${card}`,
    'It prints one line per step.',
  ].join('\n\n');
  const pasted = `This is what the build printed:\n\n${card}\n\nWhy is it slow?`;
  for (const mode of MODES) {
    const result = P.compressMarkdown(raw, { mode });
    assert.ok(result.markdown.includes(pasted), `${mode}: the message is intact`);
    assert.ok(result.markdown.endsWith('It prints one line per step.'), mode);
    if (mode !== 'off') assert.ok(result.bytes < result.baselineBytes, `${mode}: the tool output itself still shrinks`);
  }
  assert.equal(P.compressMarkdown(raw, { mode: 'lossless' }).stats.deduplicated, 1, 'the two tool cards still link to each other');
});

test('token deltas of span edits are exact when the edits sit between whitespace, and refused otherwise', () => {
  let seed = 4242;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const atoms = ['alpha', 'x', 'Привет', '漢字かな', '한국어', '🌍', '12345', 'snake_case', '!?', '...', 'é', '́'];
  const gaps = [' ', '\n', '  ', '\t', ' ', ''];
  const piece = () => atoms[Math.floor(random() * atoms.length)] + (random() < 0.5 ? atoms[Math.floor(random() * atoms.length)] : '');
  let exact = 0, refused = 0;
  for (let run = 0; run < 600; run++) {
    let raw = '';
    for (let i = 0, n = 6 + Math.floor(random() * 20); i < n; i++) raw += piece() + gaps[Math.floor(random() * gaps.length)];
    // Half of the runs put every edit between whitespace; the others cut at arbitrary offsets.
    const aligned = random() < 0.5;
    const isGap = index => index <= 0 || index >= raw.length || /\s/u.test(raw[index - 1]) || /\s/u.test(raw[index]);
    const edits = [];
    let at = 0;
    while (at < raw.length && edits.length < 4) {
      let start = at + Math.floor(random() * 12), end = start + Math.floor(random() * 14);
      if (aligned) {
        while (start < raw.length && !(start === 0 || /\s/u.test(raw[start - 1]))) start++;
        end = Math.max(end, start);
        while (end < raw.length && !/\s/u.test(raw[end])) end++;
      }
      if (end > raw.length || (aligned && !isGap(start))) break;
      edits.push({ start, end, text: random() < 0.2 ? '' : piece() + gaps[Math.floor(random() * gaps.length)] + piece() });
      at = end + 1 + Math.floor(random() * 3);
    }
    const delta = P.spanTokenDelta(raw, edits);
    if (delta === null) { refused++; continue; }
    let next = '', last = 0;
    for (const edit of [...edits].sort((a, b) => a.start - b.start)) { next += raw.slice(last, edit.start) + edit.text; last = edit.end; }
    next += raw.slice(last);
    assert.equal(P.measureMarkdown(next).estimatedTokens - P.measureMarkdown(raw).estimatedTokens, delta, JSON.stringify({ raw, edits }));
    exact++;
  }
  assert.ok(exact > 50 && refused > 50, `${exact} exact, ${refused} refused`);
  assert.equal(P.spanTokenDelta('foo bar', [{ start: 1, end: 2, text: 'xyz' }]), null, 'a neighbour that could join the chunk');
  assert.equal(P.spanTokenDelta('a b c', [{ start: 0, end: 2, text: '' }, { start: 2, end: 3, text: 'z' }]), null, 'touching edits');
  assert.equal(P.spanTokenDelta('one two three', [{ start: 4, end: 7, text: 'twelve' }]), P.measureMarkdown('one twelve three').estimatedTokens - P.measureMarkdown('one two three').estimatedTokens);
});

test('bare fences are Stubs candidates only as tool output: under an activity heading or a file card', () => {
  const lines = Array.from({ length: 24 }, (_, i) => `line ${i} of the shared body ${'z'.repeat(20)}`);
  const body = lines.join('\n');
  const tool = [`#### Used Read a.ts 4ms\n\n${fenced(body)}`, `#### Used Read b.ts 4ms\n\n${fenced(body)}`].join('\n\n');
  assert.equal(P.compressMarkdown(tool, { mode: 'stubs' }).stats.stubbed, 1, 'two reads under activity headings link');

  const card = `**📄 config.ts** _(TS)_\n\n${fenced(body, 'ts')}\n\n#### Used Read b.ts 4ms\n\n${fenced(body)}`;
  assert.equal(P.compressMarkdown(card, { mode: 'stubs' }).stats.stubbed, 1, 'a file card and a read link');

  const shapes = {
    'under a prose heading': `### Summary\n\n${fenced(body)}\n\n#### Used Read b.ts 4ms\n\n${fenced(body)}`,
    'after a paragraph': `The file reads:\n\n${fenced(body)}\n\n#### Used Read b.ts 4ms\n\n${fenced(body)}`,
    'with a language': `#### Used Read a.ts 4ms\n\n${fenced(body, 'ts')}\n\n#### Used Read b.ts 4ms\n\n${fenced(body)}`,
    'after a Thought heading': `#### Thought for 3s\n\n${fenced(body)}\n\n#### Used Read b.ts 4ms\n\n${fenced(body)}`,
  };
  for (const [name, raw] of Object.entries(shapes)) {
    const result = P.compressMarkdown(raw, { mode: 'stubs', condenseThoughts: false });
    assert.equal(result.stats.stubbed, 0, name);
    assert.doesNotMatch(result.markdown, /arex-stubs-output|identical to lines/, name);
  }
});

test('Lossless anchors the first copy untouched and every reference expands back to the original document', () => {
  eachSample(({ seed, raw, index, results }) => {
    const output = results.lossless.markdown;
    const anchored = [...output.matchAll(/<a id="arex-output-(\d+)"><\/a>\n/g)];
    const references = [...output.matchAll(/_Identical to \[output #(\d+)\]\(#arex-output-\1\) — byte-for-byte match\._/g)];
    assert.equal(references.length, results.lossless.stats.deduplicated, `transcript ${seed}: reference count`);
    assert.equal(new Set(anchored.map(match => match[1])).size, anchored.length, `transcript ${seed}: anchors are unique`);
    for (const reference of references) assert.ok(anchored.some(match => match[1] === reference[1]), `transcript ${seed}: #${reference[1]} resolves`);

    // Undo the edits: drop the anchors and put each duplicate's original block back, in document order.
    const duplicates = [];
    const firstBody = new Set();
    for (const block of index.blocks) {
      if (block.label === 'command' || (!block.label && !block.fileName) || block.bytes < 128) continue;
      if (firstBody.has(block.body)) duplicates.push(raw.slice(block.startOffset, block.endOffset)); else firstBody.add(block.body);
    }
    if (!references.length) return assert.equal(output, raw, `transcript ${seed}: nothing to link, nothing changes`);
    assert.equal(duplicates.length, references.length, `transcript ${seed}: one reference per duplicate`);
    let next = 0;
    const restored = output
      .replace(/<a id="arex-output-\d+"><\/a>\n/g, '')
      .replace(/_Identical to \[output #\d+\]\(#arex-output-\d+\) — byte-for-byte match\._/g, () => duplicates[next++]);
    assert.equal(restored, raw, `transcript ${seed}: the original is recoverable byte for byte`);
  });
});

test('Smart and Stubs never drop an execution diagnostic or shorten failing output', () => {
  const DIAGNOSTIC = /^(?:Traceback \(most recent call last\):|\s+File ".*", line \d+|[A-Za-z]*Error: .*|E {3}.*|FAILED .*|=== FAILURES ===|npm ERR!.*|cat: .*No such file.*|src\/a\.c:\d+:\d+: error:.*)$/;
  let checked = 0;
  eachSample(({ seed, index, results }) => {
    const diagnostics = [];
    for (const block of index.blocks) {
      if (block.label !== 'stdout' && block.label !== 'stderr') continue;
      for (const line of block.body.split('\n')) if (DIAGNOSTIC.test(line)) diagnostics.push(line);
    }
    for (const mode of ['smart', 'stubs']) {
      const lines = new Set(results[mode].markdown.split('\n'));
      for (const line of diagnostics) { checked++; assert.ok(lines.has(line), `transcript ${seed} ${mode}: lost ${JSON.stringify(line)}`); }
    }
    // A failing run (exit heading) or one with stderr keeps its whole output, bar terminal noise and passing runs.
    for (const block of index.blocks) {
      if (block.label !== 'stdout' && block.label !== 'stderr') continue;
      const failing = /\bexit\s+[1-9]/.test(block.activity) || block.label === 'stderr' || block.pairedCommand?.hasStderr;
      const lines = P.stripTerminalNoise(block.body).split('\n');
      if (!failing || lines.length > 100 || lines.some(line => /\[ *\d+%\]$/.test(line))) continue;
      for (const mode of ['smart', 'stubs']) {
        const kept = new Set(results[mode].markdown.split('\n'));
        for (const line of lines) assert.ok(kept.has(line), `transcript ${seed} ${mode}: failing output lost ${JSON.stringify(line.slice(0, 60))}`);
      }
    }
  });
  assert.ok(checked > 200, 'the corpus carries plenty of diagnostics');
});

test('every Stubs and draft reference points at an earlier anchor, inside the source, at lines the Smart output repeats', () => {
  let stubs = 0, drafts = 0;
  const sourceOf = (markdown, id) => {
    const anchor = `<a id="${id}"></a>\n`;
    const at = markdown.indexOf(anchor);
    assert.ok(at >= 0, 'anchor ' + id);
    assert.equal(markdown.indexOf(anchor, at + 1), -1, 'anchor ' + id + ' is unique');
    const after = markdown.slice(at + anchor.length).replace(/^(?:<a id="[^"]+"><\/a>\n)+/, '');
    const open = /^\s*(`{3,}|~{3,})[^\n]*\n/.exec(after);
    assert.ok(open, 'anchor ' + id + ' sits above a fence');
    return { at, lines: after.slice(open[0].length, after.indexOf('\n' + open[1], open[0].length)).split('\n') };
  };
  eachSample(({ seed, results, kept }) => {
    const smart = kept.smart.markdown;
    for (const mode of ['smart', 'stubs']) {
      const markdown = results[mode].markdown;
      if (mode === 'smart') assert.doesNotMatch(markdown, /arex-stubs-output/, `transcript ${seed}: Smart has no Stubs markers`);
      for (const match of markdown.matchAll(/\[\.\.\. identical to lines (\d+)–(\d+) of earlier output #(arex-stubs-output-\d+)( \(excluding line numbers\))? \.\.\.\]/g)) {
        stubs++;
        const { at, lines } = sourceOf(markdown, match[3]);
        const [from, to] = [Number(match[1]), Number(match[2])];
        assert.ok(at < match.index, `transcript ${seed}: ${match[3]} is earlier than its reference`);
        assert.ok(from >= 1 && to >= from && to <= lines.length, `transcript ${seed}: lines ${from}–${to} of ${lines.length}`);
        if (!match[4]) assert.ok(smart.split(lines.slice(from - 1, to).join('\n')).length - 1 >= 2, `transcript ${seed}: the range is repeated`);
      }
      for (const match of markdown.matchAll(/\[\.\.\. draft identical to lines (\d+)–(\d+) of later output #(arex-stubs-output-\d+) \.\.\.\]/g)) {
        drafts++;
        const { at, lines } = sourceOf(markdown, match[3]);
        const [from, to] = [Number(match[1]), Number(match[2])];
        assert.ok(at > match.index, `transcript ${seed}: ${match[3]} is later than its draft`);
        assert.ok(from >= 1 && to >= from && to <= lines.length, `transcript ${seed}: draft lines ${from}–${to} of ${lines.length}`);
        assert.ok(smart.split(lines.slice(from - 1, to).join('\n')).length - 1 >= 2, `transcript ${seed}: the draft is repeated`);
      }
    }
  });
  assert.ok(stubs > 100 && drafts > 20, `the corpus has ${stubs} Stubs and ${drafts} draft references`);
});

test('with the toggle off every Thought is exactly as exported, and only Smart and Stubs react to it', () => {
  eachSample(({ seed, raw, doc, index, results, kept }) => {
    const thoughts = doc.sections.filter(section => section.kind === 'thought').map(section => raw.slice(section.startOffset, section.endOffset));
    for (const mode of ['smart', 'stubs']) {
      for (const thought of thoughts) assert.ok(kept[mode].markdown.includes(thought), `transcript ${seed} ${mode}: a Thought changed with the toggle off`);
      assert.equal(kept[mode].stats.thoughtsCondensed, undefined, `${mode}: the stage did not run`);
    }
    for (const mode of ['off', 'lossless']) {
      assert.equal(P.compressIndex(index, { mode, condenseThoughts: true }).markdown, results[mode].markdown, `${mode} ignores the toggle`);
    }
    assert.equal(P.compressIndex(index, { mode: 'stubs' }).markdown, results.stubs.markdown, `transcript ${seed}: deterministic`);
  });
});

test('the reasoning stage runs last: applying it to the shared base gives the integrated result', () => {
  eachSample(({ seed, results, kept }) => {
    for (const mode of ['smart', 'stubs']) {
      const applied = P.applyThoughtCondensation(kept[mode], { mode, condenseThoughts: true });
      assert.equal(applied.markdown, results[mode].markdown, `transcript ${seed} ${mode}`);
      assert.equal(applied.bytes, results[mode].bytes);
      assert.equal(applied.estimatedTokens, results[mode].estimatedTokens);
      // A second application leaves the result, and the counters that describe it, alone.
      const again = P.applyThoughtCondensation(results[mode], { mode, condenseThoughts: true });
      assert.equal(again.markdown, results[mode].markdown);
      assert.equal(again.stats.thoughtsCondensed, results[mode].stats.thoughtsCondensed);
    }
  });
});

test('Stubs links overlapping reads before its tighter budget can clip the source', () => {
  const source = Array.from({ length: 60 }, (_, i) => `source line ${i} = 'abcdefghijk'`);
  const first = source.slice(0, 40).join('\n');
  const second = source.slice(10, 40).join('\n') + '\nONLY_SECOND';
  const run = (command, output) => `#### used Bash 1ms\n\n**command:**\n\n${fenced(command, 'bash')}\n\n**stdout:**\n\n${fenced(output)}`;
  const raw = [run('$ sed -n 1,40p service.py', first), run('$ sed -n 11,40p service.py', second)].join('\n\n');
  const smart = P.compressMarkdown(raw, { mode: 'smart' });
  const stubs = P.compressMarkdown(raw, { mode: 'stubs' });
  assert.equal(stubs.stats.stubbed, 1);
  assert.ok(stubs.bytes < smart.bytes);
  for (const line of source.slice(0, 40)) assert.equal(stubs.markdown.split(line).length - 1, 1, 'the source keeps every line exactly once: ' + line);
  assert.match(stubs.markdown, /ONLY_SECOND/);
  assert.match(stubs.markdown, /identical to lines 11–40 of earlier output #arex-stubs-output-1/);
});

test('without the optional modules each mode keeps its earlier behaviour', () => {
  const load = files => {
    const context = vm.createContext({ TextEncoder });
    for (const file of files) vm.runInContext(extensionFile('content/' + file), context, { filename: file });
    return context.AREX;
  };
  const noisy = Array.from({ length: 140 }, (_, i) => `row ${i} ${'x'.repeat(30)}`).join('\n');
  const passes = Array.from({ length: 12 }, (_, i) => `✓ suite > test-${i} [1.00ms]`).join('\n');
  const raw = `#### used Bash 1ms\n\n${outputBlock(noisy)}\n\n#### used Bash 2ms\n\n${outputBlock(passes)}`;
  for (const files of [['compress.js'], ['compress-index.js', 'compress.js'], ['compress-index.js', 'compress-framing.js', 'compress.js', 'compress-stubs.js']]) {
    const arex = load(files);
    const index = arex.buildMarkdownIndex(raw);
    const results = MODES.map(mode => arex.compressIndex(index, { mode }));
    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].bytes, utf8(results[i].markdown), files.join('+') + ' ' + MODES[i]);
      assert.ok(i === 0 || results[i].bytes <= results[i - 1].bytes, files.join('+') + ' monotonic');
    }
    assert.match(results[2].markdown, /omitted \d+ middle lines/, files.join('+') + ': the earlier clip still runs');
    assert.match(results[2].markdown, /collapsed 12 passing test lines/, files.join('+'));
    assert.equal(results[3].stats.thoughtsCondensed, undefined, files.join('+') + ': no reasoning stage');
  }
  // The whole bundle shrinks the same input further.
  const full = P.compressMarkdown(raw, { mode: 'smart' });
  assert.ok(full.bytes < load(['compress.js']).compressMarkdown(raw, { mode: 'smart' }).bytes);
});

test('a broken optional stage degrades to the previous stage instead of failing the preview', () => {
  const rows = tag => Array.from({ length: 140 }, (_, i) => `${tag} ${i} ${'x'.repeat(30)}`).join('\n');
  const heredoc = lines => `#### used Bash 3ms\n\n**command:**\n\n${fenced(`$ cat > a.py <<'EOF'\n${lines}\nEOF`, 'bash')}\n\n**stdout:**\n\n${fenced('(no output)')}`;
  const body = Array.from({ length: 30 }, (_, i) => `def handler_${i}(request): return validate(request, limit=${i * 7})`).join('\n');
  const raw = [
    '## 👤 User\n\nplease do it', '## 🤖 Assistant',
    `#### Thought for 5s\n\n${['a', 'b', 'c', 'd', 'e', 'f'].map(tag => tag.repeat(400)).join('\n\n')}`,
    `#### used Bash 1ms\n\n${outputBlock(rows('first'))}`, `#### used Bash 2ms\n\n${outputBlock(rows('second'))}`,
    heredoc(body), heredoc(body), 'All done.',
  ].join('\n\n');
  const index = P.buildMarkdownIndex(raw);
  const run = (mode, stage) => {
    const original = P[stage];
    P[stage] = stage ? () => { throw new Error('boom'); } : original;
    try { return P.compressIndex(index, { mode }); } finally { P[stage] = original; }
  };
  const whole = P.compressIndex(index, { mode: 'stubs' });
  assert.ok(whole.stats.stubbed > 0 && whole.stats.thoughtsCondensed > 0, 'the sample reaches every stage');
  const lossless = P.compressIndex(index, { mode: 'lossless' });
  for (const stage of ['compactFraming', 'compactCommands', 'compressStubs', 'applyThoughtCondensation', 'compactStdoutBlock',
    'analyzeExecutionDiagnostics', 'collapsePassingRuns', 'stripTerminalNoise', 'buildDocumentIndex']) {
    for (const mode of ['smart', 'stubs']) {
      const result = run(mode, stage);
      assert.equal(result.bytes, utf8(result.markdown), `${mode} without ${stage}: bytes`);
      assert.equal(result.estimatedTokens, P.measureMarkdown(result.markdown).estimatedTokens, `${mode} without ${stage}: tokens`);
      assert.ok(result.bytes <= lossless.bytes, `${mode} without ${stage}: still no larger than Lossless`);
    }
  }
  // Losing the log module hands the clip back to the earlier implementation, which still shortens long output.
  assert.match(run('smart', 'compactStdoutBlock').markdown, /omitted \d+ middle lines \(exit status not reported/);
  // Losing the indexer fails closed: nothing that could touch protected text is edited.
  assert.equal(run('stubs', 'buildDocumentIndex').markdown, raw);
});

