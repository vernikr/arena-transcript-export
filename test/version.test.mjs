import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => JSON.parse(readFileSync(new URL('../' + name, import.meta.url), 'utf8'));

test('extension manifest and npm package versions stay in sync', () => {
  const manifest = read('extension/manifest.json');
  const pkg = read('package.json');
  const lock = read('package-lock.json');
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});
