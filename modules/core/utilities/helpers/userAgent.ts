import {UAParser} from "ua-parser-js";

/**
 * The browser and system a user agent names ("Chrome", "macOS"), each only when the parser recognises it. Sign-in
 * notices and session cards name a device by them instead of the raw user agent or the IP (TD-B237, TD-F119).
 */
export function browserAndSystem(userAgent: string | undefined | null): {browser?: string; os?: string} {
    const {browser, os} = new UAParser(userAgent ?? "").getResult();
    return {...(browser.name ? {browser: browser.name} : {}), ...(os.name ? {os: os.name} : {})};
}
