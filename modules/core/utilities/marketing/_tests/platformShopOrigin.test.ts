import {afterEach, describe, expect, it, vi} from "vitest";

describe("platformShopOrigin", () => {
    afterEach(() => {
        vi.resetModules();
        vi.unstubAllEnvs();
    });

    it("matches apex and www when SHOP_ROOT_DOMAIN is set", async () => {
        vi.stubEnv("SHOP_ROOT_DOMAIN", "arpeggio.al");
        const {isPlatformShopOrigin, normalizeShopOriginHost} = await import("../platformShopOrigin");
        expect(normalizeShopOriginHost("https://arpeggio.al/path")).toBe("arpeggio.al");
        expect(isPlatformShopOrigin("https://arpeggio.al")).toBe(true);
        expect(isPlatformShopOrigin("https://www.arpeggio.al")).toBe(true);
        expect(isPlatformShopOrigin("arpeggio.al:443")).toBe(true);
    });

    it("does not match tenant subdomains", async () => {
        vi.stubEnv("SHOP_ROOT_DOMAIN", "arpeggio.al");
        const {isPlatformShopOrigin} = await import("../platformShopOrigin");
        expect(isPlatformShopOrigin("https://acme.arpeggio.al")).toBe(false);
        expect(isPlatformShopOrigin("https://shop.other.com")).toBe(false);
        expect(isPlatformShopOrigin("http://localhost:5174")).toBe(false);
    });

    it("treats bare localhost as platform when SHOP_ROOT_DOMAIN is empty", async () => {
        vi.stubEnv("SHOP_ROOT_DOMAIN", "");
        const {isPlatformShopOrigin} = await import("../platformShopOrigin");
        expect(isPlatformShopOrigin("http://localhost:5174")).toBe(true);
        expect(isPlatformShopOrigin("https://arpeggio.al")).toBe(false);
        expect(isPlatformShopOrigin("http://ecommerce.localhost:5174")).toBe(false);
    });

    it("treats bare localhost as platform when SHOP_ROOT_DOMAIN is localhost", async () => {
        vi.stubEnv("SHOP_ROOT_DOMAIN", "localhost");
        const {isPlatformShopOrigin} = await import("../platformShopOrigin");
        expect(isPlatformShopOrigin("http://localhost:5174")).toBe(true);
        expect(isPlatformShopOrigin("http://ecommerce.localhost")).toBe(false);
    });
});
