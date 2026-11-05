import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {MongoMemoryReplSet} from "mongodb-memory-server";
import mongoose, {Types} from "mongoose";

// Core only (CORE-07): core's own eraser, no vertical module.
vi.mock("@coreModule/utilities/modules/enabledModules", async (importOriginal) => ({
    ...await importOriginal<typeof import("@coreModule/utilities/modules/enabledModules")>(),
    isModuleEnabled: (name: string) => name === "core",
}));
const {deletedFiles} = vi.hoisted(() => ({deletedFiles: [] as string[]}));
vi.mock("@coreModule/utilities/gridfs/gridfsStorage", () => ({
    getGridFSStorage: () => ({deleteFile: async (id: string) => void deletedFiles.push(id)}),
}));

import {erasePersonInCompany, erasureSubject, loadPersonErasers} from "../personErasure";
import {asCrossTenant, withTenant} from "@coreModule/utilities/endpoints/tenantScope";
import Channel from "@coreModule/database/schemas/channel/channel";
import Message from "@coreModule/database/schemas/message/message";
import Media from "@coreModule/database/schemas/media/media";

let replSet: MongoMemoryReplSet;
const company = new Types.ObjectId();
const ids = {chat: new Types.ObjectId(), otherChat: new Types.ObjectId(), staffChat: new Types.ObjectId(), photo: new Types.ObjectId()};
const photoFile = new Types.ObjectId();
const raw = <T>(fn: () => Promise<T>) => asCrossTenant("test reads raw collections", fn);

beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({replSet: {count: 1, storageEngine: "wiredTiger"}});
    await mongoose.connect(replSet.getUri());
    await loadPersonErasers();
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
    await raw(async () => {
        await Channel.collection.insertMany([
            {_id: ids.chat, company, isPublicChat: true, publicChat: {status: "closed", visitor: {displayName: "Ada", email: "ada@example.com"}}, deletedAt: null},
            {_id: ids.otherChat, company, isPublicChat: true, publicChat: {status: "closed", visitor: {displayName: "Marco", email: "marco@example.com"}}, deletedAt: null},
            {_id: ids.staffChat, company, isPublicChat: false, name: "Team", deletedAt: null},
        ]);
        await Media.collection.insertOne({_id: ids.photo, company, fileId: photoFile, type: "image", deletedAt: null});
        await Message.collection.insertMany([
            {company, channel: ids.chat, text: "my booking number is 42", mediaIds: [ids.photo], deletedAt: null},
            {company, channel: ids.otherChat, text: "hello", mediaIds: [], deletedAt: null},
            {company, channel: ids.staffChat, text: "lunch?", mediaIds: [], deletedAt: null},
        ]);
    });
}, 120000);

afterAll(async () => {
    await mongoose.disconnect();
    await replSet.stop();
});

describe("core person eraser (D57, TD-B35)", {timeout: 60000}, () => {
    it("deletes the person's website chats, messages and attachments, and nobody else's", async () => {
        const counts = await withTenant(company, () => erasePersonInCompany({companyId: company, subject: erasureSubject({emails: ["ada@example.com"]}), preview: false}));
        expect(counts).toEqual(expect.arrayContaining([
            {collection: "channels", anonymised: 0, deleted: 1},
            {collection: "messages", anonymised: 0, deleted: 1},
            {collection: "media", anonymised: 0, deleted: 1},
        ]));
        expect(await raw(() => Channel.collection.countDocuments({_id: ids.chat}))).toBe(0);
        expect(await raw(() => Message.collection.countDocuments({channel: ids.chat}))).toBe(0);
        expect(await raw(() => Media.collection.countDocuments({}))).toBe(0);
        expect(deletedFiles).toEqual([photoFile.toString()]);
        expect(await raw(() => Channel.collection.countDocuments({_id: {$in: [ids.otherChat, ids.staffChat]}}))).toBe(2);
        expect(await raw(() => Message.collection.countDocuments({}))).toBe(2);
    });
});
