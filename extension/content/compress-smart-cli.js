// Pure stdout transforms for the Smart pipeline. This module is deliberately
// standalone: Wave 4 wires it into the window/worker compression pipeline.
globalThis.AREX = globalThis.AREX || {};
(function () {
  function bytes(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 128) n++;
      else if (c < 2048) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }
  const smaller = (before, after) => bytes(after) < bytes(before) ? after : before;

  function passingLine(line) {
    // Bound regex work per row, including adversarial non-matching input. Long
    // rows are left untouched instead of risking pathological backtracking.
    if (line.length > 1024) return false;
    // Never fold diagnostics or runner summaries, even if they look like a
    // test name. Do not treat pytest skips/xfails or failures as passes.
    if (/\b(?:FAIL(?:ED|URES?)?|ERROR|traceback|exception|panic)\b/i.test(line)) return false;
    if (/^\s*(?:=+|-+)\s*(?:FAILURES|ERRORS|short test summary info)/i.test(line)) return false;
    if (/^\s*(?:\S+\.py\s+)?\.+\s+\[\s*\d+%\]\s*$/.test(line)) return true;
    if (/^\s*\(pass\)\s+\S/.test(line)) return true;
    if (/^\s*[✓✔]\s+\S/.test(line)) return true;
    // Node's info records may be folded only when they explicitly describe a
    // passing test, never its aggregate ℹ pass/fail/duration footer.
    if (/^\s*ℹ\s+(?:test\s+.+\s+\.\.\.\s+ok)\s*$/.test(line)) return true;
    if (/^\s*PASS\s+\S/.test(line)) return true;
    if (/^\s*test\s+\S+\s+\.\.\.\s+ok\s*$/.test(line)) return true;
    if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s+\([A-Za-z0-9_.]+\)\s+\.\.\.\s+ok\s*$/.test(line)) return true;
    if (/^\s*\S+::\S+\s+PASSED(?:\s+\[\s*\d+%\])?\s*$/.test(line)) return true;
    if (/^\s*---\s+PASS:\s+\S+\s+\([0-9.]+s\)\s*$/.test(line)) return true;
    return /^\s*ok\s+\d+\s+-\s+\S/.test(line);
  }

  function collapsePassingRuns(text) {
    const lines = text.split('\n'), out = [];
    let collapsed = 0, diagnostics = false;
    for (let i = 0; i < lines.length;) {
      // Once diagnostics begin, their entire suffix stays byte-for-byte intact.
      if (/^\s*(?:=+|-+)\s*(?:FAILURES|ERRORS|short test summary info)\b/i.test(lines[i]) || /^\s*Traceback \(most recent call last\):/.test(lines[i])) diagnostics = true;
      if (diagnostics || !passingLine(lines[i])) { out.push(lines[i++]); continue; }
      let end = i + 1;
      while (end < lines.length && passingLine(lines[end])) end++;
      const count = end - i, original = lines.slice(i, end).join('\n');
      const marker = '[... collapsed ' + count + ' passing test lines ...]';
      if (count >= 3 && bytes(marker) < bytes(original)) { out.push(marker); collapsed += count; }
      else out.push(original);
      i = end;
    }
    const result = out.join('\n');
    return bytes(result) < bytes(text) ? { text: result, collapsed } : { text, collapsed: 0 };
  }

  // Only known GitHub hypermedia fields, plus templated *_url strings, are
  // discarded. Unknown/null data and all error subtrees are retained. Rather
  // than stringify parsed JSON (which changes numbers, duplicate keys and
  // formatting), collect exact property spans from the validated source.
  const noise = new Set(['avatar_url', 'followers_url', 'following_url', 'gists_url', 'starred_url', 'subscriptions_url', 'organizations_url', 'repos_url', 'events_url', 'received_events_url', 'gravatar_id', 'node_id', 'issues_url', 'labels_url', 'comments_url', 'assignees_url', 'milestones_url', 'notifications_url', 'hooks_url', 'keys_url', 'members_url', 'public_members_url']);
  const protectedKey = key => key === 'error' || key === 'errors' || key === 'message';
  function stripJsonBoilerplate(text) {
    const trimmed = text.trimStart();
    if (trimmed[0] !== '{' && trimmed[0] !== '[') return text;
    try { JSON.parse(text); } catch (_) { return text; }
    let i = 0;
    const stack = [], edits = new Map();
    function whitespace() { while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++; }
    function stringEnd() {
      i++; // opening quote
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i++] === '"') return;
      }
    }
    function value(protect) {
      whitespace(); const start = i, c = text[i];
      if (c === '{' || c === '[') {
        i++;
        stack.push({ object: c === '{', state: c === '{' ? 'key' : 'value', members: [], protect });
        return null;
      }
      if (c === '"') stringEnd();
      else while (i < text.length && !',]} \t\r\n'.includes(text[i])) i++;
      return { start, end: i };
    }
    function finishMember(frame, end) {
      const m = frame.current;
      m.end = end;
      if (!frame.protect && !protectedKey(m.key)) {
        m.remove = noise.has(m.key);
        if (!m.remove && m.key !== 'html_url' && m.key.endsWith('_url') && text[m.valueStart] === '"') {
          // A URI template is unambiguously navigational boilerplate.
          const raw = text.slice(m.valueStart, end);
          m.remove = raw.includes('{') && raw.includes('}');
        }
      }
      frame.members.push(m); frame.current = null; frame.state = 'delimiter';
    }
    function finishObject(frame) {
      const members = frame.members;
      for (let j = 0; j < members.length;) {
        if (!members[j].remove) { j++; continue; }
        const first = j;
        while (j < members.length && members[j].remove) j++;
        if (j < members.length) edits.set(members[first].start, members[j].start);
        else if (first > 0) edits.set(members[first - 1].comma, members[j - 1].end);
        else edits.set(members[first].start, members[j - 1].end);
      }
    }
    value(false);
    while (stack.length) {
      const f = stack[stack.length - 1]; whitespace();
      if (f.object && f.state === 'key') {
        if (text[i] === '}') { i++; finishObject(f); stack.pop(); }
        else {
          const start = i; stringEnd();
          const key = JSON.parse(text.slice(start, i));
          whitespace(); i++; // colon, validated by JSON.parse
          whitespace();
          f.current = { start, key, valueStart: i, remove: false }; f.state = 'child';
          const v = value(f.protect || protectedKey(key) || noise.has(key));
          if (v) finishMember(f, v.end);
          continue;
        }
      } else if (!f.object && f.state === 'value') {
        if (text[i] === ']') { i++; stack.pop(); }
        else {
          f.state = 'child';
          const v = value(f.protect);
          if (v) f.state = 'delimiter';
          continue;
        }
      } else if (f.state === 'delimiter') {
        if (text[i] === ',') {
          if (f.object) f.members[f.members.length - 1].comma = i;
          i++; f.state = f.object ? 'key' : 'value'; continue;
        }
        i++; if (f.object) finishObject(f); stack.pop();
      }
      // A child container has just closed; complete its parent value.
      if (stack.length) {
        const parent = stack[stack.length - 1];
        if (parent.state === 'child') {
          if (parent.object) finishMember(parent, i);
          else parent.state = 'delimiter';
        }
      }
    }
    if (!edits.size) return text;
    const parts = []; let last = 0;
    for (let pos = 0; pos < text.length; pos++) {
      const end = edits.get(pos);
      if (end !== undefined) { parts.push(text.slice(last, pos)); pos = end - 1; last = end; }
    }
    parts.push(text.slice(last));
    return smaller(text, parts.join(''));
  }

  function groupSearchHits(text) {
    if (text.includes('\r')) return text;
    const lines = text.split('\n'), trailing = lines.at(-1) === '';
    const count = lines.length - (trailing ? 1 : 0);
    if (count < 12) return text;
    const hits = [];
    for (let i = 0; i < count; i++) {
      const line = lines[i], a = line.indexOf(':'), b = line.indexOf(':', a + 1);
      if (a <= 0 || b <= a + 1) return text;
      const path = line.slice(0, a), number = line.slice(a + 1, b);
      if (/\s/.test(path) || !/^\d+$/.test(number)) return text;
      hits.push({ path, number, snippet: line.slice(b + 1) });
    }
    const out = [];
    for (let i = 0; i < hits.length;) {
      let end = i + 1;
      while (end < hits.length && hits[end].path === hits[i].path) end++;
      out.push(hits[i].path + ' (' + (end - i) + ' hits):');
      for (let j = i; j < end; j++) out.push('  L' + hits[j].number + ': ' + hits[j].snippet);
      i = end;
    }
    if (trailing) out.push('');
    return smaller(text, out.join('\n'));
  }

  function compactCliOutput(text) {
    let result = collapsePassingRuns(text).text;
    result = stripJsonBoilerplate(result);
    return groupSearchHits(result);
  }
  AREX.collapsePassingRuns = collapsePassingRuns;
  AREX.stripJsonBoilerplate = stripJsonBoilerplate;
  AREX.groupSearchHits = groupSearchHits;
  AREX.compactCliOutput = compactCliOutput;
})();
