const DB = "vibetake-media";
const VERSION = 1;
const request = (r) => new Promise((ok, fail) => { r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
const done = (t) => new Promise((ok, fail) => { t.oncomplete = () => ok(); t.onerror = () => fail(t.error); t.onabort = () => fail(t.error); });
export const openMedia = () => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore("chunks", { autoIncrement: true }).createIndex("by_id", "id");
        db.createObjectStore("frames", { autoIncrement: true }).createIndex("by_id", "id");
        db.createObjectStore("zips", { keyPath: "id" });
    };
    return request(r);
};
const put = async (db, store, value) => {
    const t = db.transaction(store, "readwrite");
    t.objectStore(store).put(value);
    await done(t);
};
export const putChunk = (db, chunk) => put(db, "chunks", chunk);
export const putFrame = (db, frame) => put(db, "frames", frame);
export const putZip = (db, zip) => put(db, "zips", zip);
const allOf = (db, store, id) => request(db.transaction(store).objectStore(store).index("by_id").getAll(IDBKeyRange.only(id)));
export const chunksOf = async (db, id, track) => (await allOf(db, "chunks", id)).filter(c => c.track === track).sort((a, b) => a.seq - b.seq).map(c => c.blob);
export const framesOf = async (db, id) => (await allOf(db, "frames", id)).sort((a, b) => a.file.localeCompare(b.file));
export const zipOf = async (db, id) => (await request(db.transaction("zips").objectStore("zips").get(id)))?.blob ?? null;
export const countChunks = (db, id) => request(db.transaction("chunks").objectStore("chunks").index("by_id").count(IDBKeyRange.only(id)));
// Every record of one recording, in all three stores, in one transaction.
export const discardMedia = async (db, id) => {
    const t = db.transaction(["chunks", "frames", "zips"], "readwrite");
    for (const store of ["chunks", "frames"]) {
        const index = t.objectStore(store).index("by_id");
        const keys = await request(index.getAllKeys(IDBKeyRange.only(id)));
        for (const key of keys)
            t.objectStore(store).delete(key);
    }
    t.objectStore("zips").delete(id);
    await done(t);
};
