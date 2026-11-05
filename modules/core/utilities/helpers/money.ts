import {Decimal128} from "mongodb";
import {DEFAULT_DECIMAL_PLACES, fromMinor} from "armonia/src/modules/core/helpers/money";

/**
 * Minor units (armonia's money helper, D35) as the `Decimal128` a schema stores: 1235n → Decimal128("12.35").
 * Reading goes the other way through `toMinor(decimal128)`, which takes its `toString()`.
 */
export function decimal128FromMinor(minor: bigint, decimals: number = DEFAULT_DECIMAL_PLACES): Decimal128 {
    return Decimal128.fromString(fromMinor(minor, decimals));
}
