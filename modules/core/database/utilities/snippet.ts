type SnippetKeyValue = {readonly keys: Readonly<Record<string, unknown>>} | Record<string, never>;

type UnwrapArray<Value> = Value extends readonly (infer Item)[] ? NonNullable<Item> : Value;

type SnippetTarget<Value> = UnwrapArray<NonNullable<Value>>;

/**
 * True when every key in `Spec`, including nested `keys` blocks, exists on `Value`.
 * An array field is checked against its element type.
 */
type SnippetKeysFit<Value, Spec> =
    Spec extends {readonly keys: infer Nested}
        ? Nested extends Record<string, unknown>
            ? SnippetTarget<Value> extends object
                ? keyof Nested extends keyof SnippetTarget<Value>
                    ? {
                        [K in keyof Nested]: SnippetKeysFit<SnippetTarget<Value>[K & keyof SnippetTarget<Value>], Nested[K]>
                    }[keyof Nested] extends true
                        ? true
                        : false
                    : false
                : false
            : false
        : true;

type EntityInvalidKeys<Entity, Keys> = {
    [K in keyof Keys]: K extends keyof Entity
        ? SnippetKeysFit<Entity[K], Keys[K]> extends true
            ? never
            : K
        : K;
}[keyof Keys];

/**
 * When allowlist keys are not exactly the Armonia wire keys, resolves to a
 * branded error object so `tsc` / the IDE report the mismatch instead of `never`.
 */
type WireKeyMismatch<Wire, Keys> =
    [Exclude<keyof Wire, keyof Keys>] extends [never]
        ? [Exclude<keyof Keys, keyof Wire>] extends [never]
            ? never
            : {
                "[Snippet type error]": "Allowlist has keys that are not on the Armonia wire type";
                extraKeys: Exclude<keyof Keys, keyof Wire>;
              }
        : {
            "[Snippet type error]": "Allowlist keys must exactly match the Armonia wire type";
            missingFromSnippet: Exclude<keyof Wire, keyof Keys>;
            extraOnSnippet: Exclude<keyof Keys, keyof Wire>;
          };

/** Keys must exist on `I*` (including nested `keys` / nested snippet consts). */
type EntityKeyMismatch<Entity, Keys> =
    [EntityInvalidKeys<Entity, Keys>] extends [never]
        ? never
        : {
            "[Snippet type error]": "Allowlist keys must exist on the Maestro document (I*) / nested keys must fit";
            invalidKeys: EntityInvalidKeys<Entity, Keys>;
          };

/** Prefer the wire mismatch message when both fire. */
type SnippetArgError<Entity, Wire, Keys> =
    WireKeyMismatch<Wire, Keys> extends infer W
        ? [W] extends [never]
            ? EntityKeyMismatch<Entity, Keys>
            : W
        : never;

/**
 * Builds a ref allowlist whose keys must exist on a Maestro document (`I*`)
 * and whose top-level keys must match an Armonia wire type.
 *
 * Mismatches are a compile-time error (branded `[Snippet type error]`), not a
 * runtime throw — TypeScript types are erased before Node starts.
 *
 * @example
 * defineSnippet<IChannel, ChannelSimple>()({ keys: { _id: {}, name: {} } })
 */
export function defineSnippet<Entity, Wire>() {
    return <Keys extends Record<string, SnippetKeyValue>>(
        ...args: [SnippetArgError<Entity, Wire, Keys>] extends [never]
            ? [{keys: Keys}]
            : [SnippetArgError<Entity, Wire, Keys>]
    ) => (args as [{keys: Keys}])[0];
}
