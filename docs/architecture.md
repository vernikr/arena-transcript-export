# Architecture — Arena Transcript Export (Chrome extension, MV3)

Goal: one-click export of the **current Arena.ai agent branch** to a single `.md` file: full history
(pagination force-loaded), every spoiler expanded (reasoning/tool groups, nested), canonical
Markdown; sidebar, right preview panel and composer excluded.

Research evidence: `docs/research/arena-page-analysis.md`.

## Shape

Plain MV3 extension, no build step, zero runtime deps (custom ~200-line HTML→MD converter).
Dev-only dep: jsdom (unit tests against a saved transcript fixture).

```
extension/
  manifest.json            MV3: content scripts on https://arena.ai/agent/*, perms downloads+storage+scripting
  popup/popup.html|.js     UI: export button, options, live progress; triggers download
  content/selectors.js     AREX.S — all DOM queries in one place (page churn containment)
  content/util.js          sleep, settle (MutationObserver quiet window), text extraction, slug
  content/loader.js        1️⃣ history gate: force-load earlier pages via scroll-to-top
  content/expand.js        2️⃣ spoiler gate: click-expand loop until zero collapsed
  content/markdown.js      HTML → Markdown (block-level recursive)
  content/serialize.js     3️⃣ message walk: roles, activity items, code cards → md
  content/main.js          orchestrator + runtime message API (EXPORT_START/PING, PROGRESS)
```

Content scripts run in the isolated world and only touch the DOM; no `page JS` access needed.
All scripts share one global namespace `AREX` (manifest load order = init order).

## Pipeline (per export request)

```
EXPORT_START ─▶ preflight ─▶ 1 loadFullHistory ─▶ 2 expandAllSpoilers ─▶ 3 serialize ─▶ deliver
                  │                 │                      │                    │
        on /agent/* page?    scroll top until        until no            Blob → popup →
        not generating?      message count/          button[aria-        chrome.downloads
        [role=log] ready     first-id stable ×N      expanded=false]     (saveAs); fallback:
                             (+ retry button)        remains (nested)    <a download> in page
```

1. **History gate** (`loader.js`). Arena pages the transcript (20/turn page, earlier pages mount
   above on demand — see research). Loop: `log.scrollTo({top:0})` → the top sentinel's
   IntersectionObserver (rootMargin 200px) fires `loadEarlierMessages`; wait (≤8 s) for the message
   count or the first message id to change; click the "Load earlier messages" retry button if the
   loader failed; finish after 3 stagnant rounds (also covers the single-page "compat" case).
2. **Spoiler gate** (`expand.js`). Collapsed spoilers don't exist in the DOM (unmounted, not
   hidden), and groups mount nested collapsed children when opened → iterative passes:
   click every visible `button[aria-expanded="false"]` inside `div[role="log"]`, wait for the DOM
   to settle (MutationObserver quiet ≥250 ms, cap 3 s), repeat. Stop on an empty pass; bail with a
   warning if a pass makes no progress (stuck/disabled buttons). Message count is re-checked after
   each pass — a change signals unexpected remounting (future windowing) and aborts export loudly.
3. **Serialization** (`serialize.js` + `markdown.js`). Order-preserving walk over
   `[data-agent-transcript-message]`, role by presence of `[data-user-message-layout]`.
   Everything stays inside `[role="log"]` ⇒ sidebar/preview/composer never enter the output.

### DOM → Markdown mapping

| DOM (inside log)                                             | Markdown |
|---|---|
| message wrapper (user)                                       | `## 👤 User` (+ `📎 **Attached:** …` chips) |
| message wrapper (assistant)                                  | `## 🤖 Assistant` |
| `.prose`                                                     | converted HTML→MD (headings, lists, code, tables, links) |
| activity header `button[aria-expanded]` text                 | `#### used Bash — 143ms` (nested → one level deeper each, min heading 6, then indents) |
| labeled card (`command`/`stdout`/`stderr` + `pre`)           | `**command:**` + fenced block (`command`→` ```bash `, others ` ```text `) |
| file chip `[role="button"]` + preview (`SHELLSCRIPT`,`MD`,…) | `**📄 name**` + fenced block, lang mapped, `.select-none` gutter stripped |
| leaf row in panel ("Read x.sh")                              | `- Read x.sh` |
| footer (Copy/time/duration)                                  | skipped; optional `*4:49 PM*` with `timestamps: true` |

Fence size auto-extends when content contains backticks. Option `includeToolActivity: false`
exports prose only (spoilers then skipped entirely).

## Delivery & UX details

- Popup keeps the run alive; result string → popup creates blob URL →
  `chrome.downloads.download({ saveAs: true })`, filename
  `arena-<slug(branch title|uuid)>-<YYYYMMDD-HHmm>.md`.
- If the popup closed mid-run, the content script falls back to an in-page `<a download>` click.
- Progress (`AREX_PROGRESS` messages: loaded N messages / pass K, expanded M / serializing) is
  shown in the popup; runs are serialized per tab (re-click while running = refusal).
- Export is refused while `button[aria-label="Stop generating"]` exists (stream in flight).
- Options persist via `chrome.storage.sync`.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Tailwind class churn (`prose`, `max-w-3xl`, card colors) | depend on stable data/aria hooks only; classes used solely within fixture-tested heuristics with fallbacks |
| Arena adds DOM windowing later | abort if message count shrinks mid-run; research shows none today |
| Unknown activity block types (plans, diffs, reasoning variants) | generic fallbacks: labeled-card, any-`pre`, text-row; headers are free-text |
| Huge branches (RAM, message-size limits) | expansion is unavoidable (user requirement); result string is streamed straight to download; ≤ tens of MB is fine |
| i18n of "Loading earlier messages" retry | primary trigger is scrolling (lang-free); text button is only an error-recovery extra |

## Testing

`npm test` (node:test + jsdom): markdown converter cases; serializer over the saved transcript
fixture (546 KB, 9 messages) asserting message order/roles, fences, exclusion of sidebar/panel
artifacts; loader/expander loops against synthetic DOMs that emulate Arena's mount-on-click and
prepend-on-scroll behavior with fake timers.
