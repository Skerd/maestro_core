import {Schema} from "mongoose";

export function applyPortalSavedSearchIndexes(PortalSavedSearchSchema: Schema): void {
    // A person's list, newest first; the daily alert's sweep of the searches with alerts on.
    PortalSavedSearchSchema.index({company: 1, user: 1, createdAt: -1});
    PortalSavedSearchSchema.index({company: 1, alerts: 1, lastAlertAt: 1});
}
