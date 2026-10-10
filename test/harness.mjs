// Loads the extension content scripts into a jsdom window and returns the AREX namespace.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const FILES = ['selectors.js', 'util.js', 'markdown.js', 'serialize.js', 'loader.js', 'expand.js', 'main.js'];

export function makeEnv({ html = '<div role="log"></div>', url = 'https://arena.ai/agent/u-1' } = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body><main>${html}</main></body></html>`, {
    url,
    runScripts: 'outside-only',
  });
  const ctx = dom.getInternalVMContext();
  for (const f of FILES) {
    const src = readFileSync(new URL(`../extension/content/${f}`, import.meta.url), 'utf8');
    vm.runInContext(src, ctx, { filename: f });
  }
  return { dom, window: dom.window, AREX: dom.window.AREX, document: dom.window.document };
}

export function fixtureHtml() {
  return readFileSync(new URL('./fixtures/arena-transcript.html', import.meta.url), 'utf8');
}
