/**
 * Outbound URL guard (SSRF): the server connects only to public internet addresses when a company, a visitor or a
 * crawled page chose the URL. Loopback, private, link-local, shared (CGNAT), multicast and reserved ranges are
 * refused, in IPv4 and in every IPv6 form that reaches an IPv4 address (mapped, compatible, NAT64, 6to4).
 *
 * Check a URL with `assertSafePublicHttpUrl` (or `assertPublicUrl` in a request, for a localized error) before every
 * request and every redirect hop: a host can be re-pointed after it was saved. A client that takes a `lookup`
 * (node `http`/`https`, an `http.Agent`) also connects with `publicOnlyLookup`, so the address checked is the one
 * connected to (no DNS rebinding between the check and the connect).
 */
import dns, {type LookupAddress} from "dns";
import net, {type LookupFunction} from "net";
import {apiValidationException} from "armonia/src/modules/core/helpers/exceptions";

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);
const BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal"];

/** IPv4 ranges the server must never reach: private, loopback, link-local, shared (CGNAT), benchmarking, multicast, reserved. */
const BLOCKED_IPV4_RANGES: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
];

function ipv4ToInt(ip: string): number {
    return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
    const n = ipv4ToInt(ip);
    return BLOCKED_IPV4_RANGES.some(([base, bits]) => {
        const mask = (~0 << (32 - bits)) >>> 0;
        return ((n & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
    });
}

/** The eight 16-bit groups of a valid IPv6 address (`::` expanded, a dotted IPv4 tail turned into two groups). */
function ipv6Groups(ip: string): number[] {
    let address = ip.toLowerCase().split("%")[0];
    const lastColon = address.lastIndexOf(":");
    const tail = address.slice(lastColon + 1);
    if (net.isIPv4(tail)) {
        const n = ipv4ToInt(tail);
        address = `${address.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
    }
    const [head, rest] = address.split("::");
    const headGroups = head ? head.split(":") : [];
    const restGroups = rest ? rest.split(":") : [];
    const zeros = rest === undefined ? [] : Array<string>(8 - headGroups.length - restGroups.length).fill("0");
    return [...headGroups, ...zeros, ...restGroups].map((group) => parseInt(group, 16));
}

function isBlockedIpv6(ip: string): boolean {
    const g = ipv6Groups(ip);
    const v4 = (high: number, low: number) => `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
    const zeroUpTo = (end: number) => g.slice(0, end).every((group) => group === 0);
    if (zeroUpTo(8)) return true; // ::
    if (zeroUpTo(7) && g[7] === 1) return true; // ::1
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) reach the IPv4 address inside
    if (zeroUpTo(5) && (g[5] === 0xffff || g[5] === 0)) return isBlockedIpv4(v4(g[6], g[7]));
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((group) => group === 0)) return isBlockedIpv4(v4(g[6], g[7])); // NAT64
    if (g[0] === 0x2002) return isBlockedIpv4(v4(g[1], g[2])); // 6to4
    if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
    if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local fec0::/10
    return (g[0] & 0xff00) === 0xff00; // multicast ff00::/8
}

/** Whether the server must not connect to this address; anything that is not an IP address counts as blocked. */
export function isBlockedIp(ip: string): boolean {
    const version = net.isIP(ip);
    if (version === 4) return isBlockedIpv4(ip);
    if (version === 6) return isBlockedIpv6(ip);
    return true;
}

/** The URL's host without the brackets of an IPv6 literal (`[::1]` → `::1`). */
function bareHostname(url: URL): string {
    return url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

/** Every address of a host, from the same resolver the connection uses. */
function lookupAll(hostname: string): Promise<LookupAddress[]> {
    return new Promise((resolve, reject) => {
        dns.lookup(hostname, {all: true, verbatim: true}, (error, addresses) => (error ? reject(error) : resolve(addresses)));
    });
}

/**
 * The parsed URL when it is http(s), carries no credentials and its host is public: an IP literal outside the
 * blocked ranges, or a name whose every address is. Throws an `Error` naming the reason otherwise; a name that does
 * not resolve throws the resolver's error.
 */
export async function assertSafePublicHttpUrl(rawUrl: string): Promise<URL> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error("Invalid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Only http/https URLs are allowed");
    }
    if (parsed.username || parsed.password) {
        throw new Error("URLs with credentials are not allowed");
    }
    const hostname = bareHostname(parsed);
    if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
        throw new Error("Blocked hostname");
    }
    if (net.isIP(hostname)) {
        if (isBlockedIp(hostname)) throw new Error("Private/link-local IP blocked");
        return parsed;
    }
    const records = await lookupAll(hostname);
    if (!records.length) throw new Error("DNS lookup failed");
    for (const record of records) {
        if (isBlockedIp(record.address)) {
            throw new Error(`Blocked private IP resolution for ${hostname}`);
        }
    }
    return parsed;
}

/**
 * `assertSafePublicHttpUrl` for a request: any refusal, a name that does not resolve included, answers
 * `url_not_public` on `field` in the caller's language.
 */
export async function assertPublicUrl(rawUrl: string, field: string, languageCode: string): Promise<URL> {
    try {
        return await assertSafePublicHttpUrl(rawUrl);
    } catch {
        throw apiValidationException("url_not_public", field, null, languageCode);
    }
}

/**
 * A resolver to connect with: it fails (`EBLOCKEDADDRESS`) when any address of the host is not public, so the
 * connection uses an address checked at connect time. A host that answers a public address to the first check and a
 * private one to the connect (DNS rebinding) is refused. Node skips the resolver for an IP literal, so a URL (and
 * every redirect target) still goes through `assertSafePublicHttpUrl`.
 */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
    dns.lookup(hostname, {family: options.family, hints: options.hints, all: true, verbatim: true}, (error, addresses) => {
        if (error) return callback(error, "", 0);
        if (addresses.length === 0 || addresses.some((record) => isBlockedIp(record.address))) {
            const blocked: NodeJS.ErrnoException = new Error(`Blocked private IP resolution for ${hostname}`);
            blocked.code = "EBLOCKEDADDRESS";
            return callback(blocked, "", 0);
        }
        if (options.all) return callback(null, addresses);
        callback(null, addresses[0].address, addresses[0].family);
    });
};
