import {Router, type Request, type Response} from "express";
import {PORTAL_INDEX_HTML_URL} from "@coreModule/environment";
import {getLogger} from "@coreModule/loggers/serverLog";
import {rateLimiter} from "@coreModule/utilities/middlewares/rateLimiter";
import {describePortalPage, type PortalBlogReader} from "@coreModule/domain/portal/portalPage";
import {isCrawler, renderPortalPage} from "@coreModule/domain/portal/portalPageHtml";
import {portalRobots, portalSitemap} from "@coreModule/domain/portal/portalSitemap";
import {inBlogScope, listPublicBlog, publicBlogSingle} from "@coreModule/api/auxiliary/public/blog";

/**
 * Portal pages for search engines and link previews (D181). The gateway sends a portal host's page requests here (the
 * original address in `X-Original-URI`), and `/robots.txt` and `/sitemap.xml`; any failure answers 503 and the gateway
 * then serves the app as it is, so a visitor never waits on this.
 * - GET /page        — the app's `index.html` with the page's head (and, for crawlers, a plain copy of its content)
 * - GET /robots.txt  — what crawlers may read on this host
 * - GET /sitemap.xml — every public page of this host
 *
 * @module modules/core/api/portal/portalPages
 */
export const basePath = "/api/portal";
export const router = Router();

const blog: PortalBlogReader = {scope: inBlogScope, list: listPublicBlog, single: publicBlogSingle};

const PAGE_CACHE_MS = 60 * 1000;
const PAGE_CACHE_MAX = 500;
const SITEMAP_CACHE_MS = 10 * 60 * 1000;
const pageCache = new Map<string, {at: number; html: string}>();
const sitemapCache = new Map<string, {at: number; xml: string}>();
let template: {at: number; html: Promise<string>} | null = null;

/** The app's built page, fetched from its own server and kept a minute (a new deploy shows within it). */
function appTemplate(): Promise<string> {
    if (!PORTAL_INDEX_HTML_URL) return Promise.reject(new Error("PORTAL_INDEX_HTML_URL is not set"));
    if (template && Date.now() - template.at < PAGE_CACHE_MS) return template.html;
    const html = fetch(PORTAL_INDEX_HTML_URL).then(async (response) => {
        if (!response.ok) throw new Error(`The portal app answered ${response.status}`);
        const page = await response.text();
        // An error page from a restarting server is not the app: never fill (or keep) it.
        if (!/<div id="root"><\/div>/i.test(page)) throw new Error("The portal app's page has no root element");
        return page;
    });
    template = {at: Date.now(), html};
    html.catch(() => {
        template = null;
    });
    return html;
}

/** The host, address and language the visitor asked with, as the gateway passes them on. */
function visitor(req: Request): {host: string; baseUrl: string; languageCode: string} {
    const hostWithPort = (req.get("x-forwarded-host") || req.get("host") || "").split(",")[0].trim().toLowerCase();
    const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
    // The first language the visitor's browser asks for; the page text falls back to English.
    const languageCode = (req.get("accept-language") || "en-US").split(",")[0].split(";")[0].trim() || "en-US";
    return {host: hostWithPort.split(":")[0], baseUrl: `${proto}://${hostWithPort}`, languageCode};
}

function remember<Entry>(cache: Map<string, Entry>, key: string, entry: Entry): void {
    if (cache.size >= PAGE_CACHE_MAX) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, entry);
}

router.get("/page", rateLimiter({windowMs: 60000, max: 300}), (req: Request, res: Response) => {
    void servePage(req, res);
});

async function servePage(req: Request, res: Response): Promise<void> {
    const logger = getLogger(req.originalUrl);
    try {
        const path = req.get("x-original-uri") || String(req.query.path ?? "/");
        if (!path.startsWith("/") || path.startsWith("//")) {
            res.status(400).end();
            return;
        }
        const {host, baseUrl, languageCode} = visitor(req);
        const withCopy = isCrawler(req.get("user-agent"));
        const key = `${baseUrl}|${path}|${languageCode}|${withCopy}`;
        const cached = pageCache.get(key);
        let html = cached && Date.now() - cached.at < PAGE_CACHE_MS ? cached.html : null;
        if (!html) {
            const [page, shell] = await Promise.all([describePortalPage({host, baseUrl, path, languageCode, logger}, blog), appTemplate()]);
            if (!page) {
                res.status(503).end();
                return;
            }
            html = renderPortalPage(shell, page, withCopy);
            remember(pageCache, key, {at: Date.now(), html});
        }
        res.status(200)
            .set("Content-Type", "text/html; charset=utf-8")
            // The app's own page is never cached by browsers either: a deploy must reach visitors at once.
            .set("Cache-Control", "no-cache")
            .set("Vary", "User-Agent, Accept-Language")
            .send(html);
    } catch (error) {
        logger.warn(`Portal page head failed, the gateway serves the app as it is: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) res.status(503).end();
    }
}

router.get("/robots.txt", rateLimiter({windowMs: 60000, max: 60}), (req: Request, res: Response) => {
    res.status(200).set("Content-Type", "text/plain; charset=utf-8").send(portalRobots(visitor(req).baseUrl));
});

router.get("/sitemap.xml", rateLimiter({windowMs: 60000, max: 30}), (req: Request, res: Response) => {
    void serveSitemap(req, res);
});

async function serveSitemap(req: Request, res: Response): Promise<void> {
    const logger = getLogger(req.originalUrl);
    try {
        const {host, baseUrl, languageCode} = visitor(req);
        const cached = sitemapCache.get(baseUrl);
        let xml = cached && Date.now() - cached.at < SITEMAP_CACHE_MS ? cached.xml : null;
        if (!xml) {
            xml = await portalSitemap({host, baseUrl, languageCode, logger}, blog);
            if (!xml) {
                res.status(404).end();
                return;
            }
            remember(sitemapCache, baseUrl, {at: Date.now(), xml});
        }
        res.status(200).set("Content-Type", "application/xml; charset=utf-8").send(xml);
    } catch (error) {
        logger.warn(`Portal sitemap failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) res.status(503).end();
    }
}
