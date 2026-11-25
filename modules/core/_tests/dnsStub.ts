/**
 * Fake DNS for tests of code behind the outbound URL guard (`utilities/security/publicUrl.ts`): tests never resolve
 * real names. Restore it with `vi.restoreAllMocks()`.
 */
import {vi} from "vitest";
import dns, {type LookupAddress} from "dns";

/** Makes the resolver answer each list in turn (`{all: true}` lookups), the last one from then on. */
export function resolveTo(...answers: LookupAddress[][]) {
    const answer = (addresses: LookupAddress[]) => (...args: unknown[]) => {
        const callback = args[args.length - 1];
        if (typeof callback === "function") callback(null, addresses);
    };
    const spy = vi.spyOn(dns, "lookup").mockImplementation(answer(answers[answers.length - 1]));
    for (const addresses of answers.slice(0, -1)) spy.mockImplementationOnce(answer(addresses));
    return spy;
}

/** A public address, for names a test wants allowed. */
export const PUBLIC_ADDRESS: LookupAddress = {address: "93.184.216.34", family: 4};
