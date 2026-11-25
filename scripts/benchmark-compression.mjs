// Realistic multi-turn compression benchmark with invariant and
// monotonicity/reconstruction checks.
//
// Default input is the deterministic synthetic coding-session fixture in
// test/fixtures/synthetic-coding-session.mjs (zero private text). Pass local
// .md files or directories as arguments to benchmark saved Arena transcripts
// instead; only aggregate byte counts, token estimates, saved percentages and
// timings are printed, never transcript content.
//
// For each input document the script:
//   1. builds the Markdown index and measures its latency,
//   2. runs every compression mode (off, lossless, smart, stubs) and measures
//      the per-mode latency (the work the extension Worker performs),
//   3. reports exact UTF-8 bytes, estimated tokens and saved % per mode,
//   4. verifies invariants survive every mode:
//        - 100% of User turns are present,
//        - the final Assistant answer is preserved byte-for-byte,
//        - exit != 0 headings and traceback/exception/FAILED diagnostics
//          survive unchanged,
//   5. enforces strict monotonicity Off >= Lossless >= Smart >= Stubs,
//   6. reconstructs the Stubs output back to the Smart output exactly.
//
// Any invariant or monotonicity violation exits non-zero.

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

function loadCompression() {
  const sandbox = { TextEncoder };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('extension/content/compress.js'), sandbox, { filename: 'compress.js' });
  return sandbox.AREX;
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

// Stubs output must reconstruct exactly to the Smart output by expanding the
// reserved markers back to their source lines and dropping the anchors. This
// does not undo Smart's deliberately lossy transformations.
const ANCHOR_RE = /<a id="arex-stubs-output-(\d+)"><\/a>\n/g;
const MARKER_RE = /\[\.\.\. identical to lines (\d+)–(\d+) of earlier output #arex-stubs-output-(\d+) \.\.\.\]/g;
function reconstructStubsToSmart(arex, smartMarkdown, stubsMarkdown) {
  if (smartMarkdown.match(ANCHOR_RE) || smartMarkdown.match(MARKER_RE)) {
    return { skipped: 'input already contains reserved marker syntax' };
  }
  const blocks = arex.buildMarkdownIndex(stubsMarkdown).blocks;
  const sources = new Map();
  for (const match of stubsMarkdown.matchAll(ANCHOR_RE)) {
    const block = blocks.find(b => b.startOffset >= match.index + match[0].length);
    if (!block || block.startOffset - match.index > 200) {
      throw new Error('Stubs source anchor has no nearby fence');
    }
    sources.set(match[1], block.body.split('\n'));
  }
  let count = 0;
  const reconstructed = stubsMarkdown
    .replace(MARKER_RE, (_, first, last, id) => {
      const lines = sources.get(id);
      const from = Number(first);
      const to = Number(last);
      if (!lines || from < 1 || to < from || to > lines.length) {
        throw new Error('Invalid Stubs source line range');
      }
      count += 1;
      return lines.slice(from - 1, to).join('\n');
    })
    .replace(ANCHOR_RE, '');
  if (reconstructed !== smartMarkdown) {
    throw new Error('Stubs cannot be reconstructed to the Smart output');
  }
  return { skipped: null, sources: sources.size, references: count };
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

  const outputs = {};
  const timings = {};
  for (const mode of MODES) {
    const r = await measure(() => arex.compressIndex(indexed.result, { mode }));
    const result = r.result;
    if (result.bytes !== Buffer.byteLength(result.markdown)) {
      throw new Error(`Incorrect UTF-8 byte count for mode ${mode}`);
    }
    outputs[mode] = result;
    timings[mode] = r.ms;
    console.log(`  ${mode.padEnd(8)}: ${ms(r.ms).padStart(9)}, ${result.bytes} B, saved ${pct(result.savedRatio)}, ` +
      `tokens ${result.estimatedTokens}, stats ${JSON.stringify(result.stats)}`);
  }

  // Strict monotonicity: Off >= Lossless >= Smart >= Stubs by byte size.
  for (let i = 1; i < MODES.length; i++) {
    const prev = MODES[i - 1];
    const cur = MODES[i];
    if (outputs[cur].bytes > outputs[prev].bytes) {
      throw new Error(`Monotonicity violation: ${cur} (${outputs[cur].bytes} B) > ${prev} (${outputs[prev].bytes} B)`);
    }
  }
  console.log('  Monotonicity Off >= Lossless >= Smart >= Stubs: yes.');

  // Invariants must survive every mode.
  for (const mode of MODES) {
    const failures = invariantFailures(markdown, outputs[mode].markdown, originalInv);
    if (failures.length) {
      throw new Error(`Invariant violation in ${mode} mode: ${failures.join('; ')}`);
    }
  }
  console.log('  Invariants (User turns, final Assistant answer, diagnostics, exit!=0): preserved in all modes.');

  // Stubs -> Smart reconstruction harness.
  const reconstruction = reconstructStubsToSmart(arex, outputs.smart.markdown, outputs.stubs.markdown);
  if (reconstruction.skipped) {
    console.log(`  Stubs reconstruction: skipped (${reconstruction.skipped}).`);
  } else {
    console.log(`  Stubs reconstruction to Smart: exact; ${reconstruction.sources} sources, ${reconstruction.references} references.`);
  }
  return { originalBytes, outputs, timings };
}

console.log('Arena compression benchmark (realistic multi-turn session)');
console.log(`Node ${process.version}; ${os.platform()} ${os.arch()}; ${os.cpus()[0]?.model || 'CPU unknown'}`);
console.log('Median of 3 measured runs after 1 warm-up; in-process (extension Worker work), not browser UI latency.');

const arex = loadCompression();
const args = process.argv.slice(2);
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
}
const elapsed = performance.now() - totalStart;
console.log('');
console.log(`Completed in ${ms(elapsed)}. No invariant, monotonicity or reconstruction violations.`);
console.log('Note: Worker message round-trip, browser memory and network latency were not measured.');
