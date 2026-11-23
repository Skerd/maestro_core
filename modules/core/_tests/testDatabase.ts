/**
 * The database of a DB-backed test file. Call both from the file's own `beforeAll` / `afterAll` (vitest 1 runs
 * a file's hooks of one kind in parallel, so a separate hook could race the seeding):
 *
 *   beforeAll(async () => { await connectTestDatabase(); ...seed });
 *   afterAll(async () => { await disconnectTestDatabase(); });
 *
 * Each vitest worker has one database on the run's shared replica set (`mongoGlobalSetup.ts`) and a file starts by
 * emptying it, so files stay isolated, transactions work, and each collection and its indexes are built once per
 * worker instead of once per file (building them for every model in a fresh database per file made the suite
 * take ~10 minutes, almost all of it inside mongod; dropping the ones a file did not use cost most of 9 minutes
 * again until TD-B184).
 */
import mongoose from "mongoose";
import {inject} from "vitest";

export async function connectTestDatabase(): Promise<void> {
    // VITEST_POOL_ID is unique among the workers running at the same time (1..maxWorkers).
    await mongoose.connect(inject("mongoUri"), {dbName: `test_worker_${process.env.VITEST_POOL_ID ?? "0"}`});
    const db = mongoose.connection.db;
    const models = mongoose.modelNames().map((name) => mongoose.model(name));
    const ours = new Set(models.map((model) => model.collection.collectionName));
    // Empty every collection but keep it and its indexes, also the ones only an earlier file's models used: a later
    // file of this worker that registers those models finds them ready. Building a collection's indexes is a mongod
    // step the workers queue for, and dropping and rebuilding them was most of the suite's time (TD-B184). A
    // collection this file has no model for loses its unique indexes, though: a fixture that writes to it directly
    // must not pass or fail by which file ran before it.
    const collections = await db.listCollections({}, {nameOnly: true}).toArray();
    await Promise.all(collections.filter(({name}) => !name.startsWith("system.")).map(async ({name}) => {
        const collection = db.collection(name);
        await collection.deleteMany({});
        if (ours.has(name)) return;
        const unique = (await collection.indexes()).filter((index) => index.unique === true && index.name !== "_id_");
        await Promise.all(unique.map((index) => collection.dropIndex(String(index.name))));
    }));
    // Wait until every registered model's collection and indexes exist: a transaction gets only 5 ms to take a
    // collection lock, so an implicit collection create or a background index build fails it (LockTimeout).
    // On a worker's later files they already exist and this is quick. `syncIndexes` then drops indexes an earlier
    // file's schema left behind (a file may register a stand-in model under a real model's name).
    await Promise.all(models.map((model) => model.init()));
    await Promise.all(models.map((model) => model.syncIndexes()));
}

/** Disconnects; the worker's next file empties the database when it connects. */
export async function disconnectTestDatabase(): Promise<void> {
    await mongoose.disconnect();
}
