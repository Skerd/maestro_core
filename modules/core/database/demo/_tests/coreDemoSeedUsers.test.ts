/**
 * TD-B218: a demo row whose user exists in no dev profile is skipped silently, so the core demo messages and
 * notifications name only the core users, which every profile creates before any company's demo seed.
 */
import {describe, expect, it} from "vitest";
import {defaultSysUsers} from "@coreModule/database/schemas/user/user.defaults";
import {DEMO_MESSAGES} from "@coreModule/database/schemas/message/message.defaults";
import {DEMO_NOTIFICATIONS} from "@coreModule/database/schemas/notification/notification.defaults";

describe("core demo seed users", () => {
    it("names only the core users in the demo messages and notifications", () => {
        const known = new Set(defaultSysUsers.map((user: {username: string}) => user.username));
        const named = [
            ...DEMO_MESSAGES.flatMap((message) => [message.from, message.to]),
            ...DEMO_NOTIFICATIONS.map((notification) => notification.receiver),
        ];
        expect(named.filter((username) => !known.has(username))).toEqual([]);
    });
});
