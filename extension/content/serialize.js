// Transcript DOM → Markdown document. AREX.serialize(log, {timestamps, includeToolActivity}).
window.AREX = window.AREX || {};

(function () {
  const S = AREX.S, q = AREX.q, qq = AREX.qq, txt = AREX.text;

  const LANG_BADGE = /^[A-Z][A-Z0-9+#.]{1,14}$/;
  const LANG_MAP = {
    SHELLSCRIPT: 'bash', BASH: 'bash', SH: 'bash', ZSH: 'bash',
    MD: 'markdown', MARKDOWN: 'markdown', YML: 'yaml', YAML: 'yaml',
    JSON: 'json', JSONC: 'jsonc', TYPESCRIPT: 'ts', TSX: 'tsx',
    JAVASCRIPT: 'js', JSX: 'jsx', PYTHON: 'py', PY: 'py',
    TEXT: 'text', PLAINTEXT: 'text', HTML: 'html', CSS: 'css', DIFF: 'diff',
    XML: 'xml', SQL: 'sql', GO: 'go', GOLANG: 'go', RUST: 'rust', RS: 'rust',
    TOML: 'toml', DOCKERFILE: 'dockerfile', GRAPHQL: 'graphql', CPP: 'cpp', C: 'c',
  };
  const fenceLang = badge => LANG_MAP[badge] || (badge || '').toLowerCase() || 'text';

  const heading = (level, text) => `${'#'.repeat(Math.min(level, 6))} ${text}`;
  // Chrome predicates short-circuit on cheap DOM properties first; the CSS
  // engine (nwsapi in jsdom) only runs for elements that could actually match.
  const isSvg = el => el.tagName === 'svg' || el.tagName === 'SVG';
  const hasSelectNone = el => (el.classList?.contains('select-none') ?? false);
  const skipChrome = el => isSvg(el) || hasSelectNone(el);
  const isOpenFile = el => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Open file';
  const isExpandable = el => el.tagName === 'BUTTON' && el.hasAttribute('aria-expanded');
  const isPanel = el => el.tagName === 'DIV' && (el.getAttribute('style') || '').includes('overflow: clip');
  const isCollapsed = el => isExpandable(el) && el.getAttribute('aria-expanded') === 'false';
  const isProse = el => el.classList?.contains('prose') ?? false;
  const isFileChip = el => el.getAttribute?.('role') === 'button';
  const normalized = text => text.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const cleanText = (el, { spaced = false, openFile = false } = {}) => AREX.filteredText(el, {
    spaced, skip: n => skipChrome(n) || (openFile && isOpenFile(n)),
  });
  // The old serializer read innerText on a detached clone. Chromium returns
  // textContent for detached elements (not the rendered live innerText), so
  // textContent is the parity-preserving fast path, including line endings.
  const codeText = el => {
    if (!el.querySelector('svg, button, ' + S.SKIP_GUTTER))
      return (el.textContent ?? '').replace(/\n+$/g, '');
    return AREX.filteredText(el, { skip: n => skipChrome(n) || n.tagName === 'BUTTON' }).replace(/\n+$/g, '');
  };

  const isItemWrapper = el => {
    if (el.tagName !== 'DIV') return false;
    for (let child = el.firstElementChild; child; child = child.nextElementSibling)
      if (isExpandable(child)) return true;
    return false;
  };

  // File chip / artifact card: a `[role=button]` row carrying a lang badge ("ci.yml YAML",
  // "… Plan MD"). Body may hold a rendered document (.prose), a <pre>, or a code preview.
  function fileChip(el) {
    let chip = null;
    if (isFileChip(el)) chip = el;
    else {
      let candidate = null, count = 0;
      for (let child = el.firstElementChild; child && count <= 3; child = child.nextElementSibling) {
        count++;
        if (!candidate && isFileChip(child)) candidate = child;
      }
      if (count <= 3 && candidate && !q(S.EXPANDABLE, el)) chip = candidate;
    }
    if (!chip) return null;
    // Single pass over the badge spans: no intermediate filter/map arrays.
    const spans = [];
    for (const span of qq('span', chip)) {
      let chrome = false;
      for (let n = span; n && n !== chip; n = n.parentElement)
        if (skipChrome(n) || isOpenFile(n)) { chrome = true; break; }
      if (chrome) continue;
      const text = normalized(cleanText(span, { openFile: true }));
      if (text) spans.push(text);
    }
    let lang = null, name = null;
    for (const t of spans) {
      if (LANG_BADGE.test(t)) { lang = t; break; }
      if (!name) name = t;
    }
    return lang && name ? { name, lang, host: el, chip } : null;
  }

  // Classify and collect the label in one pass, so the walker need not scrub
  // the same row twice. A null result means it is not a leaf row.
  function leafText(el) {
    if (isFileChip(el)) return null;
    let hasSvg = false, blocked = false;
    const visit = n => {
      if (n.nodeType === 3) return { plain: n.nodeValue, spaced: n.nodeValue };
      if (n.nodeType !== 1) return { plain: '', spaced: '' };
      const plain = [], spaced = [];
      for (let child = n.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1) {
          // Tag names are compared uppercase: no per-node lowercasing alloc.
          const tag = child.tagName;
          if (tag === 'DIV' || tag === 'BUTTON' || tag === 'PRE') { blocked = true; return { plain: '', spaced: '' }; }
          if (tag === 'svg' || tag === 'SVG') {
            hasSvg = true;
            // Even SVG descendants are checked for forbidden HTML containers.
            if (child.querySelector('div, button, pre')) blocked = true;
            continue;
          }
          if (hasSelectNone(child)) {
            if (child.querySelector('svg')) hasSvg = true;
            if (child.querySelector('div, button, pre')) blocked = true;
            continue;
          }
        }
        const value = visit(child);
        if (blocked) return { plain: '', spaced: '' };
        plain.push(value.plain); spaced.push(value.spaced);
      }
      return { plain: plain.join(''), spaced: spaced.join(' ') };
    };
    const value = visit(el);
    return blocked || !hasSvg || S.CARD_LABELS.includes(normalized(value.plain).toLowerCase())
      ? null : value.spaced.replace(/\s+/g, ' ').trim();
  }
  const isLeafRow = el => leafText(el) !== null;

  const footerOf = el => {
    if (!q(S.TIME, el) || q(S.EXPANDABLE, el) || q(S.CARD_PRE, el) || q(S.PROSE, el)) return null;
    return q(S.FOOTER_COPY, el) ? el : null;
  };

  // Uppercase label chip (command/stdout/stderr) of the card containing `pre`.
  function cardLabel(pre, boundary, cache = new WeakMap()) {
    let node = pre;
    while (node.parentElement && node !== boundary && !isItemWrapper(node)) {
      node = node.parentElement;
      let label = cache.get(node);
      if (label === undefined) {
        label = '';
        for (const span of node.getElementsByTagName('span')) {
          const text = txt(span).toLowerCase();
          if (S.CARD_LABELS.includes(text)) { label = text; break; }
        }
        cache.set(node, label);
      }
      if (label) return label;
    }
    return '';
  }

  function renderFileChip(el, chip) {
    const head = `**📄 ${chip.name}** _(${chip.lang})_`;
    const prose = q(S.PROSE, chip.chip); // artifact card: full rendered document
    if (prose) return [head, AREX.mdConvert(prose)].filter(Boolean).join('\n\n');
    const preview = q(S.CARD_PRE, chip.host) || q(S.CARD_PRE, chip.chip) || q('.bg-surface-primary', chip.host);
    if (!preview) return head;
    const code = codeText(preview).trim();
    return code ? `${head}\n\n${AREX.mdFence(code, fenceLang(chip.lang))}` : head;
  }

  function renderPlainChip(el) {
    const t = cleanText(el, { spaced: true, openFile: true }).replace(/\s+/g, ' ').trim();
    return t ? '- ' + t : '';
  }

  // Precompute footer ancestors from the usually tiny set of <time> nodes,
  // rather than running four full-subtree selectors on every visited DOM node.
  // For each <time>: climb to the nearest ancestor carrying the Copy affordance,
  // validate only that candidate with the exact footer predicate, then mark the
  // (few) ancestors above it that hold no content markers — exactly the set the
  // per-node predicate scan used to produce, at a fraction of the selector cost.
  const FOOTER_MARKERS = `${S.EXPANDABLE}, ${S.CARD_PRE}, ${S.PROSE}`;
  function footerSet(message) {
    const found = new WeakSet();
    for (const time of qq(S.TIME, message)) {
      let node = time.parentElement;
      while (node && node !== message && !q(S.FOOTER_COPY, node)) node = node.parentElement;
      if (!node || node === message) continue;
      if (footerOf(node)) found.add(node);
      for (let up = node.parentElement; up && up !== message; up = up.parentElement)
        if (!q(FOOTER_MARKERS, up)) found.add(up);
    }
    return found;
  }

  // Zero-generator iterative walk: an explicit frame stack replaces recursive
  // `yield*` delegation, which used to allocate generator state per tree level
  // and suspend/resume once per visited DOM element. Two frame kinds:
  //   CHILDREN — cursor over one parent's children (one live frame per open
  //              nesting level, reused across all siblings);
  //   ITEM     — a spoiler group still collecting its panel output; composed
  //              into the parent sink once every nested frame above it drains.
  const CHILDREN = 0, ITEM = 1;
  const CHECKPOINT_MASK = 63; // amortise clock reads by 64 visited nodes

  // Advance the walk by one step. Returns true when a DOM element was visited
  // (the unit the async path counts for its budget checkpoints).
  function walkStep(stack, opts, footers, labels, boundary) {
    const frame = stack[stack.length - 1];
    if (frame.kind === ITEM) {
      stack.pop();
      frame.dest.push([heading(frame.level, frame.head), ...frame.sink].filter(Boolean).join('\n\n'));
      return false;
    }
    const child = frame.next;
    if (!child) { stack.pop(); return false; }
    frame.next = child.nextElementSibling;
    visit(child, frame.level, frame.sink, stack, opts, footers, labels, boundary);
    return true;
  }

  function visit(el, level, sink, stack, opts, footers, labels, boundary) {
    if (footers.has(el)) return;
    if (isItemWrapper(el)) {
      if (opts.includeToolActivity === false) return;
      const head = AREX.headerText(el) || 'details';
      let panel = null, collapsed = false;
      for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
        if (!panel && isPanel(child)) panel = child;
        if (!collapsed && isCollapsed(child)) collapsed = true;
      }
      const nested = [];
      if (panel) {
        stack.push({ kind: ITEM, level, head, sink: nested, dest: sink });
        stack.push({ kind: CHILDREN, next: panel.firstElementChild, level: level + 1, sink: nested });
      } else {
        if (collapsed) nested.push('_(not expanded)_');
        sink.push([heading(level, head), ...nested].filter(Boolean).join('\n\n'));
      }
      return;
    }
    if (isProse(el)) { sink.push(AREX.mdConvert(el)); return; }
    const chip = fileChip(el);
    if (chip) { sink.push(renderFileChip(el, chip)); return; }
    if (el.tagName === 'PRE') {
      const lbl = cardLabel(el, boundary, labels);
      const lang = lbl === 'command' ? 'bash' : 'text';
      sink.push([lbl ? `**${lbl}:**` : '', AREX.mdFence(codeText(el), lang)].filter(Boolean).join('\n\n'));
      return;
    }
    if (isFileChip(el)) { const line = renderPlainChip(el); if (line) sink.push(line); return; }
    const leaf = leafText(el);
    if (leaf !== null) { if (leaf) sink.push('- ' + leaf); return; }
    stack.push({ kind: CHILDREN, next: el.firstElementChild, level, sink });
  }

  const startWalk = (root, level, sink) => [{ kind: CHILDREN, next: root.firstElementChild, level, sink }];

  // Synchronous walk: no generators, no clock reads.
  function walkAll(root, level, out, opts, footers, labels, boundary) {
    const stack = startWalk(root, level, out);
    while (stack.length) walkStep(stack, opts, footers, labels, boundary);
  }

  function msgTimestamp(m) {
    const t = q(S.TIME, m);
    return t ? txt(t) : '';
  }

  function renderUser(m, opts) {
    const layout = q(S.USER, m) || m;
    const names = [...new Set(qq(S.ATTACH_NAME, layout).map(s => txt(s)).filter(Boolean))];
    const body = [];
    if (names.length) body.push(`📎 **Attached:** ${names.join(', ')}`);
    const prose = qq(S.PROSE, layout);
    body.push(prose.length ? prose.map(p => AREX.mdConvert(p)).filter(Boolean).join('\n\n') : normalized(cleanText(layout)));
    return body.filter(Boolean).join('\n\n');
  }

  function messageHeader(m, opts) {
    const user = !!q(S.USER, m);
    const head = user ? '## 👤 User' : '## 🤖 Assistant';
    const ts = opts.timestamps ? msgTimestamp(m) : '';
    return { user, head: ts ? `${head}  \n_${ts}_` : head };
  }

  // Header metadata. `AREX.serializeHeader(count)` keeps byte-identical output.
  // Partial exports may pass `{ partial: true, totalMessages }` to note that only
  // `count` of `totalMessages` messages were serialized before the export stopped.
  AREX.serializeHeader = function (count, { partial = false, totalMessages = null } = {}) {
    const lines = [`# ${AREX.chatTitle()}`, '', `- Source: ${location.href}`,
      `- Exported: ${new Date().toISOString()}`, `- Messages: ${count}`];
    if (partial) lines.push(`- Status: Partial export (${count}/${totalMessages ?? '?'} messages)`);
    lines.push('', '---');
    return lines.join('\n');
  };

  AREX.serializeMessage = function (m, opts = {}) {
    const { user, head } = messageHeader(m, opts);
    const out = [];
    if (user) out.push(renderUser(m, opts));
    else walkAll(m, 4, out, opts, footerSet(m), new WeakMap(), m);
    const body = out.filter(Boolean).join('\n\n');
    return [head, body].filter(Boolean).join('\n\n');
  };

  AREX.serializeMessageAsync = async function (m, opts = {}, budgetMs = 20) {
    const { user, head } = messageHeader(m, opts);
    const out = [];
    if (user) out.push(renderUser(m, opts));
    else {
      const footers = footerSet(m), labels = new WeakMap();
      const stack = startWalk(m, 4, out);
      let visited = 0, start = performance.now();
      while (stack.length) {
        if (!walkStep(stack, opts, footers, labels, m)) continue;
        visited += 1;
        if ((visited & CHECKPOINT_MASK) !== 0) continue;
        if (performance.now() - start < budgetMs) continue;
        AREX.throwIfAborted?.();
        await AREX.yieldToMain();
        start = performance.now();
      }
    }
    AREX.throwIfAborted?.();
    const body = out.filter(Boolean).join('\n\n');
    return [head, body].filter(Boolean).join('\n\n');
  };

  AREX.serialize = function (log, opts = {}) {
    const msgs = AREX.messages(log);
    return [AREX.serializeHeader(msgs.length), ...msgs.map(m => AREX.serializeMessage(m, opts))].join('\n\n') + '\n';
  };

  // exposed for unit tests
  AREX._serializeInternals = { isItemWrapper, fileChip, isLeafRow, footerOf, cardLabel, fenceLang, footerSet };
})();
