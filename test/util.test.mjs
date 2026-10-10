import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './harness.mjs';

const { AREX } = makeEnv();

test('dedupeTitle collapses tooltip-duplicated titles', () => {
  assert.equal(AREX.dedupeTitle('Рефакторинг research WorkspaceРефакторинг research Workspace'),
    'Рефакторинг research Workspace');
  assert.equal(AREX.dedupeTitle('abcabc'), 'abc');
  assert.equal(AREX.dedupeTitle('haha'), 'haha');          // 2-char unit: false positive guard
  assert.equal(AREX.dedupeTitle('Обычный заголовок'), 'Обычный заголовок');
});

test('chatTitle dedupes topbar text, falls back to uuid', () => {
  const env = makeEnv({
    html: '<div class="absolute start-0 top-0 z-20"><span>My BranchMy Branch</span></div>',
    url: 'https://arena.ai/agent/2a6c2b7b-1234',
  });
  assert.equal(env.AREX.chatTitle(), 'My Branch');
  const bare = makeEnv({ html: '' });
  assert.equal(bare.AREX.chatTitle(), 'u-1');
});
