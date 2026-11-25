// Persistent storage for the latest prepared transcript.
// IndexedDB avoids chrome.storage.local's small quota for large conversation histories.
// Shared between the popup (window.indexedDB) and the background service worker
// (self.indexedDB): both live on the chrome-extension://<id> origin.
// Loaded via <script src> in the popup and importScripts() in the service worker.
(() => {
  const root = typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this);
  const DB_NAME = 'arena-transcript-export';
  const STORE_NAME = 'snapshots';
  const DB_VERSION = 2;

  // Legacy v1 keys kept for migration and default-scope shims.
  const LEGACY_KEY = 'latest';
  const LEGACY_META_KEY = 'latest-meta';
  const LEGACY_PROFILE_KEY = 'latest-profile';
  const DEFAULT_SCOPE = 'default';

  const MAX_SCOPED_SNAPSHOTS = 8;
  const MAX_SCOPED_LOGS = 16;

  let databasePromise = null;

  const byteLength = text => {
    try { return new TextEncoder().encode(String(text ?? '')).length; }
    catch { return String(text ?? '').length; }
  };

  function normalizeId(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
    return null;
  }

  function tabKey(tabId) {
    const id = normalizeId(tabId);
    return id === null ? null : `tab:${id}`;
  }

  function chatKey(chatUuid) {
    const id = normalizeId(chatUuid);
    return id === null ? null : `chat:${id}`;
  }

  function logTabKey(tabId) {
    const id = normalizeId(tabId);
    return id === null ? null : `log:tab:${id}`;
  }

  function logChatKey(chatUuid) {
    const id = normalizeId(chatUuid);
    return id === null ? null : `log:chat:${id}`;
  }

  function snapshotKeysForScope(scope = {}) {
    const keys = [];
    const tk = tabKey(scope.tabId);
    const ck = chatKey(scope.chatUuid);
    if (tk) keys.push(tk);
    if (ck) keys.push(ck);
    return keys;
  }

  function logKeysForScope(scope = {}) {
    const keys = [];
    const tk = logTabKey(scope.tabId);
    const ck = logChatKey(scope.chatUuid);
    if (tk) keys.push(tk);
    if (ck) keys.push(ck);
    return keys;
  }

  function isSnapshotRecordKey(key) {
    return typeof key === 'string'
      && key !== DEFAULT_SCOPE
      && key !== LEGACY_KEY
      && key !== LEGACY_META_KEY
      && key !== LEGACY_PROFILE_KEY
      && key !== chatKey(DEFAULT_SCOPE)
      && !key.startsWith('log:');
  }

  function isLogRecordKey(key) {
    return typeof key === 'string' && key.startsWith('log:');
  }

  function metaOf(snapshot, { partial = false, updatedAt } = {}) {
    const markdown = typeof snapshot?.markdown === 'string' ? snapshot.markdown : '';
    const completedMessages = Number.isInteger(snapshot?.completedMessages)
      ? snapshot.completedMessages
      : (Number.isInteger(snapshot?.stats?.messages) ? snapshot.stats.messages : null);
    const totalMessages = Number.isInteger(snapshot?.totalMessages)
      ? snapshot.totalMessages
      : (Number.isInteger(snapshot?.stats?.totalMessages) ? snapshot.stats.totalMessages : null);
    return {
      filename: snapshot?.filename || null,
      stats: snapshot?.stats || null,
      warnings: Array.isArray(snapshot?.warnings) ? snapshot.warnings : [],
      createdAt: snapshot?.createdAt || Date.now(),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : (snapshot?.updatedAt || Date.now()),
      bytes: typeof snapshot?.bytes === 'number' ? snapshot.bytes : byteLength(markdown),
      tabId: typeof snapshot?.tabId === 'number' ? snapshot.tabId : (normalizeId(snapshot?.tabId) ?? null),
      chatUuid: snapshot?.chatUuid ? String(snapshot.chatUuid) : null,
      sourceUrl: snapshot?.sourceUrl || null,
      partial: Boolean(partial),
      completedMessages,
      totalMessages,
    };
  }

  function makeSnapshotRecord(scope, snapshot, { partial = false, profile = null } = {}) {
    const updatedAt = Date.now();
    const record = {
      snapshot: snapshot ? { ...snapshot, createdAt: snapshot?.createdAt || updatedAt, updatedAt } : null,
    };
    if (record.snapshot && typeof record.snapshot.bytes !== 'number') {
      record.snapshot.bytes = byteLength(record.snapshot.markdown);
    }
    record.meta = metaOf(record.snapshot, { partial, updatedAt });
    // Scope identity is authoritative for lookups and SPA-branch verification.
    const tabId = normalizeId(scope?.tabId);
    const chatUuid = normalizeId(scope?.chatUuid);
    if (tabId !== null) record.meta.tabId = tabId;
    if (chatUuid !== null) record.meta.chatUuid = String(chatUuid);
    record.profile = (profile && typeof profile === 'object') ? { ...profile } : (record.snapshot?.profile ?? null);
    record.updatedAt = updatedAt;
    record.recordType = 'snapshot';
    return record;
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const indexedDB = root.indexedDB;
      if (!indexedDB) {
        reject(new Error('IndexedDB is unavailable in this browser.'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = request.result;
        const tx = request.transaction;
        const oldVersion = event.oldVersion || 0;
        let store;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          store = db.createObjectStore(STORE_NAME);
        } else {
          store = tx.objectStore(STORE_NAME);
        }

        // v1 -> v2: migrate legacy singleton keys into default scope record.
        if (oldVersion < 2) {
          const getReq = store.get(LEGACY_KEY);
          getReq.onsuccess = () => {
            const legacy = getReq.result;
            const metaReq = store.get(LEGACY_META_KEY);
            metaReq.onsuccess = () => {
              const legacyMeta = metaReq.result;
              const profileReq = store.get(LEGACY_PROFILE_KEY);
              profileReq.onsuccess = () => {
                const legacyProfile = profileReq.result;
                if (legacy && typeof legacy === 'object') {
                  const migratedSnapshot = { ...legacy };
                  const record = {
                    snapshot: migratedSnapshot,
                    meta: legacyMeta && typeof legacyMeta === 'object' ? { ...legacyMeta } : metaOf(migratedSnapshot),
                    profile: legacyProfile && typeof legacyProfile === 'object' ? { ...legacyProfile } : null,
                    updatedAt: Date.now(),
                    recordType: 'snapshot',
                  };
                  if (!Number.isFinite(record.meta.updatedAt)) record.meta.updatedAt = record.meta.createdAt || record.updatedAt;
                  record.meta.partial = Boolean(record.meta.partial);
                  if (!('completedMessages' in record.meta)) record.meta.completedMessages = Number.isInteger(record.meta?.stats?.messages) ? record.meta.stats.messages : null;
                  if (!('totalMessages' in record.meta)) record.meta.totalMessages = Number.isInteger(record.meta?.stats?.totalMessages) ? record.meta.stats.totalMessages : null;
                  store.put(record, chatKey(DEFAULT_SCOPE));
                }
                // Remove legacy keys after successful migration read; keep no-op safe.
                try { store.delete(LEGACY_KEY); } catch {}
                try { store.delete(LEGACY_META_KEY); } catch {}
                try { store.delete(LEGACY_PROFILE_KEY); } catch {}
              };
            };
          };
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open saved export history.'));
      request.onblocked = () => reject(new Error('Saved export storage is blocked by another browser tab.'));
    }).catch(error => {
      databasePromise = null;
      throw error;
    });
    return databasePromise;
  }

  function withStore(mode, fn) {
    return openDatabase().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      let settled = false;
      let result;
      const finishResolve = (value) => { if (!settled) { settled = true; result = value; } };
      const finishReject = (error) => { if (!settled) { settled = true; reject(error); } };
      tx.oncomplete = () => { if (!settled) resolve(result); else resolve(result); };
      tx.onerror = () => finishReject(tx.error || new Error('Could not commit the saved transcript.'));
      tx.onabort = () => finishReject(tx.error || new Error('Saved transcript transaction was aborted.'));
      Promise.resolve().then(() => fn(store, finishResolve, finishReject, tx)).catch(finishReject);
    }));
  }

  function requestToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function collectAll(store) {
    // Prefer getAllKeys/getAll when available (fake-indexeddb supports them).
    if (typeof store.getAllKeys === 'function' && typeof store.getAll === 'function') {
      return Promise.all([requestToPromise(store.getAllKeys()), requestToPromise(store.getAll())])
        .then(([keys, values]) => keys.map((key, i) => ({ key, value: values[i] })));
    }
    return new Promise((resolve, reject) => {
      const entries = [];
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(entries); return; }
        entries.push({ key: cursor.key, value: cursor.value });
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  function recordScopeId(key, value) {
    if (key === DEFAULT_SCOPE) return 'scope:default';
    if (isLogRecordKey(key)) {
      const tabId = normalizeId(value?.tabId);
      const chatUuid = normalizeId(value?.chatUuid);
      if (tabId !== null) return `log:tab:${tabId}`;
      if (chatUuid !== null) return `log:chat:${chatUuid}`;
      return `log:key:${String(key)}`;
    }
    const tabId = normalizeId(value?.meta?.tabId ?? value?.snapshot?.tabId);
    const chatUuid = normalizeId(value?.meta?.chatUuid ?? value?.snapshot?.chatUuid);
    if (tabId !== null) return `snap:tab:${tabId}`;
    if (chatUuid !== null) return `snap:chat:${chatUuid}`;
    return `snap:key:${String(key)}`;
  }

  function evictLRU(store, predicate, maxRecords, protectedKeys = []) {
    const protectedSet = new Set(protectedKeys.filter(k => typeof k === 'string'));
    return collectAll(store).then(entries => {
      const groups = new Map();
      for (const e of entries) {
        if (!predicate(e.key)) continue;
        const scopeId = recordScopeId(e.key, e.value);
        const updatedAt = Number.isFinite(e.value?.updatedAt)
          ? e.value.updatedAt
          : (Number.isFinite(e.value?.meta?.updatedAt) ? e.value.meta.updatedAt : (Number.isFinite(e.value?.meta?.createdAt) ? e.value.meta.createdAt : 0));
        const g = groups.get(scopeId) || { scopeId, updatedAt: 0, keys: [], protected: false };
        g.updatedAt = Math.max(g.updatedAt, updatedAt);
        g.keys.push(e.key);
        if (protectedSet.has(e.key)) g.protected = true;
        groups.set(scopeId, g);
      }
      const all = Array.from(groups.values())
        .sort((a, b) => (b.updatedAt - a.updatedAt) || String(a.scopeId).localeCompare(String(b.scopeId)));
      const keep = new Set();
      // Always keep protected groups (just-written scope).
      for (const g of all) { if (g.protected) keep.add(g.scopeId); }
      // Fill remaining slots with most recent non-protected groups.
      for (const g of all) {
        if (keep.size >= maxRecords) break;
        keep.add(g.scopeId);
      }
      for (const g of all) {
        if (keep.has(g.scopeId)) continue;
        for (const key of g.keys) { try { store.delete(key); } catch {} }
      }
    });
  }

  async function saveForScope(scope = {}, snapshot = {}, options = {}) {
    if (!snapshot || typeof snapshot !== 'object') throw new Error('Snapshot must be an object.');
    const keys = snapshotKeysForScope(scope);
    if (keys.length === 0) throw new Error('saveForScope requires tabId and/or chatUuid.');
    const record = makeSnapshotRecord(scope, snapshot, options);
    await withStore('readwrite', async (store) => {
      for (const key of keys) store.put(record, key);
      await evictLRU(store, isSnapshotRecordKey, MAX_SCOPED_SNAPSHOTS, keys);
    });
    return record.meta;
  }

  async function loadSnapshotRecordForTab(tabId, chatUuid) {
    const tk = tabKey(tabId);
    const ck = chatKey(chatUuid);
    return withStore('readonly', async (store, resolve) => {
      let tabRecord = null;
      if (tk) tabRecord = await requestToPromise(store.get(tk));
      if (tabRecord && typeof tabRecord === 'object') {
        const recordChat = normalizeId(tabRecord.meta?.chatUuid ?? tabRecord.snapshot?.chatUuid);
        const requestedChat = normalizeId(chatUuid);
        if (requestedChat === null || recordChat === null || String(recordChat) === String(requestedChat)) {
          resolve(tabRecord);
          return;
        }
        // SPA branch switch in same tab: tab key belongs to another branch.
      }
      if (ck) {
        const chatRecord = await requestToPromise(store.get(ck));
        if (chatRecord && typeof chatRecord === 'object') {
          resolve(chatRecord);
          return;
        }
      }
      resolve(null);
    });
  }

  async function loadForTab(tabId, chatUuid) {
    const record = await loadSnapshotRecordForTab(tabId, chatUuid);
    return record?.snapshot ?? null;
  }

  async function loadMetaForTab(tabId, chatUuid) {
    const record = await loadSnapshotRecordForTab(tabId, chatUuid);
    return record?.meta ?? null;
  }

  async function saveDiagnosticLog(scope = {}, logBundle = {}) {
    if (!logBundle || typeof logBundle !== 'object') throw new Error('Diagnostic log must be an object.');
    const keys = logKeysForScope(scope);
    if (keys.length === 0) throw new Error('saveDiagnosticLog requires tabId and/or chatUuid.');
    const tabId = normalizeId(scope?.tabId);
    const chatUuid = normalizeId(scope?.chatUuid);
    const record = {
      log: { ...logBundle },
      tabId: tabId !== null ? tabId : null,
      chatUuid: chatUuid !== null ? String(chatUuid) : null,
      updatedAt: Date.now(),
      recordType: 'log',
    };
    await withStore('readwrite', async (store) => {
      for (const key of keys) store.put(record, key);
      await evictLRU(store, isLogRecordKey, MAX_SCOPED_LOGS, keys);
    });
    return record;
  }

  async function loadDiagnosticLog(tabId, chatUuid) {
    const tk = logTabKey(tabId);
    const ck = logChatKey(chatUuid);
    return withStore('readonly', async (store, resolve) => {
      let tabRecord = null;
      if (tk) tabRecord = await requestToPromise(store.get(tk));
      if (tabRecord && typeof tabRecord === 'object') {
        const recordChat = normalizeId(tabRecord.chatUuid);
        const requestedChat = normalizeId(chatUuid);
        if (requestedChat === null || recordChat === null || String(recordChat) === String(requestedChat)) {
          resolve(tabRecord.log ?? null);
          return;
        }
      }
      if (ck) {
        const chatRecord = await requestToPromise(store.get(ck));
        if (chatRecord && typeof chatRecord === 'object') {
          resolve(chatRecord.log ?? null);
          return;
        }
      }
      resolve(null);
    });
  }

  // --- Legacy shims (delegate to default scope) -----------------------------

  async function legacySave(snapshot) {
    const record = { ...snapshot, createdAt: snapshot?.createdAt || Date.now() };
    if (typeof record.bytes !== 'number') record.bytes = byteLength(record.markdown);
    const key = chatKey(DEFAULT_SCOPE);
    let meta;
    await withStore('readwrite', async (store) => {
      const existing = await requestToPromise(store.get(key));
      const existingProfile = (existing && typeof existing === 'object' && existing.profile && typeof existing.profile === 'object')
        ? existing.profile
        : null;
      const rec = makeSnapshotRecord({ chatUuid: DEFAULT_SCOPE }, record, {
        partial: Boolean(record.partial),
        profile: existingProfile,
      });
      // Preserve legacy scope identity in meta.
      rec.meta.tabId = typeof record?.tabId === 'number' ? record.tabId : (normalizeId(record?.tabId) ?? null);
      rec.meta.chatUuid = record?.chatUuid ? String(record.chatUuid) : rec.meta.chatUuid;
      meta = rec.meta;
      store.put(rec, key);
    });
    return meta;
  }

  async function legacyLoad() {
    const rec = await withStore('readonly', async (store, resolve) => {
      const r = await requestToPromise(store.get(chatKey(DEFAULT_SCOPE)));
      resolve(r && typeof r === 'object' ? r : null);
    });
    return rec?.snapshot;
  }

  async function legacyLoadMeta() {
    const rec = await withStore('readonly', async (store, resolve) => {
      const r = await requestToPromise(store.get(chatKey(DEFAULT_SCOPE)));
      resolve(r && typeof r === 'object' ? r : null);
    });
    if (!rec) return null;
    return rec.meta || metaOf(rec.snapshot);
  }

  async function legacyLoadProfile() {
    const rec = await withStore('readonly', async (store, resolve) => {
      const r = await requestToPromise(store.get(chatKey(DEFAULT_SCOPE)));
      resolve(r && typeof r === 'object' ? r : null);
    });
    return (rec?.profile && typeof rec.profile === 'object') ? rec.profile : null;
  }

  async function legacySaveProfile(profile) {
    if (!profile || typeof profile !== 'object') throw new Error('Profile must be an object.');
    const recordProfile = { ...profile };
    if (!Number.isInteger(recordProfile.profileVersion)) recordProfile.profileVersion = 1;
    await withStore('readwrite', async (store) => {
      const key = chatKey(DEFAULT_SCOPE);
      const existing = await requestToPromise(store.get(key));
      const base = existing && typeof existing === 'object' ? { ...existing } : {
        snapshot: null, meta: null, profile: null, updatedAt: Date.now(), recordType: 'snapshot',
      };
      base.profile = recordProfile;
      base.updatedAt = Date.now();
      if (!base.recordType) base.recordType = 'snapshot';
      store.put(base, key);
    });
    return recordProfile;
  }

  async function legacyClearProfile() {
    await withStore('readwrite', async (store) => {
      const key = chatKey(DEFAULT_SCOPE);
      const existing = await requestToPromise(store.get(key));
      if (!existing || typeof existing !== 'object') return;
      existing.profile = null;
      existing.updatedAt = Date.now();
      store.put(existing, key);
    });
  }

  async function legacyClear() {
    await withStore('readwrite', async (store) => {
      store.delete(chatKey(DEFAULT_SCOPE));
      // Also clean legacy keys if somehow present.
      try { store.delete(LEGACY_KEY); } catch {}
      try { store.delete(LEGACY_META_KEY); } catch {}
      try { store.delete(LEGACY_PROFILE_KEY); } catch {}
    });
  }

  root.AREX_RESULT_STORE = {
    DB_NAME,
    STORE_NAME,
    DB_VERSION,
    MAX_SCOPED_SNAPSHOTS,
    MAX_SCOPED_LOGS,

    // v2 scoped API
    saveForScope,
    loadForTab,
    loadMetaForTab,
    saveDiagnosticLog,
    loadDiagnosticLog,

    // Legacy shims (default scope)
    loadProfile: legacyLoadProfile,
    saveProfile: legacySaveProfile,
    clearProfile: legacyClearProfile,
    load: legacyLoad,
    loadMeta: legacyLoadMeta,
    save: legacySave,
    clear: legacyClear,
  };
})();
