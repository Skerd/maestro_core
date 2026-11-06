/**
 * The database of a DB-backed test file. Call both from the file's own `beforeAll` / `afterAll` (vitest 1 runs
 * a file's hooks of one kind in parallel, so a separate hook could race the seeding):
 *
 *   beforeAll(async () => { await connectTestDatabase(); ...seed });
 *   afterAll(async () => { await disconnectTestDatabase(); });
 *
 * The file gets a fresh database on the run's shared replica set (`mongoGlobalSetup.ts`), so files stay
 * isolated and transactions work.
 */
import {randomBytes} from "node:crypto";
import mongoose from "mongoose";
import {inject} from "vitest";

export async function connectTestDatabase(): Promise<void> {
    await mongoose.connect(inject("mongoUri"), {dbName: `test_${randomBytes(8).toString("hex")}`});
}

/** Drops the file's database (the replica set outlives the file) and disconnects. */
export async function disconnectTestDatabase(): Promise<void> {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
}
