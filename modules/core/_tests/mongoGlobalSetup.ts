/**
 * Starts the one in-memory MongoDB replica set of a test run (vitest `globalSetup`, see vitest.config.ts).
 * One `mongod` per file died mid-file under full-suite load and raced for ports (TD-T14); test files now connect
 * to this one through `connectTestDatabase`, each in a database of its own.
 */
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
    provide("mongoUri", replSet.getUri());
    return async () => {
        await replSet.stop();
    };
}
