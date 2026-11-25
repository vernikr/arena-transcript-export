// Lossless structural framing edits for Smart/Stubs. Off/Lossless never opt in.
// Consume a DocumentIndex, propose disjoint edits against its exact offsets,
// and leave command/output payloads, user turns and answer prose untouched.
globalThis.AREX = globalThis.AREX || {};

(function () {
  function compactFraming(index, options = {}) {
    const raw = index.markdown;
    const edits = [];
    const stats = { collapsedWrappers: 0, emptyExplored: 0, compactCommands: 0 };
    if (options.mode !== 'smart' && options.mode !== 'stubs') {
      return { ...AREX.applySpanEdits(raw, edits), edits, stats };
    }
    const { sections, turns, blocks } = index;
    const assistant = section => section && turns[section.turnIndex]?.kind === 'assistant';
    const afterLine = offset => {
      const end = raw.indexOf('\n', offset);
      return end < 0 ? raw.length : end + 1;
    };

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      if (!assistant(section) || section.level !== 4) continue;
      const bodyStart = afterLine(section.startOffset);
      const next = sections[i + 1];
      if (section.kind === 'explored_wrapper' && /^Explored \d+ reads?$/i.test(section.title)) {
        const end = Math.min(next?.startOffset ?? raw.length, section.rawEndOffset);
        if (raw.slice(bodyStart, end).trim() === '') {
          edits.push({ start: section.startOffset, end, text: '' });
          stats.emptyExplored++;
        }
      } else if (section.kind === 'ran_commands_wrapper' && /^Ran commands 1$/i.test(section.title)) {
        // Exactly one H5 Bash child, with no other headings anywhere in the
        // group and no parent body (including prose or not-expanded markers).
        const child = next;
        const following = sections[i + 2];
        if (child?.parentIndex !== section.index || child.level !== 5 || child.kind !== 'bash_run' ||
            child.turnIndex !== section.turnIndex ||
            (following && following.startOffset < section.rawEndOffset) ||
            raw.slice(bodyStart, child.startOffset).trim() !== '') continue;
        const childBody = afterLine(child.startOffset);
        // Remove just one hash from the original heading; retain title,
        // duration, exit status, indentation and whitespace byte-for-byte.
        const heading = raw.slice(child.startOffset, childBody).replace(/^( {0,3})#/, '$1');
        edits.push({ start: section.startOffset, end: childBody, text: heading });
        stats.collapsedWrappers++;
      }
    }

    for (let i = 0; i + 1 < blocks.length; i++) {
      const command = blocks[i], output = blocks[i + 1];
      const section = sections[command.sectionIndex];
      if (command.label !== 'command' || command.lang !== 'bash' ||
          !assistant(section) || section.kind !== 'bash_run' ||
          command.startOffset < section.startOffset || command.endOffset > section.endOffset ||
          output.label !== 'stdout' || output.pairedCommand !== command ||
          output.sectionIndex !== command.sectionIndex || output.turnIndex !== command.turnIndex ||
          command.body.length > 160 || !/^\$ [^\r\n]+$/.test(command.body) ||
          command.body.includes('`')) continue;

      // Locate the card label without ever consuming unrelated prose. An
      // anchor anywhere on this command card makes its fenced form immutable:
      // Stubs line references require the original source block to stay put.
      const previous = blocks[i - 1];
      const boundary = previous?.sectionIndex === command.sectionIndex
        ? previous.endOffset : afterLine(section.startOffset);
      const prefix = raw.slice(boundary, command.startOffset);
      if (/<a\b[^>]*(?:id|name)\s*=/i.test(prefix) || /arex-stubs-output-/.test(prefix)) continue;
      const label = raw.lastIndexOf('**command:**', command.startOffset);
      if (label < boundary || !/^\*\*command:\*\*[ \t]*\n[ \t\n]*$/.test(raw.slice(label, command.startOffset))) continue;
      // Only an immediately paired stdout fence qualifies. Output anchors
      // are safe to retain: only its card label changes, never source lines.
      const gap = /^[ \t\n]*\*\*stdout:\*\*[ \t]*\n[ \t\n]*((?:<a (?:id|name)="[^"\r\n]+"><\/a>\n[ \t\n]*)*)$/.exec(raw.slice(command.endOffset, output.startOffset));
      if (!gap) continue;
      edits.push({ start: label, end: output.startOffset, text: '> `' + command.body + '`\n\n' + gap[1] });
      stats.compactCommands++;
    }

    return { ...AREX.applySpanEdits(raw, edits), edits, stats };
  }

  AREX.compactFraming = compactFraming;
})();
