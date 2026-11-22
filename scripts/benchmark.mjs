// Reproducible regression benchmark; no production data and no browser UI timing.
// Baseline defaults to the last pre-windowing commit. A shallow checkout may
// lack it; current measurements still work in that case.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import os from 'node:os';

const baselineRef = process.argv.find(v => v.startsWith('--baseline-ref='))?.split('=')[1] || '73a0cbb';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
function baseline(path) {
  try { return execFileSync('git', ['show', baselineRef + ':' + path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
}
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
async function measure(fn, runs = 3) {
  await fn(); // one warm-up
  const timings = [];
  let result;
  for (let i = 0; i < runs; i++) { const start = performance.now(); result = await fn(); timings.push(performance.now() - start); }
  return { ms: median(timings), result };
}
const ms = n => `${n.toFixed(1)} ms`;
const norm = text => text.replace(/^- Exported: .*$/m, '- Exported: <ts>');
const fixture = read('test/fixtures/arena-transcript.html');
const expected = read('test/snapshots/fixture-expected.md');
const fixtureUrl = 'https://arena.ai/agent/01a125f9-92b4-7e1a-a13a-b2e1bc5ffd61';
function domWithSources(getSource) {
  const dom = new JSDOM(`<!doctype html><main>${fixture}</main>`, { url: fixtureUrl, runScripts: 'outside-only' });
  dom.window.TextEncoder = TextEncoder;
  for (const name of ['selectors', 'util', 'markdown', 'serialize']) {
    const src = getSource(`extension/content/${name}.js`);
    if (!src) { dom.window.close(); return null; }
    vm.runInContext(src, dom.getInternalVMContext(), { filename: name + '.js' });
  }
  return dom;
}
function compressWithSource(src) {
  if (!src) return null;
  const sandbox = { TextEncoder }; sandbox.window = sandbox;
  vm.createContext(sandbox); vm.runInContext(src, sandbox);
  return sandbox.AREX;
}

console.log('Arena performance regression benchmark');
console.log(`Node ${process.version}; ${os.platform()} ${os.arch()}; ${os.cpus()[0]?.model || 'CPU unknown'}`);
console.log('Median of 3 measured runs after 1 warm-up; jsdom/Node, not real-browser latency.');
const currentDom = domWithSources(read), oldDom = domWithSources(baseline);
const current = currentDom.window.AREX;
const now = await measure(() => current.serialize(current.logEl()));
if (norm(now.result) !== expected) throw new Error('Current serializer does not match the committed snapshot');
console.log(`Fixture: HTML ${Buffer.byteLength(fixture)} B; output ${Buffer.byteLength(now.result)} B; 9 messages.`);
console.log(`Current synchronous serializer: ${ms(now.ms)}; byte parity with snapshot: yes.`);
if (oldDom) {
  const old = oldDom.window.AREX, prior = await measure(() => old.serialize(old.logEl()));
  const equal = norm(prior.result) === norm(now.result);
  console.log(`Baseline ${baselineRef} serializer: ${ms(prior.ms)}; speedup ${(prior.ms / now.ms).toFixed(2)}x; parity ${equal ? 'yes' : 'NO'}.`);
  if (!equal) throw new Error('Baseline/current serializer outputs differ');
  oldDom.window.close();
} else console.log(`Baseline ${baselineRef} unavailable locally; comparison skipped.`);

const modern = compressWithSource(read('extension/content/compress.js'));
const legacy = compressWithSource(baseline('extension/content/compress.js'));
// A deterministic ~2 MB workload made by repeating the existing committed
// snapshot; it is deliberately duplicate-heavy and not the user's Archive.zip.
const markdown = expected.repeat(24);
console.log(`Synthetic Markdown: ${Buffer.byteLength(markdown)} B; 24 copies of the fixture snapshot (duplicate-heavy).`);
const newMeasure = await measure(() => modern.measureMarkdown(markdown));
if (legacy) {
  const oldMeasure = await measure(() => legacy.measureMarkdown(markdown));
  if (newMeasure.result.estimatedTokens !== oldMeasure.result.estimatedTokens) throw new Error('Token estimate parity failure');
  console.log(`Token estimate: baseline ${ms(oldMeasure.ms)}, current ${ms(newMeasure.ms)}, ${(oldMeasure.ms / newMeasure.ms).toFixed(2)}x; parity yes.`);
} else console.log(`Token estimate current: ${ms(newMeasure.ms)}.`);
const indexed = await measure(() => modern.buildMarkdownIndex(markdown));
console.log(`Index: ${ms(indexed.ms)}; ${indexed.result.blocks.length} fenced blocks.`);
const outputs = {};
for (const mode of ['off', 'lossless', 'smart', 'stubs']) {
  const r = await measure(() => modern.compressIndex(indexed.result, { mode }));
  if (r.result.bytes !== Buffer.byteLength(r.result.markdown)) throw new Error('Incorrect UTF-8 byte count');
  outputs[mode] = r.result;
  console.log(`Indexed ${mode}: ${ms(r.ms)}, ${r.result.bytes} B, saved ${(r.result.savedRatio * 100).toFixed(1)}%.`);
}
const modes = ['off', 'lossless', 'smart', 'stubs'];
for (let i = 1; i < modes.length; i++) if (outputs[modes[i]].bytes > outputs[modes[i - 1]].bytes) throw new Error('Compression monotonicity failure');
const cache = new Map(Object.entries(outputs));
const lookup = await measure(() => { for (let i = 0; i < 100000; i++) cache.get(modes[i % 4]); }, 3);
console.log(`100,000 in-memory cache lookups: ${ms(lookup.ms)} (not a Worker/UI round trip).`);
// Initial no-marker probe plus final settle, with default production timeouts.
const probeDom = new JSDOM('<div role="log"><div data-agent-transcript-message></div></div>', { url: fixtureUrl, runScripts: 'outside-only' });
probeDom.window.TextEncoder = TextEncoder;
for (const name of ['selectors', 'util', 'loader']) vm.runInContext(read(`extension/content/${name}.js`), probeDom.getInternalVMContext());
const start = performance.now();
const history = await probeDom.window.AREX.loadFullHistory(probeDom.window.AREX.logEl());
console.log(`No-sentinel history probe: ${ms(performance.now() - start)}; stable=${history.stable} (includes 150 ms probe + 100 ms settle).`);
probeDom.window.close(); currentDom.window.close();
console.log('Archive.zip, browser memory, Worker round-trip latency and main-thread responsiveness were not measured.');
