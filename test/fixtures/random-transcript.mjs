// Seeded generator of multi-turn Arena transcripts for the compression property tests.
//
// 100% synthetic and deterministic: the same seed always yields the same Markdown. Every turn mixes the shapes
// the pipeline has to keep apart: long clean output, wide lines, terminal noise, test runs with and without
// failures, search hits, JSON, tracebacks and compiler errors (with and without a failing exit heading), stderr,
// git diffs, inline scripts, file reads and writes, Thought drafts, and code in User and assistant prose that
// repeats earlier tool output (which must never be rewritten).

const FENCE = String.fromCharCode(96).repeat(3);
const fence = (body, lang = 'text') => `${FENCE}${lang}\n${body}\n${FENCE}`;

export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// `proseFences` lists the code fences the generator wrote into User and assistant prose, verbatim: the oracle
// for what no compression mode may rewrite. Prose that directly follows a Thought has no heading of its own, so
// the Markdown cannot tell it from the Thought; its fences are listed apart in `gluedFences`.
export function randomTranscript(seed, options = {}) {
  return generate(seed, options).markdown;
}

export function randomTranscriptWithMeta(seed, options = {}) {
  return generate(seed, options);
}

function generate(seed, { turns = null } = {}) {
  const rnd = seededRandom(seed);
  const proseFences = [], gluedFences = [];
  let afterThought = false;
  const int = (low, high) => low + Math.floor(rnd() * (high - low + 1));
  const pick = list => list[int(0, list.length - 1)];
  const chance = p => rnd() < p;

  // A few source files whose lines recur across reads, writes, drafts and quotes.
  const files = Array.from({ length: 4 }, (_, k) => ({
    path: `src/mod${k}.py`,
    lines: Array.from({ length: int(12, 90) }, (_, i) => `def mod${k}_fn${i}(request): return validate(request, limit=${i * 7 + k})`),
  }));
  const variant = lines => {
    const copy = [...lines];
    if (chance(0.35)) copy[int(0, copy.length - 1)] = `changed_${int(0, 99)}()`;
    return chance(0.3) ? copy.slice(int(0, 3), copy.length - int(0, 3)) : copy;
  };
  const gutter = lines => lines.map((line, i) => `${String(i + 1).padStart(6)}\t${line}`);
  const prose = (tag, length) => {
    let text = tag + int(0, 9999) + ':';
    while (text.length < length) text += ' reasoning' + int(0, 9);
    return text.slice(0, length) + '.';
  };

  const card = (command, stdout, { heading = 'used Bash ' + int(5, 900) + 'ms', stderr = null } = {}) => {
    const parts = [`##### ${heading}`, `**command:**\n\n${fence('$ ' + command, 'bash')}`];
    if (stdout !== null) parts.push(`**stdout:**\n\n${fence(stdout)}`);
    if (stderr !== null) parts.push(`**stderr:**\n\n${fence(stderr)}`);
    return parts.join('\n\n');
  };
  const ran = (...cards) => `#### Ran commands ${cards.length}\n\n${cards.join('\n\n')}`;

  const fileLines = () => pick(files);
  const outputs = [
    // file reads, numbered or not, whole or sliced
    () => { const f = fileLines(); return ran(card('cat ' + f.path, variant(f.lines).join('\n'))); },
    () => { const f = fileLines(); return ran(card('cat -n ' + f.path, gutter(variant(f.lines)).join('\n'))); },
    () => { const f = fileLines(); const a = int(0, 8); return ran(card(`sed -n '${a + 1},${a + 40}p' ${f.path}`, f.lines.slice(a, a + 40).join('\n'))); },
    () => { const f = fileLines(); return `#### Used Read ${f.path} ${int(2, 40)}ms\n\n${fence(variant(f.lines).join('\n'))}`; },
    () => { const f = fileLines(); return `#### Edited ${f.path}\n\n**📄 ${f.path}** _(python)_\n\n${fence(variant(f.lines).join('\n'), 'python')}`; },
    () => { const f = fileLines(); return ran(card(`cat > ${f.path} <<'EOF'\n${variant(f.lines).join('\n')}\nEOF`, '(no output)')); },
    // very long, wide and noisy clean output
    () => ran(card('find . -name "*.py"', Array.from({ length: int(60, 400) }, (_, i) => `./pkg/sub${i % 9}/module_${i}.py`).join('\n'))),
    () => ran(card('cat data.json | head -1', 'x'.repeat(int(300, 2500)))),
    () => ran(card('make build', Array.from({ length: int(30, 120) }, (_, i) => `\u001b[32mcompiling unit ${i}\u001b[0m\r\n\r⠋ working`).join('\n'))),
    () => ran(card('rg handler src/', Array.from({ length: int(12, 60) }, (_, i) => `src/mod${i % 4}.py:${i * 3 + 1}:    return handler_${i}(request)`).join('\n'))),
    () => ran(card('gh api repos/o/r/issues/1', JSON.stringify({ id: 1, title: 'issue', avatar_url: 'https://x/a.png', followers_url: 'https://x/f', labels_url: 'https://x/l{/name}', user: { login: 'u', node_id: 'n', gravatar_id: '' }, body: 'text '.repeat(int(5, 60)) }, null, 2))),
    // identifiers that merely contain error words
    () => ran(card('grep -rn Error src/', Array.from({ length: int(12, 30) }, (_, i) => `src/errors.py:${i + 1}:class W${i}Error(Exception): pass  # pointError`).join('\n'))),
    // tests
    () => ran(card('pytest -q', Array.from({ length: int(8, 80) }, (_, i) => `tests/test_${i % 5}.py ${'.'.repeat(int(3, 30))} [ ${Math.min(99, i)}%]`).join('\n') + '\n== 12 passed in 1.2s ==')),
    () => ran(card('pytest -q', [...Array.from({ length: int(5, 40) }, (_, i) => `tests/test_${i % 5}.py ..F.. [ ${i}%]`), '=== FAILURES ===', '___ test_widget ___', 'E   AssertionError: expected 3 got 4', 'FAILED tests/test_1.py::test_widget - AssertionError', '== 1 failed in 0.4s =='].join('\n'), { heading: 'used Bash exit 1 ' + int(100, 900) + 'ms' })),
    // failures
    () => ran(card('python app.py', Array.from({ length: int(60, 200) }, (_, i) => `log line ${i}: starting step`).join('\n') + '\nTraceback (most recent call last):\n  File "app.py", line 3, in <module>\n    main()\nValueError: boom', { heading: 'used Bash exit 1 ' + int(10, 300) + 'ms' })),
    () => ran(card('gcc -c a.c', Array.from({ length: int(14, 40) }, (_, i) => `src/a.c:${i + 3}:5: error: unknown type name 'T${i}'`).join('\n'))),
    () => ran(card('cat missing.py', null, { heading: 'used Bash exit 1 ' + int(5, 90) + 'ms', stderr: 'cat: missing.py: No such file or directory' })),
    () => ran(card('npm run lint', Array.from({ length: int(40, 100) }, (_, i) => `warning: unused variable ${i}`).join('\n'), { stderr: 'npm ERR! lint failed' })),
    // clean scripts and diffs with an explicit exit 0
    () => ran(card(`python3 - <<'PY'\n${Array.from({ length: int(30, 90) }, (_, i) => `value_${i} = compute(${i})`).join('\n')}\nprint("done")\nPY`, 'done', { heading: 'used Bash exit 0 ' + int(20, 300) + 'ms' })),
    () => { const n = int(20, 60); return ran(card('git diff', ['diff --git a/f.py b/f.py', '--- a/f.py', '+++ b/f.py', `@@ -1,${n} +1,${n} @@`, ...Array.from({ length: n }, (_, i) => (i === 7 ? '-old_line()' : i === 8 ? '+new_line()' : ` context line number ${i}`))].join('\n'), { heading: 'used Bash exit 0 ' + int(20, 300) + 'ms' })); },
    // repeated identical output
    () => ran(card('ls -la', Array.from({ length: 14 }, (_, i) => `-rw-r--r-- 1 user user 4096 Jan ${i + 1} file-${i}.txt`).join('\n'))),
  ];

  const thought = () => {
    const f = fileLines();
    const blocks = Array.from({ length: int(2, 9) }, () => {
      const kind = rnd();
      if (kind < 0.3) return `${pick(['Draft:', 'Code:'])}\n${fence(variant(f.lines).join('\n'), 'python')}`;
      if (kind < 0.4) return fence(variant(f.lines).join('\n'), 'python');
      return prose('step', int(80, 700));
    });
    return `#### Thought for ${int(1, 90)}s\n\n${blocks.join('\n\n')}`;
  };

  const quoted = () => {
    const f = fileLines();
    const block = fence(variant(f.lines).join('\n'), pick(['python', 'text', '']));
    (afterThought ? gluedFences : proseFences).push(block);
    return block;
  };

  const parts = ['# Branch'];
  const turnCount = turns ?? int(1, 4);
  for (let turn = 0; turn < turnCount; turn++) {
    const ask = [prose('ask', int(40, 200))];
    if (chance(0.5)) ask.push(quoted());
    parts.push(`## 👤 User\n\n${ask.join('\n\n')}`);
    const body = ['## 🤖 Assistant'];
    for (let step = 0, steps = int(1, 9); step < steps; step++) {
      const kind = rnd();
      afterThought = kind < 0.35;
      body.push(afterThought ? thought() : pick(outputs)());
      if (chance(0.12)) body.push(chance(0.5) ? prose('note', int(60, 200)) : `${prose('here', 60)}\n\n${quoted()}`);
      afterThought = false;
    }
    if (chance(0.85)) body.push(chance(0.5) ? prose('answer', int(60, 300)) : `${prose('fix', 60)}\n\n${quoted()}\n\n${prose('done', 40)}`);
    parts.push(body.join('\n\n'));
  }
  return { markdown: parts.join('\n\n'), proseFences, gluedFences };
}
