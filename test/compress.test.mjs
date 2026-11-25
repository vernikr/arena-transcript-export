import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './harness.mjs';

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
