/**
 * The name a person is shown under in public, such as a review: the first name and the last name's initial ("Gent M.").
 * What someone booked or bought can itself be personal, so a public page never carries the full name (SEC-06).
 *
 * @module publicName
 */
export function publicPersonName(firstName: string, lastName: string): string {
    const initial = lastName.trim().charAt(0);
    return [firstName.trim(), initial ? `${initial.toUpperCase()}.` : ""].filter(Boolean).join(" ");
}
