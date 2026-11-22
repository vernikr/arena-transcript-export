import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeEnv, fixtureHtml } from './harness.mjs';

const normal = text => text.replace(/^- Exported: .*$/m, '- Exported: <ts>');
const url = 'https://arena.ai/agent/01a125f9-92b4-7e1a-a13a-b2e1bc5ffd61';
const expected = readFileSync(new URL('./snapshots/fixture-expected.md', import.meta.url), 'utf8');

test('synchronous and windowed serializers match the fixture byte for byte', async () => {
  const { AREX, dom } = makeEnv({ html: fixtureHtml(), url });
  const sync = normal(AREX.serialize(AREX.logEl()));
  const windowed = normal((await AREX.processMessagesInWindows(AREX.logEl())).markdown);
  assert.deepEqual(Buffer.from(sync), Buffer.from(expected));
  assert.deepEqual(Buffer.from(windowed), Buffer.from(expected));
  dom.window.close();
});

test('synchronous and windowed serializers agree byte-for-byte for each export option', async () => {
  for (const options of [{ timestamps: true }, { includeToolActivity: false }, { timestamps: true, includeToolActivity: false }]) {
    const { AREX, dom } = makeEnv({ html: fixtureHtml(), url });
    const sync = normal(AREX.serialize(AREX.logEl(), options));
    const windowed = normal((await AREX.processMessagesInWindows(AREX.logEl(), options)).markdown);
    assert.deepEqual(Buffer.from(windowed), Buffer.from(sync), JSON.stringify(options));
    dom.window.close();
  }
});
