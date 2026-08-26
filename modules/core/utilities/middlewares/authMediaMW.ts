import type {NextFunction, Request, Response} from "express";
import authMW from "@coreModule/utilities/middlewares/authMW";
import {clearMediaAuthCookie, readMediaAuthCookie} from "@coreModule/utilities/media/mediaAuthCookie";

/**
 * Private media GET for `<img>` / `<video src>`: JWT from `x-auth-token` or
 * the HttpOnly media cookie set on login.
 */
export default function authMediaMW(req: Request, res: Response, next: NextFunction): void {
    if (!req.header("x-auth-token")) {
        const cookieToken = readMediaAuthCookie(req);
        if (cookieToken) {
            req.headers["x-auth-token"] = cookieToken;
        }
    }

    let authFinished = false;
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
        if (!authFinished && res.statusCode >= 400) {
            clearMediaAuthCookie(res);
        }
        return originalJson(body);
    }) as Response["json"];

    authMW("private")(req, res, (err?: unknown) => {
        authFinished = true;
        next(err);
    });
}
