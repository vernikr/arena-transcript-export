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
function compression(get) {
  const c = { TextEncoder }; c.window = c; vm.createContext(c);
  vm.runInContext(get('extension/content/compress.js'), c);
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
const modern = compression(read), legacy = compression(old);
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
// Verify that Stubs' additional references reconstruct the complete Smart
// output. This does not undo Smart's deliberately lossy transformations.
const anchorRe = /<a id="arex-stubs-output-(\d+)"><\/a>\n/g;
const markerRe = /\[\.\.\. identical to lines (\d+)–(\d+) of earlier output #arex-stubs-output-(\d+) \.\.\.\]/g;
if (outputs.smart.markdown.match(anchorRe) || outputs.smart.markdown.match(markerRe)) {
  console.log('Stubs reconstruction skipped: input already contains reserved marker syntax.');
} else {
  const text = outputs.stubs.markdown, blocks = modern.buildMarkdownIndex(text).blocks, sources = new Map();
  for (const match of text.matchAll(anchorRe)) {
    const block = blocks.find(b => b.startOffset >= match.index + match[0].length);
    if (!block || block.startOffset - match.index > 200) throw new Error('Stubs source anchor has no nearby fence');
    sources.set(match[1], block.body.split('\n'));
  }
  let count = 0;
  const reconstructed = text.replace(markerRe, (_, first, last, id) => {
    const lines = sources.get(id), from = Number(first), to = Number(last);
    if (!lines || from < 1 || to < from || to > lines.length) throw new Error('Invalid Stubs source line range');
    count++; return lines.slice(from - 1, to).join('\n');
  }).replace(anchorRe, '');
  if (reconstructed !== outputs.smart.markdown) throw new Error('Stubs cannot be reconstructed to the Smart output');
  console.log(`Stubs reconstruction to Smart: exact; ${sources.size} sources, ${count} references (Smart is lossy).`);
}
console.log('Current indexed mode timings exclude index construction; baseline mode timings include its parsing. No Chrome UI, expansion, network or memory measurements.');
