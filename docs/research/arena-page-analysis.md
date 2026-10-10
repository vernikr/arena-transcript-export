# Arena.ai agent page — DOM & bundle analysis

Evidence base: saved page (`Arena _ Benchmark & Compare the Best AI Models.html`, 1.8 MB, 9 messages)
from `https://arena.ai/agent/<uuid>` + its JS chunks (Next.js/Turbopack, shadcn/Radix UI).

## Answer to "are old messages unloaded in long branches?"

Yes for **loading**: the transcript is paginated. In bundles:

- `COMPLETE_TRANSCRIPT_PAGINATION = { hasMore: false, cursor: null, limit: 20 }` — cursor pages of 20.
- `GET /api/chat/:id` returns `{ messages, pagination, ... }`; `transcriptReadStrategy` is
  `"bounded"` when the server sent pagination, else `"compat"` (whole transcript).
- A top sentinel inside `div[role="log"]` is watched by an `IntersectionObserver`
  (`{ root: logElement, rootMargin: "200px 0px 0px" }`); entering view calls `loadEarlierMessages()`.
- Intermediate UI states: `role="status"` spinner text **"Loading earlier messages"**; on failure an
  absolute-positioned `<button>` **"Load earlier messages"** (retry, text-lookup).
- `LARGE_CHAT_UI_MESSAGE_THRESHOLD = 20`; telemetry `agent.chat.transcript_page_ready` carries
  `page: "older"`, `strategy: "bounded"`, `hasMore`.
- Telemetry tracks `loadedMessageCount` vs `renderedMessageCount`
  (`root.querySelectorAll("[data-agent-transcript-message]").length`).

No **unmounting** of loaded messages was found: no tanstack-virtual/react-window usage, no
message-window slicing in chat chunks. Loaded pages stay in the DOM (only render throttling like
`content-visibility` may skip painting, which does not affect serialization). The exporter still
treats message count as a live invariant and re-verifies it at the end.

## Transcript DOM anatomy (live page, dark theme)

```
main
└─ div[role="log"].overflow-y-auto          ← transcript scroll container (aria-live=polite)
   └─ div.max-w-3xl…                         ← message list column
      ├─ div[data-agent-transcript-message][data-chat-message-id][id="chat-message-…"]  (per turn)
      │  ├─ (user) div[data-user-message-layout] → attachment chips (span.truncate) + .prose
      │  └─ (assistant) card div.bg-surface-primary
      │     ├─ activity items: wrapper div > button[aria-expanded] (+ sibling panel after expand)
      │     ├─ div.prose (answer text; may appear between/after activity items)
      │     └─ footer: button[aria-label="Copy"], <time>, duration ("18m 4s | 1 hour ago")
      └─ bottom spacer (div.shrink-0)
```

Stable hooks (not obfuscated by Tailwind): `[role="log"]`, `[data-agent-transcript-message]`,
`[data-chat-message-id]`, `[data-user-message-layout]`, `.prose`, `button[aria-expanded]`,
`button[aria-label]` ("Copy", "Expand", "Collapse", "Open file", "Stop generating").

## Spoilers (critical)

- Collapsible = `<button aria-expanded="true|false">` + animated sibling/child
  `<div style="overflow: clip; height: auto; opacity: 1">` (present only when expanded).
- **Collapsed content is not in the DOM at all** (parent holds only the button) → must click every
  `button[aria-expanded="false"]` in the transcript, then repeat: expanding a group
  (e.g. "Ran commands 6") mounts nested items that are themselves collapsed. Loop until none remain.
- Headers observed: `used Bash … 143ms`, `used Bash exit 128 238ms`, `Ran commands N`,
  `Explored N reads`, `Edited files N`, `Edit <path> ×n`, `Write <path> N lines` (+ `open`).
- Panel bodies: labeled cards — uppercase chip `command` / `stdout` / `stderr` + `<pre>`;
  leaf rows ("Read <file>"); nested item wrappers; file-preview cards
  (`[role="button"]` chip: filename + lang span like `SHELLSCRIPT`/`MD`/`YAML`, then a
  highlighted preview with `.select-none` line-number gutter spans).
- Reasoning parts exist in the protocol (`reasoningUIPartSchema`) but none were rendered in the
  dump; the generic spoiler rule covers them if shown.

## Scope exclusion

Left sidebar is `[data-sidebar="sidebar"]` (shadcn), the right preview/workspace panel is
`div.absolute.bottom-0.end-0.top-0` under `main`. Both sit outside `div[role="log"]`; scoping all
queries to the log element excludes them and the composer/footer naturally.

## Streaming gate

While the agent generates, `button[aria-label="Stop generating"]` exists → export is refused with a
clear error (the DOM would mutate mid-export and truncate the branch tail).
