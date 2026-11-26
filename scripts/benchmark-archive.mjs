// Benchmark a local, saved Arena HTML page without putting it in the repository.
// The HTML is parsed by jsdom with embedded scripts disabled. Only aggregate
// timings, byte counts and statistics are printed; transcript content stays local.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import os from 'node:os';

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/benchmark-archive.mjs /path/to/saved-arena.html [baseline-ref]');
const ref = process.argv[3] || '73a0cbb';
const html = readFileSync(file, 'utf8');
const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const old = p => execFileSync('git', ['show', `${ref}:${p}`], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
const norm = x => x.replace(/^- Exported: .*$/m, '- Exported: <timestamp>');
const median = a => [...a].sort((a,b) => a-b)[Math.floor(a.length/2)];
async function bench(fn) {
  await fn();
  const times = []; let result;
  for (let i = 0; i < 3; i++) { const t = performance.now(); result = await fn(); times.push(performance.now() - t); }
  return { result, ms: median(times), times };
}
const fmt = n => n.toFixed(1);
function page(get) {
  const d = new JSDOM(html, { url: 'https://arena.ai/agent/benchmark', runScripts: 'outside-only' });
  d.window.TextEncoder = TextEncoder;
  for (const n of ['selectors', 'util', 'markdown', 'serialize'])
    vm.runInContext(get(`extension/content/${n}.js`), d.getInternalVMContext(), {filename: n+'.js'});
  if (!d.window.AREX.logEl()) throw new Error('No transcript log in HTML');
  return d;
}
// The compression modules in popup.html order; a baseline ref may only have compress.js.
function compression(get, files) {
  const c = { TextEncoder }; c.window = c; vm.createContext(c);
  for (const file of files) vm.runInContext(get('extension/content/' + file), c);
  return c.AREX;
}
console.log(`Node ${process.version}; ${os.platform()} ${os.arch()}; ${os.cpus()[0]?.model}`);
console.log(`HTML ${Buffer.byteLength(html)} B; median of 3 after 1 warm-up; jsdom, static saved DOM; baseline ${ref}.`);
let d = page(read), a = d.window.AREX;
console.log(`DOM nodes ${d.window.document.querySelectorAll('*').length}; log nodes ${a.logEl().querySelectorAll('*').length}; messages ${a.messages(a.logEl()).length}; expanded buttons ${a.logEl().querySelectorAll('button[aria-expanded="true"]').length}.`);
const current = await bench(() => a.serialize(a.logEl()));
const markdown = current.result;
console.log(`Current synchronous serialize: ${fmt(current.ms)} ms; markdown ${Buffer.byteLength(markdown)} B.`);
// Verify the asynchronous message walker on precisely the same static snapshot.
const opts = {}; const pieces = [];
for (const message of a.messages(a.logEl())) pieces.push(await a.serializeMessageAsync(message, opts));
const asynchronous = [a.serializeHeader(pieces.length), ...pieces].join('\n\n') + '\n';
if (norm(asynchronous) !== norm(markdown)) throw new Error('Async/sync serialization differs');
console.log('Async message walker parity: yes (static DOM, no expansion).');
d.window.close(); d = null; a = null;
if (global.gc) global.gc();
d = page(old); a = d.window.AREX;
const prior = await bench(() => a.serialize(a.logEl()));
const same = norm(prior.result) === norm(markdown);
console.log(`Baseline synchronous serialize: ${fmt(prior.ms)} ms; speedup ${(prior.ms/current.ms).toFixed(2)}x; normalized byte parity ${same ? 'yes' : 'NO'}.`);
if (!same) throw new Error('Baseline/current serialization differs');
d.window.close(); d = null; a = null;
if (global.gc) global.gc();
const pipeline = [...read('extension/popup/popup.html').matchAll(/<script src="\.\.\/content\/(compress[\w-]*\.js)"/g)].map(match => match[1]);
const modern = compression(read, pipeline), legacy = compression(old, ['compress.js']);
const index = await bench(() => modern.buildMarkdownIndex(markdown));
console.log(`Index: ${fmt(index.ms)} ms; blocks ${index.result.blocks.length}.`);
let lastBytes = Infinity; const outputs = {};
for (const mode of ['off','lossless','smart','stubs']) {
  const next = await bench(() => modern.compressIndex(index.result, {mode}));
  const r = next.result; outputs[mode] = r;
  if (r.bytes !== Buffer.byteLength(r.markdown) || r.bytes > lastBytes) throw new Error(`Bad byte count or non-monotonic result: ${mode}`);
  lastBytes = r.bytes;
  const before = await bench(() => legacy.compressMarkdown(markdown, {mode}));
  if (before.result.bytes !== Buffer.byteLength(before.result.markdown)) throw new Error(`Bad baseline byte count: ${mode}`);
  console.log(`${mode}: current ${fmt(next.ms)} ms, ${r.bytes} B, saved ${(r.savedRatio*100).toFixed(2)}%, tokens ${r.estimatedTokens}, stats ${JSON.stringify(r.stats)}; baseline ${fmt(before.ms)} ms, ${before.result.bytes} B, saved ${(before.result.savedRatio*100).toFixed(2)}%.`);
}
// Stubs also tightens the log budget and shortens scripts, so its output no longer rebuilds the Smart output
// byte for byte. Validate each reference instead: a unique earlier anchor above a fence that holds the range,
// standing for lines the Smart output repeats.
const markerRe = /\[\.\.\. identical to lines (\d+)–(\d+) of earlier output #(arex-stubs-output-\d+)( \(excluding line numbers\))? \.\.\.\]/g;
{
  const smartText = modern.compressIndex(index.result, { mode: 'smart', condenseThoughts: false }).markdown;
  const text = outputs.stubs.markdown, sources = new Set();
  let count = 0;
  for (const match of text.matchAll(markerRe)) {
    const anchor = `<a id="${match[3]}"></a>\n`, at = text.indexOf(anchor);
    if (at < 0 || at > match.index || text.indexOf(anchor, at + 1) >= 0) throw new Error('Stubs anchor is missing, duplicated or later than its reference');
    const after = text.slice(at + anchor.length).replace(/^(?:<a id="[^"]+"><\/a>\n)+/, '');
    const open = /^\s*(`{3,}|~{3,})[^\n]*\n/.exec(after);
    if (!open) throw new Error('Stubs source anchor has no fence');
    const lines = after.slice(open[0].length, after.indexOf('\n' + open[1], open[0].length)).split('\n');
    const from = Number(match[1]), to = Number(match[2]);
    if (from < 1 || to < from || to > lines.length) throw new Error('Invalid Stubs source line range');
    if (!match[4] && smartText.split(lines.slice(from - 1, to).join('\n')).length - 1 < 2) throw new Error('Stubs reference stands for lines the Smart output does not repeat');
    sources.add(match[3]); count++;
  }
  console.log(`Stubs references: all sound; ${sources.size} sources, ${count} references.`);
}
console.log('Current indexed mode timings exclude index construction; baseline mode timings include its parsing. No Chrome UI, expansion, network or memory measurements.');
