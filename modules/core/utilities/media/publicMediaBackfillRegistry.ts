import type {Model} from "mongoose";
import type {SchemaDef} from "armonia/src/modules/core/helpers/schemaDefBuilder";

export type PublicMediaBackfillSource = {
    name: string;
    schemaDef: SchemaDef | Record<string, unknown>;
    loadModel: () => Promise<Model<any>>;
    companyFromDocumentId?: boolean;
};

const sources: PublicMediaBackfillSource[] = [];

export function registerPublicMediaBackfillSource(source: PublicMediaBackfillSource): void {
    if (sources.some((existing) => existing.name === source.name)) {
        return;
    }
    sources.push(source);
}

export function getPublicMediaBackfillSources(): readonly PublicMediaBackfillSource[] {
    return sources;
}
