import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = file => readFileSync(new URL('../extension/content/' + file, import.meta.url), 'utf8');
const context = vm.createContext({});
for (const file of ['compress-index.js', 'compress-commands.js']) {
  vm.runInContext(read(file), context, { filename: file });
}
const { AREX } = context;
const fence = (body, lang = 'text') => '```' + lang + '\n' + body + '\n```';
const run = (command, stdout = 'ok', { title = 'Used Bash exit 0 42ms', stderr } = {}) =>
  '##### ' + title + '\n\n**command:**\n\n' + fence(command, 'bash') +
  (stdout === null ? '' : '\n\n**stdout:**\n\n' + fence(stdout)) +
  (stderr === undefined ? '' : '\n\n**stderr:**\n\n' + fence(stderr));
const assistant = body => '## \u{1F916} Assistant\n\n#### Ran commands 1\n\n' + body;
const compact = (markdown, mode = 'stubs') => AREX.compactCommands(AREX.buildDocumentIndex(markdown), { mode });

function pythonScript() {
  const middle = Array.from({ length: 34 }, (_, i) =>
    'print("processing record ' + i + ' with a sufficiently long description for the transcript")');
  middle[13] = "target = Path('src/updated.py')";
  middle[14] = 'with open("reports/results.json", "w") as out: out.write("done")';
  middle[15] = 'os.system("cat > artifacts/log.txt <<EOF")';
  return [
    "$ cd /repo && python3 - <<'PY'",
    'from pathlib import Path',
    'import os',
    'import sys',
    'source = Path("src/original.py")',
    'print("loading inputs")',
    'print("checking files")',
    'print("preparing output")',
    'print("starting update")',
    'print("reading existing state")',
    ...middle,
    'print("checking changes")',
    'print("final summary")',
    'print("output written")',
    'print("validation passed")',
    'print("done")',
    'PY',
  ].join('\n');
}

function diffFile(path, count = 18) {
  const before = Array.from({ length: count }, (_, i) => ' context before ' + i + ': ' + 'x'.repeat(80));
  const after = Array.from({ length: count }, (_, i) => ' context after ' + i + ': ' + 'y'.repeat(80));
  return [
    `diff --git a/${path} b/${path}`,
    'index 1234567..abcdef0 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${count * 2 + 1} +1,${count * 2 + 1} @@ function update()`,
    ...before,
    '-old_value = 1',
    '+new_value = 2',
    ...after,
  ].join('\n');
}

test('shortens only clean, large inline scripts; retains both ends and all referenced paths', () => {
  const script = pythonScript();
  const answer = '\n\nFinal answer with the original file details.\n';
  const raw = assistant(run(script)) + answer;
  const result = compact(raw);
  const lines = script.split('\n');
  assert.equal(result.stats.shortenedScripts, 1);
  assert.equal(result.stats.trimmedDiffs, 0);
  assert.ok(result.markdown.includes(lines.slice(0, 10).join('\n')));
  assert.ok(result.markdown.includes(lines.slice(-6).join('\n')));
  assert.match(result.markdown, new RegExp(`omitted ${lines.length - 16} lines of clean inline script`));
  for (const path of ['src/original.py', 'src/updated.py', 'reports/results.json', 'artifacts/log.txt']) {
    assert.ok(result.markdown.includes(path), path);
  }
  assert.ok(!result.markdown.includes('processing record 30'));
  assert.ok(result.markdown.endsWith(answer));
  assert.equal(result.bytes, Buffer.byteLength(result.markdown));
  assert.equal(result.byteDelta, result.bytes - Buffer.byteLength(raw));
  assert.equal(AREX.applySpanEdits(raw, result.edits).markdown, result.markdown);
  assert.equal(compact(result.markdown).markdown, result.markdown);
});

test('supports Node heredocs and multiline Python -c without losing file provenance', () => {
  const node = [
    "$ node <<'EOF'",
    'const fs = require("node:fs");',
    ...Array.from({ length: 30 }, (_, i) => 'console.log("processing node record ' + i + ' ' + 'x'.repeat(35) + '");'),
    'fs.writeFileSync("dist/bundle.js", "result");',
    'console.log("finished");',
    'EOF',
  ].join('\n');
  const python = [
    '$ python3 -c "',
    'from pathlib import Path',
    ...Array.from({ length: 30 }, (_, i) => 'print(\'processing python record ' + i + ' ' + 'x'.repeat(35) + '\')'),
    "Path('output/report.txt').write_text('done')",
    'print(\'finished\')"',
  ].join('\n');
  const raw = assistant(run(node) + '\n\n' + run(python));
  const result = compact(raw);
  assert.equal(result.stats.shortenedScripts, 2);
  assert.match(result.markdown, /touched: dist\/bundle\.js/);
  assert.match(result.markdown, /touched: output\/report\.txt/);
  assert.ok(result.markdown.includes('EOF\n'));
  assert.ok(result.markdown.includes("print('finished')\""));
});

test('failed, unknown, stderr and stdout-error executions retain every script byte', () => {
  const script = pythonScript();
  for (const [title, stdout, stderr] of [
    ['Used Bash exit 1 42ms', 'failed', undefined],
    ['Used Bash 42ms', 'ok', undefined],
    ['Used Bash exit 0 42ms', 'ok', 'Warning: write failed'],
    ['Used Bash exit 0 42ms', 'Traceback (most recent call last):\nValueError: failed', undefined],
    ['Used Bash exit 0 42ms', 'SyntaxError: invalid syntax', undefined],
    ['Used Bash exit 0 42ms', 'not ok 1 - script validation', undefined],
    ['Used Bash exit 0 42ms', 'FAILED tests/test_script.py::test_output', undefined],
  ]) {
    const raw = assistant(run(script, stdout, { title, stderr }));
    assert.equal(compact(raw).markdown, raw, title + ' ' + stdout);
    assert.equal(compact(raw).stats.shortenedScripts, 0);
  }
  const chunked = assistant(run(script, 'ok') + '\n\n**stdout:**\n\n' + fence('Error: execution failed'));
  assert.equal(compact(chunked).markdown, chunked);
});

test('requires both strict size thresholds, a complete inline invocation and Stubs mode', () => {
  const script = pythonScript();
  const shortLines = ["$ python3 - <<'PY'", ...Array(24).fill('print("' + 'x'.repeat(90) + '")'), 'PY'].join('\n');
  const shortBytes = ["$ python3 - <<'PY'", ...Array(30).fill('pass'), 'PY'].join('\n');
  const base = ["$ python3 - <<'PY'", ...Array(30).fill('pass'), 'PY'].join('\n');
  const exactly1500 = base.replace('pass', 'pass' + 'x'.repeat(1500 - Buffer.byteLength(base)));
  assert.equal(Buffer.byteLength(exactly1500), 1500);
  for (const command of [shortLines, shortBytes, exactly1500, script.replace("PY'", "BAD'"),
    script.replace('$ cd /repo && python3', '$ bash'), script.replace(/\nPY$/, '\nNOT_PY'),
    script.replace(/\n/g, '\r\n'), '$ cat > file.py <<EOF\n' + 'pass\n'.repeat(40) + 'EOF']) {
    const raw = assistant(run(command));
    assert.equal(compact(raw).markdown, raw, command.slice(0, 60));
  }
  for (const mode of ['off', 'lossless', 'smart', undefined]) {
    const raw = assistant(run(script));
    const index = AREX.buildDocumentIndex(raw);
    assert.equal(AREX.compactCommands(index, { mode }).markdown, raw);
  }
});

test('does not edit User turns, answer prose or non-Bash activity', () => {
  const script = pythonScript();
  const user = '## \u{1F464} User\n\n' + run(script) + '\n\n';
  const final = '\n\nFinal answer: ' + script + '\n';
  const raw = user + assistant(run(script)) + final;
  const result = compact(raw);
  assert.ok(result.markdown.startsWith(user));
  assert.ok(result.markdown.endsWith(final));
  assert.equal(result.stats.shortenedScripts, 1);
  const proseSection = '## \u{1F916} Assistant\n\n#### Explanation\n\n**command:**\n\n' + fence(script, 'bash');
  assert.equal(compact(proseSection).edits.length, 0);
});

test('trims repetitive context in clean git diff/show but retains metadata and every hunk header', () => {
  const diff = [
    'commit abcdef123456789',
    'Author: A Developer <a@example.test>',
    'Date: Wed Nov 25 12:00:00 2026',
    ' src/one.js | 2 +-',
    ' src/two.js | 2 +-',
    ' 2 files changed, 2 insertions(+), 2 deletions(-)',
    diffFile('src/one.js'),
    diffFile('src/two.js'),
  ].join('\n');
  const raw = assistant(run('$ git show HEAD', diff));
  const result = compact(raw);
  assert.equal(result.stats.trimmedDiffs, 1);
  for (const line of diff.split('\n').filter(line =>
    /^(commit |Author:|Date:| src\/| 2 files|diff --git |index |--- |\+\+\+ |@@ |[+-](?:old_value|new_value))/.test(line))) {
    assert.ok(result.markdown.includes(line), line);
  }
  assert.match(result.markdown, /omitted \d+ unchanged diff context lines/);
  assert.ok(result.bytes < Buffer.byteLength(raw));
  assert.equal(compact(result.markdown).markdown, result.markdown);
});

test('budgets changed lines across hunks while retaining file and hunk headers', () => {
  const changes = Array.from({ length: 36 }, (_, i) => [
    '-old ' + i + ' ' + 'a'.repeat(150),
    '+new ' + i + ' ' + 'b'.repeat(150),
  ]).flat();
  const body = [
    'diff --git a/src/big.js b/src/big.js', '--- a/src/big.js', '+++ b/src/big.js',
    '@@ -1,36 +1,36 @@', ...changes,
    'diff --git a/src/tiny.js b/src/tiny.js', '--- a/src/tiny.js', '+++ b/src/tiny.js',
    '@@ -1 +1 @@', '-old tiny', '+new tiny',
  ].join('\n');
  const result = compact(assistant(run('$ git diff', body)));
  assert.equal(result.stats.trimmedDiffs, 1);
  assert.ok(result.markdown.includes(changes[0]));
  assert.ok(!result.markdown.includes(changes.at(-1)));
  assert.match(result.markdown, /omitted \d+ changed \+\/- diff lines/);
  for (const header of ['diff --git a/src/big.js b/src/big.js', '@@ -1,36 +1,36 @@',
    'diff --git a/src/tiny.js b/src/tiny.js', '@@ -1 +1 @@']) {
    assert.ok(result.markdown.includes(header));
  }
});

test('leaves malformed, failed, unrelated and too-small git outputs unchanged', () => {
  const diff = diffFile('src/one.js');
  const exhaustedSide = [
    'diff --git a/src/a.js b/src/a.js', '@@ -1,1 +1,2 @@', '-old', '+new',
    ' context that cannot fit the remaining hunk counts', '+extra',
  ].join('\n') + '\n' + diff;
  for (const raw of [
    assistant(run('$ git diff', diff, { title: 'Used Bash exit 1 42ms' })),
    assistant(run('$ git show HEAD', diff, { stderr: 'fatal: bad revision' })),
    assistant(run('$ git diff', 'fatal: not a git repository\n' + diff)),
    assistant(run('$ echo diff', diff)),
    assistant(run('$ git diff --stat', ' src/one.js | 2 +-\n 1 file changed')),
    assistant(run('$ git diff', diff.replace('@@ -1,37 +1,37 @@', '@@ -1,99 +1,99 @@'))),
    assistant(run('$ git diff', diff.replace(' context before 0:', '!context before 0:'))),
    assistant(run('$ git diff', exhaustedSide)),
  ]) assert.equal(compact(raw).markdown, raw);
});
