import type {CronHandlerContext} from "@coreModule/cronjobs/registry/types";
import {companyService} from "@coreModule/database/schemas/company/company.service";
import type {ICompany} from "@coreModule/database/schemas/company/company";
import type {SiteProvisionStatus} from "armonia/src/modules/core/api/company/private/company/siteSlug";

export type SiteHostProbeResult = {
    status: SiteProvisionStatus;
    lastError: string;
    reachable: boolean;
};

export function interpretSiteHostProbe(input: {
    httpStatus: number | null;
    responseVat?: string;
    expectedVat: string;
    networkError?: string;
}): SiteHostProbeResult {
    if (input.networkError) {
        return {status: "failed", lastError: input.networkError, reachable: false};
    }
    if (input.httpStatus !== 200) {
        return {status: "failed", lastError: `HTTP ${input.httpStatus ?? "000"}`, reachable: false};
    }
    const servedVat = (input.responseVat ?? "").trim();
    const expectedVat = input.expectedVat.trim();
    if (!servedVat || servedVat !== expectedVat) {
        return {status: "failed", lastError: "site served a different company", reachable: false};
    }
    return {status: "online", lastError: "", reachable: true};
}

function applyProbeResult(company: ICompany, result: SiteHostProbeResult): void {
    company.siteProvision = {
        status: result.status,
        checkedAt: new Date(),
        lastError: result.lastError,
        steps: {
            slug: true,
            domain: Boolean(company.siteHost),
            reachable: result.reachable,
        },
    };
    company.markModified("siteProvision");
}

/** Asks the host which company it serves (`POST /api/portal/site`) and compares the VAT. */
async function probeSite(siteHost: string, expectedVat: string): Promise<SiteHostProbeResult> {
    const origin = `https://${siteHost}`;
    try {
        const response = await fetch(`${origin}/api/portal/site`, {
            method: "POST",
            headers: {
                Origin: origin,
                "Content-Type": "application/json",
                "x-device-id": "site-host-probe",
                language: "en-US",
            },
            body: "{}",
            signal: AbortSignal.timeout(12000),
        });
        let responseVat: string | undefined;
        if (response.status === 200) {
            const body = await response.json() as {data?: {company?: {vat?: string}}};
            responseVat = body.data?.company?.vat;
        }
        return interpretSiteHostProbe({
            httpStatus: response.status,
            responseVat,
            expectedVat,
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return interpretSiteHostProbe({
            httpStatus: null,
            expectedVat,
            networkError: message,
        });
    }
}

export async function runSiteHostProbe(ctx: CronHandlerContext): Promise<void> {
    const company = await companyService.findById(ctx.company, {logger: ctx.logger});
    if (!company?.siteSlug) {
        return;
    }
    if (company.siteProvision?.status === "online" && company.siteHost) {
        ctx.appendLog(`Site host ${company.siteHost} already online`);
        return;
    }
    if (!company.siteHost) {
        applyProbeResult(company, {
            status: "failed",
            lastError: "PORTAL_ROOT_DOMAIN is not set",
            reachable: false,
        });
        await company.save();
        ctx.appendLog("Site host missing; PORTAL_ROOT_DOMAIN is not set");
        return;
    }

    const result = await probeSite(company.siteHost, company.vat);
    applyProbeResult(company, result);
    await company.save();
    ctx.appendLog(
        result.status === "online"
            ? `Site host ${company.siteHost} online`
            : `Site host ${company.siteHost} ${result.lastError}`,
    );
}
