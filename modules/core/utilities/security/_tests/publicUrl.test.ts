import {afterEach, describe, expect, it, vi} from "vitest";
import dns, {type LookupAddress} from "dns";
import {ServerError} from "armonia/src/modules/core/types";
import {PUBLIC_ADDRESS, resolveTo} from "@coreModule/_tests/dnsStub";
import {
    assertPublicUrl,
    assertSafePublicHttpUrl,
    isBlockedIp,
    publicOnlyLookup,
} from "@coreModule/utilities/security/publicUrl";

function lookupResult(host: string, all: boolean): Promise<{error: NodeJS.ErrnoException | null; address: string | LookupAddress[]}> {
    return new Promise((resolve) => publicOnlyLookup(host, {all}, (error, address) => resolve({error, address})));
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("blocked addresses", () => {
    it.each([
        "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0",
        // Shared address space (CGNAT) and benchmarking ranges
        "100.64.0.1", "100.127.255.254", "198.18.0.1", "198.19.255.255",
        "224.0.0.1", "255.255.255.255",
    ])("refuses IPv4 %s", (ip) => {
        expect(isBlockedIp(ip)).toBe(true);
    });

    it.each([
        "::1", "fd00::1", "fe80::1",
        // The unspecified address, and IPv4 addresses written as IPv6 (mapped, compatible, NAT64, 6to4)
        "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:10.0.0.1", "::127.0.0.1",
        "64:ff9b::a00:1", "2002:7f00:1::",
        "ff02::1",
    ])("refuses IPv6 %s", (ip) => {
        expect(isBlockedIp(ip)).toBe(true);
    });

    it.each(["8.8.8.8", "100.128.0.1", "198.20.0.1", "2a00:1450:4001::200e", "::ffff:8.8.8.8"])("allows public %s", (ip) => {
        expect(isBlockedIp(ip)).toBe(false);
    });

    it("refuses what is not an IP address", () => {
        expect(isBlockedIp("example.ch")).toBe(true);
    });
});

describe("checking a URL", () => {
    it.each([
        "http://127.0.0.1:8069/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[::]/", "http://100.64.0.1/",
        "http://localhost/", "http://LOCALHOST:121/", "http://api.localhost/", "http://printer.local/",
        "http://metadata.google.internal/", "http://db.internal/",
        "ftp://example.ch/", "http://user:secret@example.ch/", "not a url",
    ])("refuses %s without resolving it", async (url) => {
        const lookups = resolveTo([PUBLIC_ADDRESS]);
        await expect(assertSafePublicHttpUrl(url)).rejects.toThrow();
        expect(lookups).not.toHaveBeenCalled();
    });

    it("refuses a host that resolves to a private address", async () => {
        resolveTo([PUBLIC_ADDRESS, {address: "10.0.0.5", family: 4}]);
        await expect(assertSafePublicHttpUrl("https://intranet.example.ch/")).rejects.toThrow(/Blocked private IP/);
    });

    it("allows a public IP and a host whose every address is public", async () => {
        resolveTo([PUBLIC_ADDRESS, {address: "2a00:1450:4001::200e", family: 6}]);
        expect((await assertSafePublicHttpUrl("https://shop.example.ch/web")).hostname).toBe("shop.example.ch");
        expect((await assertSafePublicHttpUrl("http://8.8.8.8:8069/")).host).toBe("8.8.8.8:8069");
    });
});

describe("checking a URL in a request", () => {
    it("answers url_not_public in the caller's language", async () => {
        await expect(assertPublicUrl("http://127.0.0.1:8069", "url", "en-US")).rejects.toBeInstanceOf(ServerError);
        await expect(assertPublicUrl("http://127.0.0.1:8069", "url", "en-US"))
            .rejects.toMatchObject({error_code: "url_not_public", status: 400, message: expect.stringContaining("public internet")});
        await expect(assertPublicUrl("http://localhost", "url", "de-CH"))
            .rejects.toMatchObject({error_code: "url_not_public", message: expect.stringContaining("öffentliche")});
    });

    it("answers url_not_public for a name that does not resolve", async () => {
        const failing = (...args: unknown[]) => {
            const callback = args[args.length - 1];
            if (typeof callback === "function") callback(Object.assign(new Error("not found"), {code: "ENOTFOUND"}));
        };
        vi.spyOn(dns, "lookup").mockImplementation(failing);
        await expect(assertPublicUrl("https://nowhere.example.ch", "url", "en-US")).rejects.toMatchObject({error_code: "url_not_public"});
    });

    it("returns the URL when it is public", async () => {
        resolveTo([PUBLIC_ADDRESS]);
        expect((await assertPublicUrl("https://shop.example.ch", "url", "en-US")).origin).toBe("https://shop.example.ch");
    });
});

describe("the resolver to connect with", () => {
    it("answers with a public address", async () => {
        resolveTo([PUBLIC_ADDRESS]);
        expect(await lookupResult("example.ch", false)).toEqual({error: null, address: PUBLIC_ADDRESS.address});
        expect(await lookupResult("example.ch", true)).toEqual({error: null, address: [PUBLIC_ADDRESS]});
    });

    it("fails when any address of the host is private", async () => {
        resolveTo([PUBLIC_ADDRESS, {address: "::ffff:127.0.0.1", family: 6}]);
        const {error} = await lookupResult("example.ch", false);
        expect(error?.code).toBe("EBLOCKEDADDRESS");
        expect(error?.message).toMatch(/Blocked private IP/);
    });
});
