/**
 * Rounds a major-unit money amount to cents. Single rounding rule for every
 * module's totals (cart, checkout, POS, fiscalization, rental quotes) so stored
 * amounts match what the gateway charges (Stripe converts with the same Math.round).
 */
export function roundMoney(amount: number): number {
    return Math.round(amount * 100) / 100;
}
