import {describe, expect, it} from "vitest";
import {
    isModuleCodeFile,
    MODULE_FILE_EXTENSION,
    moduleCodeFile,
    withoutModuleExtension,
} from "@coreModule/utilities/modules/moduleCodeFiles";

describe("moduleCodeFiles", () => {
    it("runs as TypeScript under vitest", () => {
        expect(MODULE_FILE_EXTENSION).toBe(".ts");
    });

    it.each([".ts", ".js"])("accepts module code with the %s extension", (ext) => {
        expect(isModuleCodeFile(`a${ext}`, ext)).toBe(true);
        expect(isModuleCodeFile(`index${ext}`, ext)).toBe(true);
        expect(isModuleCodeFile(`unit.route${ext}`, ext)).toBe(true);
    });

    it.each([".ts", ".js"])("rejects test files with the %s extension", (ext) => {
        expect(isModuleCodeFile(`a.test${ext}`, ext)).toBe(false);
        expect(isModuleCodeFile(`a.spec${ext}`, ext)).toBe(false);
    });

    it("rejects declarations, source maps and the other extension", () => {
        expect(isModuleCodeFile("a.d.ts", ".ts")).toBe(false);
        expect(isModuleCodeFile("a.js.map", ".js")).toBe(false);
        expect(isModuleCodeFile("a.js", ".ts")).toBe(false);
        expect(isModuleCodeFile("a.ts", ".js")).toBe(false);
        expect(isModuleCodeFile("a.json", ".js")).toBe(false);
    });

    it("defaults to the running extension", () => {
        expect(isModuleCodeFile("a.ts")).toBe(true);
        expect(isModuleCodeFile("a.js")).toBe(false);
        expect(moduleCodeFile("moduleBootstrap")).toBe("moduleBootstrap.ts");
        expect(withoutModuleExtension("/m/api/private/unit.ts")).toBe("/m/api/private/unit");
    });

    it("names a well-known module file for either runtime", () => {
        expect(moduleCodeFile("moduleBootstrap", ".js")).toBe("moduleBootstrap.js");
        expect(moduleCodeFile("environment.validator", ".ts")).toBe("environment.validator.ts");
    });

    it("strips only the given trailing extension", () => {
        expect(withoutModuleExtension("/m/database/moduleBootstrap.js", ".js")).toBe("/m/database/moduleBootstrap");
        expect(withoutModuleExtension("realEstate/private/unit.ts", ".ts")).toBe("realEstate/private/unit");
        expect(withoutModuleExtension("/m/tsHelpers/a.js", ".ts")).toBe("/m/tsHelpers/a.js");
        expect(withoutModuleExtension("/m/api/private/unit", ".js")).toBe("/m/api/private/unit");
    });
});
