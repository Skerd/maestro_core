/**
 * Core's own reportable kind (D191): a company, reported from its portal page or its own site. Hiding it hides the
 * company from the portal and the shop apex, the same as the platform's companies page does; its own site keeps
 * working until the platform suspends it.
 *
 * @module domain/reports/coreReportables
 */

import {companyService} from "@coreModule/database/schemas/company/company.service";
import {setCompanyPortalHidden} from "@coreModule/domain/company/companyStanding";
import {companySiteUrl} from "@coreModule/utilities/marketing/portalCompanies";
import type {ReportableDefinition} from "@coreModule/domain/reports/reportables";

export const coreReportables: ReportableDefinition[] = [
    {
        kind: "core.company",
        typeLabel: {"en-US": "Business", "de-CH": "Unternehmen", "fr-FR": "Entreprise", "it-IT": "Azienda", "sq-AL": "Biznes"},
        snapshot: async ({recordId, session}) => {
            const company = await companyService.findById(recordId, {session}, undefined, "_id name siteSlug hiddenFromPortal");
            if (!company) return null;
            return {
                title: company.name ?? "",
                companyId: company._id,
                url: companySiteUrl({_id: company._id, siteSlug: company.siteSlug}, "/"),
                hidden: company.hiddenFromPortal === true,
            };
        },
        setHidden: async ({recordId, hidden, decidedBy, session, logger, languageCode}) => {
            await setCompanyPortalHidden(recordId, hidden, {decidedBy: decidedBy.toString(), session, logger, languageCode});
        },
    },
];
