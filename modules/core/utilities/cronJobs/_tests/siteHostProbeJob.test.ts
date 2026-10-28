import {describe, expect, it} from "vitest";
import {interpretSiteHostProbe} from "../siteHostProbeJob";

describe("interpretSiteHostProbe", () => {
    it("marks the site online when VAT matches", () => {
        expect(interpretSiteHostProbe({
            httpStatus: 200,
            responseVat: "Z123",
            expectedVat: "Z123",
        })).toEqual({status: "online", lastError: "", reachable: true});
    });

    it("fails on a Cloudflare origin error", () => {
        expect(interpretSiteHostProbe({
            httpStatus: 521,
            expectedVat: "Z123",
        })).toEqual({status: "failed", lastError: "HTTP 521", reachable: false});
    });

    it("fails when the wildcard fell through to another tenant", () => {
        expect(interpretSiteHostProbe({
            httpStatus: 200,
            responseVat: "OTHER",
            expectedVat: "Z123",
        })).toEqual({status: "failed", lastError: "site served a different company", reachable: false});
    });

    it("fails on a network error", () => {
        expect(interpretSiteHostProbe({
            httpStatus: null,
            expectedVat: "Z123",
            networkError: "Could not resolve host",
        })).toEqual({status: "failed", lastError: "Could not resolve host", reachable: false});
    });
});
