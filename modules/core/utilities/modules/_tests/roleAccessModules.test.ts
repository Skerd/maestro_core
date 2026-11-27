import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
import mongoose, {Schema} from "mongoose";

// Redis down: every lookup reads the roles from the database.
vi.mock("@coreModule/connections/connectToRedis", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@coreModule/connections/connectToRedis")>()),
    isRedisConnected: () => false,
}));

import {getRolesAccess} from "@coreModule/utilities/security/roleAccessCache";

// Stand-ins for the models getRolesAccess resolves by name; only the fields (and the soft-delete
// query helper) it uses.
const roleSchema = new Schema({isAdmin: Boolean, permissions: [Schema.Types.ObjectId], deletedAt: Date});
(roleSchema.query as any).noDeleted = function (this: any) { return this.where({deletedAt: null}); };
const Role = mongoose.model("Role", roleSchema);
const RolePermission = mongoose.model("RolePermission", new Schema({tag: String, module: String}));


beforeAll(async () => {
    await connectTestDatabase();
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
});

describe("getRolesAccess module filter", () => {
    it("leaves out tags of modules the company does not have, admins included", async () => {
        const [coreTag, rentalTag, clinicTag] = await RolePermission.create([
            {tag: "users[read:self:name]", module: "core"},
            {tag: "vehicles[read:self:name]", module: "carRental"},
            {tag: "practitioners[read:self:name]", module: "dentalClinic"},
        ]);
        const admin = await Role.create({isAdmin: true, permissions: [coreTag._id, rentalTag._id, clinicTag._id]});

        const clinic = await getRolesAccess([admin._id], ["core", "finance", "dentalClinic"]);
        expect(clinic.isAdmin).toBe(true);
        expect(clinic.tags.sort()).toEqual(["practitioners[read:self:name]", "users[read:self:name]"]);

        // Same role, other company: re-enabling a module needs no role change.
        const rental = await getRolesAccess([admin._id], ["core", "carRental"]);
        expect(rental.tags.sort()).toEqual(["users[read:self:name]", "vehicles[read:self:name]"]);
    });

    it("keeps another module's platform-list tags when asked, and only those (D195)", async () => {
        const [coreTag, listTag, otherTag] = await RolePermission.create([
            {tag: "countries[read:self:name]", module: "core"},
            {tag: "productcategories[read:self:name]", module: "eCommerce"},
            {tag: "products[read:self:title]", module: "eCommerce"},
        ]);
        const admin = await Role.create({isAdmin: true, permissions: [coreTag._id, listTag._id, otherTag._id]});

        const platform = await getRolesAccess([admin._id], ["core"], ["productcategories["]);
        expect(platform.tags.sort()).toEqual(["countries[read:self:name]", "productcategories[read:self:name]"]);
        expect((await getRolesAccess([admin._id], ["core"])).tags).toEqual(["countries[read:self:name]"]);
    });
});
