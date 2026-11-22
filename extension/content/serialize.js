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
  const skipChrome = el => el.tagName?.toLowerCase() === 'svg' || el.matches(S.SKIP_GUTTER);
  const normalized = text => text.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const cleanText = (el, { spaced = false, openFile = false } = {}) => AREX.filteredText(el, {
    spaced, skip: n => skipChrome(n) || (openFile && n.matches(S.OPEN_FILE)),
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
      if (child.matches(S.EXPANDABLE)) return true;
    return false;
  };

  // File chip / artifact card: a `[role=button]` row carrying a lang badge ("ci.yml YAML",
  // "… Plan MD"). Body may hold a rendered document (.prose), a <pre>, or a code preview.
  function fileChip(el) {
    let chip = null;
    if (el.matches?.(S.FILE_CHIP)) chip = el;
    else {
      let candidate = null, count = 0;
      for (let child = el.firstElementChild; child && count <= 3; child = child.nextElementSibling) {
        count++;
        if (!candidate && child.matches(S.FILE_CHIP)) candidate = child;
      }
      if (count <= 3 && candidate && !q(S.EXPANDABLE, el)) chip = candidate;
    }
    if (!chip) return null;
    const spans = qq('span', chip).filter(span => {
      for (let n = span; n && n !== chip; n = n.parentElement)
        if (skipChrome(n) || n.matches(S.OPEN_FILE)) return false;
      return true;
    }).map(span => normalized(cleanText(span, { openFile: true }))).filter(Boolean);
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
    if (el.matches?.(S.FILE_CHIP)) return null;
    let hasSvg = false, blocked = false;
    const visit = n => {
      if (n.nodeType === 3) return { plain: n.nodeValue, spaced: n.nodeValue };
      if (n.nodeType !== 1) return { plain: '', spaced: '' };
      const plain = [], spaced = [];
      for (let child = n.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1) {
          const tag = child.tagName.toLowerCase();
          if (tag === 'div' || tag === 'button' || tag === 'pre') { blocked = true; return { plain: '', spaced: '' }; }
          if (tag === 'svg') {
            hasSvg = true;
            // Even SVG descendants are checked for forbidden HTML containers.
            if (child.querySelector('div, button, pre')) blocked = true;
            continue;
          }
          if (child.matches(S.SKIP_GUTTER)) {
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
  // rather than running four descendant selectors on every visited DOM node.
  function footerSet(message) {
    const found = new WeakSet();
    for (const time of qq(S.TIME, message)) {
      for (let node = time; node && node !== message; node = node.parentElement)
        if (footerOf(node)) found.add(node);
    }
    return found;
  }

  // Generator checkpoints allow the async path to yield during even a single
  // very large message. The synchronous public serializer consumes the same
  // walker, preserving ordering and formatting byte-for-byte.
  function* walkSteps(root, level, out, opts, footers, labels, boundary = root) {
    function* walk(el) {
      yield;
      if (footers.has(el)) return;
      if (isItemWrapper(el)) {
        if (opts.includeToolActivity !== false) {
          const head = AREX.headerText(el) || 'details';
          let panel = null, collapsed = false;
          for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
            if (!panel && child.matches(S.PANEL)) panel = child;
            if (!collapsed && child.matches(S.COLLAPSED)) collapsed = true;
          }
          const nested = [heading(level, head)];
          if (panel) yield* walkSteps(panel, level + 1, nested, opts, footers, labels);
          else if (collapsed) nested.push('_(not expanded)_');
          out.push(nested.filter(Boolean).join('\n\n'));
        }
        return;
      }
      if (el.matches?.(S.PROSE)) { out.push(AREX.mdConvert(el)); return; }
      const chip = fileChip(el);
      if (chip) { out.push(renderFileChip(el, chip)); return; }
      if (el.tagName === 'PRE') {
        const lbl = cardLabel(el, boundary, labels);
        const lang = lbl === 'command' ? 'bash' : 'text';
        out.push([lbl ? `**${lbl}:**` : '', AREX.mdFence(codeText(el), lang)].filter(Boolean).join('\n\n'));
        return;
      }
      if (el.matches?.(S.FILE_CHIP)) { const line = renderPlainChip(el); if (line) out.push(line); return; }
      const leaf = leafText(el);
      if (leaf !== null) { if (leaf) out.push('- ' + leaf); return; }
      for (let child = el.firstElementChild; child; child = child.nextElementSibling) yield* walk(child);
    }
    for (let child = root.firstElementChild; child; child = child.nextElementSibling) yield* walk(child);
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

  AREX.serializeHeader = function (count) {
    return [`# ${AREX.chatTitle()}`, '', `- Source: ${location.href}`,
      `- Exported: ${new Date().toISOString()}`, `- Messages: ${count}`, '', '---'].join('\n');
  };

  AREX.serializeMessage = function (m, opts = {}) {
    const { user, head } = messageHeader(m, opts);
    const out = [];
    if (user) out.push(renderUser(m, opts));
    else for (const _ of walkSteps(m, 4, out, opts, footerSet(m), new WeakMap())) { /* consume synchronously */ }
    const body = out.filter(Boolean).join('\n\n');
    return [head, body].filter(Boolean).join('\n\n');
  };

  AREX.serializeMessageAsync = async function (m, opts = {}, budgetMs = 20) {
    const { user, head } = messageHeader(m, opts);
    const out = [];
    if (user) out.push(renderUser(m, opts));
    else {
      let start = performance.now();
      for (const _ of walkSteps(m, 4, out, opts, footerSet(m), new WeakMap())) {
        if (performance.now() - start >= budgetMs) {
          AREX.throwIfAborted?.();
          await AREX.yieldToMain();
          start = performance.now();
        }
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
  AREX._serializeInternals = { isItemWrapper, fileChip, isLeafRow, footerOf, cardLabel, fenceLang };
})();
