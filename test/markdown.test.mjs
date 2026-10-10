import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './harness.mjs';

const conv = html => {
  const { document, AREX } = makeEnv({ html: `<div role="log">${html}</div>` });
  return AREX.mdConvert(document.querySelector('[role="log"]'));
};

test('headings, paragraphs, inline styles', () => {
  assert.equal(
    conv('<h3>Title</h3><p>some <strong>bold</strong> and <em>em</em> and <code>x = 1</code></p>'),
    '### Title\n\nsome **bold** and *em* and `x = 1`',
  );
});

test('nested lists with order and indent', () => {
  const md = conv('<ol><li><p>one</p><ul><li>sub a</li><li>sub b</li></ul></li><li><p>two</p></li></ol>');
  assert.equal(md, '1. one\n  - sub a\n  - sub b\n2. two');
});

test('pre fence grows past backticks in content', () => {
  const md = conv('<pre>```js\ncode\n```</pre>');
  assert.equal(md, '````\n```js\ncode\n```\n````');
});

test('tables become pipes', () => {
  const md = conv('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td><code>x|y</code></td></tr></table>');
  assert.equal(md, '| A | B |\n| --- | --- |\n| 1 | `x\\|y` |');
});

test('links, images, br, hr, blockquote', () => {
  const md = conv('<p><a href="https://x.dev">site</a><br>next</p><img src="data:image/png;base64,AAAA" alt="pic"><hr><blockquote><p>quote</p></blockquote>');
  assert.equal(md, '[site](https://x.dev)\nnext\n\n*[image: pic]*\n\n---\n\n> quote');
});

test('svg and buttons are skipped, text escaped', () => {
  const md = conv('<p>a * b [c]</p><p><svg><path d="M0"/></svg><button>Copy</button>keep</p>');
  assert.equal(md, 'a \\* b \\[c\\]\n\nkeep');
});

test('ol start attribute', () => {
  assert.equal(conv('<ol start="5"><li>five</li><li>six</li></ol>'), '5. five\n6. six');
});
