import {Router} from "express";
import {ObjectId} from "mongodb";
import {asyncHandler} from "@coreModule/utilities/middlewares/asyncHandler";
import authMW from "@coreModule/utilities/middlewares/authMW";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {validateFormZod} from "@coreModule/utilities/middlewares/validateFormZod";
import {countryService} from "@coreModule/database/schemas/country/country.service";
import {stateService} from "@coreModule/database/schemas/state/state.service";
import {cityService} from "@coreModule/database/schemas/city/city.service";
import {resolveStorefrontContext} from "@coreModule/utilities/marketing/portalStorefront";
import {portalPlacesFormSchema, type PortalPlacesFormType} from "armonia/src/modules/core/api/portal/public/portal/portalPlaces.form.validator";

/**
 * Countries, states and cities for the portal's address forms (checkout, saved addresses, a posted job). An address
 * names its country, state and city as rows of the host's company, which zone matching needs, so the visitor gets
 * a buyer-safe list of that company's rows without any admin model permission.
 */
export const basePath = "/api/portal/places";
export const router = Router();

router.get(
    "/countries",
    authMW("public"),
    rateLimiter({windowMs: 60000, max: 60}),
    asyncHandler(async (params: any) => {
        const {languageCode, origin} = params;
        await resolveStorefrontContext(origin, languageCode);
        const countries = await countryService.find({}, {}, undefined, "name code", {name: 1});
        return {data: countries.map((country) => ({_id: country._id.toString(), name: country.name ?? "", code: country.code ?? ""}))};
    }),
);

router.post(
    "/states",
    authMW("public"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(portalPlacesFormSchema),
    asyncHandler(async (params: any & PortalPlacesFormType) => {
        const {languageCode, origin, countryId} = params;
        await resolveStorefrontContext(origin, languageCode);
        const states = await stateService.find({country: new ObjectId(countryId)}, {}, undefined, "name", {name: 1});
        return {data: states.map((state) => ({_id: state._id.toString(), name: state.name ?? ""}))};
    }),
);

router.post(
    "/cities",
    authMW("public"),
    rateLimiter({windowMs: 60000, max: 60}),
    validateFormZod(portalPlacesFormSchema),
    asyncHandler(async (params: any & PortalPlacesFormType) => {
        const {languageCode, origin, countryId} = params;
        await resolveStorefrontContext(origin, languageCode);
        const cities = await cityService.find({country: new ObjectId(countryId)}, {}, undefined, "name", {name: 1});
        return {data: cities.map((city) => ({_id: city._id.toString(), name: city.name ?? ""}))};
    }),
);
