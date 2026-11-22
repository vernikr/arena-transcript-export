// Export remains available while Arena exposes its active-generation control.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './harness.mjs';

test('exports the currently rendered transcript while the agent is generating', async () => {
  const { AREX, document } = makeEnv({
    html: `<div role="log">
      <div data-agent-transcript-message data-chat-message-id="m1">
        <div class="prose">Current reasoning in progress</div>
        <button aria-label="Stop generating">Stop</button>
      </div>
    </div>`,
  });

  assert.ok(document.querySelector('button[aria-label="Stop generating"]'));
  AREX.loadFullHistory = async () => ({ messages: 1, stable: true, pages: 0 });
  AREX.expandAllSpoilers = async () => ({ expanded: 0, stuck: [] });
  AREX.settle = async () => {};

  const result = await AREX.runExport();

  assert.match(result.markdown, /Current reasoning in progress/);
  assert.equal(result.stats.messages, 1);
  assert.equal(AREX._running, false);
});
