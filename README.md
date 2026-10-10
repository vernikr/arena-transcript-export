# Arena Transcript Export

Chrome extension (MV3) that exports the **current Arena.ai agent branch** to a single Markdown
file: the full history is force-loaded first (Arena pages long transcripts and mounts older pages
on scroll-up), then every spoiler is expanded — reasoning blocks, tool calls, command outputs —
including nested groups. The left sidebar, the right preview panel and the composer are excluded
by construction: everything is scoped to the transcript container (`div[role="log"]`).

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the `extension/` directory of this repo.
3. Open an agent branch on `https://arena.ai/agent/…`, click the extension icon →
   **Export branch to Markdown**.

Keep the popup open while it works (long branches take a while: history paging + spoiler passes).
If you close it mid-run, the file is still delivered via an in-page download fallback.

## Options

- **Expand & include tool activity** (default on) — click-open every spoiler and export its
  content as headed sections with fenced code. Off = prose only (fast).
- **Message timestamps** (default off) — append the visible message time to each heading.

Progress and a completion summary (messages / expanded spoilers / warnings) show in the popup.

## Markdown schema

Document header: `# branch title`, source URL, export timestamp, message count. Each turn:

- `## 👤 User` — text (converted from the rendered markup) + `📎 **Attached:** …` chips.
- `## 🤖 Assistant` — answer prose; each activity item as `#### used Bash 143ms`-style heading
  (nested groups go one level down), cards as `**command:**`/`**stdout:**/`**stderr:**` +
  fenced blocks, file cards as `**📄 name** _(LANG)_` + fenced content, and document artifacts
  (e.g. written `.md` files) rendered as fully converted markdown.

## Limits

- Export is refused while the agent is still generating (the tail would be truncated).
- The right preview panel is out of scope per requirements; code that exists only behind
  "open file in preview" actions is exported as the inline preview embedded in the transcript.
- If Arena eventually introduces real DOM windowing (unloading rendered messages — none today),
  the exporter aborts loudly instead of writing a partial file.

## Dev

No build step, no runtime dependencies. `npm install` once for jsdom, then `npm test`
(node:test; jsdom unit tests over a saved Arena transcript fixture, snapshot at
`test/snapshots/fixture-expected.md` — regenerate with `UPDATE_SNAPSHOT=1 npm test`).

- `docs/architecture.md` — module design, pipeline, DOM→MD mapping, risks.
- `docs/research/arena-page-analysis.md` — how Arena loads/renders the transcript (evidence).

Page markup is obfuscated Tailwind CSS and may drift; all queries live in
`extension/content/selectors.js` and lean on `data-*`/`role` hooks. If export degrades after an
Arena update, start there and update the fixture.
