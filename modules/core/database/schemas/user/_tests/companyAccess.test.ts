import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import {ObjectId} from "mongodb";

// Redis down: every lookup reads the roles from the database.
vi.mock("@coreModule/connections/connectToRedis", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@coreModule/connections/connectToRedis")>()),
    isRedisConnected: () => false,
}));

import User from "@coreModule/database/schemas/user/user";
import Role from "@coreModule/database/schemas/role/role";
// roleAccessCache reads it by model name; the servers load every model at start-up.
import RolePermission from "@coreModule/database/schemas/rolePermission/rolePermission";
import Company from "@coreModule/database/schemas/company/company";
import {registerPlatformRouter} from "@coreModule/utilities/security/platformListRegistry";
import {withTenant} from "@coreModule/utilities/endpoints/tenantScope";

const shop = new ObjectId();
const clinic = new ObjectId();
const clinicAdminRole = new ObjectId();
const platform = new ObjectId();
const platformStaffRole = new ObjectId();
const categoryRead = new ObjectId();
const productRead = new ObjectId();

beforeAll(async () => {
    await connectTestDatabase();
    await Role.collection.insertOne({_id: clinicAdminRole, company: clinic, name: "SysAdmin", slug: "clinic:sysadmin", isAdmin: true, permissions: []});
    // The platform company runs core only; eCommerce's product categories are a platform list (D195).
    await Company.collection.insertOne({_id: platform, name: "Platform", isPlatformOwner: true, isActive: true, modules: ["core"]});
    await RolePermission.collection.insertMany([
        {_id: categoryRead, tag: "productcategories[read:self:name]", module: "eCommerce"},
        {_id: productRead, tag: "products[read:self:title]", module: "eCommerce"},
    ]);
    await Role.collection.insertOne({_id: platformStaffRole, company: platform, name: "Staff", slug: "platform:staff", isAdmin: false, permissions: [categoryRead, productRead]});
    registerPlatformRouter({}, "productcategories");
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

describe("a user's access in one of their companies (D16)", () => {
    const member = new User({
        username: "member@example.com",
        companies: [shop, clinic],
        roles: [
            {company: shop, active: "active", roles: []},
            {company: clinic, active: "active", roles: [clinicAdminRole]},
        ],
    });

    it("reads that company's roles even while the request belongs to another of them", async () => {
        // The companies list asks for every company of the user from inside one company's request.
        const access = await withTenant(shop, () => member.getCompanyAccess(clinic, ["core"]));
        expect(access.isAdmin).toBe(true);
        expect((await withTenant(shop, () => member.getUserRoles(clinic))).map((role) => role.name)).toEqual(["SysAdmin"]);
    });

    it("gives the platform company the platform lists of modules it does not run, and nothing else of them (D195)", async () => {
        const staff = new User({username: "staff@example.com", companies: [platform], roles: [{company: platform, active: "active", roles: [platformStaffRole]}]});
        const {permissions} = await withTenant(platform, () => staff.getCompanyAccess(platform, ["core"]));
        expect(permissions).toEqual(["productcategories[read:self:name]"]);
    });
});
