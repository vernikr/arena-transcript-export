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
  const scrub = (el, extra = '') => {
    const c = el.cloneNode(true);
    c.querySelectorAll(`svg, ${S.SKIP_GUTTER}${extra ? ', ' + extra : ''}`).forEach(n => n.remove());
    return c;
  };
  // Code text: innerText keeps line breaks of span-split highlight rows; gutter stripped first.
  const codeText = el => {
    const c = el.cloneNode(true);
    c.querySelectorAll(`svg, button, ${S.SKIP_GUTTER}`).forEach(n => n.remove());
    return (c.innerText ?? c.textContent ?? '').replace(/\n+$/g, '');
  };

  const isItemWrapper = el =>
    el.tagName === 'DIV' && !!q(':scope > ' + S.EXPANDABLE, el);

  // File chip / artifact card: a `[role=button]` row carrying a lang badge ("ci.yml YAML",
  // "… Plan MD"). Body may hold a rendered document (.prose), a <pre>, or a code preview.
  function fileChip(el) {
    let chip = null;
    if (el.matches?.(S.FILE_CHIP)) chip = el;
    else if ((el.children?.length || 0) <= 3 && !q(S.EXPANDABLE, el))
      chip = [...el.children].find(c => c.matches?.(S.FILE_CHIP)) || null;
    if (!chip) return null;
    const clone = scrub(chip, S.OPEN_FILE);
    const spans = qq('span', clone).map(s => txt(s)).filter(Boolean);
    let lang = null, name = null;
    for (const t of spans) {
      if (LANG_BADGE.test(t)) { lang = t; break; }
      if (!name) name = t;
    }
    return lang && name ? { name, lang, host: el, chip } : null;
  }

  const isLeafRow = el =>
    !el.matches?.(S.FILE_CHIP) &&
    el.querySelector('svg') && !el.querySelector('div, button, pre') &&
    !S.CARD_LABELS.includes(txt(scrub(el)).toLowerCase());

  const footerOf = el => {
    if (!q(S.TIME, el) || q(S.EXPANDABLE, el) || q(S.CARD_PRE, el) || q(S.PROSE, el)) return null;
    return q(S.FOOTER_COPY, el) ? el : null;
  };

  // Uppercase label chip (command/stdout/stderr) of the card containing `pre`.
  function cardLabel(pre, boundary) {
    let node = pre;
    while (node.parentElement && node !== boundary && !isItemWrapper(node)) {
      node = node.parentElement;
      const chip = qq('span', node).find(s => S.CARD_LABELS.includes(txt(s).toLowerCase()));
      if (chip) return txt(chip).toLowerCase();
    }
    return '';
  }

  function renderItem(wrapper, level, opts) {
    const head = AREX.headerText(wrapper) || 'details';
    const panel = [...wrapper.children].find(c => c.matches?.(S.PANEL)) || null;
    const collapsed = qq(':scope > ' + S.COLLAPSED, wrapper).length > 0;
    const out = [heading(level, head)];
    if (panel) walkInto(panel, level + 1, out, opts);
    else if (collapsed) out.push('_(not expanded)_');
    return out.filter(Boolean).join('\n\n');
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
    const t = AREX.spacedText(scrub(el, S.OPEN_FILE));
    return t ? '- ' + t : '';
  }

  // DFS with handle-or-descend; pushes Markdown blocks in reading order.
  function walkInto(root, level, out, opts, boundary = root) {
    const walk = el => {
      if (footerOf(el)) return;
      if (isItemWrapper(el)) { if (opts.includeToolActivity !== false) out.push(renderItem(el, level, opts)); return; }
      if (el.matches?.(S.PROSE)) { out.push(AREX.mdConvert(el)); return; }
      const chip = fileChip(el);
      if (chip) { out.push(renderFileChip(el, chip)); return; }
      if (el.tagName === 'PRE') {
        const lbl = cardLabel(el, boundary);
        const lang = lbl === 'command' ? 'bash' : 'text';
        out.push([lbl ? `**${lbl}:**` : '', AREX.mdFence(codeText(el), lang)].filter(Boolean).join('\n\n'));
        return;
      }
      if (el.matches?.(S.FILE_CHIP)) { const line = renderPlainChip(el); if (line) out.push(line); return; }
      if (isLeafRow(el)) { const t = AREX.spacedText(scrub(el)); if (t) out.push('- ' + t); return; }
      for (const c of el.children || []) walk(c);
    };
    for (const c of root.children || []) walk(c);
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
    body.push(prose.length ? prose.map(p => AREX.mdConvert(p)).filter(Boolean).join('\n\n') : txt(scrub(layout)));
    return body.filter(Boolean).join('\n\n');
  }

  function renderAssistant(m, opts) {
    const out = [];
    walkInto(m, 4, out, opts);
    return out.filter(Boolean).join('\n\n');
  }

  AREX.serialize = function (log, opts = {}) {
    const msgs = AREX.messages(log);
    const meta = [
      `# ${AREX.chatTitle()}`,
      '',
      `- Source: ${location.href}`,
      `- Exported: ${new Date().toISOString()}`,
      `- Messages: ${msgs.length}`,
      '', '---',
    ].join('\n');
    const parts = [meta];
    for (const m of msgs) {
      const user = !!q(S.USER, m);
      const head = user ? '## 👤 User' : '## 🤖 Assistant';
      const ts = opts.timestamps ? msgTimestamp(m) : '';
      const body = (user ? renderUser : renderAssistant)(m, opts);
      parts.push([ts ? `${head}  \n_${ts}_` : head, body].filter(Boolean).join('\n\n'));
    }
    return parts.join('\n\n') + '\n';
  };

  // exposed for unit tests
  AREX._serializeInternals = { isItemWrapper, fileChip, isLeafRow, footerOf, cardLabel, fenceLang };
})();
