// HTML → Markdown converter, tuned for Arena chat markup. AREX.mdConvert(el).
window.AREX = window.AREX || {};

(function () {
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'SVG', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'CANVAS', 'NOSCRIPT']);
  const INLINE_TAGS = new Set(['A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DFN', 'EM', 'I', 'IMG', 'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR', 'DEL', 'INS', 'FONT']);
  const esc = s => s.replace(/([\\`*_[\]])/g, '\\$1');
  const collapse = s => s.replace(/ /g, ' ').replace(/[ \t]+/g, ' ');

  function maxRun(s, ch) {
    const code = ch.charCodeAt(0);
    let m = 0, cur = 0;
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) === code) { if (++cur > m) m = cur; }
      else cur = 0;
    }
    return m;
  }

  // Fenced code block; fence grows past the longest backtick run in content.
  function fence(content, lang = '') {
    let c = String(content);
    let start = 0, end = c.length;
    while (start < end && c.charCodeAt(start) === 10) start++;
    while (end > start && c.charCodeAt(end - 1) === 10) end--;
    if (start !== 0 || end !== c.length) c = c.slice(start, end);
    const n = Math.max(3, maxRun(c, '`') + 1);
    const f = '`'.repeat(n);
    return `${f}${lang}\n${c}\n${f}`;
  }

  function skipped(el) {
    return SKIP_TAGS.has(el.tagName) || el.matches?.(AREX.S ? AREX.S.SKIP_GUTTER : '.select-none');
  }

  function inlineChildren(el) {
    let out = '';
    for (let n = el.firstChild; n; n = n.nextSibling) out += inlineNode(n);
    return out;
  }

  function inlineNode(n) {
    if (n.nodeType === 3) return esc(collapse(n.nodeValue));
    if (n.nodeType !== 1 || skipped(n)) return '';
    const inner = () => inlineChildren(n);
    switch (n.tagName) {
      case 'STRONG': case 'B': return `**${inner()}**`;
      case 'EM': case 'I': return `*${inner()}*`;
      case 'DEL': case 'S': return `~~${inner()}~~`;
      case 'CODE': {
        const c = (n.textContent || '').replace(/\n/g, ' ');
        const f = '`'.repeat(Math.max(1, maxRun(c, '`') + 1));
        const pad = c.startsWith('`') || c.endsWith('`') ? ' ' : '';
        return `${f}${pad}${c}${pad}${f}`;
      }
      case 'A': {
        const href = n.getAttribute('href') || '';
        const t = inner().trim();
        if (!href || href.startsWith('javascript:')) return t;
        return `[${t || href}](${href})`;
      }
      case 'IMG': {
        const src = n.getAttribute('src') || '';
        const alt = n.getAttribute('alt') || '';
        if (!src) return '';
        return (src.startsWith('data:') || src.length > 180)
          ? `*[image${alt ? `: ${alt}` : ''}]*`
          : `![${alt}](${src})`;
      }
      case 'BR': return '\n';
      case 'HR': return '\n---\n';
      default:
        if (!INLINE_TAGS.has(n.tagName)) return inner(); // unknown inline-ish: keep children
        return inner();
    }
  }

  // Block conversion: returns array of block strings.
  function blockChildren(el, depth, skipNode) {
    const blocks = [];
    let inlineBuf = '';
    const flush = () => { const t = inlineBuf.replace(/\s+/g, ' ').trim(); inlineBuf = ''; if (t) blocks.push(t); };
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (skipNode && n === skipNode) continue;
      if (n.nodeType === 3) { inlineBuf += inlineNode(n); continue; }
      if (n.nodeType !== 1 || skipped(n)) continue;
      if (INLINE_TAGS.has(n.tagName)) { inlineBuf += inlineNode(n); continue; }
      flush();
      blocks.push(...blockElement(n, depth));
    }
    flush();
    return blocks;
  }

  function listBlock(el, depth) {
    const ordered = el.tagName === 'OL';
    let start = parseInt(el.getAttribute('start') || '1', 10);
    if (!Number.isFinite(start)) start = 1;
    const pad = ' '.repeat(depth * 2);
    const out = [];
    let i = 0;
    for (let li = el.firstElementChild; li; li = li.nextElementSibling) {
      if (li.tagName !== 'LI') continue;
      const parts = blockChildren(li, 0).map(p => p.trim()).filter(Boolean);
      const marker = ordered ? `${start + i}. ` : '- ';
      if (!parts.length) { out.push(pad + marker.trimEnd()); }
      else {
        out.push(pad + marker + parts[0].replace(/\n/g, ' '));
        for (let j = 1; j < parts.length; j++) {
          const rest = parts[j];
          out.push(rest.split('\n').map(l => l ? pad + '  ' + l : l).join('\n'));
        }
      }
      i++;
    }
    return out.join('\n');
  }

  function tableBlock(el) {
    const rows = el.querySelectorAll('tr');
    if (!rows.length) return '';
    const rowCells = [];
    let cols = 0;
    for (let ri = 0; ri < rows.length; ri++) {
      const r = rows[ri];
      const cells = [];
      for (let c = r.firstElementChild; c; c = c.nextElementSibling) {
        if (c.tagName !== 'TD' && c.tagName !== 'TH') continue;
        cells.push(inlineChildren(c).replace(/\|/g, '\\|').replace(/\n/g, '<br>').trim());
      }
      if (cells.length > cols) cols = cells.length;
      rowCells.push(cells);
    }
    if (cols === 0) return '';
    const lines = [];
    for (let ri = 0; ri < rowCells.length; ri++) {
      const cells = rowCells[ri];
      while (cells.length < cols) cells.push('');
      lines.push('| ' + cells.join(' | ') + ' |');
      if (ri === 0) lines.push('|' + ' --- |'.repeat(cols));
    }
    return lines.join('\n');
  }

  function blockElement(el, depth) {
    const inner = () => blockChildren(el, depth);
    if (/^H[1-6]$/.test(el.tagName)) {
      const t = inlineChildren(el).replace(/\s+/g, ' ').trim();
      return t ? ['#'.repeat(+el.tagName[1]) + ' ' + t] : [];
    }
    switch (el.tagName) {
      case 'P': {
        const t = inlineChildren(el).trim();
        return t ? [t] : [];
      }
      case 'PRE': return [fence(el.textContent || '', langOfPre(el))];
      case 'BLOCKQUOTE': {
        const body = inner().join('\n\n');
        return body ? [body.split('\n').map(l => l ? '> ' + l : '>').join('\n')] : [];
      }
      case 'UL': case 'OL': return [listBlock(el, depth)];
      case 'TABLE': return [tableBlock(el)];
      case 'HR': return ['---'];
      case 'DETAILS': {
        let sum = null;
        for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
          if (c.tagName === 'SUMMARY') { sum = c; break; }
        }
        const head = sum ? '**' + inlineChildren(sum).trim() + '**' : '';
        const rest = blockChildren(el, depth, sum);
        return [head, ...rest].filter(Boolean);
      }
      case 'SUMMARY': return [];
      case 'LI': {
        const parts = blockChildren(el, 0).map(p => p.trim()).filter(Boolean);
        const pad = ' '.repeat(depth * 2);
        if (!parts.length) return [pad + '-'];
        const out = [pad + '- ' + parts[0].replace(/\n/g, ' ')];
        for (let j = 1; j < parts.length; j++) {
          const rest = parts[j];
          out.push(rest.split('\n').map(l => l ? pad + '  ' + l : l).join('\n'));
        }
        return [out.join('\n')];
      }
      default: return inner(); // DIV/SECTION/etc: transparent container
    }
  }

  function langOfPre(pre) {
    const code = pre.querySelector('code');
    const cls = (code?.className || pre.className || '').match(/language-([\w+-]+)/);
    return cls ? cls[1] : '';
  }

  AREX.mdFence = fence;
  AREX.mdConvert = el => blockChildren(el, 0).map(b => b.trim()).filter(Boolean).join('\n\n');
})();
