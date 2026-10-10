# 2026.10.10 — secret exposure purge & history rewrite

## Incident
Repo (planned private) ended up public; secret scanning auto-revoked the GitHub PAT embedded in
the repo's copy of the user's global `AGENTS.md` (also containing npm/PyPI tokens), breaking the
session's write auth mid-task.

## User decisions
- Keep the project **public**; remove `AGENTS.md` from the project entirely.
- Purge `AGENTS.md` from git history; tokens are disposable and will be rotated by the user.

## Actions
- `git filter-repo --path AGENTS.md --invert-paths` → full history rewrite (all SHAs changed).
- Deleted GitHub Release + tag `v0.2.0` (pinned secret-bearing ancestry), force-pushed rewritten
  `main`, re-created releases `v0.2.0` (zip of the extension as of the cut) and `v0.2.1`.
- **Caveat:** commits removed by the rewrite may linger as dangling objects on GitHub's side
  reachable by old SHA until server-side GC; treat all old tokens as leaked permanently
  (rotation covers it). Only repo delete/recreate or a support ticket purges server caches.

## Rule for this repo
Never add `AGENTS.md` (or any file with credentials) to this repository.
