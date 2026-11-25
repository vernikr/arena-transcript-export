# AGENTS.md

## Issues

- For native GitHub sub-issues, ensure `.github/workflows/issue-parent-sync.yml` exists with `issues: [opened, edited]`, `permissions: issues: write`, and a job calling `vernikr/mother/.github/workflows/issue-parent-sync.yml@v1` (create the caller workflow if missing); then put `<!-- issue-parent: #N -->` on its own line in the child Issue body, or use `<!-- issue-parent: none -->` to detach.

## Chrome extension sync (local profiles, via Arena Bridge)

How the installed extension gets updated. The loadable extension lives in `extension/` and is
loaded **unpacked** in Chrome on the user's Mac from one shared checkout:

```
~/Downloads/projects/arena-transcript-export/extension
```

Every profile that has the extension registered points at that same directory, so syncing is
never a copy step — profiles must not be edited individually.

### After every push to `main`

1. Run on the Mac, through the Arena Bridge `bash` tool (not on the cloud sandbox):

   ```bash
   bash ~/Downloads/projects/arena-transcript-export/scripts/sync-extension.sh
   ```

   It does `git fetch` + `git pull --ff-only origin main` and rewrites
   `extension/dev-version.txt` with the new short SHA. The sentinel is the trigger;
   `manifest.version` is not, because it only moves on real releases.

2. Every profile's service worker polls that file and reloads itself —
   `chrome.alarms` every minute, plus a 10 s fast path while the worker is awake
   (`extension/dev-reload.js`, imported at the top of `background.js`). Give it ~60 s.

3. Verify, then report the per-profile result to the user:

   ```bash
   bash ~/Downloads/projects/arena-transcript-export/scripts/check-extension-sync.sh
   ```

   `pending` right after a sync is normal for up to a minute. If it is still `pending` after
   several minutes, the sentinel was not written or that profile's worker is asleep — ask the
   user to open `chrome://extensions` in that profile and press **Reload**.

### Hard rules

- The extension is installed in exactly these five profiles: `Default`, `Profile 1`,
  `Profile 10`, `Profile 12`, `Profile 16`. Do not install it anywhere else (the user decided
  the other nine profiles are out of scope) and never copy files between profile directories.
- Never edit `Secure Preferences` / `Local State` to register or reload the extension: Chrome
  signs them and silently reverts out-of-band changes.
- Do not build flows on CDP: `chrome_attach` (port 9222) does not work on this Chrome build.
  Self-hosted CRX / External Extensions update URLs are also dead ends on macOS.
- Never interrupt a running export: `dev-reload.js` postpones the reload while any job has
  `status: "running"` and retries on the next tick.
- Keep the plumbing intact: `"alarms"` in `extension/manifest.json` permissions, the
  `importScripts('dev-reload.js')` line in `extension/background.js`, and the
  `extension/dev-version.txt` rule in `.gitignore`. Never commit the sentinel file.
- One-time bootstrap, and only after code older than 0.4.2 is still loaded: a profile that
  holds pre-`dev-reload.js` code cannot react to the sentinel and needs exactly one manual
  reload (`chrome://extensions` → card → **Reload**, or restart Chrome). A profile whose
  window was closed loads the new code from disk on its next launch by itself. Once a profile
  is on 0.4.2+, never reload by hand again — the sentinel handles every later push.

### Test caveat

`npm test`: the "LRU eviction caps scoped snapshots at 8 and logs at 16" test in
`test/result-store.test.mjs` fails intermittently in full-suite runs even on a clean tree; it
passes when run in isolation. Do not chase it as a regression.
