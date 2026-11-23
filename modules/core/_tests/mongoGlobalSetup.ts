/**
 * Starts the one in-memory MongoDB replica set of a test run (vitest `globalSetup`, see vitest.config.ts).
 * One `mongod` per file died mid-file under full-suite load and raced for ports (TD-T14); test files now connect
 * to this one through `connectTestDatabase`, each in a database of its own.
 */
import {MongoClient} from "mongodb";
import {MongoMemoryReplSet} from "mongodb-memory-server";
import type {GlobalSetupContext} from "vitest/node";

declare module "vitest" {
    export interface ProvidedContext {
        /** The run's replica set; `testDatabase.ts` adds the file's database name. */
        mongoUri: string;
    }
}

export default async function setup({provide}: GlobalSetupContext): Promise<() => Promise<void>> {
    // A replica set so transactions work; wiredTiger like production.
    const replSet = await MongoMemoryReplSet.create({replSet: {count: 1, storageEngine: "wiredTiger"}});
    // Acknowledged once in memory, not after the journal reaches the disk (TD-B184): on the one test node a majority
    // write waits for a disk sync, about 6 ms per insert and 30 ms per collection or index, which was most of the suite's
    // time. Reads on the primary see the same data either way; only a crash of the test mongod could lose it.
    const admin = new MongoClient(replSet.getUri());
    await admin.connect();
    await admin.db("admin").command({setDefaultRWConcern: 1, defaultWriteConcern: {w: 1}});
    await admin.close();
    provide("mongoUri", replSet.getUri());
    return async () => {
        await replSet.stop();
    };
}
