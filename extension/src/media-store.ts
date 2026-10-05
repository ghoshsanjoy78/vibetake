// IndexedDB for media: chunks as they are recorded, frames as they are grabbed, the sealed zip. The
// one place the database is touched — the offscreen document writes, the popup reads and deletes.
// Everything is keyed by the recording id, so one recording's media can be removed without touching
// another's.
import type { TrackName } from "./recorder.js";

const DB = "vibetake-media";
const VERSION = 1;

export type Chunk = { id: string; track: TrackName; seq: number; blob: Blob };
export type FrameBlob = { id: string; file: string; blob: Blob };
export type ZipBlob = { id: string; blob: Blob };

const request = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((ok, fail) => { r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
const done = (t: IDBTransaction): Promise<void> =>
  new Promise((ok, fail) => { t.oncomplete = () => ok(); t.onerror = () => fail(t.error); t.onabort = () => fail(t.error); });

export const openMedia = (): Promise<IDBDatabase> => {
  const r = indexedDB.open(DB, VERSION);
  r.onupgradeneeded = () => {
    const db = r.result;
    db.createObjectStore("chunks", { autoIncrement: true }).createIndex("by_id", "id");
    db.createObjectStore("frames", { autoIncrement: true }).createIndex("by_id", "id");
    db.createObjectStore("zips", { keyPath: "id" });
  };
  return request(r);
};

const put = async (db: IDBDatabase, store: string, value: unknown): Promise<void> => {
  const t = db.transaction(store, "readwrite");
  t.objectStore(store).put(value);
  await done(t);
};
export const putChunk = (db: IDBDatabase, chunk: Chunk): Promise<void> => put(db, "chunks", chunk);
export const putFrame = (db: IDBDatabase, frame: FrameBlob): Promise<void> => put(db, "frames", frame);
export const putZip = (db: IDBDatabase, zip: ZipBlob): Promise<void> => put(db, "zips", zip);

const allOf = <T>(db: IDBDatabase, store: string, id: string): Promise<T[]> =>
  request(db.transaction(store).objectStore(store).index("by_id").getAll(IDBKeyRange.only(id)) as IDBRequest<T[]>);

export const chunksOf = async (db: IDBDatabase, id: string, track: TrackName): Promise<Blob[]> =>
  (await allOf<Chunk>(db, "chunks", id)).filter(c => c.track === track).sort((a, b) => a.seq - b.seq).map(c => c.blob);

export const framesOf = async (db: IDBDatabase, id: string): Promise<FrameBlob[]> =>
  (await allOf<FrameBlob>(db, "frames", id)).sort((a, b) => a.file.localeCompare(b.file));

export const zipOf = async (db: IDBDatabase, id: string): Promise<Blob | null> =>
  (await request(db.transaction("zips").objectStore("zips").get(id) as IDBRequest<ZipBlob | undefined>))?.blob ?? null;

export const countChunks = (db: IDBDatabase, id: string): Promise<number> =>
  request(db.transaction("chunks").objectStore("chunks").index("by_id").count(IDBKeyRange.only(id)));

// Every record of one recording, in all three stores, in one transaction.
export const discardMedia = async (db: IDBDatabase, id: string): Promise<void> => {
  const t = db.transaction(["chunks", "frames", "zips"], "readwrite");
  for (const store of ["chunks", "frames"]) {
    const index = t.objectStore(store).index("by_id");
    const keys = await request(index.getAllKeys(IDBKeyRange.only(id)));
    for (const key of keys) t.objectStore(store).delete(key);
  }
  t.objectStore("zips").delete(id);
  await done(t);
};
