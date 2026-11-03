import {afterEach, describe, expect, it} from "vitest";
import {wantsInstalledModuleScope, wantsStudioSample} from "../modelModules";

describe("wantsInstalledModuleScope", () => {
    const previous = process.env.SERVER_NODE_ENV;

    afterEach(() => {
        if (previous === undefined) delete process.env.SERVER_NODE_ENV;
        else process.env.SERVER_NODE_ENV = previous;
    });

    it("accepts scope=installed only while the server is in development", () => {
        process.env.SERVER_NODE_ENV = "development";
        expect(wantsInstalledModuleScope({scope: "installed"})).toBe(true);
        expect(wantsInstalledModuleScope({scope: "company"})).toBe(false);
        expect(wantsInstalledModuleScope(undefined)).toBe(false);

        process.env.SERVER_NODE_ENV = "production";
        expect(wantsInstalledModuleScope({scope: "installed"})).toBe(false);
    });

    it("accepts the studio sample header only while the server is in development", () => {
        process.env.SERVER_NODE_ENV = "development";
        expect(wantsStudioSample("1")).toBe(true);
        expect(wantsStudioSample("0")).toBe(false);
        expect(wantsStudioSample(undefined)).toBe(false);

        process.env.SERVER_NODE_ENV = "production";
        expect(wantsStudioSample("1")).toBe(false);
    });
});
