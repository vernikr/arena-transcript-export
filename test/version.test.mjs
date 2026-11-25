import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => JSON.parse(readFileSync(new URL('../' + name, import.meta.url), 'utf8'));
const readText = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
// Every runtime version literal must follow the package version; these patterns
// fail loudly (as a test error) if a constant is renamed out from under them.
const literal = (source, pattern, label) => {
  const match = source.match(pattern);
  assert.ok(match, `${label} not found — update this test together with the rename`);
  return match[1];
};

test('extension manifest and npm package versions stay in sync', () => {
  const manifest = read('extension/manifest.json');
  const pkg = read('package.json');
  const lock = read('package-lock.json');
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});

test('content <-> background feature handshake and profile tool version match the package version', () => {
  const { version } = read('package.json');
  // background.js gates re-injection on this exact string when a tab answers AREX_PING.
  const background = readText('extension/background.js');
  assert.equal(literal(background, /const CONTENT_FEATURE_VERSION = '([^']+)';/, 'background.js CONTENT_FEATURE_VERSION'), version);
  // main.js reports the same string in the AREX_PING readiness reply and records
  // it as the profiler toolVersion of every export.
  const main = readText('extension/content/main.js');
  assert.equal(literal(main, /toolVersion: '([^']+)'/, 'main.js toolVersion'), version);
  assert.equal(literal(main, /featureVersion: '([^']+)'/, 'main.js featureVersion'), version);
});

test('cross-cutting npm scripts exist and point at committed entry points', () => {
  const { scripts } = read('package.json');
  assert.equal(scripts.test, 'node --test test/*.test.mjs');
  assert.equal(scripts.benchmark, 'node scripts/benchmark.mjs');
  assert.equal(scripts['benchmark:archive'], 'node --expose-gc scripts/benchmark-archive.mjs');
  // Wave 4.1 wires the large-page stress benchmark in package.json (Wave 3.3
  // owns only the script itself).
  assert.equal(scripts['benchmark:large'], 'node --expose-gc scripts/benchmark-large-page.mjs');
  for (const script of Object.values(scripts)) {
    const entry = script.match(/scripts\/[\w.-]+\.mjs/)?.[0];
    if (!entry) continue;
    assert.doesNotThrow(() => readText(entry), `${entry} referenced by package.json is missing`);
  }
});
