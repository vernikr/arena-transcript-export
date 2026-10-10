// HTML → Markdown converter, tuned for Arena chat markup. AREX.mdConvert(el).
window.AREX = window.AREX || {};

(function () {
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'SVG', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'CANVAS', 'NOSCRIPT']);
  const INLINE_TAGS = new Set(['A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DFN', 'EM', 'I', 'IMG', 'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR', 'DEL', 'INS', 'FONT']);
  const esc = s => s.replace(/([\\`*_[\]])/g, '\\$1');
  const collapse = s => s.replace(/ /g, ' ').replace(/[ \t]+/g, ' ');

  function maxRun(s, ch) {
    let m = 0, cur = 0;
    for (const c of s) { cur = c === ch ? cur + 1 : 0; if (cur > m) m = cur; }
    return m;
  }

  // Fenced code block; fence grows past the longest backtick/`~` run in content.
  function fence(content, lang = '') {
    const c = String(content).replace(/^\n+|\n+$/g, '');
    const n = Math.max(3, maxRun(c, '`') + 1);
    const f = '`'.repeat(n);
    return `${f}${lang}\n${c}\n${f}`;
  }

  function skipped(el) {
    return SKIP_TAGS.has(el.tagName) || el.matches?.(AREX.S ? AREX.S.SKIP_GUTTER : '.select-none');
  }

  function inlineChildren(el) { return inlineNodes([...el.childNodes]); }

  function inlineNodes(nodes) {
    let out = '';
    for (const n of nodes) out += inlineNode(n);
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
  function blockNodes(nodes, depth) {
    const blocks = [];
    let inlineBuf = '';
    const flush = () => { const t = inlineBuf.replace(/\s+/g, ' ').trim(); inlineBuf = ''; if (t) blocks.push(t); };
    for (const n of nodes) {
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
    [...el.children].filter(c => c.tagName === 'LI').forEach((li, i) => {
      const parts = blockNodes([...li.childNodes], 0).map(p => p.trim()).filter(Boolean);
      const marker = ordered ? `${start + i}. ` : '- ';
      if (!parts.length) { out.push(pad + marker.trimEnd()); return; }
      out.push(pad + marker + parts[0].replace(/\n/g, ' '));
      for (const rest of parts.slice(1))
        out.push(rest.split('\n').map(l => l ? pad + '  ' + l : l).join('\n'));
    });
    return out.join('\n');
  }

  function tableBlock(el) {
    const rows = [...el.querySelectorAll('tr')];
    if (!rows.length) return '';
    const cell = c => inlineNodes([...c.childNodes]).replace(/\|/g, '\\|').replace(/\n/g, '<br>').trim();
    const lines = rows.map(r => '| ' + [...r.children].filter(c => /^(TD|TH)$/.test(c.tagName)).map(cell).join(' | ') + ' |');
    const cols = (lines[0].match(/\|/g) || []).length - 1;
    lines.splice(1, 0, '|' + ' --- |'.repeat(cols));
    return lines.join('\n');
  }

  function blockElement(el, depth) {
    const inner = () => blockNodes([...el.childNodes], depth);
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
        const sum = [...el.children].find(c => c.tagName === 'SUMMARY');
        const head = sum ? '**' + inlineNodes([...sum.childNodes]).trim() + '**' : '';
        const rest = blockNodes([...el.childNodes].filter(c => c !== sum), depth);
        return [head, ...rest].filter(Boolean);
      }
      case 'SUMMARY': return [];
      case 'LI': return [listBlock({ tagName: 'UL', children: [el], getAttribute: () => null }, depth)];
      default: return inner(); // DIV/SECTION/etc: transparent container
    }
  }

  function langOfPre(pre) {
    const code = pre.querySelector('code');
    const cls = (code?.className || pre.className || '').match(/language-([\w+-]+)/);
    return cls ? cls[1] : '';
  }

  AREX.mdFence = fence;
  AREX.mdConvert = el => blockNodes([...el.childNodes], 0).map(b => b.trim()).filter(Boolean).join('\n\n');
})();
