import {afterAll, afterEach, beforeAll, describe, expect, it} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {ObjectId} from "mongodb";
import mongoose from "mongoose";
import {SERVER} from "@coreModule/environment";
import Company from "@coreModule/database/schemas/company/company";
import {companyTimeZone, companyTimeZoneOf, companyTodayOf} from "@coreModule/utilities/time/companyTimeZone";

const instanceZone = SERVER.TIMEZONE;

beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

afterEach(() => {
    SERVER.TIMEZONE = instanceZone;
});

describe("companyTimeZone (D91)", () => {
    it("is the company's own zone first", () => {
        SERVER.TIMEZONE = "Europe/Berlin";
        expect(companyTimeZone({timezone: "Europe/Tirane"})).toBe("Europe/Tirane");
        expect(companyTimeZone({timezone: "  Asia/Kuwait "})).toBe("Asia/Kuwait");
    });

    it("falls back to the instance's zone when the company has none or an unknown one", () => {
        SERVER.TIMEZONE = "Europe/Zurich";
        expect(companyTimeZone({})).toBe("Europe/Zurich");
        expect(companyTimeZone({timezone: ""})).toBe("Europe/Zurich");
        expect(companyTimeZone({timezone: "Mars/Olympus"})).toBe("Europe/Zurich");
        expect(companyTimeZone(null)).toBe("Europe/Zurich");
    });

    it("is UTC when the instance names no valid zone either", () => {
        SERVER.TIMEZONE = "";
        expect(companyTimeZone({})).toBe("UTC");
        SERVER.TIMEZONE = "Not/AZone";
        expect(companyTimeZone({timezone: "Mars/Olympus"})).toBe("UTC");
    });

    it("reads the zone of a company by its id, and treats an unknown company like one without a zone", async () => {
        SERVER.TIMEZONE = "Europe/Rome";
        const [zoned, plain] = [new ObjectId(), new ObjectId()];
        // Raw inserts: saving a Company seeds its roles, bot and jobs, which this helper does not need.
        await Company.collection.insertMany([
            {_id: zoned, name: "Zoned", vat: "TZ-1", timezone: "Europe/Tirane", deletedAt: null},
            {_id: plain, name: "Plain", vat: "TZ-2", deletedAt: null},
        ]);

        expect(await companyTimeZoneOf(zoned)).toBe("Europe/Tirane");
        expect(await companyTimeZoneOf(plain.toString())).toBe("Europe/Rome");
        expect(await companyTimeZoneOf(new ObjectId())).toBe("Europe/Rome");
    });
});

describe("companyTodayOf (D91, D115)", () => {
    // 20:00 UTC on 1 March is already 2 March in Tokyo and still 1 March in UTC.
    const now = new Date("2027-03-01T20:00:00Z");

    it("is the company's calendar day in its own zone, else the instance's", async () => {
        SERVER.TIMEZONE = "UTC";
        const [tokyo, plain] = [new ObjectId(), new ObjectId()];
        await Company.collection.insertMany([
            {_id: tokyo, name: "Tokyo", vat: "TD-1", timezone: "Asia/Tokyo", deletedAt: null},
            {_id: plain, name: "Plain", vat: "TD-2", deletedAt: null},
        ]);

        expect(await companyTodayOf(tokyo, {now})).toBe("2027-03-02");
        expect(await companyTodayOf(plain.toString(), {now})).toBe("2027-03-01");
    });

    it("reads the company inside the caller's transaction", async () => {
        SERVER.TIMEZONE = "UTC";
        const id = new ObjectId();
        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                await Company.collection.insertOne({_id: id, name: "Uncommitted", vat: "TD-3", timezone: "Asia/Tokyo", deletedAt: null}, {session});
                expect(await companyTodayOf(id, {session, now})).toBe("2027-03-02");
                // Outside the transaction the company does not exist yet, so the instance zone applies.
                expect(await companyTodayOf(id, {now})).toBe("2027-03-01");
            });
        } finally {
            await session.endSession();
        }
    });
});
