// Persistent storage for the latest prepared transcript.
// IndexedDB avoids chrome.storage.local's small quota for large conversation histories.
(() => {
  const DB_NAME = 'arena-transcript-export';
  const STORE_NAME = 'snapshots';
  const KEY = 'latest';
  let databasePromise = null;

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
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

  async function requestValue(mode, operation, value) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      const request = operation === 'get'
        ? store.get(KEY)
        : operation === 'put'
          ? store.put(value, KEY)
          : store.delete(KEY);
      let result;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error || new Error('Could not access the saved transcript.'));
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error('Could not commit the saved transcript.'));
      transaction.onabort = () => reject(transaction.error || new Error('Saved transcript transaction was aborted.'));
    });
  }

  window.AREX_RESULT_STORE = {
    load: () => requestValue('readonly', 'get'),
    save: snapshot => requestValue('readwrite', 'put', snapshot),
    clear: () => requestValue('readwrite', 'delete'),
  };
})();
