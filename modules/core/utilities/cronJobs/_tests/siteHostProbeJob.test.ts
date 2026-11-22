import {describe, expect, it} from "vitest";
import {interpretSiteHostProbe} from "../siteHostProbeJob";

describe("interpretSiteHostProbe", () => {
    it("marks the site online when the served slug matches", () => {
        expect(interpretSiteHostProbe({
            httpStatus: 200,
            responseSlug: "aria",
            expectedSlug: "aria",
        })).toEqual({status: "online", lastError: "", reachable: true});
    });

    it("fails on a Cloudflare origin error", () => {
        expect(interpretSiteHostProbe({
            httpStatus: 521,
            expectedSlug: "aria",
        })).toEqual({status: "failed", lastError: "HTTP 521", reachable: false});
    });

    it("fails when the wildcard fell through to another tenant", () => {
        expect(interpretSiteHostProbe({
            httpStatus: 200,
            responseSlug: "other",
            expectedSlug: "aria",
        })).toEqual({status: "failed", lastError: "site served a different company", reachable: false});
    });

    it("fails when the host answered without a site slug", () => {
        expect(interpretSiteHostProbe({
            httpStatus: 200,
            expectedSlug: "aria",
        })).toEqual({status: "failed", lastError: "site served a different company", reachable: false});
    });

    it("fails on a network error", () => {
        expect(interpretSiteHostProbe({
            httpStatus: null,
            expectedSlug: "aria",
            networkError: "Could not resolve host",
        })).toEqual({status: "failed", lastError: "Could not resolve host", reachable: false});
    });
});
