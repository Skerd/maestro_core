import type {CookieOptions, Response} from "express";
import {AUTHENTICATION} from "@coreModule/environment";

export const MEDIA_AUTH_COOKIE = "arpeggio_media_auth";
export const MEDIA_AUTH_COOKIE_PATH = "/api/auxiliary/media";

function cookieOptions(): CookieOptions {
    return {
        httpOnly: true,
        sameSite: "lax",
        path: MEDIA_AUTH_COOKIE_PATH,
        secure: process.env.NODE_ENV === "production",
        maxAge: AUTHENTICATION.SESSION_EXPIRES_IN,
    };
}

export function setMediaAuthCookie(response: Response, token: string): void {
    response.cookie(MEDIA_AUTH_COOKIE, token, cookieOptions());
}

export function clearMediaAuthCookie(response: Response): void {
    response.clearCookie(MEDIA_AUTH_COOKIE, {
        path: MEDIA_AUTH_COOKIE_PATH,
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
    });
}

export function readMediaAuthCookie(req: {headers: {cookie?: string}}): string | undefined {
    const header = req.headers.cookie;
    if (!header) {
        return undefined;
    }
    for (const part of header.split(";")) {
        const idx = part.indexOf("=");
        if (idx === -1) {
            continue;
        }
        const key = part.slice(0, idx).trim();
        if (key === MEDIA_AUTH_COOKIE) {
            return decodeURIComponent(part.slice(idx + 1).trim());
        }
    }
    return undefined;
}
