import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { makeEnv, fixtureHtml } from './harness.mjs';

const SNAPSHOT = new URL('./snapshots/fixture-expected.md', import.meta.url);
// The meta header embeds wall-clock time; strip it for comparisons.
const normalize = md => md.trim().replace(/^- Exported: .*$/m, '- Exported: <ts>');

function exported(opts = {}) {
  const { AREX } = makeEnv({
    html: fixtureHtml(),
    url: 'https://arena.ai/agent/01a125f9-92b4-7e1a-a13a-b2e1bc5ffd61',
  });
  return AREX.serialize(AREX.logEl(), opts);
}

const md = exported();

// Regenerate: UPDATE_SNAPSHOT=1 npm test
if (process.env.UPDATE_SNAPSHOT) writeFileSync(SNAPSHOT, normalize(md) + '\n');

test('fixture converts to the committed snapshot', () => {
  assert.ok(existsSync(SNAPSHOT), 'run UPDATE_SNAPSHOT=1 npm test first');
  assert.equal(normalize(md), readFileSync(SNAPSHOT, 'utf8').trim());
});

test('message count and role headings', () => {
  assert.equal((md.match(/^## 👤 User$/gm) || []).length, 4);
  assert.equal((md.match(/^## 🤖 Assistant$/gm) || []).length, 5);
  assert.match(md, /^- Messages: 9$/m);
  assert.match(md, /^- Source: https:\/\/arena\.ai\/agent\/01a125f9/m);
});

test('attachments and user prose', () => {
  assert.match(md, /📎 \*\*Attached:\*\* AGENTS\.md, server-spec\.md/);
  assert.match(md, /Проанализируй проект/);
  assert.match(md, /- Устрани скрытые баги и непокрытые edge cases\./);
});

test('tool activity: headers, fences, labels', () => {
  assert.match(md, /^#### used Bash 143ms/m);
  assert.match(md, /\*\*command:\*\*\n\n```bash\n\$ ls -la \/home\/user/);
  assert.match(md, /\*\*stdout:\*\*\n\n```text\n\/home\/user:/);
  assert.match(md, /^#### Ran commands 6/m);
  assert.match(md, /^- Read AGENTS\.md/m);
});

test('nested spoiler content stays nested', () => {
  assert.match(md, /^#### Ran commands 81/m);
  assert.match(md, /^##### used Bash exit 128 238ms/m);
  assert.match(md, /\*\*stderr:\*\*/);
});

test('file chips and artifact documents', () => {
  assert.match(md, /\*\*📄 report-check\.sh\*\* _\(SHELLSCRIPT\)_/);
  assert.match(md, /\*\*📄 ci\.yml\*\* _\(YAML\)_/);
  assert.match(md, /\*\*📄 Comprehensive Refactoring Plan: Research Workspace\*\* _\(MD\)_\n\n# Comprehensive Refactoring Plan/);
  assert.match(md, /^- Write docs\/worklog\/2026\.10\.10-refactoring-plan\/plan\.md 285 lines$/m);
});

test('assistant prose passes through converter (tables, lists)', () => {
  assert.match(md, /^### Итог работы/m);
  assert.match(md, /\| \*\*Портативность\*\* \| 40\+ жестких путей/);
  assert.match(md, /^  - Убраны дублирующиеся блоки текста/m);
});

test('chrome residue is excluded', () => {
  assert.ok(!/hour ago/.test(md), 'footer duration must not leak');
  assert.ok(!/^Copy$/m.test(md), 'copy buttons must not leak');
  assert.ok(!md.includes('Load earlier messages'));
  assert.ok(!/\d{1,2}:\d{2} PM/.test(md), 'footer time must not leak without option');
});

test('timestamps option adds time line', () => {
  const withTs = exported({ timestamps: true });
  assert.match(withTs, /## 🤖 Assistant {2}\n_4:49 PM_/);
});

test('includeToolActivity=false drops spoilers but keeps prose', () => {
  const plain = exported({ includeToolActivity: false });
  assert.ok(!/^#### used Bash/m.test(plain));
  assert.match(plain, /^### Итог работы/m);
});
