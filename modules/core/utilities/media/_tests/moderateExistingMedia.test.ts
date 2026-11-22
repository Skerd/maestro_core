import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {ObjectId} from "mongodb";
import {Readable} from "stream";
import sharp from "sharp";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {testVideo} from "@coreModule/_tests/testVideo";
import Media from "@coreModule/database/schemas/media/media";
import {getGridFSStorage} from "@coreModule/utilities/gridfs/gridfsStorage";
import {getLogger} from "@coreModule/loggers/serverLog";
import {moderateExistingMedia} from "@coreModule/utilities/media/moderateExistingMedia";
import type {ContentModerator, ModerationScores} from "@coreModule/utilities/security/contentModerator";

const NEUTRAL: ModerationScores = {porn: 0, hentai: 0, sexy: 0, neutral: 1, drawing: 0};
const EXPLICIT: ModerationScores = {porn: 0.96, hentai: 0, sexy: 0.03, neutral: 0.01, drawing: 0};

/** A fake detector (BE-09): with `explicitRed`, a red frame scores as explicit; everything else is neutral. */
function fakeModerator(explicitRed: boolean): ContentModerator & {frames: number} {
    const moderator = {
        frames: 0,
        scoreFrame: async (rgb: Buffer) => {
            moderator.frames++;
            return explicitRed && rgb[0] > 200 && rgb[1] < 60 ? EXPLICIT : NEUTRAL;
        },
    };
    return moderator;
}

const company = new ObjectId();
const logger = getLogger("moderate-existing-media-test");

async function stored(type: "image" | "video", bytes: Buffer, name: string, extra: Record<string, unknown> = {}): Promise<ObjectId> {
    const fileId = await getGridFSStorage("en-US", "media").uploadFile(Readable.from(bytes), name, {});
    const {insertedId} = await Media.collection.insertOne({
        type, originalName: name, fileName: name, fileId: new ObjectId(fileId.toString()), company,
        metadata: {size: bytes.length, safeCheckedFlag: false}, ...extra,
    });
    return insertedId;
}

const red = () => sharp({create: {width: 16, height: 16, channels: 3, background: "#f00"}}).png().toBuffer();
const blue = () => sharp({create: {width: 16, height: 16, channels: 3, background: "#00f"}}).png().toBuffer();
const moderationOf = async (id: ObjectId) => (await Media.collection.findOne({_id: id}))?.metadata?.moderation;

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

beforeEach(async () => {
    await Media.collection.deleteMany({});
});

describe("moderateExistingMedia (D177)", () => {
    it("flags a clear case instead of refusing it, and records the rest as passed", async () => {
        const explicit = await stored("image", await red(), "old.png");
        const ordinary = await stored("image", await blue(), "logo.png");
        const result = await moderateExistingMedia({moderator: fakeModerator(true), types: ["image"], logger});
        expect(result).toMatchObject({checked: 2, passed: 1, flagged: 1, notChecked: 0, flaggedIds: [String(explicit)]});
        expect(await moderationOf(explicit)).toMatchObject({status: "flagged", scores: {porn: 0.96}});
        expect((await moderationOf(ordinary)).status).toBe("passed");
    });

    it("checks only the asked types, skips files already judged and deleted ones", async () => {
        const video = await stored("video", testVideo(4), "tour.mp4");
        const image = await stored("image", await blue(), "logo.png");
        await stored("video", testVideo(1), "done.mp4", {metadata: {moderation: {status: "passed"}}});
        await stored("video", testVideo(1), "gone.mp4", {deletedAt: new Date()});
        const moderator = fakeModerator(false);
        const result = await moderateExistingMedia({moderator, types: ["video"], logger});
        expect(result.checked).toBe(1);
        expect(moderator.frames).toBe(2);
        expect((await moderationOf(video)).status).toBe("passed");
        expect(await moderationOf(image)).toBeUndefined();
    });

    it("records a file it cannot read as not checked, and tries it again on the next run", async () => {
        const broken = await stored("video", Buffer.from("not a video"), "broken.mp4");
        expect((await moderateExistingMedia({moderator: fakeModerator(false), types: ["video"], logger})).notChecked).toBe(1);
        expect((await moderationOf(broken)).status).toBe("not_checked");
        expect((await moderateExistingMedia({moderator: fakeModerator(false), types: ["video"], logger})).checked).toBe(1);
    });

    it("writes nothing on a dry run", async () => {
        const explicit = await stored("image", await red(), "old.png");
        const result = await moderateExistingMedia({moderator: fakeModerator(true), types: ["image"], logger, dryRun: true});
        expect(result.flagged).toBe(1);
        expect(await moderationOf(explicit)).toBeUndefined();
    });
});
