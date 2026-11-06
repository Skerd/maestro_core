import path from "path";
import {describe, expect, it} from "vitest";
import {collectModuleEnvironmentErrors, type ModuleEnvironmentContext} from "@coreModule/environment/validator";
import * as enabledWithChecks from "./fixtures/enabledWithChecks/environment.validator";
import * as disabledWithChecks from "./fixtures/disabledWithChecks/environment.validator";

const modulesRoot = path.join(__dirname, "fixtures");
const isEnabled = (name: string) => name !== "disabledWithChecks";
// Boot loads the files with ts-node's require; the test hands over the same modules, imported.
const fixtureModules: Record<string, typeof enabledWithChecks> = {enabledWithChecks, disabledWithChecks};
const load = (file: string) => fixtureModules[path.basename(path.dirname(file))];
const validateString: ModuleEnvironmentContext["validateString"] = (key, value, required = true) =>
    required && !value ? {key, message: `${key} missing`} : null;
const ctx = (env: NodeJS.ProcessEnv): ModuleEnvironmentContext => ({
    env,
    kafkaEnabled: false,
    validateString,
    validateNumber: () => null,
    validateBoolean: () => null,
    validateArray: () => null,
});

describe("module environment validator seam (D67)", () => {
    it("runs the validator of every enabled module that has one", () => {
        expect(collectModuleEnvironmentErrors(ctx({}), {modulesRoot, isEnabled, load})).toEqual([
            {key: "FIXTURE_REQUIRED_VALUE", message: "FIXTURE_REQUIRED_VALUE missing"},
        ]);
    });

    it("passes when the module's variables are set", () => {
        expect(collectModuleEnvironmentErrors(ctx({FIXTURE_REQUIRED_VALUE: "set"}), {modulesRoot, isEnabled, load})).toEqual([]);
    });

    it("skips disabled modules", () => {
        expect(collectModuleEnvironmentErrors(ctx({}), {modulesRoot, isEnabled: () => false, load})).toEqual([]);
    });
});
