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
