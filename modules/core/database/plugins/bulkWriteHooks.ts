import {ClientSession, Model, Schema} from "mongoose";

/*
 * Mongoose 6 runs no middleware for `Model.bulkWrite`, so a core plugin that must see those writes wraps the model's
 * `bulkWrite` (a schema static). Each schema gets one wrapper; every plugin's hook runs before the write, in the order
 * the plugins were applied, so the health-field refusal (D102) and the reference check (D104) compose instead of
 * one static replacing the other.
 */

export interface BulkWriteHookOptions {
    session?: ClientSession | null;
}

/** Runs before the model's `bulkWrite`; a throw (or rejection) refuses the whole batch. */
export type BulkWriteHook = (model: Model<unknown>, ops: unknown[], options: BulkWriteHookOptions) => void | Promise<void>;

const hooksBySchema = new WeakMap<Schema, BulkWriteHook[]>();

/** Adds `hook` to the schema's `bulkWrite`. */
export function preBulkWrite(schema: Schema, hook: BulkWriteHook): void {
    const existing = hooksBySchema.get(schema);
    if (existing) {
        existing.push(hook);
        return;
    }
    const hooks = [hook];
    hooksBySchema.set(schema, hooks);
    schema.static("bulkWrite", function (this: Model<unknown>, ops: unknown, ...rest: unknown[]) {
        const options = rest[0];
        const session = options !== null && typeof options === "object" && "session" in options ? options.session as ClientSession | null : undefined;
        const callback = rest.find((arg): arg is (error: unknown) => void => typeof arg === "function");
        const checked = (async () => {
            for (const run of hooks) await run(this, Array.isArray(ops) ? ops : [], {session});
        })();
        if (callback) {
            checked.then(() => Reflect.apply(Model.bulkWrite, this, [ops, ...rest]), callback);
            return undefined;
        }
        return checked.then(() => Reflect.apply(Model.bulkWrite, this, [ops, ...rest]));
    });
}
