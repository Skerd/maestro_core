/** "Street 1, 8000 Zurich" from an address whose city is populated (or omitted). */
export function formatPostalAddress(address: {street?: string; postalCode?: string; city?: unknown} | undefined): string | undefined {
    if (!address) return undefined;
    const city = (address.city as {name?: string} | undefined)?.name;
    const locality = [address.postalCode, city].filter(Boolean).join(" ");
    const text = [address.street, locality].filter(Boolean).join(", ");
    return text || undefined;
}
