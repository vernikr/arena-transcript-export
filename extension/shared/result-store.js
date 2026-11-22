// Persistent storage for the latest prepared transcript.
// IndexedDB avoids chrome.storage.local's small quota for large conversation histories.
// Shared between the popup (window.indexedDB) and the background service worker
// (self.indexedDB): both live on the chrome-extension://<id> origin.
// Loaded via <script src> in the popup and importScripts() in the service worker.
(() => {
  const root = typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this);
  const DB_NAME = 'arena-transcript-export';
  const STORE_NAME = 'snapshots';
  const KEY = 'latest';
  // Tiny metadata record kept next to the full snapshot so the UI can show
  // "what is stored" without reading a multi-megabyte markdown string.
  const META_KEY = 'latest-meta';
  const PROFILE_KEY = 'latest-profile';
  let databasePromise = null;

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const indexedDB = root.indexedDB;
      if (!indexedDB) {
        reject(new Error('IndexedDB is unavailable in this browser.'));
        return;
      }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
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

  function requestValue(mode, operation, value) {
    return openDatabase().then(db => new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      const request = operation === 'get'
        ? store.get(value)
        : operation === 'put'
          ? store.put(value.data, value.key)
          : store.delete(value);
      let result;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error || new Error('Could not access the saved transcript.'));
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error('Could not commit the saved transcript.'));
      transaction.onabort = () => reject(transaction.error || new Error('Saved transcript transaction was aborted.'));
    }));
  }

  function putBoth(full, meta) {
    return openDatabase().then(db => new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.put(full, KEY);
      store.put(meta, META_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Could not commit the saved transcript.'));
      transaction.onabort = () => reject(transaction.error || new Error('Saved transcript transaction was aborted.'));
    }));
  }

  function deleteBoth() {
    return openDatabase().then(db => new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.delete(KEY);
      store.delete(META_KEY);
      store.delete(PROFILE_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Could not delete the saved transcript.'));
      transaction.onabort = () => reject(transaction.error || new Error('Saved transcript transaction was aborted.'));
    }));
  }

  const byteLength = text => {
    try { return new TextEncoder().encode(String(text ?? '')).length; }
    catch { return String(text ?? '').length; }
  };

  function metaOf(snapshot) {
    const markdown = typeof snapshot?.markdown === 'string' ? snapshot.markdown : '';
    return {
      filename: snapshot?.filename || null,
      stats: snapshot?.stats || null,
      warnings: Array.isArray(snapshot?.warnings) ? snapshot.warnings : [],
      createdAt: snapshot?.createdAt || Date.now(),
      bytes: typeof snapshot?.bytes === 'number' ? snapshot.bytes : byteLength(markdown),
      // Job context, when the snapshot was persisted by the background coordinator.
      tabId: typeof snapshot?.tabId === 'number' ? snapshot.tabId : null,
      chatUuid: snapshot?.chatUuid || null,
      sourceUrl: snapshot?.sourceUrl || null,
    };
  }

  root.AREX_RESULT_STORE = {
    // Persistent profile record attached to the latest snapshot.
    loadProfile: () => requestValue('readonly', 'get', PROFILE_KEY).then(value => (value && typeof value === 'object' ? value : null)),
    async saveProfile(profile) {
      if (!profile || typeof profile !== 'object') throw new Error('Profile must be an object.');
      const record = { ...profile };
      if (!Number.isInteger(record.profileVersion)) record.profileVersion = 1;
      await requestValue('readwrite', 'put', { data: record, key: PROFILE_KEY });
      return record;
    },
    clearProfile: () => requestValue('readwrite', 'delete', PROFILE_KEY),

    load: () => requestValue('readonly', 'get', KEY),
    async loadMeta() {
      const meta = await requestValue('readonly', 'get', META_KEY);
      if (meta) return meta;
      // Upgrade path for snapshots stored before the metadata record existed.
      const full = await requestValue('readonly', 'get', KEY);
      if (!full) return null;
      const derived = metaOf(full);
      try { await requestValue('readwrite', 'put', { data: derived, key: META_KEY }); } catch { /* best effort */ }
      return derived;
    },
    async save(snapshot) {
      const record = { ...snapshot, createdAt: snapshot?.createdAt || Date.now() };
      if (typeof record.bytes !== 'number') record.bytes = byteLength(record.markdown);
      await putBoth(record, metaOf(record));
      return metaOf(record);
    },
    clear: () => deleteBoth(),
  };
})();
