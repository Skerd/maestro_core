import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {connectTestDatabase, disconnectTestDatabase} from "@coreModule/_tests/testDatabase";
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

beforeAll(async () => {
    await connectTestDatabase();
    await Role.collection.insertOne({_id: adminRole, company, name: "SysAdmin", slug: "x:sysadmin", isAdmin: true, permissions: []});
}, 120000);

afterAll(async () => {
    await disconnectTestDatabase();
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

    it("removes a permission no model or action produces any more, from the catalog and every company's roles (TD-T13)", async () => {
        registerModelAction(Booking, "confirm");
        await createRolePermissions();
        const current = await RolePermission.findOne({tag: "permissionsyncbookings[action:self:confirm]"}).lean();
        // A retired action of a mounted module, and one of a module whose routers this process did not mount.
        const [retired, unmounted] = [new ObjectId(), new ObjectId()];
        await RolePermission.collection.insertMany([
            {_id: retired, name: "Retire", group: "Permissionsyncbookings", tag: "permissionsyncbookings[action:self:retire]", alwaysActive: false, module: "core"},
            {_id: unmounted, name: "Elsewhere", group: "Unmountedthings", tag: "unmountedthings[action:self:elsewhere]", alwaysActive: false, module: "unmountedFixture"},
        ]);
        const deskRole = new ObjectId();
        await Role.collection.insertOne({_id: deskRole, company: new ObjectId(), name: "Desk", slug: "y:desk", isAdmin: false, permissions: [current!._id, retired, unmounted]});
        await Role.collection.updateOne({_id: adminRole}, {$addToSet: {permissions: {$each: [retired, unmounted]}}});

        await createRolePermissions();

        expect(await RolePermission.exists({_id: retired})).toBeNull();
        expect(await RolePermission.exists({_id: current!._id})).not.toBeNull();
        expect(await RolePermission.exists({_id: unmounted})).not.toBeNull();
        for (const roleId of [deskRole, adminRole]) {
            const granted = (await Role.collection.findOne({_id: roleId}))!.permissions.map(String);
            expect(granted).not.toContain(String(retired));
            expect(granted).toContain(String(current!._id));
            expect(granted).toContain(String(unmounted));
        }
    });

    it("names default-role groups that no permission has, so a misspelt group is not silent (TD-B32)", () => {
        registerDefaultRoles([{name: "Desk", slug: "fixture_desk", isAdmin: false, isSignupDefault: false, canEdit: true, canDelete: false, permissionGroups: ["Permissionsynccharts", "Permissionsyncchartz"]}]);
        expect(unknownDefaultRoleGroups(new Set(["Permissionsynccharts"]))).toContain("fixture_desk: Permissionsyncchartz");
        expect(unknownDefaultRoleGroups(new Set(["Permissionsynccharts"]))).not.toContain("fixture_desk: Permissionsynccharts");
    });
});
