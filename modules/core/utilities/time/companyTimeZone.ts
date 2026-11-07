import type {ObjectId} from "mongodb";
import type {ClientSession} from "mongoose";
import {SERVER} from "@coreModule/environment";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import {isValidTimeZone} from "@coreModule/utilities/time/timeWindows";

/** The zone used when neither the company nor the instance names a valid one. */
const FALLBACK_TIME_ZONE = "UTC";

function validZone(zone: string | undefined | null): string | undefined {
    const trimmed = zone?.trim();
    return trimmed && isValidTimeZone(trimmed) ? trimmed : undefined;
}

/**
 * The IANA zone a company's business rules run in (GLB-09, D91): its "today", expiry and report day/month bounds.
 * The company's own `timezone`, else the instance's `SERVER_TIMEZONE`, else UTC. A zone that is set but unknown
 * counts as unset. Pass the company document you already hold; use {@link companyTimeZoneOf} when you have its id.
 *
 * @example localDayInterval("2027-03-01", companyTimeZone(company))
 */
export function companyTimeZone(company: {timezone?: string | null} | null | undefined): string {
    return validZone(company?.timezone) ?? validZone(SERVER.TIMEZONE) ?? FALLBACK_TIME_ZONE;
}

/**
 * {@link companyTimeZone} for a company id: reads the company's `timezone` through the company service (D17).
 * An unknown company resolves like a company without a zone.
 */
export async function companyTimeZoneOf(companyId: ObjectId | string, opts: {session?: ClientSession | null} = {}): Promise<string> {
    const company = await companyService.findById(companyId, {session: opts.session ?? undefined}, undefined, "timezone");
    return companyTimeZone(company);
}
