// Option gating of export warnings: the "spoiler(s) stayed collapsed" warning must fire only
// when spoiler expansion was requested (checkbox on). Users opting out must not be warned
// about the collapsed spoilers they intentionally skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './harness.mjs';

function exportWith(options) {
  const { AREX } = makeEnv({
    html: `<div role="log"><div class="max-w-3xl">
      <div data-agent-transcript-message data-chat-message-id="m1"><div class="prose">msg 1</div></div>
      <button aria-expanded="false">spoiler</button>
    </div></div>`,
  });
  let expandCalls = 0;
  AREX.loadFullHistory = async () => ({ messages: 1, stable: true, pages: 0 });
  AREX.expandAllSpoilers = async () => { expandCalls++; return { expanded: 0, stuck: [] }; };
  AREX.settle = async () => { };
  return AREX.runExport(options).then(result => ({ result, expandCalls }));
}

test('collapsed-spoiler warning fires when expansion is on (default)', async () => {
  const { result, expandCalls } = await exportWith({});
  assert.equal(expandCalls, 1);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /1 spoiler\(s\) stayed collapsed/);
});

test('no warnings and no expansion when tool activity is opted out', async () => {
  const { result, expandCalls } = await exportWith({ includeToolActivity: false });
  assert.equal(expandCalls, 0);
  assert.equal(result.warnings.length, 0); // vm-realm array: structural deepEqual would be cross-realm
});
