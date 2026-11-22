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

test('Compact Stubs handles ordinary Read activity blocks without file-chip labels', () => {
  const { AREX, dom } = makeEnv();
  const nl = String.fromCharCode(10);
  const oldBody = Array.from({ length: 60 }, (_, i) => 'export const OLD_' + i + ' = ' + i + ';').join(nl);
  const newBody = Array.from({ length: 60 }, (_, i) => 'export const NEW_' + i + ' = ' + i + ';').join(nl);
  const read = (body, elapsed) => '#### used Read src/config.ts ' + elapsed + 'ms' + nl + nl + fenced(body, 'text');
  const raw = read(oldBody, 12) + nl + nl + read(newBody, 19);
  const smart = AREX.compressMarkdown(raw, { mode: 'smart' });
  const stubs = AREX.compressMarkdown(raw, { mode: 'stubs' });

  assert.equal(stubs.stats.stubbed, 1);
  assert.ok(stubs.markdown.includes('compact stub: earlier read of src/config.ts'));
  assert.match(stubs.markdown, /NEW_59/);
  assert.doesNotMatch(stubs.markdown, /OLD_59/);
  assert.ok(stubs.bytes < smart.bytes);
  assert.ok(stubs.bytes < stubs.baselineBytes);
  dom.window.close();
});

test('Compact Stubs also recognises file artifact cards', () => {
  const { AREX, dom } = makeEnv();
  const nl = String.fromCharCode(10);
  const filename = name => '**📄 ' + name + '** _(TS)_' + nl + nl;
  const oldBody = Array.from({ length: 60 }, (_, i) => 'export const OLD_' + i + ' = ' + i + ';').join(nl);
  const newBody = Array.from({ length: 60 }, (_, i) => 'export const NEW_' + i + ' = ' + i + ';').join(nl);
  const raw = filename('config.ts') + fenced(oldBody, 'ts') + nl + nl +
    filename('config.ts') + fenced(newBody, 'ts');
  const result = AREX.compressMarkdown(raw, { mode: 'stubs' });
  assert.equal(result.stats.stubbed, 1);
  assert.ok(result.markdown.includes('compact stub: earlier read of config.ts'));
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
  assert.equal(results[3].stats.stubbed, 1);
  assert.match(results[3].markdown, /earlier read of service\.py/);
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

test('Stubs abbreviates only earlier overwrites of the same heredoc target', () => {
  const { AREX } = makeEnv();
  const body = word => Array.from({ length: 90 }, (_, i) => `${word}_line_${i} = ${i}`).join('\n');
  const write = (path, word, cwd = '/repo') => `#### used Bash 1ms\n\n**command:**\n\n${fenced(`$ cd ${cwd} && cat > ${path} << 'PY'\n${body(word)}\nPY`, 'bash')}`;
  const raw = [write('file.py', 'OLD'), write('file.py', 'NEW'), write('file.py', 'OTHER', '/other')].join('\n\n');
  const result = AREX.compressMarkdown(raw, { mode: 'stubs' });
  assert.equal(result.stats.stubbed, 1);
  assert.match(result.markdown, /earlier write of file\.py/);
  assert.doesNotMatch(result.markdown, /OLD_line_89/);
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
