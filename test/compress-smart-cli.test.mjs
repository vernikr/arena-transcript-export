import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../extension/content/compress-smart-cli.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(src, context);
const { collapsePassingRuns, stripJsonBoilerplate, groupSearchHits, compactCliOutput } = context.AREX;
const bytes = s => Buffer.byteLength(s, 'utf8');

test('folds pytest progress in failed runs while preserving failures and footer verbatim', () => {
  const passes = Array.from({ length: 8 }, (_, i) => `packages/core/tests/test_long_${i}.py ........... [ ${i + 1}%]`).join('\n');
  const tail = ['packages/core/tests/test_bad.py ..FFFF [ 80%]', '=== FAILURES ===', 'Traceback (most recent call last):', '  ✔ keep even passing-looking trace', '=== short test summary info ===', 'FAILED tests/test_bad.py::test_a', '1 failed, 80 passed'].join('\n');
  const input = passes + '\n.............. [ 45%]\n' + tail;
  const result = collapsePassingRuns(input);
  assert.equal(result.collapsed, 9);
  assert.ok(result.text.endsWith(tail));
  assert.ok(bytes(result.text) < bytes(input));
});

test('handles node, cargo, jest, legacy pass rows without folding footers or diagnostics', () => {
  for (const row of ['✔ a passing node test with long descriptive name', 'test module::long_test_name ... ok', 'PASS packages/example/very_long_test_name.test.js', 'ℹ test a long example test ... ok', 'file.py::test_long_example PASSED']) {
    const input = [row, row, row, 'ℹ tests 3', 'ℹ pass 3', 'ℹ fail 0', 'test result: ok. 3 passed; 0 failed'].join('\n');
    const result = collapsePassingRuns(input);
    assert.equal(result.collapsed, 3, row);
    assert.ok(result.text.endsWith(input.slice(input.indexOf('ℹ tests'))));
  }
  for (const row of ['foo.py ..F.... [ 40%]', 'foo.py ...E [ 40%]', '✔ FAILED test', 'PASS test with ERROR', 'ℹ pass 10']) {
    assert.equal(collapsePassingRuns([row, row, row].join('\n')).collapsed, 0);
  }
  assert.equal(collapsePassingRuns('. [ 1%]\n. [ 2%]\n. [ 3%]').collapsed, 0, 'non-expanding');
});

test('strips nested GitHub boilerplate but preserves protected data and exact numeric lexemes', () => {
  const input = JSON.stringify({
    url: 'https://api.github.com/repos/a/b/issues/6', html_url: 'https://github.com/a/b/issues/6',
    number: 6, title: 'тест', state: 'open', body: null,
    user: { login: 'alice', avatar_url: 'https://example.com/a', followers_url: 'https://api.github.com/users/alice/followers', node_id: 'abc' },
    labels: [{ name: 'bug', url: 'https://api.github.com/labels/bug', node_id: 'def' }],
    errors: [{ message: 'bad', avatar_url: 'preserve diagnostic' }],
    message: 'failure', unknown_null: null, endpoint_url: 'https://example.com/{id}', download_url: 'https://example.com/file'
  }, null, 2).replace('"number": 6', '"number": 123456789012345678901234567890');
  const output = stripJsonBoilerplate(input);
  const parsed = JSON.parse(output);
  assert.ok(output.includes('123456789012345678901234567890'));
  assert.equal(parsed.user.login, 'alice');
  assert.equal(parsed.user.avatar_url, undefined);
  assert.equal(parsed.user.followers_url, undefined);
  assert.equal(parsed.labels[0].name, 'bug');
  assert.equal(parsed.labels[0].url, 'https://api.github.com/labels/bug');
  assert.equal(parsed.errors[0].avatar_url, 'preserve diagnostic');
  assert.equal(parsed.message, 'failure');
  assert.equal(parsed.body, null);
  assert.equal(parsed.unknown_null, null);
  assert.equal(parsed.endpoint_url, undefined);
  assert.equal(parsed.download_url, 'https://example.com/file');
  assert.ok(parsed.url && parsed.html_url);
  assert.ok(bytes(output) < bytes(input));
});

test('valid JSON remains valid across property placement, arrays, duplicate keys and whitespace', () => {
  for (const s of [
    '{"avatar_url":"long long value", "ok":1}',
    '{"ok":1, "avatar_url":"long long value"}',
    '{"ok":1, "avatar_url":"long long value", "node_id":"long value", "x":2}',
    '{"avatar_url":null,"node_id":null}',
    '[{"node_id":"long", "a":[{"avatar_url":"longlong", "z":true}]},{"node_id":"long"}]',
    '{"node_id":{"avatar_url":"long", "test": 1}, "x": 2}',
    '{"x":1,"node_id":"12345678","x":2}',
    '{"url":"u","html_url":"h","error":{"node_id":"must remain"}}'
  ]) {
    const out = stripJsonBoilerplate(s);
    assert.doesNotThrow(() => JSON.parse(out), out);
    assert.ok(bytes(out) <= bytes(s));
    assert.equal(out.includes('"x":1'), s.includes('"x":1'));
    if (s.includes('must remain')) assert.ok(out.includes('must remain'));
  }
  for (const s of ['{not json', 'curl: error\n{"node_id":"abc"}', '[1,2,', '"node_id"', '{}']) assert.equal(stripJsonBoilerplate(s), s);
});

test('groups consecutive grep matches without losing numbers, snippets, ordering or newline', () => {
  const rows = Array.from({ length: 16 }, (_, i) => `packages/web/src/long/path/${i < 8 ? 'file-a.js' : 'file-b.js'}:${i + 1}:snippet ${i}: значение`);
  const input = rows.join('\n') + '\n';
  const out = groupSearchHits(input);
  assert.ok(out.includes('file-a.js (8 hits):'));
  assert.ok(out.includes('file-b.js (8 hits):'));
  for (let i = 0; i < rows.length; i++) assert.ok(out.includes(`  L${i + 1}: snippet ${i}: значение\n`));
  assert.ok(bytes(out) < bytes(input));
  assert.equal(groupSearchHits(rows.slice(0, 11).join('\n')), rows.slice(0, 11).join('\n'));
  assert.equal(groupSearchHits(input + 'warning: failed\n'), input + 'warning: failed\n');
  const short = Array.from({ length: 12 }, (_, i) => `x:${i}:y`).join('\n');
  assert.equal(groupSearchHits(short), short);
});

test('composite is deterministic and non-expanding for UTF-8 and malformed data', () => {
  const cases = ['', '😀', '{"node_id":"😀😀😀😀","title":"тест"}', 'plain\ntext', 'x:1:😀\n'.repeat(12)];
  for (const input of cases) {
    for (const transform of [s => collapsePassingRuns(s).text, stripJsonBoilerplate, groupSearchHits, compactCliOutput]) {
      const out = transform(input);
      assert.equal(out, transform(input));
      assert.ok(bytes(out) <= bytes(input));
    }
  }
});

test('deep JSON and long non-matching output are handled without recursion or regex blowups', () => {
  const deep = '['.repeat(20000) + '{"node_id":"discard this long identifier","title":"ok"}' + ']'.repeat(20000);
  const out = stripJsonBoilerplate(deep);
  assert.doesNotThrow(() => JSON.parse(out));
  assert.ok(!out.includes('node_id'));
  const line = 'name::'.repeat(20000) + 'no match';
  assert.equal(collapsePassingRuns(line).text, line);
});
