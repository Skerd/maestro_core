/**
 * Applies the demo company profiles (name, description, address, logo) to the
 * live database and creates any demo company that is not there yet.
 *
 * Does not drop the database. An existing company is matched by VAT: its profile
 * is updated, and its module catalogs are left in place. A missing company is
 * created and receives that module's demo seed.
 *
 * Usage (from maestro/):
 *   yarn sync:demo-companies
 * In a deployed container (compiled build, no .ts sources):
 *   docker exec maestroApi-<instance> node -r tsconfig-paths/register scripts/syncDemoCompanies.js
 */

import {ObjectId} from "mongodb";
import mongoose from "mongoose";
import {connectToMongoDb, disconnectFromMongoDb} from "@coreModule/connections/connectToMongoDb";
import {asCrossTenant} from "@coreModule/utilities/endpoints/tenantScope";
import {getAllModels} from "@initializer";
import Company from "@coreModule/database/schemas/company/company";
import {createCompanies} from "@coreModule/database/schemas/company/company.defaults";

const LOREM_PRODUCT_ID = new ObjectId("6acbfb6ff2b5182b46074d7a");

async function replaceLoremProduct(): Promise<void> {
    const products = mongoose.connection.collection("products");
    const existing = await products.findOne({_id: LOREM_PRODUCT_ID});
    if (!existing) return;

    await products.updateOne(
        {_id: LOREM_PRODUCT_ID},
        {$set: {
            title: "Stonewashed linen shirt",
            slug: "stonewashed-linen-shirt",
            sku: "LINEN-SHIRT-001",
            brand: "Arpeggio Market",
            vendor: "Arpeggio Market",
            shortDescription: "A relaxed linen shirt in stonewashed sand, cut for warm weather and left unlined.",
            description: "A relaxed linen shirt in stonewashed sand. The cloth is garment-washed so it is soft on the first wear, with a camp collar, mother-of-pearl buttons, and a straight hem that can be worn out.",
        }},
    );
}

async function main(): Promise<void> {
    await connectToMongoDb(undefined, false);
    await getAllModels();
    await createCompanies(undefined, true);
    await replaceLoremProduct();
    await mongoose.connection.collection("smtpservers").updateMany(
        {fromName: "Pronix Demo"},
        {$set: {fromName: "Arpeggio Demo"}},
    );

    const companies = await Company.find({})
        .select("name vat description website phoneNumber logo isPlatformOwner siteSlug addresses")
        .lean();

    console.log("COMPANY_SYNC_RESULT");
    for (const company of companies) {
        const description = String(company.description ?? "");
        console.log(JSON.stringify({
            name: company.name,
            vat: company.vat,
            platform: company.isPlatformOwner === true,
            siteSlug: company.siteSlug ?? null,
            phone: company.phoneNumber,
            website: company.website,
            logo: company.logo ? String(company.logo) : null,
            address: company.addresses?.[0]?.street ?? null,
            description: description.slice(0, 80),
            lorem: /lorem|ipsum/i.test(description),
        }));
    }

    const platform = companies.find((company) => company.isPlatformOwner === true && company.name === "Arpeggio");
    if (!platform?.logo) {
        throw new Error("Arpeggio was not saved with a logo");
    }

    await disconnectFromMongoDb();
}

// Operator scripts span companies on purpose (D16).

asCrossTenant("a demo sync rewrites the demo companies' data", main).then(() => {
    process.exit(0);
}).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
