import {NextFunction, Request, Response} from 'express';
import {ZodObject} from 'zod';
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {ValidationError} from "armonia/src/modules/core/types";
import {CONSTANTS} from "@coreModule/environment";

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
export const validateFormZod = (schemaFactory: (languageCode: string | undefined, form?: any, sanitizedFields?: any, sanitizedReadFields?: any) => ZodObject<any>) => {
    return function (req: Request, _: Response, next: NextFunction) {

        if (req.body == null || typeof req.body !== "object") {
            req.body = {};
        }
        const body = req.body;
        const languageCode = body.languageCode ?? CONSTANTS.DEFAULT_LANGUAGE;
        const schema = schemaFactory(languageCode, null, req.body?.sanitizedWriteFields ?? {}, req.body?.sanitizedReadFields ?? {});
        const result = schema.safeParse(body);
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
        Object.assign(body, result.data);
        return next();
    };
};
