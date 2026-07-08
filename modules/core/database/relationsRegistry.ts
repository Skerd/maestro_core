import type {ClientSession, Model} from "mongoose";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";
import {COLLECTED_DATA} from "@coreModule/database/collections";

// ── Types ─────────────────────────────────────────────────────────────────────

interface RelationEntry {
    /** The model that holds the reference field. */
    refModel: Model<any>;
    /** Human-readable collection name for error messages (e.g. "states"). */
    fromCollection: string;
    /** Path name on the referencing model (e.g. "country"). */
    field: string;
    /**
     * True when the field is declared required in the referencing schema.
     * Required relations BLOCK deletion; optional ones are skipped.
     *
     * Array-of-ObjectId fields are always treated as non-required because
     * an empty array is always valid — the blocking criterion is whether any
     * document actually contains the id in that array.
     */
    required: boolean;
}

// ── Registry (built lazily on first assertCanDelete call) ─────────────────────

/** Maps target model name (e.g. "Country") → all schemas that reference it. */
const registry = new Map<string, RelationEntry[]>();
let built = false;

function addEntry(targetModelName: string, entry: RelationEntry): void {
    if (!registry.has(targetModelName)) registry.set(targetModelName, []);
    registry.get(targetModelName)!.push(entry);
}

function buildRegistry(): void {
    if (built) return;

    for (const collectedData of Object.values(COLLECTED_DATA)) {
        const {model: refModel} = collectedData;

        refModel.schema.eachPath((pathName, schemaType) => {
            // Skip plugin/system paths and nested sub-document paths.
            if (pathName.includes(".")) return;

            // ── Scalar ObjectId ref ──────────────────────────────────────────
            if (schemaType.instance === "ObjectID" && schemaType.options?.ref) {
                addEntry(schemaType.options.ref, {
                    refModel,
                    fromCollection: refModel.collection.name,
                    field: pathName,
                    required: !!schemaType.isRequired,
                });
                return;
            }

            // ── Array of ObjectId refs ───────────────────────────────────────
            // e.g. imageGallery: [{ type: SchemaTypes.ObjectId, ref: "Media" }]
            const caster = (schemaType as any).caster;
            if (
                schemaType.instance === "Array" &&
                caster?.instance === "ObjectID" &&
                caster?.options?.ref
            ) {
                addEntry(caster.options.ref, {
                    refModel,
                    fromCollection: refModel.collection.name,
                    field: pathName,
                    required: false, // arrays can always be empty; count check handles the rest
                });
            }
        });
    }

    built = true;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Asserts that the given document can be safely deleted (soft or hard).
 *
 * Builds the relation registry on first call (lazy, safe because HTTP handlers
 * only run after all modules are loaded). Checks every required reference
 * declared in any registered Mongoose schema. If any active (non-soft-deleted)
 * document still references this id via a required field, throws a `ServerError`
 * with a list of the blocking relations.
 *
 * @param modelName    - Mongoose model name of the entity being deleted (e.g. `Country.modelName`)
 * @param id           - The `_id` of the document being deleted
 * @param languageCode - Locale code (used for future i18n of the error message)
 * @param session      - Active MongoDB session / transaction (optional)
 *
 * @throws {ServerError} status 400 when required references exist
 *
 * @example
 * await assertCanDelete(Country.modelName, country._id, languageCode, session);
 */
export async function assertCanDelete(
    modelName: string,
    id: any,
    languageCode: string = "en-US",
    session?: ClientSession,
): Promise<void> {
    buildRegistry();

    const relations = registry.get(modelName);
    if (!relations?.length) return;

    const blockers: string[] = [];

    for (const rel of relations) {
        if (!rel.required) continue;

        const count: number = await rel.refModel
            .countDocuments({[rel.field]: id})
            .session(session ?? null);

        if (count > 0) {
            blockers.push(`${rel.fromCollection}.${rel.field} (${count} record${count === 1 ? "" : "s"})`);
        }
    }

    if (blockers.length > 0) {
        throw apiValidationException(
            "cannot_delete_has_relations",
            null,
            null,
            languageCode,
            [blockers.join(", ")]
        );
    }
}
