import {describe, expect, it} from "vitest";
import {emitNotificationEvent, notificationEventBus} from "@coreModule/domain/notifications/notificationEventBus";
import {requestContext} from "@coreModule/utilities/endpoints/requestContext";

describe("emitNotificationEvent (D16)", () => {
    it("runs the handlers as the event's company, whatever request raised it", () => {
        const seen: (string | undefined)[] = [];
        const handler = () => seen.push(requestContext.getStore()?.tenantCompanyId);
        notificationEventBus.on("TEST_TENANT_EVENT", handler);

        // A public request (no tenant), then a request of another company.
        emitNotificationEvent("TEST_TENANT_EVENT", {receiverIds: ["u1"], payload: {companyId: "6a0000000000000000000001"}});
        requestContext.run({tenantCompanyId: "6a0000000000000000000002"}, () =>
            emitNotificationEvent("TEST_TENANT_EVENT", {receiverIds: ["u1"], payload: {companyId: "6a0000000000000000000001"}}));
        // No company named: the handlers keep the caller's context.
        requestContext.run({tenantCompanyId: "6a0000000000000000000002"}, () =>
            emitNotificationEvent("TEST_TENANT_EVENT", {receiverIds: ["u1"], payload: {}}));

        notificationEventBus.off("TEST_TENANT_EVENT", handler);
        expect(seen).toEqual(["6a0000000000000000000001", "6a0000000000000000000001", "6a0000000000000000000002"]);
    });
});
