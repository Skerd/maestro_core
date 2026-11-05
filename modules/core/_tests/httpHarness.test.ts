import {describe, expect, it} from "vitest";
import type {AddressInfo} from "node:net";
import {appFor} from "@coreModule/_tests/httpHarness";

const server = appFor([]);

describe("appFor (TD-T11)", () => {
    it("listens on loopback only before the first test, so no other local server can answer its requests", () => {
        expect(server.listening).toBe(true);
        expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
    });
});
