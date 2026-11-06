import type {ModuleEnvironmentContext, ValidationError} from "@coreModule/environment/validator";

export function validateEnvironment({env, validateString}: ModuleEnvironmentContext): ValidationError[] {
    const error = validateString("FIXTURE_REQUIRED_VALUE", env.FIXTURE_REQUIRED_VALUE, true);
    return error ? [error] : [];
}
