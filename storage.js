const DATABASE_NAME = "video-webcli";
const DATABASE_VERSION = 2;
const SESSION_STORE = "sessions";
const CHUNK_STORE = "chunks";
const PROJECT_STORE = "projects";

let databasePromise;

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SESSION_STORE)) database.createObjectStore(SESSION_STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(CHUNK_STORE)) database.createObjectStore(CHUNK_STORE, { keyPath: "key" });
      if (!database.objectStoreNames.contains(PROJECT_STORE)) database.createObjectStore(PROJECT_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onblocked = () => {
      databasePromise = undefined;
      reject(new Error("Close older video.webcli.app tabs, then reload to upgrade local project storage."));
    };
    request.onerror = () => {
      databasePromise = undefined;
      reject(request.error ?? new Error("Unable to open local recording storage."));
    };
  });
  return databasePromise;
}

export async function saveEditorProject(project) {
  const database = await openDatabase();
  const transaction = database.transaction(PROJECT_STORE, "readwrite");
  transaction.objectStore(PROJECT_STORE).put({ ...project, id: "current", updatedAt: Date.now() });
  await transactionDone(transaction);
}

export async function loadEditorProject() {
  const database = await openDatabase();
  const transaction = database.transaction(PROJECT_STORE, "readonly");
  const result = await requestResult(transaction.objectStore(PROJECT_STORE).get("current"));
  await transactionDone(transaction);
  return result ?? null;
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error ?? new Error("Local storage transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Local storage transaction was aborted."));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Local storage request failed."));
  });
}

async function rootDirectory() {
  if (!navigator.storage?.getDirectory) return null;
  try {
    return await navigator.storage.getDirectory();
  } catch {
    return null;
  }
}

async function trackDirectory(sessionId, trackId, create) {
  const root = await rootDirectory();
  if (!root) return null;
  try {
    const sessions = await root.getDirectoryHandle("video-webcli", { create: true });
    const session = await sessions.getDirectoryHandle(sessionId, { create });
    return await session.getDirectoryHandle(trackId, { create });
  } catch (error) {
    if (!create && error.name === "NotFoundError") return null;
    throw error;
  }
}

export async function createSession(manifest) {
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, "readwrite");
  transaction.objectStore(SESSION_STORE).add(manifest);
  await transactionDone(transaction);
  return manifest;
}

export async function updateSession(id, update) {
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, "readwrite");
  const store = transaction.objectStore(SESSION_STORE);
  const request = store.get(id);
  request.onsuccess = () => {
    if (!request.result) {
      transaction.abort();
      return;
    }
    store.put(update(request.result));
  };
  await transactionDone(transaction);
}

export async function getSession(id) {
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, "readonly");
  const result = await requestResult(transaction.objectStore(SESSION_STORE).get(id));
  await transactionDone(transaction);
  return result ?? null;
}

export async function listRecoverableSessions() {
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, "readonly");
  const sessions = await requestResult(transaction.objectStore(SESSION_STORE).getAll());
  await transactionDone(transaction);
  return sessions.filter((session) => session.status === "recording" || session.status === "interrupted");
}

export async function saveChunk(sessionId, trackId, index, blob) {
  const key = `${sessionId}/${trackId}/${index}`;
  let directory;
  try {
    directory = await trackDirectory(sessionId, trackId, true);
    if (directory) {
      const handle = await directory.getFileHandle(`chunk-${index}.bin`, { create: true });
      const writer = await handle.createWritable();
      await writer.write(blob);
      await writer.close();
    }
  } catch {
    directory = null;
  }

  const database = await openDatabase();
  const transaction = database.transaction([SESSION_STORE, CHUNK_STORE], "readwrite");
  const sessions = transaction.objectStore(SESSION_STORE);
  const chunks = transaction.objectStore(CHUNK_STORE);
  const manifestRequest = sessions.get(sessionId);
  manifestRequest.onsuccess = () => {
    const manifest = manifestRequest.result;
    if (!manifest) {
      transaction.abort();
      return;
    }
    chunks.put({
      key,
      sessionId,
      trackId,
      index,
      backend: directory ? "opfs" : "indexeddb",
      size: blob.size,
      ...(directory ? {} : { blob })
    });
    manifest.tracks[trackId].chunkCount = Math.max(manifest.tracks[trackId].chunkCount, index + 1);
    manifest.tracks[trackId].bytes += blob.size;
    manifest.durationMs = Math.max(manifest.durationMs ?? 0, Date.now() - manifest.startedAt);
    manifest.tracks[trackId].durationMs = manifest.durationMs;
    manifest.updatedAt = Date.now();
    sessions.put(manifest);
  };
  await transactionDone(transaction);
}

export async function loadTrackBlob(sessionId, trackId) {
  const database = await openDatabase();
  const transaction = database.transaction(CHUNK_STORE, "readonly");
  const allChunks = await requestResult(transaction.objectStore(CHUNK_STORE).getAll());
  await transactionDone(transaction);
  const records = allChunks
    .filter((chunk) => chunk.sessionId === sessionId && chunk.trackId === trackId)
    .sort((left, right) => left.index - right.index);
  const directory = await trackDirectory(sessionId, trackId, false);
  if (directory) {
    const knownIndices = new Set(records.map((record) => record.index));
    for await (const [name, handle] of directory.entries()) {
      const match = /^chunk-(\d+)\.bin$/.exec(name);
      if (!match) continue;
      const index = Number(match[1]);
      if (!knownIndices.has(index)) {
        records.push({
          index,
          backend: "opfs",
          file: await handle.getFile()
        });
      }
    }
    records.sort((left, right) => left.index - right.index);
  }
  const parts = [];
  for (const record of records) {
    if (record.backend === "indexeddb") {
      parts.push(record.blob);
      continue;
    }
    if (!directory) throw new Error(`Missing local recording data for ${trackId}.`);
    parts.push(record.file ?? await (await directory.getFileHandle(`chunk-${record.index}.bin`)).getFile());
  }
  if (!parts.length) throw new Error(`No recorded chunks were found for ${trackId}.`);
  return new Blob(parts);
}

export async function setSessionStatus(id, status) {
  await updateSession(id, (manifest) => ({ ...manifest, status, updatedAt: Date.now() }));
}
