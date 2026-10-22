import {beforeEach, describe, expect, it, vi} from "vitest";
import {WebSocketMessageCodes} from "armonia/src/modules/core/websocket/types";

const pushWebsocketMessage = vi.fn();

vi.mock("@coreModule/connections/connectToWebSocketServer", () => ({
    pushWebsocketMessage: (message: unknown) => pushWebsocketMessage(message),
}));

import {pushNotificationToUsers} from "../pushNotificationToUsers";

const notification = {_id: "n1"} as never;

describe("pushNotificationToUsers", () => {
    beforeEach(() => {
        pushWebsocketMessage.mockReset();
    });

    it("pushes the notifications to the given users", () => {
        pushNotificationToUsers(["u1", "u2"], [notification]);

        expect(pushWebsocketMessage).toHaveBeenCalledWith({
            code: WebSocketMessageCodes.NEW_NOTIFICATIONS,
            userIds: ["u1", "u2"],
            payload: [notification],
        });
    });

    it("pushes nothing without receivers or notifications", () => {
        pushNotificationToUsers([], [notification]);
        pushNotificationToUsers(["u1"], []);

        expect(pushWebsocketMessage).not.toHaveBeenCalled();
    });
});
