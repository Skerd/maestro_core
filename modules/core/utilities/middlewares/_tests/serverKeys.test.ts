import {describe, expect, it, vi} from "vitest";
import {z} from "zod";
import type {NextFunction} from "express";

vi.mock("@coreModule/environment", () => ({
    CONSTANTS: {DEFAULT_LANGUAGE: "en-US"},
}));

import {clientValuesOfServerKeys, stripServerKeys} from "../serverKeys";
import {validateFormZod} from "../validateFormZod";
import {buildCreateDataFromSchemaDef, buildUpdateDataFromSchemaDef} from "@coreModule/api/buildUpdateDataFromSchemaDef";

/** A contract that, like a campaign recipient or an order, declares fields named like server keys. */
const recipientSchema = () => z.object({
    title: z.string(),
    languageCode: z.string().optional(),
    customer: z.string().optional(),
});

function request(body: Record<string, unknown>, originalUrl = "/api/x") {
    return {body, originalUrl} as never as Parameters<typeof stripServerKeys>[0] & {body: Record<string, unknown>};
}

/** For guard calls whose `next` the test does not inspect. */
const proceed: NextFunction = () => undefined;

/** What authMW does after the guard: writes the server's own values under its keys. */
function authWrites(body: Record<string, unknown>) {
    body.languageCode = "de-CH";
    body.company = {_id: "server-company"};
    body.actionUserCtx = {userId: "editor"};
}

describe("stripServerKeys", () => {
    it("takes client-sent server keys out of the body and keeps their values aside", () => {
        const req = request({title: "Hello", company: {_id: "forged"}, actionUserCtx: {isAdmin: true}, sanitizedWriteFields: {all: {}}});
        const next = vi.fn();
        stripServerKeys(req, {} as never, next);
        expect(next).toHaveBeenCalledWith();
        expect(req.body).toEqual({title: "Hello"});
        expect(clientValuesOfServerKeys(req)).toEqual({company: {_id: "forged"}, actionUserCtx: {isAdmin: true}, sanitizedWriteFields: {all: {}}});
    });

    it("runs once per request, so values a middleware wrote are never mistaken for client input", () => {
        const req = request({title: "Hello", languageCode: "fr-FR"});
        stripServerKeys(req, {} as never, proceed);
        authWrites(req.body);
        stripServerKeys(req, {} as never, proceed); // a second router mounted on the same path
        expect(req.body.languageCode).toBe("de-CH");
        expect(clientValuesOfServerKeys(req)).toEqual({languageCode: "fr-FR"});
    });

    it("leaves non-object bodies alone", () => {
        const req = request([] as never);
        const next = vi.fn();
        stripServerKeys(req, {} as never, next);
        expect(next).toHaveBeenCalledWith();
    });
});

describe("validateFormZod with quarantined server keys", () => {
    function run(clientBody: Record<string, unknown>) {
        const req = request(clientBody);
        stripServerKeys(req, {} as never, proceed);
        authWrites(req.body);
        const next = vi.fn();
        validateFormZod(recipientSchema)(req as never, {} as never, next);
        expect(next).toHaveBeenCalledWith();
        return req.body;
    }

    it("validates a declared field against the client's value, not the server's", () => {
        const body = run({title: "Hello", languageCode: "it-IT"});
        expect(body.validatedForm).toEqual({title: "Hello", languageCode: "it-IT"});
    });

    it("keeps the server's value for handlers when a middleware wrote that key", () => {
        const body = run({title: "Hello", languageCode: "it-IT"});
        expect(body.languageCode).toBe("de-CH");
        expect(body.company).toEqual({_id: "server-company"});
    });

    it("hands handlers the validated client value when no middleware writes that key", () => {
        const body = run({title: "Hello", customer: "customer-1"});
        expect(body.customer).toBe("customer-1");
    });

    it("never lets an undeclared client server key reach the handler", () => {
        const body = run({title: "Hello", sanitizedWriteFields: {everything: {}}, parentBypass: {userId: "x"}});
        expect(body.sanitizedWriteFields).toBeUndefined();
        expect(body.parentBypass).toBeUndefined();
    });
});

describe("SchemaDef builders read colliding names from the validated form", () => {
    const Def = {
        title: {type: "string", required: true},
        languageCode: {type: "string", required: false},
    } as const;
    const params = {title: "Hello", languageCode: "de-CH", validatedForm: {title: "Hello", languageCode: "it-IT"}};

    it("create takes the recipient's language, not the editor's", () => {
        expect(buildCreateDataFromSchemaDef(Def)(params)).toEqual({title: "Hello", languageCode: "it-IT"});
    });

    it("update does the same for writable fields", () => {
        expect(buildUpdateDataFromSchemaDef(Def)(params, {title: {}, languageCode: {}})).toEqual({title: "Hello", languageCode: "it-IT"});
    });

    it("still reads other fields from params, so callers can pass pre-resolved values", () => {
        expect(buildCreateDataFromSchemaDef(Def)({...params, title: "Resolved"})).toEqual({title: "Resolved", languageCode: "it-IT"});
    });
});
