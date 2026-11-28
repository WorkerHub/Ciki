import type { ImportCheckpoint } from "./types"

const DB_NAME = "ciki_import_checkpoints"
const DB_VERSION = 1
const STORE_NAME = "checkpoints"

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not supported in this environment"))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "zipSha256" })
      }
    }
  })
}

export async function saveCheckpoint(
  checkpoint: ImportCheckpoint
): Promise<void> {
  try {
    const db = await openDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite")
      const store = tx.objectStore(STORE_NAME)
      const req = store.put(checkpoint)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch (err) {
    console.warn("Failed to save import checkpoint to IndexedDB:", err)
  }
}

export async function getCheckpoint(
  zipSha256: string
): Promise<ImportCheckpoint | null> {
  try {
    const db = await openDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly")
      const store = tx.objectStore(STORE_NAME)
      const req = store.get(zipSha256)
      req.onsuccess = () => resolve((req.result as ImportCheckpoint) ?? null)
      req.onerror = () => reject(req.error)
    })
  } catch (err) {
    console.warn("Failed to get import checkpoint from IndexedDB:", err)
    return null
  }
}

export async function deleteCheckpoint(zipSha256: string): Promise<void> {
  try {
    const db = await openDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite")
      const store = tx.objectStore(STORE_NAME)
      const req = store.delete(zipSha256)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch (err) {
    console.warn("Failed to delete import checkpoint from IndexedDB:", err)
  }
}

/** 计算文件/字节流的 SHA-256 哈希字符串 */
export async function calculateSha256(
  data: ArrayBuffer | Uint8Array | Blob
): Promise<string> {
  let buffer: ArrayBuffer
  if (data instanceof Blob) {
    buffer = await data.arrayBuffer()
  } else if (data instanceof Uint8Array) {
    buffer = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength
    ) as ArrayBuffer
  } else {
    buffer = data
  }
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}
