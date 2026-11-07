import {afterAll, afterEach, beforeAll, describe, expect, it} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {ObjectId} from "mongodb";
import {SERVER} from "@coreModule/environment";
import Company from "@coreModule/database/schemas/company/company";
import {companyTimeZone, companyTimeZoneOf} from "@coreModule/utilities/time/companyTimeZone";

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
