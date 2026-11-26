// Realistic multi-turn compression benchmark with invariant, monotonicity and reference checks.
//
// Default input is the deterministic synthetic coding-session fixture in
// test/fixtures/synthetic-coding-session.mjs (zero private text). Pass local
// .md files or directories as arguments to benchmark saved Arena transcripts
// instead; only aggregate byte counts, token estimates, saved percentages and
// timings are printed, never transcript content.
//
// The whole compression stack is loaded in popup.html order into the main
// context, which behaves like the Worker's global scope. (A vm.createContext
// sandbox makes hot loops that touch globals ~60x slower, so timings recorded
// before this script loaded the modules that way are not comparable.)
//
// For each input document the script:
//   1. builds the Markdown index and measures its latency,
//   2. runs every compression mode (off, lossless, smart, stubs) with and
//      without the reasoning stage, and measures the per-mode latency (the work
//      the extension Worker performs),
//   3. reports exact UTF-8 bytes, estimated tokens and saved % per mode,
//   4. verifies invariants survive every mode and toggle state:
//        - 100% of User turns are present,
//        - the final Assistant answer is preserved byte-for-byte,
//        - exit != 0 headings and traceback/exception/FAILED diagnostics
//          survive unchanged,
//   5. enforces strict monotonicity Off >= Lossless >= Smart >= Stubs,
//   6. validates every Stubs reference: its anchor is unique and earlier, its
//      line range lies inside the source, and the lines it stands for are
//      repeated in the Smart output.
//
// Without arguments it also runs a ~3.5 MB scale check of the Worker work
// against the 120 ms budget (reported; pass --strict to fail when it is missed).
//
// Any invariant, monotonicity or reference violation exits non-zero.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import vm from 'node:vm';
import os from 'node:os';
import {
  generateSyntheticCodingSession,
  extractInvariants,
  sessionByteShares,
} from '../test/fixtures/synthetic-coding-session.mjs';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

// Every compression module, in the order popup.html loads them.
function loadCompression() {
  const files = [...read('extension/popup/popup.html').matchAll(/<script src="\.\.\/content\/(compress[\w-]*\.js)"/g)].map(match => match[1]);
  if (!files.length) throw new Error('popup.html lists no compression scripts');
  for (const file of files) vm.runInThisContext(read('extension/content/' + file), { filename: file });
  return globalThis.AREX;
}

const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
async function measure(fn, runs = 3) {
  await fn(); // one warm-up
  const times = [];
  let result;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    result = await fn();
    times.push(performance.now() - start);
  }
  return { result, ms: median(times) };
}
const ms = n => `${n.toFixed(1)} ms`;
const BUDGET_MS = 120;
const pct = r => `${(r * 100).toFixed(2)}%`;

// Collect .md inputs from CLI arguments (files or directories, recursive).
function collectInputs(args) {
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = dir + '/' + entry.name;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
    }
  };
  for (const arg of args) {
    const stat = statSync(arg);
    if (stat.isDirectory()) walk(arg);
    else if (stat.isFile() && arg.endsWith('.md')) files.push(arg);
    else throw new Error(`Unsupported input (expected a .md file or a directory): ${arg}`);
  }
  return files;
}

// Invariant checks that must hold for every compression mode.
function invariantFailures(original, output, originalInv) {
  const outInv = extractInvariants(output);
  const failures = [];
  if (outInv.userHeadingCount !== originalInv.userHeadingCount) {
    failures.push(`User turn count changed: ${originalInv.userHeadingCount} -> ${outInv.userHeadingCount}`);
  }
  if (outInv.assistantHeadingCount !== originalInv.assistantHeadingCount) {
    failures.push(`Assistant turn count changed: ${originalInv.assistantHeadingCount} -> ${outInv.assistantHeadingCount}`);
  }
  if (outInv.finalAssistant !== originalInv.finalAssistant) {
    failures.push(`Final Assistant answer changed (${originalInv.finalAssistant.length} -> ${outInv.finalAssistant.length} chars)`);
  }
  let missingDiag = 0;
  for (const line of originalInv.diagnostics) {
    if (!output.includes(line)) missingDiag += 1;
  }
  if (missingDiag) failures.push(`${missingDiag} diagnostic line(s) missing (traceback/exception/FAILED)`);
  let missingExit = 0;
  for (const heading of originalInv.exitHeadings) {
    if (!output.includes(heading)) missingExit += 1;
  }
  if (missingExit) failures.push(`${missingExit} exit!=0 heading(s) missing`);
  return failures;
}

// Every reference Stubs wrote must be sound: its anchor is unique and earlier than the marker (later, for a
// draft pointer), sits above a fence that holds the referenced line range, and the lines it stands for are
// repeated in the Smart output (the pipeline matched them there). Stubs also tightens the log budget and shortens
// scripts, so its output no longer rebuilds the Smart output byte for byte; this checks each reference instead.
const STUBS_MARKER = /\[\.\.\. (draft )?identical to lines (\d+)–(\d+) of (earlier|later) output #(arex-stubs-output-\d+)( \(excluding line numbers\))? \.\.\.\]/g;
function validateStubsReferences(stubsMarkdown, smartMarkdown) {
  let references = 0;
  const sources = new Set();
  for (const match of stubsMarkdown.matchAll(STUBS_MARKER)) {
    const [, draft, first, last, direction, id, numbered] = match;
    const anchor = `<a id="${id}"></a>\n`;
    const at = stubsMarkdown.indexOf(anchor);
    if (at < 0 || stubsMarkdown.indexOf(anchor, at + 1) >= 0) throw new Error(`Stubs anchor ${id} is missing or duplicated`);
    if ((direction === 'earlier') !== (at < match.index) || Boolean(draft) !== (direction === 'later')) {
      throw new Error(`Stubs reference to ${id} points the wrong way`);
    }
    const after = stubsMarkdown.slice(at + anchor.length).replace(/^(?:<a id="[^"]+"><\/a>\n)+/, '');
    const open = /^\s*(`{3,}|~{3,})[^\n]*\n/.exec(after);
    if (!open) throw new Error(`Stubs anchor ${id} is not above a fence`);
    const lines = after.slice(open[0].length, after.indexOf('\n' + open[1], open[0].length)).split('\n');
    const from = Number(first), to = Number(last);
    if (from < 1 || to < from || to > lines.length) throw new Error(`Invalid Stubs source line range ${from}-${to} of ${lines.length}`);
    if (!numbered && smartMarkdown.split(lines.slice(from - 1, to).join('\n')).length - 1 < 2) {
      throw new Error(`Stubs reference to ${id} stands for lines the Smart output does not repeat`);
    }
    sources.add(id);
    references += 1;
  }
  return { sources: sources.size, references };
}

const MODES = ['off', 'lossless', 'smart', 'stubs'];

async function benchDocument(arex, label, markdown) {
  const originalBytes = Buffer.byteLength(markdown);
  const originalInv = extractInvariants(markdown);
  const shares = sessionByteShares(markdown);

  console.log('');
  console.log(`Document: ${label}`);
  console.log(`  UTF-8 bytes: ${originalBytes} B; estimated tokens: ${arex.measureMarkdown(markdown).estimatedTokens}; ` +
    `User turns: ${originalInv.userHeadingCount}; Assistant turns: ${originalInv.assistantHeadingCount}; ` +
    `diagnostics: ${originalInv.diagnostics.length}; exit!=0 headings: ${originalInv.exitHeadings.length}`);
  console.log(`  Byte shares: Thought ${(shares.thoughtShare * 100).toFixed(1)}%, stdout ${(shares.stdoutShare * 100).toFixed(1)}%, ` +
    `command ${(shares.commandShare * 100).toFixed(1)}%, framing ${(shares.framingShare * 100).toFixed(1)}%.`);

  const indexed = await measure(() => arex.buildMarkdownIndex(markdown));
  console.log(`  Index build: ${ms(indexed.ms)}; ${indexed.result.blocks.length} fenced blocks.`);

  // The default run includes the reasoning stage; `kept` is the same pipeline with it switched off.
  const runs = [
    ...MODES.map(mode => ({ name: mode, mode, options: { mode } })),
    ...['smart', 'stubs'].map(mode => ({ name: `${mode} (reasoning kept)`, mode, options: { mode, condenseThoughts: false } })),
  ];
  const outputs = {};
  const timings = {};
  for (const run of runs) {
    const r = await measure(() => arex.compressIndex(indexed.result, run.options));
    const result = r.result;
    if (result.bytes !== Buffer.byteLength(result.markdown)) throw new Error(`Incorrect UTF-8 byte count for ${run.name}`);
    if (result.estimatedTokens !== arex.measureMarkdown(result.markdown).estimatedTokens) throw new Error(`Incorrect token count for ${run.name}`);
    outputs[run.name] = result;
    timings[run.name] = r.ms;
    console.log(`  ${run.name.padEnd(24)}: ${ms(r.ms).padStart(9)}, ${String(result.bytes).padStart(8)} B, saved ${pct(result.savedRatio).padStart(7)}, ` +
      `tokens ${result.estimatedTokens}, stats ${JSON.stringify(result.stats)}`);
  }

  // Strict monotonicity: Off >= Lossless >= Smart >= Stubs by byte size, with and without the reasoning stage.
  const chains = [MODES, ['off', 'lossless', 'smart (reasoning kept)', 'stubs (reasoning kept)']];
  for (const chain of chains) {
    for (let i = 1; i < chain.length; i++) {
      if (outputs[chain[i]].bytes > outputs[chain[i - 1]].bytes) {
        throw new Error(`Monotonicity violation: ${chain[i]} (${outputs[chain[i]].bytes} B) > ${chain[i - 1]} (${outputs[chain[i - 1]].bytes} B)`);
      }
    }
  }
  for (const mode of ['smart', 'stubs']) {
    if (outputs[mode].bytes > outputs[`${mode} (reasoning kept)`].bytes) throw new Error(`Reasoning stage grew ${mode}`);
  }
  console.log('  Monotonicity Off >= Lossless >= Smart >= Stubs: yes (with and without reasoning).');

  // Invariants must survive every mode and toggle state.
  for (const run of runs) {
    const failures = invariantFailures(markdown, outputs[run.name].markdown, originalInv);
    if (failures.length) {
      throw new Error(`Invariant violation in ${run.name}: ${failures.join('; ')}`);
    }
  }
  console.log('  Invariants (User turns, final Assistant answer, diagnostics, exit!=0): preserved in all modes.');

  const references = validateStubsReferences(outputs.stubs.markdown, outputs['smart (reasoning kept)'].markdown);
  console.log(`  Stubs references: all sound; ${references.sources} sources, ${references.references} references.`);
  return { originalBytes, outputs, timings };
}

// The Worker work for a ~3.5 MB snapshot: seven distinct copies of the fixture (digits shifted per copy so
// Lossless cannot collapse whole copies), which keeps the shape of the session at the size of the largest
// real exports.
async function benchScale(arex, strict) {
  const one = generateSyntheticCodingSession();
  let markdown = '';
  for (let copy = 0; copy < 7; copy++) {
    markdown += (copy ? '\n\n' : '') + one.replace(/\d+/g, digits => String((Number(digits) + copy * 7919) % 1000003));
  }
  const bytes = Buffer.byteLength(markdown);
  console.log('');
  console.log(`Scale check: ${(bytes / 1e6).toFixed(2)} MB snapshot (7 distinct copies of the fixture); budget ${BUDGET_MS} ms per mode in the Worker.`);
  const indexed = await measure(() => arex.buildMarkdownIndex(markdown), 3);
  console.log(`  Index build (once per snapshot, at INIT): ${ms(indexed.ms)}.`);
  let missed = false;
  for (const mode of ['lossless', 'smart', 'stubs']) {
    const run = await measure(() => arex.compressIndex(indexed.result, { mode }), 5);
    const within = run.ms < BUDGET_MS;
    missed ||= !within;
    console.log(`  ${mode.padEnd(8)}: ${ms(run.ms).padStart(9)}, saved ${pct(run.result.savedRatio)}, within ${BUDGET_MS} ms: ${within ? 'yes' : 'NO'}.`);
  }
  const base = arex.compressIndex(indexed.result, { mode: 'stubs', condenseThoughts: false });
  const toggle = await measure(() => arex.applyThoughtCondensation(base, { mode: 'stubs' }), 5);
  console.log(`  reasoning toggle on a cached Stubs base: ${ms(toggle.ms)}.`);
  if (missed && strict) throw new Error(`A mode exceeded the ${BUDGET_MS} ms Worker budget`);
  if (missed) console.log(`  Budget missed on this machine; rerun with --strict to make that fatal.`);
}

console.log('Arena compression benchmark (realistic multi-turn session)');
console.log(`Node ${process.version}; ${os.platform()} ${os.arch()}; ${os.cpus()[0]?.model || 'CPU unknown'}`);
console.log('Median of 3 measured runs after 1 warm-up; in-process (extension Worker work), not browser UI latency.');

const arex = loadCompression();
const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const strict = process.argv.includes('--strict');
const inputs = args.length ? collectInputs(args) : null;

let totalStart = performance.now();
if (inputs) {
  if (!inputs.length) throw new Error('No .md files found in the given directory(ies)');
  console.log(`Input: ${inputs.length} local .md file(s) from CLI arguments.`);
  for (const file of inputs) {
    const markdown = readFileSync(file, 'utf8');
    await benchDocument(arex, file, markdown);
  }
} else {
  const markdown = generateSyntheticCodingSession();
  console.log('Input: synthetic coding-session fixture (deterministic, zero private text).');
  await benchDocument(arex, 'synthetic-coding-session (fixture)', markdown);
  await benchScale(arex, strict);
}
const elapsed = performance.now() - totalStart;
console.log('');
console.log(`Completed in ${ms(elapsed)}. No invariant, monotonicity or reference violations.`);
console.log('Note: Worker message round-trip, browser memory and network latency were not measured.');
