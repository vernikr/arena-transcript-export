// ---------------------------------------------------------------------------
// Dev reload: pick up a fresh checkout without clicking "Reload" by hand.
//
// The cloud agent (Arena) pulls the repo on this machine and then rewrites
// extension/dev-version.txt with the new commit SHA (see
// scripts/sync-extension.sh). Every Chrome profile runs its own service worker,
// so every profile polls that sentinel file and calls chrome.runtime.reload()
// on its own — no CDP, no chrome://extensions, no copy-per-profile.
//
// Why a sentinel file and not manifest.version: the version is bumped only for
// real releases (0.4.1 today), so it would miss most pushes.
// Why chrome.alarms and not a WebSocket: MV3 puts the service worker to sleep
// after ~30 s, which kills any socket; alarms wake it back up.
//
// The sentinel lives outside git (extension/dev-version.txt is ignored), so a
// fresh clone simply has no sentinel and this module stays idle.
// ---------------------------------------------------------------------------

(() => {
  const SENTINEL = 'dev-version.txt';
  const ALARM = 'arex-dev-reload';
  const STORAGE_KEY = 'arexDevVersion';
  const SESSION_KEY = 'arexJobs';
  const POLL_MS = 10000; // fast path while the worker happens to be awake
  const ALARM_MINUTES = 1; // guaranteed wake-up while the worker sleeps

  if (typeof chrome === 'undefined' || !chrome.alarms || !chrome.runtime?.getURL) return;
  if (typeof fetch !== 'function') return;

  let checking = false;
  let reloading = false;

  async function readSentinel() {
    const url = `${chrome.runtime.getURL(SENTINEL)}?t=${Date.now()}`;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    const text = (await response.text()).trim();
    return text || null;
  }

  // Never pull the rug out from under a running export: the coordinator mirrors
  // job state to session storage, so an in-flight job is visible from here.
  async function hasRunningJob() {
    try {
      const stored = await chrome.storage?.session?.get?.(SESSION_KEY);
      const list = stored?.[SESSION_KEY];
      if (!Array.isArray(list)) return false;
      return list.some(job => job && job.status === 'running');
    } catch {
      return false;
    }
  }

  async function check() {
    if (checking || reloading) return;
    checking = true;
    try {
      const current = await readSentinel();
      if (!current) return;
      const stored = (await chrome.storage.local.get(STORAGE_KEY))?.[STORAGE_KEY] || null;
      if (stored === current) return;
      if (!stored) {
        // First run after the dev-version feature landed: record the baseline
        // instead of reloading, otherwise the first check would always reload.
        await chrome.storage.local.set({ [STORAGE_KEY]: current });
        return;
      }
      if (await hasRunningJob()) return; // retry on the next tick
      reloading = true;
      // Recorded before the reload so the next worker start does not see a
      // mismatch and reload again in a loop.
      await chrome.storage.local.set({ [STORAGE_KEY]: current });
      try { console.info('[arex] dev version', stored, '->', current, '- reloading extension'); } catch { /* noop */ }
      chrome.runtime.reload();
    } catch {
      // No sentinel yet, or storage unavailable: stay silent and try later.
    } finally {
      checking = false;
    }
  }

  try {
    chrome.alarms.create(ALARM, { periodInMinutes: ALARM_MINUTES });
    chrome.alarms.onAlarm.addListener(alarm => {
      if (alarm?.name === ALARM) void check();
    });
  } catch { /* alarms permission missing: poll while awake only */ }

  try { setInterval(() => void check(), POLL_MS)?.unref?.(); } catch { /* noop */ }
  void check();
})();
