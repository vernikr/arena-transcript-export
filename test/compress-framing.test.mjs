import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeEnv } from './harness.mjs';

const read = path => readFileSync(new URL('../extension/' + path, import.meta.url), 'utf8');
const tick = '`';
const fence = (body, lang = 'text') => `${tick.repeat(3)}${lang}\n${body}\n${tick.repeat(3)}`;
const card = (command = '$ ls -la /home/user', output = 'file.txt') =>
  `**command:**\n\n${fence(command, 'bash')}\n\n**stdout:**\n\n${fence(output)}`;
const bash = (body = card(), title = 'Used Bash 94ms') => `##### ${title}\n\n${body}`;
const assistant = body => `## 🤖 Assistant\n\n${body}`;
const wrapper = body => `#### Ran commands 1\n\n${body}`;
function load() {
  const ctx = vm.createContext({});
  for (const file of ['compress-index.js', 'compress-framing.js', 'compress.js']) {
    vm.runInContext(read('content/' + file), ctx, { filename: file });
  }
  return ctx.AREX;
}
const AREX = load();
const framing = (raw, mode = 'smart') => AREX.compactFraming(AREX.buildDocumentIndex(raw), { mode });

test('collapses only redundant wrappers, retaining exact Bash metadata and payloads', () => {
  const raw = assistant(wrapper(bash(card(), 'Used Bash 94ms · exit 2')));
  const result = framing(raw);
  assert.equal(result.markdown, assistant('#### Used Bash 94ms · exit 2\n\n> `$ ls -la /home/user`\n\n' + fence('file.txt')));
  assert.equal(result.stats.collapsedWrappers, 1);
  assert.equal(result.stats.compactCommands, 1);
  assert.equal(result.bytes, Buffer.byteLength(result.markdown));
  assert.equal(result.byteDelta, result.bytes - Buffer.byteLength(raw));
  assert.equal(AREX.applySpanEdits(raw, [...result.edits].reverse()).markdown, result.markdown);
});

test('removes empty Explored read/read(s) headings, including immediately nested headings', () => {
  for (const title of ['Explored 1 read', 'Explored 2 reads']) {
    const raw = assistant(`#### ${title}\n\n${wrapper(bash())}`);
    const result = framing(raw);
    assert.equal(result.stats.emptyExplored, 1);
    assert.doesNotMatch(result.markdown, /Explored|Ran commands/);
  }
  const raw = assistant('#### Explored 1 read\n\n' + bash());
  assert.equal(framing(raw).stats.emptyExplored, 1);
});

test('does not discard explored content, file cards, not-expanded markers or metadata', () => {
  for (const body of ['A read result.', '_(not expanded)_', '**📄 x.txt** _(TXT)_\n\n' + fence('x')]) {
    const raw = assistant(`#### Explored 1 read\n\n${body}\n\n${wrapper(bash())}`);
    assert.match(framing(raw).markdown, /#### Explored 1 read/);
    assert.ok(framing(raw).markdown.includes(body));
  }
  const raw = assistant('#### Explored 1 read 20ms\n\n' + wrapper(bash()));
  assert.match(framing(raw).markdown, /Explored 1 read 20ms/);
});

test('keeps multi-child, non-Bash, populated and annotated Ran commands wrappers', () => {
  const cases = [
    wrapper(bash() + '\n\n' + bash()),
    wrapper('Parent prose.\n\n' + bash()),
    wrapper('_(not expanded)_\n\n' + bash()),
    wrapper('##### Used Read file.txt\n\n' + fence('contents')),
    wrapper(bash() + '\n\n###### Another heading\n\n' + fence('x')),
    '#### Ran commands 2\n\n' + bash(),
    '#### Ran commands 1 94ms\n\n' + bash(),
    '#### Ran commands 1\n\n###### Used Bash 94ms\n\n' + card(),
  ];
  for (const body of cases) {
    const result = framing(assistant(body));
    assert.equal(result.stats.collapsedWrappers, 0, body);
    assert.ok(result.markdown.includes(body.split('\n')[0]));
  }
});

test('does not count headings or labels inside output fences as structural framing', () => {
  const output = '#### Ran commands 1\n\n##### Used Bash 1ms\n**command:**\n$ do-not-run';
  const raw = assistant(wrapper(bash(card('$ echo safe', output))));
  const result = framing(raw);
  assert.equal(result.stats.collapsedWrappers, 1);
  assert.ok(result.markdown.endsWith(fence(output)));
});

test('Off, Lossless and unspecified modes retain canonical framing byte-for-byte', () => {
  const raw = assistant('#### Explored 1 read\n\n' + wrapper(bash()));
  for (const mode of ['off', 'lossless', undefined]) {
    assert.equal(framing(raw, mode ?? 'lossless').markdown, raw);
    assert.equal(AREX.compressMarkdown(raw, { mode }).markdown, raw);
  }
  assert.equal(AREX.compactFraming(AREX.buildDocumentIndex(raw)).markdown, raw);
});

test('Smart and Stubs integrate framing with exact final metrics and are idempotent', () => {
  const raw = assistant('#### Explored 1 read\n\n' + wrapper(bash(card('$ printf "Привет 🌍"', 'Привет 🌍'))));
  for (const mode of ['smart', 'stubs']) {
    const result = AREX.compressMarkdown(raw, { mode });
    assert.equal(result.markdown, framing(raw, mode).markdown);
    assert.equal(result.bytes, Buffer.byteLength(result.markdown));
    assert.equal(result.baselineBytes, Buffer.byteLength(raw));
    assert.equal(result.savedBytes, Buffer.byteLength(raw) - result.bytes);
    assert.equal(result.savedRatio, result.savedBytes / result.baselineBytes);
    assert.equal(result.estimatedTokens, AREX.measureMarkdown(result.markdown).estimatedTokens);
    assert.equal(AREX.compressMarkdown(result.markdown, { mode }).markdown, result.markdown);
  }
});

test('preserves user turns, assistant answer prose and non-transcript input exactly', () => {
  const user = '## 👤 User\n\n#### Explored 1 read\n\n' + wrapper(bash()) + '\n\n';
  const answer = '\n\nFinal answer — keep **all** text and whitespace.\n';
  const raw = user + assistant(wrapper(bash())) + answer;
  for (const mode of ['smart', 'stubs']) {
    const result = AREX.compressMarkdown(raw, { mode });
    assert.ok(result.markdown.startsWith(user));
    assert.ok(result.markdown.endsWith(answer));
  }
  const rawCard = wrapper(bash());
  assert.equal(framing(rawCard).markdown, rawCard);
  const prose = assistant('#### Explanation\n\n' + card());
  assert.equal(framing(prose).markdown, prose);
});

test('command text is exact, with shell quoting, Unicode and trailing spaces', () => {
  for (const command of ['$ echo "a > b" | sed \'s/a/b/\'', '$ echo \\x "Привет 🌍"  ', '$ ' + 'x'.repeat(158)]) {
    const raw = assistant(bash(card(command)));
    assert.equal(framing(raw).markdown, assistant('##### Used Bash 94ms\n\n> `' + command + '`\n\n' + fence('file.txt')));
  }
});

test('multiline, CRLF, backtick, over-limit and non-bash commands keep their fences', () => {
  for (const command of ['$ echo first\necho second', '$ echo first\r\necho second', '$ echo `date`', '$ ' + 'x'.repeat(159), '$ echo hi\n']) {
    const raw = assistant(bash(card(command)));
    assert.equal(framing(raw).markdown, raw, command);
  }
  const raw = assistant(bash(card().replace('```bash', '```python')));
  assert.equal(framing(raw).markdown, raw);
});

test('command anchors before/after card labels and after command fences are retained', () => {
  const anchor = '<a id="arex-stubs-output-7"></a>\n';
  const original = card();
  const cases = [
    anchor + original,
    original.replace('```bash', anchor + '```bash'),
    original.replace('\n\n**stdout:**', '\n' + anchor + '\n**stdout:**'),
    original.replace('```bash', '<a name="custom-command"></a>\n```bash'),
  ];
  for (const body of cases) {
    const raw = assistant(bash(body));
    assert.equal(framing(raw).markdown, raw);
    for (const mode of ['smart', 'stubs']) assert.ok(AREX.compressMarkdown(raw, { mode }).markdown.includes('```bash'));
  }
});

test('requires an immediate paired stdout fence, preserving stderr-only/decorated cards', () => {
  const cases = [
    card().replace('**stdout:**', '**stderr:**'),
    card().replace('**stdout:**', 'Important prose.\n\n**stdout:**'),
    card().replace('**stdout:**', '##### Used Bash 2ms\n\n**stdout:**'),
    card().replace('**command:**', '**command:** extra metadata'),
    '**command:**\n\n' + fence('$ echo alone', 'bash'),
  ];
  for (const body of cases) {
    const raw = assistant(bash(body));
    assert.equal(framing(raw).markdown, raw);
  }
});

test('compacts multiple command cards without crossing sections or changing stderr', () => {
  const stderr = '\n\n**stderr:**\n\n' + fence('Error: preserve this diagnostic');
  const raw = assistant(wrapper(bash(card('$ echo one', 'one') + stderr + '\n\n' + card('$ echo two', 'two'))));
  const result = framing(raw);
  assert.equal(result.stats.compactCommands, 2);
  assert.ok(result.markdown.includes(stderr));
  assert.match(result.markdown, /> `\$ echo one`/);
  assert.match(result.markdown, /> `\$ echo two`/);
});

test('window and bare worker contexts produce the same Smart/Stubs framing', () => {
  const { AREX: windowAREX, dom } = makeEnv();
  const raw = assistant(wrapper(bash()));
  try {
    for (const mode of ['smart', 'stubs']) {
      assert.equal(windowAREX.compressMarkdown(raw, { mode }).markdown, AREX.compressMarkdown(raw, { mode }).markdown);
    }
  } finally { dom.window.close(); }
});

test('real popup worker imports the modules and returns compacted previews/downloads', () => {
  const sent = [], sandbox = vm.createContext({ self: { postMessage: value => sent.push(value) } });
  sandbox.importScripts = (...paths) => {
    for (const path of paths) vm.runInContext(read(path.replace('../', '')), sandbox);
  };
  vm.runInContext(read('popup/compress-worker.js'), sandbox);
  const send = data => sandbox.self.onmessage({ data });
  const raw = assistant(wrapper(bash()));
  send({ type: 'INIT_SNAPSHOT', snapshotId: 1, markdown: raw });
  for (const mode of ['off', 'lossless', 'smart', 'stubs']) {
    send({ type: 'GET_MODE', snapshotId: 1, requestId: 1, mode });
    assert.equal(sent.at(-1).type, 'MODE_RESULT');
    assert.equal(sent.at(-1).result.markdown, AREX.compressMarkdown(raw, { mode }).markdown);
    send({ type: 'GET_MARKDOWN', snapshotId: 1, requestId: 2, mode });
    assert.equal(sent.at(-1).markdown, AREX.compressMarkdown(raw, { mode }).markdown);
  }
});

test('retains output anchors while compacting commands and composing real Stubs references', () => {
  const shared = Array.from({ length: 12 }, (_, i) => `shared line ${i}: ${'x'.repeat(35)}`).join('\n');
  const first = 'first version\n' + shared + '\nfirst end';
  const second = 'second version\n' + shared + '\nsecond end';
  const raw = assistant(wrapper(bash(card('$ cat src/x.ts', first))) + '\n\n' + wrapper(bash(card('$ cat src/x.ts', second))));
  const smart = AREX.compressMarkdown(raw, { mode: 'smart' });
  const stubs = AREX.compressMarkdown(raw, { mode: 'stubs' });
  assert.ok(stubs.stats.stubbed > 0);
  assert.ok(stubs.bytes < smart.bytes);
  assert.equal((stubs.markdown.match(/> `\$ cat src\/x.ts`/g) || []).length, 2);
  assert.match(stubs.markdown, /<a id="arex-stubs-output-\d+"><\/a>\n```text/);
  assert.equal(stubs.bytes, Buffer.byteLength(stubs.markdown));
  const sourceLines = first.split('\n');
  const restored = stubs.markdown
    .replace(/\[\.\.\. identical to lines (\d+)–(\d+) of earlier output #arex-stubs-output-\d+ \.\.\.\]/g,
      (_, start, end) => sourceLines.slice(Number(start) - 1, Number(end)).join('\n'))
    .replace(/<a id="arex-stubs-output-\d+"><\/a>\n/g, '');
  assert.equal(restored, smart.markdown);
});

test('proposed edits obey DocumentIndex user/answer immutable spans', () => {
  const raw = '## 👤 User\n\n' + wrapper(bash()) + '\n\n' +
    assistant(wrapper(bash()) + '\n\nFinal answer.\n');
  const index = AREX.buildDocumentIndex(raw);
  const protectedSpans = index.turns.flatMap(turn => turn.kind === 'user'
    ? [{ start: turn.startOffset, end: turn.endOffset }]
    : turn.answerSpans.map(span => ({ start: span.startOffset, end: span.endOffset })));
  const result = AREX.compactFraming(index, { mode: 'smart' });
  assert.equal(AREX.applySpanEdits(raw, result.edits, protectedSpans).markdown, result.markdown);
});
