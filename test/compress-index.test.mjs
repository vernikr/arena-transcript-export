import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { makeEnv } from './harness.mjs';

// The module must run unchanged in a window, a service worker and a dedicated
// Web Worker, so it only ever touches `globalThis.AREX`. The suite loads it
// both into a bare vm context (worker-like, no window/document) and into the
// jsdom window used by the other suites (window-like, alongside compress.js).
const SRC = readFileSync(new URL('../extension/content/compress-index.js', import.meta.url), 'utf8');

function loadCompressIndexBare() {
  const ctx = vm.createContext({});
  vm.runInContext(SRC, ctx, { filename: 'compress-index.js' });
  return ctx.AREX;
}

const bt = String.fromCharCode(96); // backtick
const fence = (body, lang = 'text') => bt.repeat(3) + lang + '\n' + body + '\n' + bt.repeat(3);
const outputBlock = body => '**stdout:**\n\n' + fence(body);

test('loads in a bare worker-like context via globalThis.AREX', () => {
  const AREX = loadCompressIndexBare();
  assert.equal(typeof AREX.buildDocumentIndex, 'function');
  assert.equal(typeof AREX.applySpanEdits, 'function');
  assert.equal(typeof AREX.utf8Bytes, 'function');
  const index = AREX.buildDocumentIndex('## 👤 User\n\nhello\n');
  assert.equal(index.turns.length, 1);
  assert.equal(index.turns[0].kind, 'user');
});

test('loads into a window context alongside the existing compress.js indexer', () => {
  const { dom, AREX } = makeEnv();
  vm.runInContext(SRC, dom.getInternalVMContext(), { filename: 'compress-index.js' });
  assert.equal(typeof AREX.buildDocumentIndex, 'function');
  assert.equal(typeof AREX.applySpanEdits, 'function');
  // Coexists with the legacy block indexer without touching it.
  assert.equal(typeof AREX.buildMarkdownIndex, 'function');
  const index = AREX.buildDocumentIndex('## 🤖 Assistant\n\n#### used Bash 1ms\n\n' + outputBlock('out'));
  assert.equal(index.turns.length, 1);
  assert.equal(index.blocks.length, 1);
  dom.window.close();
});

test('parses turn boundaries with exact offsets and flags user turns immutable', () => {
  const AREX = loadCompressIndexBare();
  const md = [
    '# Session',
    '',
    '- Source: https://arena.ai/agent/u-1',
    '',
    '---',
    '',
    '## 👤 User',
    '',
    'Первый запрос.',
    '',
    '## 🤖 Assistant',
    '',
    '#### Ran commands 1',
    '',
    '_(not expanded)_',
    '',
    'Ответ.',
    '',
    '## 👤 User',
    '',
    'Второй запрос.',
    '',
  ].join('\n');
  const index = AREX.buildDocumentIndex(md);

  assert.equal(index.turns.length, 3);
  // Note: the module runs in a separate vm realm, so cross-realm deepEqual is
  // avoided; compare structurally instead (same values, different prototypes).
  assert.deepEqual([...index.turns].map(t => t.kind), ['user', 'assistant', 'user']);
  assert.deepEqual([...index.turns].map(t => t.immutable), [true, false, true]);

  // Exact offsets: each turn slice starts with its heading and ends where the
  // next turn (or EOF) begins; spans never overlap (adjacent is allowed).
  let prevEnd = -1;
  for (const turn of index.turns) {
    assert.ok(turn.startOffset >= prevEnd, 'turns must not overlap');
    prevEnd = turn.endOffset;
    const slice = md.slice(turn.startOffset, turn.endOffset);
    assert.ok(slice.startsWith('## ' + turn.heading), 'turn slice starts with its heading');
    assert.equal(md.indexOf('## ' + turn.heading, turn.startOffset === 0 ? 0 : turn.startOffset), turn.startOffset);
  }
  assert.equal(index.turns[2].endOffset, md.length);
  assert.equal(index.turns[0].startOffset, md.indexOf('## 👤 User'));
  assert.equal(index.turns[1].startOffset, md.indexOf('## 🤖 Assistant'));
  assert.equal(index.turns[2].startOffset, md.lastIndexOf('## 👤 User'));
  // The document header before the first turn is not part of any turn.
  assert.ok(index.turns[0].startOffset > 0);
});

test('isolates Thought spoiler prose from the final Assistant answer prose', () => {
  const AREX = loadCompressIndexBare();
  const md = [
    '## 🤖 Assistant',
    '',
    '#### Thought for 42s',
    '',
    'Мысль первая о рефакторинге проекта.',
    '',
    'Мысль вторая о покрытии тестами.',
    '',
    '#### used Bash 120ms',
    '',
    '**command:**',
    '',
    '```bash',
    '$ ls -la',
    '```',
    '',
    '**stdout:**',
    '',
    '```text',
    'total 0',
    '```',
    '',
    'Финальный ответ пользователю с итогами работы.',
    '',
  ].join('\n');
  const index = AREX.buildDocumentIndex(md);
  const turn = index.turns[0];
  assert.equal(turn.kind, 'assistant');
  assert.equal(turn.immutable, false);

  const thought = index.sections.find(s => s.kind === 'thought');
  assert.ok(thought, 'thought section parsed');
  const thoughtSlice = md.slice(thought.startOffset, thought.endOffset);
  assert.match(thoughtSlice, /Мысль первая о рефакторинге проекта\./);
  assert.match(thoughtSlice, /Мысль вторая о покрытии тестами\./);
  assert.equal(thought.immutable, false);

  assert.ok(turn.finalAnswer, 'final answer span present');
  assert.equal(turn.finalAnswer.immutable, true);
  const answerSlice = md.slice(turn.finalAnswer.startOffset, turn.finalAnswer.endOffset);
  assert.match(answerSlice, /Финальный ответ пользователю с итогами работы\./);
  assert.doesNotMatch(answerSlice, /Мысль/);

  // The final answer never overlaps any spoiler section span.
  for (const sec of index.sections) {
    assert.ok(turn.finalAnswer.startOffset >= sec.endOffset || turn.finalAnswer.endOffset <= sec.startOffset,
      'final answer must not overlap section ' + sec.index);
  }
  // Every answer span is immutable by construction.
  assert.ok(turn.answerSpans.length >= 1);
  assert.ok(turn.answerSpans.every(s => s.immutable === true));
  assert.equal(turn.answerSpans.at(-1), turn.finalAnswer);
});

test('classifies Ran commands wrappers and nested Used Bash runs with exit status and duration', () => {
  const AREX = loadCompressIndexBare();
  const md = [
    '## 🤖 Assistant',
    '',
    '#### Ran commands 1',
    '',
    '##### used Bash exit 128 238ms',
    '',
    '**command:**',
    '',
    '```bash',
    '$ pwd && ls -la && git status',
    '```',
    '',
    '**stdout:**',
    '',
    '```text',
    '/home/user',
    '```',
    '',
    '**stderr:**',
    '',
    '```text',
    'fatal: not a git repository',
    '```',
    '',
    '##### used Bash 1.7s',
    '',
    '_(not expanded)_',
    '',
    '## 👤 User',
    '',
    'Следующий запрос.',
    '',
  ].join('\n');
  const index = AREX.buildDocumentIndex(md);
  const wrapper = index.sections.find(s => s.kind === 'ran_commands_wrapper');
  assert.ok(wrapper);
  assert.equal(wrapper.level, 4);
  assert.equal(wrapper.parentIndex, -1);

  const runs = index.sections.filter(s => s.kind === 'bash_run');
  assert.equal(runs.length, 2);
  assert.deepEqual([...runs].map(r => r.parentIndex), [wrapper.index, wrapper.index]);
  assert.equal(runs[0].exitStatus, 128);
  assert.equal(runs[0].durationMs, 238);
  assert.equal(runs[1].exitStatus, null);
  assert.equal(runs[1].durationMs, 1700);

  // The wrapper spans its children; children are trimmed to their activity.
  for (const run of runs) {
    assert.ok(run.startOffset >= wrapper.startOffset);
    assert.ok(run.endOffset <= wrapper.endOffset);
  }
  const notExpanded = md.indexOf('_(not expanded)_');
  assert.equal(runs[1].endOffset, notExpanded + '_(not expanded)_'.length);

  // Blocks are scoped to their turn and section and pair command/stdout/stderr.
  const command = index.blocks.find(b => b.label === 'command');
  const stdout = index.blocks.find(b => b.label === 'stdout');
  const stderr = index.blocks.find(b => b.label === 'stderr');
  assert.equal(command.turnIndex, 0);
  assert.equal(command.sectionIndex, runs[0].index);
  assert.equal(stdout.pairedCommand, command);
  assert.equal(stderr.pairedCommand, command);
  assert.equal(command.hasStderr, true);
});

test('handles backtick and tilde fence nesting with longer runs', () => {
  const AREX = loadCompressIndexBare();
  const md = [
    '## 🤖 Assistant',
    '',
    '#### Show fences',
    '',
    '**stdout:**',
    '',
    '```text',
    'line with ``` inside',
    '~~~ also tilde',
    '```',
    '',
    '**stdout:**',
    '',
    '~~~text',
    'line with ``` inside',
    '``` alone',
    '~~~',
    '',
    '**stdout:**',
    '',
    '````text',
    '``` inside four-backtick fence',
    '```',
    '````',
    '',
    'Done.',
    '',
  ].join('\n');
  const index = AREX.buildDocumentIndex(md);
  assert.equal(index.blocks.length, 3);

  assert.equal(index.blocks[0].body, 'line with ``` inside\n~~~ also tilde');
  assert.equal(index.blocks[0].fence, '`');
  assert.equal(index.blocks[0].fenceLength, 3);

  assert.equal(index.blocks[1].body, 'line with ``` inside\n``` alone');
  assert.equal(index.blocks[1].fence, '~');
  assert.equal(index.blocks[1].fenceLength, 3);

  assert.equal(index.blocks[2].body, '``` inside four-backtick fence\n```');
  assert.equal(index.blocks[2].fence, '`');
  assert.equal(index.blocks[2].fenceLength, 4);

  // Offsets splice back to the exact raw slice of every block.
  for (const block of index.blocks) {
    const slice = md.slice(block.startOffset, block.endOffset);
    assert.ok(slice.startsWith(block.fence.repeat(block.fenceLength)));
    assert.ok(slice.endsWith(block.fence.repeat(block.fenceLength)));
  }
  // The prose after the last fence is the immutable final answer.
  const answer = index.turns[0].finalAnswer;
  assert.match(md.slice(answer.startOffset, answer.endOffset), /Done\./);
});

test('labels and pairs blocks with turn and section indices', () => {
  const AREX = loadCompressIndexBare();
  const md = [
    '## 👤 User',
    '',
    'Сделай задачу.',
    '',
    '## 🤖 Assistant',
    '',
    '#### used Bash 10ms',
    '',
    '**command:**',
    '',
    '```bash',
    '$ cat file.py',
    '```',
    '',
    '**stdout:**',
    '',
    '```text',
    'source line',
    '```',
    '',
    '**stderr:**',
    '',
    '```text',
    'warning: failed to read',
    '```',
    '',
    '#### Edit src/app.js',
    '',
    '**📄 app.js** _(JS)_',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '```text',
    'unlabeled block',
    '```',
    '',
    'Готово.',
    '',
  ].join('\n');
  const index = AREX.buildDocumentIndex(md);
  const bashSection = index.sections.find(s => s.kind === 'bash_run');
  const editSection = index.sections.find(s => s.kind === 'edit_activity');

  const command = index.blocks.find(b => b.label === 'command');
  const stdout = index.blocks.find(b => b.label === 'stdout');
  const stderr = index.blocks.find(b => b.label === 'stderr');
  assert.equal(command.turnIndex, 1);
  assert.equal(command.sectionIndex, bashSection.index);
  assert.equal(stdout.pairedCommand, command);
  assert.equal(stderr.pairedCommand, command);
  assert.equal(command.hasStderr, true);

  const fileBlock = index.blocks.find(b => b.label === 'file');
  assert.equal(fileBlock.fileName, 'app.js');
  assert.equal(fileBlock.turnIndex, 1);
  assert.equal(fileBlock.sectionIndex, editSection.index);

  const unlabeled = index.blocks.find(b => b.label === 'unlabeled');
  assert.ok(unlabeled);
  assert.equal(unlabeled.fileName, null);
});

test('label lookback never leaks across headings or previous fences', () => {
  const AREX = loadCompressIndexBare();
  const md = [
    '**stdout:**',
    '',
    '```text',
    'a'.repeat(200),
    '```',
    '',
    '## 👤 User',
    '',
    '```text',
    'user block',
    '```',
    '',
    '**stdout:**',
    '',
    '```text',
    'second labeled',
    '```',
    '',
    '```text',
    'after previous fence',
    '```',
    '',
  ].join('\n');
  const index = AREX.buildDocumentIndex(md);
  assert.equal(index.blocks[0].label, 'stdout');
  // A heading boundary resets the label lookback.
  assert.equal(index.blocks[1].label, 'unlabeled');
  assert.equal(index.blocks[2].label, 'stdout');
  // A closed fence also resets the lookback.
  assert.equal(index.blocks[3].label, 'unlabeled');
});

test('defensively relabels and merges consecutive mislabeled command blocks', () => {
  const AREX = loadCompressIndexBare();
  const md = [
    '## 🤖 Assistant',
    '',
    '#### used Bash 10ms',
    '',
    '**command:**',
    '',
    '```bash',
    '$ ls -la',
    '```',
    '',
    '**stdout:**',
    '',
    '```text',
    'first chunk output',
    '```',
    '',
    '**command:**',
    '',
    '```text',
    'continuation chunk one',
    '```',
    '',
    '**command:**',
    '',
    '```text',
    'continuation chunk two',
    '```',
    '',
    '**command:**',
    '',
    '```bash',
    '$ echo real',
    '```',
    '',
    '**stdout:**',
    '',
    '```text',
    'real output',
    '```',
    '',
  ].join('\n');
  const index = AREX.buildDocumentIndex(md);
  assert.equal(index.blocks.length, 5);

  const realCommands = index.blocks.filter(b => b.label === 'command');
  assert.equal(realCommands.length, 2);
  assert.match(realCommands[0].body, /^\$\s*ls -la$/);
  assert.match(realCommands[1].body, /^\$\s*echo real$/);

  const merged = index.blocks.find(b => b.merged);
  assert.ok(merged, 'consecutive mislabeled run merged');
  assert.equal(merged.label, 'stdout');
  assert.equal(merged.relabeled, true);
  assert.match(merged.body, /continuation chunk one/);
  assert.match(merged.body, /continuation chunk two/);
  // The merged continuation pairs with the preceding real command.
  assert.equal(merged.pairedCommand, realCommands[0]);

  // A lone mislabeled command block is relabeled but not merged.
  const lone = AREX.buildDocumentIndex('**command:**\n\n```text\nsingle mislabeled\n```\n');
  assert.equal(lone.blocks[0].label, 'stdout');
  assert.equal(lone.blocks[0].relabeled, true);
  assert.notEqual(lone.blocks[0].merged, true);
});

test('applySpanEdits splices edits with exact byte-delta accounting and determinism', () => {
  const AREX = loadCompressIndexBare();
  const raw = 'hello мир\nsecond line\nthird line\n';
  const secondStart = raw.indexOf('second line');
  const edits = [
    { start: secondStart, end: secondStart + 'second line'.length, text: 'replaced line' },
  ];
  const result = AREX.applySpanEdits(raw, edits);
  assert.equal(result.markdown, 'hello мир\nreplaced line\nthird line\n');
  assert.equal(result.baseBytes, AREX.utf8Bytes(raw));
  assert.equal(result.bytes, new TextEncoder().encode(result.markdown).length);
  assert.equal(result.byteDelta, result.bytes - result.baseBytes);
  assert.equal(result.stats.applied, 1);

  // Deterministic regardless of edit order.
  const reversed = AREX.applySpanEdits(raw, [...edits].reverse());
  assert.equal(reversed.markdown, result.markdown);

  // Multiple non-overlapping edits, adjacent allowed.
  const multi = AREX.applySpanEdits(raw, [
    { start: 0, end: 5, text: 'HELLO' },
    { start: raw.length - 'third line\n'.length, end: raw.length, text: 'THIRD\n' },
  ]);
  assert.equal(multi.markdown, 'HELLO мир\nsecond line\nTHIRD\n');
  assert.equal(multi.stats.applied, 2);

  // Empty edit list returns the input unchanged.
  const none = AREX.applySpanEdits(raw, []);
  assert.equal(none.markdown, raw);
  assert.equal(none.byteDelta, 0);

  // Byte-delta accounting is exact for multibyte replacements: replacing the
  // 3-char (9-byte) 'мир' with the 5-byte 'earth' shrinks the byte count by 4.
  const multiByte = AREX.applySpanEdits('мир земля', [{ start: 0, end: 3, text: 'earth' }]);
  assert.equal(multiByte.markdown, 'earth земля');
  assert.equal(multiByte.byteDelta, 5 - new TextEncoder().encode('мир').length);
});

// The module runs in a separate vm realm, so its RangeError is a different
// class than this test's. Match by name so the check is realm-agnostic.
const isRangeError = err => err && typeof err === 'object' && err.name === 'RangeError';

test('applySpanEdits rejects overlaps, out-of-bounds edits and protected-span violations', () => {
  const AREX = loadCompressIndexBare();
  const raw = 'hello world\nsecond line\n';
  assert.throws(() => AREX.applySpanEdits(raw, [
    { start: 0, end: 5, text: 'a' },
    { start: 3, end: 10, text: 'b' },
  ]), isRangeError);
  assert.throws(() => AREX.applySpanEdits(raw, [{ start: 0, end: raw.length + 1, text: 'x' }]), isRangeError);
  assert.throws(() => AREX.applySpanEdits(raw, [{ start: 5, end: 2, text: 'x' }]), isRangeError);
  assert.throws(() => AREX.applySpanEdits(raw, [{ start: 0, end: 5 }]), /text/);

  // Protected (immutable) spans: an edit touching one is rejected, a distant
  // edit is accepted.
  const protectedSpan = { start: 0, end: 5 };
  assert.throws(() => AREX.applySpanEdits(raw, [{ start: 2, end: 7, text: 'x' }], [protectedSpan]), isRangeError);
  const ok = AREX.applySpanEdits(raw, [{ start: raw.indexOf('second line'), end: raw.length, text: '' }], [protectedSpan]);
  assert.equal(ok.markdown, 'hello world\n');
  // Protected spans also accept [start, end] tuples.
  assert.throws(() => AREX.applySpanEdits(raw, [{ start: 0, end: 1, text: 'x' }], [[0, 5]]), isRangeError);
});

test('index offsets and byte counts match TextEncoder exactly', () => {
  const AREX = loadCompressIndexBare();
  const enc = new TextEncoder();
  const md = [
    '## 👤 User',
    '',
    'Привет мир 🌍 — проверь проект.',
    '',
    '## 🤖 Assistant',
    '',
    '#### used Bash 5ms',
    '',
    '**command:**',
    '',
    '```bash',
    '$ cat файл.py',
    '```',
    '',
    '**stdout:**',
    '',
    '```text',
    'строка с эмодзи 🎯 и кириллицей',
    '```',
    '',
    'Ответ с multibyte текстом.',
    '',
  ].join('\n');
  const index = AREX.buildDocumentIndex(md);
  assert.equal(index.bytes, enc.encode(md).length);
  for (const block of index.blocks) {
    assert.equal(block.bytes, enc.encode(block.body).length);
    assert.equal(block.rawSliceBytes, enc.encode(md.slice(block.startOffset, block.endOffset)).length);
    assert.equal(md.slice(block.startOffset, block.endOffset).slice(0, 3), '```');
  }
  // Section and turn slices splice back to their headings exactly.
  for (const sec of index.sections) {
    assert.ok(md.slice(sec.startOffset, sec.startOffset + 4).startsWith('####'));
  }
  for (const turn of index.turns) {
    assert.ok(md.slice(turn.startOffset, turn.startOffset + 3).startsWith('## '));
  }
});

test('section spans nest correctly and blocks stay inside their sections', () => {
  const AREX = loadCompressIndexBare();
  const md = [
    '## 🤖 Assistant',
    '',
    '#### Ran commands 2',
    '',
    '##### used Bash 1ms',
    '',
    '**command:**',
    '',
    '```bash',
    '$ ls',
    '```',
    '',
    '**stdout:**',
    '',
    '```text',
    'out',
    '```',
    '',
    '##### used Bash 2ms',
    '',
    '_(not expanded)_',
    '',
    '#### Explored 1 reads',
    '',
    '- Read a.md',
    '',
    'Готово.',
    '',
  ].join('\n');
  const index = AREX.buildDocumentIndex(md);
  const sorted = [...index.sections].sort((a, b) => a.startOffset - b.startOffset);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i].startOffset >= sorted[i - 1].startOffset);
  }
  for (const sec of index.sections) {
    if (sec.parentIndex >= 0) {
      const parent = index.sections[sec.parentIndex];
      assert.ok(sec.startOffset >= parent.startOffset);
      assert.ok(sec.endOffset <= parent.endOffset);
    }
    for (const blockIdx of sec.blocks) {
      const block = index.blocks[blockIdx];
      assert.equal(block.sectionIndex, sec.index);
      assert.ok(block.startOffset >= sec.startOffset);
      assert.ok(block.endOffset <= sec.endOffset);
    }
  }
  // Every block references a valid turn and section.
  for (const block of index.blocks) {
    assert.ok(block.turnIndex >= 0 && block.turnIndex < index.turns.length);
    assert.ok(block.sectionIndex >= 0 && block.sectionIndex < index.sections.length);
  }
});

test('indexes 3.5 MB of markdown in under 40 ms (single linear pass)', () => {
  const AREX = loadCompressIndexBare();
  const nl = String.fromCharCode(10);
  const parts = [];
  let size = 0;
  const push = s => { parts.push(s); size += s.length; };
  push('# Large Session' + nl + nl + '- Source: https://arena.ai/agent/large-session' + nl +
    '- Messages: 999' + nl + nl + '---' + nl + nl);
  const userText = 'Проверь проект, найди и исправь ошибки, добавь тесты и обнови документацию.' + nl + nl;
  const thought = n => '#### Thought for ' + (30 + n % 90) + 's' + nl + nl +
    'Разбираю структуру проекта и планирую шаги рефакторинга.' + nl + nl +
    'Проверяю существующие тесты и их покрытие.' + nl + nl +
    'Оцениваю риски изменения путей и конфигураций.' + nl + nl;
  const bashRun = (n, exit, dur) => {
    const head = '##### used Bash' + (exit === null ? '' : ' exit ' + exit) + ' ' + dur + 'ms' + nl + nl;
    const cmd = '**command:**' + nl + nl + '```bash' + nl + '$ cd /repo && python3 -m pytest tests/test_suite_' + n + '.py -q' + nl + '```' + nl + nl;
    const lines = [];
    for (let k = 0; k < 45; k++) lines.push('test_suite_' + n + '.py ......... [ ' + (k * 2) + '%] ' + 'x'.repeat(40));
    return head + cmd + '**stdout:**' + nl + nl + '```text' + nl + lines.join(nl) + nl + '```' + nl + nl;
  };
  const answer = 'Фаза работы завершена, все проверки пройдены, изменения отправлены в репозиторий.' + nl + nl;
  let n = 0;
  while (size < 3.5 * 1024 * 1024) {
    push('## 👤 User' + nl + nl + userText);
    push('## 🤖 Assistant' + nl + nl);
    push(thought(n));
    push('#### Ran commands 3' + nl + nl);
    push(bashRun(n, null, '1' + (n % 9) + '0ms'));
    push(bashRun(n + 1, 1, '2' + (n % 9) + '5ms'));
    push('#### Explored 2 reads' + nl + nl + '- Read src/module_' + n + '.py' + nl + nl + '- Read tests/test_' + n + '.py' + nl + nl);
    push(answer);
    n++;
  }
  const md = parts.join('');
  assert.ok(md.length >= 3.5 * 1024 * 1024, 'fixture must reach 3.5 MB, got ' + md.length);

  // Warm up the JIT and let GC settle from the fixture construction, then
  // measure the indexing pass itself. The gate targets the steady-state
  // single-pass cost, so take the best of a few measured runs.
  for (let w = 0; w < 3; w++) AREX.buildDocumentIndex(md);
  let elapsed = Infinity;
  let index;
  for (let w = 0; w < 5; w++) {
    const start = performance.now();
    index = AREX.buildDocumentIndex(md);
    elapsed = Math.min(elapsed, performance.now() - start);
  }

  assert.ok(elapsed < 40, 'indexing 3.5 MB took ' + elapsed.toFixed(2) + ' ms (gate: < 40 ms)');
  assert.ok(index.turns.length > 100);
  assert.ok(index.sections.length > 500);
  assert.ok(index.blocks.length > 500);
  // Sanity: the parse is structurally consistent on the large document.
  for (const block of index.blocks) {
    assert.ok(block.turnIndex >= 0 && block.turnIndex < index.turns.length);
    assert.ok(block.sectionIndex >= 0 && block.sectionIndex < index.sections.length);
  }
  for (const turn of index.turns) {
    if (turn.kind === 'user') assert.equal(turn.immutable, true);
  }
});
