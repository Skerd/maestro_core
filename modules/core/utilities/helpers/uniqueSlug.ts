import type {ObjectId} from "mongodb";

function toBaseSlug(input: string): string {
    return input
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, "")
        .replace(/[\s_]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

/**
 * A URL slug from `base` that no other row of the company's `model` holds yet: `name`, then `name-1`, `name-2`, ….
 * Soft-deleted rows count as taken, because they still hold their slug in the unique index. `existingId` leaves the
 * row being edited out. A base with no usable characters falls back to `item`.
 */
export async function generateUniqueSlug(
    base: string,
    // Schema hooks pass `this.constructor` (typed `Function`), so the model stays loosely typed, as before the move.
    model: {countDocuments(filter: object): Promise<number>} & any,
    companyId: ObjectId,
    existingId?: ObjectId,
): Promise<string> {
    const baseSlug = toBaseSlug(base) || "item";
    let slug = baseSlug;
    let suffix = 0;

    while (true) {
        const filter: Record<string, unknown> = {slug, company: companyId};
        if (existingId) filter._id = {$ne: existingId};
        const count = await model.countDocuments(filter).withDeleted();
        if (count === 0) return slug;
        suffix++;
        slug = `${baseSlug}-${suffix}`;
    }
}
