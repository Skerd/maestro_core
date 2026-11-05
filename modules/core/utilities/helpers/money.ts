import {Decimal128} from "mongodb";
import {DEFAULT_DECIMAL_PLACES, fromMinor} from "armonia/src/modules/core/helpers/money";

/**
 * Minor units (armonia's money helper, D35) as the `Decimal128` a schema stores: 1235n → Decimal128("12.35").
 * Reading goes the other way through `toMinor(decimal128)`, which takes its `toString()`.
 */
export function decimal128FromMinor(minor: bigint, decimals: number = DEFAULT_DECIMAL_PLACES): Decimal128 {
    return Decimal128.fromString(fromMinor(minor, decimals));
}

/**
 * Rounds a major-unit money amount to cents. Single rounding rule for every
 * module's totals (cart, checkout, POS, fiscalization, rental quotes) so stored
 * amounts match what the gateway charges (Stripe converts with the same Math.round).
 *
 * @deprecated Float math (1.005 → 1.00). Use armonia's money helper (`toMinor`, `multiplyMinor`, `sumMinor`,
 * `roundToCurrency`); modules move off this one by one (D35).
 */
export function roundMoney(amount: number): number {
    return Math.round(amount * 100) / 100;
}
