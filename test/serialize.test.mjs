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

// Real Arena panels use a shared flex container for several cards and may
// append further output chunks directly or in single-pre wrappers.
test('Bash continuation chunks keep their stream labels in both serializers', async () => {
  const chunk1 = 'A'.repeat(10240) + ' end';
  const chunk2 = 'B'.repeat(10240) + ' tail';
  const html = `<div role="log"><div data-agent-transcript-message data-chat-message-id="chunks">
    <div><button aria-expanded="true">Used Bash 100ms</button><div style="overflow: clip">
      <div class="flex flex-col gap-2">
        <div class="bg-surface-secondary"><div><span>command</span></div><div><pre>$ make</pre></div></div>
        <div class="bg-surface-secondary"><div><span>stdout</span></div><div><pre>start</pre></div></div>
        <pre>${chunk1}</pre><div><div><pre>${chunk2}</pre></div></div>
        <div class="bg-surface-secondary"><div><span>stderr</span></div><div><pre>warning</pre></div></div>
        <pre>stderr continuation</pre>
        <div class="bg-surface-secondary"><div><span>command</span></div><div><pre>$ next</pre></div></div>
        <pre>not a command</pre>
      </div>
    </div></div></div></div>`;
  const { AREX, document, dom } = makeEnv({ html });
  const message = AREX.messages(document.querySelector('[role=log]'))[0];
  const expected = '## 🤖 Assistant\n\n#### Used Bash 100ms\n\n'
    + '**command:**\n\n```bash\n$ make\n```\n\n'
    + '**stdout:**\n\n```text\nstart\n```\n\n'
    + `**stdout:**\n\n\`\`\`text\n${chunk1}\n\`\`\`\n\n`
    + `**stdout:**\n\n\`\`\`text\n${chunk2}\n\`\`\`\n\n`
    + '**stderr:**\n\n```text\nwarning\n```\n\n'
    + '**stderr:**\n\n```text\nstderr continuation\n```\n\n'
    + '**command:**\n\n```bash\n$ next\n```\n\n```text\nnot a command\n```';
  assert.equal(AREX.serializeMessage(message), expected);
  assert.equal(await AREX.serializeMessageAsync(message, {}, 0), expected);
  assert.ok(AREX.serialize(AREX.logEl()).endsWith(expected + '\n'));
  dom.window.close();
});

test('labels do not leak across siblings, non-Bash panels, or intervening content', async () => {
  const html = `<div role="log"><div data-agent-transcript-message data-chat-message-id="scope">
    <div><button aria-expanded="true">Used Bash</button><div style="overflow: clip"><div>
      <div><span>command</span><pre>$ test</pre></div><pre>orphan</pre>
      <div><span>stdout</span><pre>first</pre></div><div>interruption</div><pre>after interruption</pre>
      <div><span>stdout</span><pre>contains <span>command</span> here</pre><pre>same card</pre></div>
    </div></div></div>
    <div><button aria-expanded="true">Other tool</button><div style="overflow: clip"><div>
      <div><span>stdout</span><pre>other output</pre></div><pre>other orphan</pre>
    </div></div></div>
    <pre>outside</pre>
  </div></div>`;
  const { AREX, document, dom } = makeEnv({ html });
  const message = AREX.messages(document.querySelector('[role=log]'))[0];
  const sync = AREX.serializeMessage(message);
  assert.equal(await AREX.serializeMessageAsync(message, {}, 0), sync);
  assert.match(sync, /\*\*command:\*\*\n\n```bash\n\$ test\n```\n\n```text\norphan\n```/);
  assert.match(sync, /```text\nafter interruption\n```/);
  assert.doesNotMatch(sync, /\*\*(?:stdout|command):\*\*\n\n```(?:text|bash)\nafter interruption/);
  assert.match(sync, /\*\*stdout:\*\*\n\n```text\nsame card\n```/);
  assert.match(sync, /\*\*stdout:\*\*\n\n```text\nother output\n```\n\n```text\nother orphan\n```/);
  assert.doesNotMatch(sync, /\*\*(?:stdout|stderr|command):\*\*\n\n```(?:text|bash)\noutside/);
  dom.window.close();
});
