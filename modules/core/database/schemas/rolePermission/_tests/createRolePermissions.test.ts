import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {MongoMemoryServer} from "mongodb-memory-server";
import mongoose, {Schema} from "mongoose";
import {ObjectId} from "mongodb";
import Role from "@coreModule/database/schemas/role/role";
import RolePermission from "@coreModule/database/schemas/rolePermission/rolePermission";
import {createRolePermissions} from "@coreModule/database/schemas/rolePermission/rolePermission.default";
import {registerModelAction} from "@coreModule/utilities/security/actionPermissions";
import {registerDefaultRoles, resolveDefaultRolePermissionIds, unknownDefaultRoleGroups} from "@coreModule/database/schemas/role/role.defaults";

const Booking = mongoose.model("PermissionSyncBooking", new Schema({title: String}));
const Chart = mongoose.model("PermissionSyncChart", new Schema({
    title: String,
    history: {type: {notes: String, signedAt: Date}, sensitivity: "health"},
}));
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

    it("marks a sensitive field's tags and leaves them out of default roles that do not list the group (SEC-06)", async () => {
        await createRolePermissions();
        const tags = await RolePermission.find({group: "Permissionsynccharts"}).lean();
        const historyTags = tags.filter((permission) => permission.tag.includes(":history"));
        expect(historyTags.length).toBeGreaterThanOrEqual(3); // history, history_notes, history_signedAt
        expect(historyTags.every((permission) => permission.sensitivity === "health")).toBe(true);
        expect(tags.find((permission) => permission.tag.endsWith(":title]"))?.sensitivity).toBeUndefined();

        const role = {name: "Desk", slug: "desk", isAdmin: false, isSignupDefault: false, canEdit: true, canDelete: false, permissionGroups: ["Permissionsynccharts"]};
        const withoutHealth = (await resolveDefaultRolePermissionIds(role)).map(String);
        const withHealth = (await resolveDefaultRolePermissionIds({...role, sensitivePermissionGroups: ["Permissionsynccharts"]})).map(String);
        const historyIds = historyTags.map((permission) => String(permission._id));
        expect(withoutHealth.some((id) => historyIds.includes(id))).toBe(false);
        expect(withoutHealth).toContain(String(tags.find((permission) => permission.tag.endsWith(":title]"))!._id));
        expect(historyIds.every((id) => withHealth.includes(id))).toBe(true);

        // Admin roles keep every tag, sensitive ones included (architect's choice, D39).
        const admin = await Role.collection.findOne({_id: adminRole});
        expect(historyIds.every((id) => admin!.permissions.map(String).includes(id))).toBe(true);
    });

    it("clears the mark when a field stops being sensitive", async () => {
        await RolePermission.updateOne({tag: {$regex: ":title\\]$", $options: ""}, group: "Permissionsynccharts"}, {$set: {sensitivity: "payment"}});
        await createRolePermissions();
        const title = await RolePermission.findOne({group: "Permissionsynccharts", tag: {$regex: ":title\\]$"}}).lean();
        expect(title?.sensitivity).toBeUndefined();
    });

    it("names default-role groups that no permission has, so a misspelt group is not silent (TD-B32)", () => {
        registerDefaultRoles([{name: "Desk", slug: "fixture_desk", isAdmin: false, isSignupDefault: false, canEdit: true, canDelete: false, permissionGroups: ["Permissionsynccharts", "Permissionsyncchartz"]}]);
        expect(unknownDefaultRoleGroups(new Set(["Permissionsynccharts"]))).toContain("fixture_desk: Permissionsyncchartz");
        expect(unknownDefaultRoleGroups(new Set(["Permissionsynccharts"]))).not.toContain("fixture_desk: Permissionsynccharts");
    });
});
