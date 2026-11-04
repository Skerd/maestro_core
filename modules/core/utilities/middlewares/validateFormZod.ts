import {NextFunction, Request, Response} from 'express';
import {ZodType} from 'zod';
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {ValidationError} from "armonia/src/modules/core/types";
import {CONSTANTS} from "@coreModule/environment";
import {clientValuesOfServerKeys, SERVER_KEYS} from "@coreModule/utilities/middlewares/serverKeys";

/**
 * Form Validation Middleware (Zod-based)
 *
 * Validates request body against a Zod schema. The schema is created per-request
 * from a factory so it can use languageCode for localized error messages.
 *
 * @param schemaFactory - A function (languageCode, form) => ZodSchema, e.g., getAllUsersFormSchema
 *
 * @example
 * ```typescript
 * router.post(
 *   "/users",
 *   authMW("private"),
 *   validateFormZod(getAllUsersFormSchema),
 *   asyncHandler(getCompanyUsers)
 * );
 * ```
 */
// Only `safeParse` is used, so any Zod type qualifies, including the `z.preprocess` pipes some validators return.
export const validateFormZod = (schemaFactory: (languageCode: string | undefined, form?: any, sanitizedFields?: any, sanitizedReadFields?: any) => ZodType) => {
    return function (req: Request, _: Response, next: NextFunction) {

        if (req.body == null || typeof req.body !== "object") {
            req.body = {};
        }
        const body = req.body;
        const languageCode = body.languageCode ?? CONSTANTS.DEFAULT_LANGUAGE;
        const schema = schemaFactory(languageCode, null, req.body?.sanitizedWriteFields ?? {}, req.body?.sanitizedReadFields ?? {});
        // Validate what the client sent: server-written keys are swapped back for the client's own values
        // (quarantined by stripServerKeys), so a contract field like a recipient's `languageCode` sees its input.
        const input: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(body)) {
            if (!SERVER_KEYS.has(key)) input[key] = value;
        }
        Object.assign(input, clientValuesOfServerKeys(req));
        const result = schema.safeParse(input);
        if( !result.success ){
            const validationErrors: ValidationError[] = [];
            const zodErrors = result.error.issues;
            for( let fieldError of zodErrors ){
                validationErrors.push({
                    message: fieldError.message,
                    error_code: fieldError.code,
                    extra_message: undefined,
                    content: undefined,
                    path: fieldError.path.join(".")
                })
            }
            const error = apiValidationException("form_not_correct", null, validationErrors, languageCode);
            return next(error);
        }
        /** Multipart and URL-encoded bodies arrive as strings; Zod preprocess/coerce produces typed values. Merge so handlers see parsed output. */
        const data: unknown = result.data;
        if (data != null && typeof data === "object") {
            for (const [key, value] of Object.entries(data)) {
                // A value a middleware wrote (e.g. authMW's `languageCode`) wins; otherwise the validated client value.
                if (SERVER_KEYS.has(key) && body[key] !== undefined) continue;
                body[key] = value;
            }
            body.validatedForm = data;
        }
        return next();
    };
};
