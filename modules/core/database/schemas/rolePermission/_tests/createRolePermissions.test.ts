import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {MongoMemoryServer} from "mongodb-memory-server";
import mongoose, {Schema} from "mongoose";
import {ObjectId} from "mongodb";
import Role from "@coreModule/database/schemas/role/role";
import RolePermission from "@coreModule/database/schemas/rolePermission/rolePermission";
import {createRolePermissions} from "@coreModule/database/schemas/rolePermission/rolePermission.default";
import {registerModelAction} from "@coreModule/utilities/security/actionPermissions";

const Booking = mongoose.model("PermissionSyncBooking", new Schema({title: String}));
const company = new ObjectId();
const adminRole = new ObjectId();
let mongo: MongoMemoryServer;

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Role.collection.insertOne({_id: adminRole, company, name: "SysAdmin", slug: "x:sysadmin", isAdmin: true, permissions: []});
}, 120000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
});

describe("createRolePermissions", () => {
    it("creates each action's permission and grants it to every company's admin roles, outside any request (D14, D16)", async () => {
        registerModelAction(Booking, "confirm");

        // Boot runs with no tenant: the admin grant spans companies on purpose.
        await createRolePermissions();

        const tag = await RolePermission.findOne({tag: "permissionsyncbookings[action:self:confirm]"}).lean();
        expect(tag).toMatchObject({name: "Confirm", group: "Permissionsyncbookings", module: "core"});
        const admin = await Role.collection.findOne({_id: adminRole});
        expect(admin!.permissions.map(String)).toContain(String(tag!._id));
    });
});
