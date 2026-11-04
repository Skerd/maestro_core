import {describe, expect, it} from "vitest";
import {ObjectId} from "mongodb";
import User from "@coreModule/database/schemas/user/user";
import {userToCompanyUserDTO} from "@coreModule/utilities/mappers/user/userMapper.dto";

describe("userToCompanyUserDTO", () => {
    const platform = new ObjectId();
    const shop = new ObjectId();
    const shopLogin = new Date("2026-11-04T10:00:00Z");
    const user = new User({
        username: "member@example.com",
        roles: [
            {company: platform, active: "inactive", roles: [], lastLogin: new Date("2026-01-01T00:00:00Z")},
            {company: shop, active: "active", roles: [], lastLogin: shopLogin},
        ],
    });

    it("describes the membership of the requested company, not the first one stored", () => {
        const dto = userToCompanyUserDTO(user, shop);
        expect(dto?.status).toBe("active");
        expect(dto?.lastLogin).toEqual(shopLogin);
    });

    it("has no roles in a company the user does not belong to", () => {
        const dto = userToCompanyUserDTO(user, new ObjectId());
        expect(dto?.roles).toEqual([]);
        expect(dto?.status).toBe("inactive");
    });
});
