/**
 * Renders every transactional email to a PNG so the templates can be reviewed
 * without sending mail.
 *
 * It drives the real notifiers (`sendSignUpMail`, `sendReservationClientMail`, …)
 * and intercepts `sendMail`, so what you see is byte-for-byte what production
 * would deliver — no second copy of the placeholder wiring to drift out of sync.
 *
 * Usage (from `maestro/`):
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     modules/core/utilities/emails/test/renderEmailPreviews.ts [options]
 *
 * Options:
 *   --help                    print this usage summary
 *   --list                    print the modules, locales and cases available to render
 *   --languages=en-US,de-CH   locales to render (default: all supported; `all` is explicit)
 *   --modules=core,eCommerce  modules to render (default: all)
 *   --only=reservation        substring filter on the case name
 *   --width=680               viewport width in px (default 680; try 400 for mobile)
 *   --max-height=6000         tall viewport used before trimming (default 6000)
 *   --out=<dir>               output root (default: maestro/_temp/emails)
 *   --html                    also keep the rendered .html next to each .png
 *   --chrome=<path>           Chrome/Chromium binary (default: $CHROME_BIN or a known location)
 *
 * Images are grouped as `<out>/<module>/<locale>/<case>.png`.
 *
 * Screenshots need Chrome or Chromium. Bottom whitespace is trimmed with Pillow
 * (`python3 -m pip install pillow`); without it the images are simply untrimmed.
 */

import {execFileSync} from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {CLIENT_SIDE, CONSTANTS, EMAIL} from "@coreModule/environment";
import * as mailDeliveryService from "@coreModule/utilities/emails/mailDeliveryService";
import * as reservationContractAttachment from "@propertyManagement/utilities/emails/reservationContractAttachment";
import {resolveEmailLocaleTag, type EmailLocaleTag} from "../emailLocale";
import {buildPreviewCases, type PreviewCase, type PreviewModule} from "./emailPreviewCases";

const ALL_LOCALES: EmailLocaleTag[] = ["en-US", "sq-AL", "de-CH", "fr-FR", "it-IT"];
const ALL_MODULES: PreviewModule[] = ["core", "propertyManagement", "eCommerce"];

/** `maestro/_temp/emails` — `_temp` is git-ignored, so previews never land in a commit. */
const DEFAULT_OUT_DIR = path.resolve(__dirname, "..", "..", "..", "..", "..", "_temp", "emails");

const CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
];

const USAGE = `Render every transactional email to a PNG.

Usage (from maestro/):
  npm run preview:emails -- [options]

Options:
  --help                    print this usage summary
  --list                    print the modules, locales and cases available to render
  --languages=en-US,de-CH   locales to render (default: all; "all" is explicit)
  --modules=core,eCommerce  modules to render (default: all)
  --only=reservation        substring filter on the case name
  --width=680               viewport width in px (default 680; try 400 for mobile)
  --max-height=6000         tall viewport used before trimming (default 6000)
  --out=<dir>               output root (default: maestro/_temp/emails)
  --html                    also keep the rendered .html next to each .png
  --chrome=<path>           Chrome/Chromium binary (default: $CHROME_BIN or a known location)

Images are grouped as <out>/<module>/<locale>/<case>.png`;

function printList(): void {
    const cases = buildPreviewCases();
    console.log(`Locales (--languages):\n  ${ALL_LOCALES.join("\n  ")}\n`);
    console.log("Modules (--modules) and their cases (--only):");
    for (const module of ALL_MODULES) {
        const names = cases.filter((c) => c.module === module).map((c) => c.name);
        console.log(`\n  ${module}  (${names.length} case${names.length === 1 ? "" : "s"})`);
        for (const name of names) {
            console.log(`    ${name}`);
        }
    }
    console.log(`\nTotal: ${cases.length} case(s) x ${ALL_LOCALES.length} locale(s) = ${cases.length * ALL_LOCALES.length} image(s).`);
}

type Options = {
    languages: string[];
    modules: PreviewModule[];
    only?: string;
    width: number;
    maxHeight: number;
    outDir: string;
    keepHtml: boolean;
    chrome?: string;
};

function parseArgs(argv: string[]): Options {
    const get = (name: string): string | undefined => {
        const hit = argv.find((a) => a.startsWith(`--${name}=`));
        return hit?.slice(name.length + 3);
    };

    const languagesRaw = get("languages");
    const languages =
        !languagesRaw || languagesRaw === "all"
            ? [...ALL_LOCALES]
            : languagesRaw.split(",").map((l) => l.trim()).filter(Boolean);

    const modulesRaw = get("modules");
    const modules =
        !modulesRaw || modulesRaw === "all"
            ? [...ALL_MODULES]
            : (modulesRaw.split(",").map((m) => m.trim()).filter(Boolean) as PreviewModule[]);

    const unknownModule = modules.find((m) => !ALL_MODULES.includes(m));
    if (unknownModule) {
        throw new Error(`Unknown module "${unknownModule}". Expected one of: ${ALL_MODULES.join(", ")}. Run with --list to see everything available.`);
    }

    const unknownLanguage = languages.find((l) => !ALL_LOCALES.includes(l as EmailLocaleTag));
    if (unknownLanguage) {
        throw new Error(
            `Unknown language "${unknownLanguage}". Expected one of: ${ALL_LOCALES.join(", ")}. ` +
                "Run with --list to see everything available."
        );
    }

    return {
        languages,
        modules,
        only: get("only"),
        width: Number(get("width") ?? 680),
        maxHeight: Number(get("max-height") ?? 6000),
        outDir: path.resolve(get("out") ?? DEFAULT_OUT_DIR),
        keepHtml: argv.includes("--html"),
        chrome: get("chrome"),
    };
}

function resolveChrome(explicit?: string): string {
    const candidates = [explicit, process.env.CHROME_BIN, ...CHROME_CANDIDATES].filter(Boolean) as string[];
    const found = candidates.find((c) => fs.existsSync(c));
    if (!found) {
        throw new Error(
            "Could not find Chrome or Chromium. Pass --chrome=<path> or set CHROME_BIN.\nLooked in:\n  " +
                candidates.join("\n  ")
        );
    }
    return found;
}

/** Captured `sendMail` arguments for the notifier call currently in flight. */
type CapturedMail = {
    subject: string;
    html: string;
    attachments: {filename?: string; cid?: string; path?: string; content?: Buffer; contentType?: string}[];
};

let captured: CapturedMail | null = null;

function installStubs(): void {
    // The notifiers bail out unless mail is enabled, and read branding from env.
    (EMAIL as {ENABLED: boolean}).ENABLED = true;
    CLIENT_SIDE.NAME = CLIENT_SIDE.NAME || "Arpeggio";
    CLIENT_SIDE.HOST = CLIENT_SIDE.HOST || "https://app.arpeggio.example";
    CONSTANTS.DEFAULT_LANGUAGE = CONSTANTS.DEFAULT_LANGUAGE || "en-US";

    // Capture instead of delivering.
    (mailDeliveryService as {sendMail: unknown}).sendMail = async (
        _companyId: unknown,
        options: {subject?: string; html?: string; attachments?: CapturedMail["attachments"]}
    ): Promise<void> => {
        captured = {
            subject: options.subject ?? "",
            html: options.html ?? "",
            attachments: options.attachments ?? [],
        };
    };

    // Contract lookups hit GridFS; previews stand in a fake PDF so the
    // "contract attached" note renders for the kinds that carry one.
    (reservationContractAttachment as {tryLoadReservationContractForEmail: unknown}).tryLoadReservationContractForEmail =
        async (): Promise<{filename: string; content: Buffer; contentType: string}> => ({
            filename: "contract.pdf",
            content: Buffer.from("%PDF-1.4 preview placeholder"),
            contentType: "application/pdf",
        });
}

/**
 * Inline images are attached by CID, which a browser cannot resolve — swap each
 * `cid:` reference for a data URI so previews show the same artwork as the inbox.
 */
function inlineCidImages(html: string, attachments: CapturedMail["attachments"]): string {
    let result = html;
    for (const attachment of attachments) {
        if (!attachment.cid) {
            continue;
        }
        const content =
            attachment.content ?? (attachment.path && fs.existsSync(attachment.path) ? fs.readFileSync(attachment.path) : null);
        if (!content) {
            continue;
        }
        const mime = attachment.contentType ?? guessMimeType(attachment.path ?? attachment.filename ?? "");
        const dataUri = `data:${mime};base64,${content.toString("base64")}`;
        result = result.split(`cid:${attachment.cid}`).join(dataUri);
    }
    return result;
}

function guessMimeType(file: string): string {
    const ext = path.extname(file).toLowerCase();
    if (ext === ".png") return "image/png";
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".gif") return "image/gif";
    if (ext === ".svg") return "image/svg+xml";
    return "application/octet-stream";
}

function screenshot(
    chrome: string,
    htmlFile: string,
    pngFile: string,
    width: number,
    height: number
): void {
    execFileSync(
        chrome,
        [
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--force-device-scale-factor=1",
            "--no-sandbox",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-sync",
            "--disable-default-apps",
            "--mute-audio",
            `--window-size=${width},${height}`,
            `--screenshot=${pngFile}`,
            htmlFile,
        ],
        {stdio: "ignore"}
    );
}

const TRIM_SCRIPT = `
import sys
from PIL import Image
img = Image.open(sys.argv[1]).convert("RGB")
width, height = img.size
background = img.getpixel((1, height - 1))
pixels = img.load()
bottom = height
while bottom > 1:
    row = bottom - 1
    if any(pixels[x, row] != background for x in range(0, width, 3)):
        break
    bottom -= 1
bottom = min(height, bottom + 24)
if bottom < height:
    img.crop((0, 0, width, bottom)).save(sys.argv[1])
`;

/** Crops the dead background below the email. No Pillow → leave the image as-is. */
function trimBottom(pngFile: string, trimScriptFile: string | null): boolean {
    if (!trimScriptFile) {
        return false;
    }
    try {
        execFileSync("python3", [trimScriptFile, pngFile], {stdio: "ignore"});
        return true;
    } catch {
        return false;
    }
}

function prepareTrimScript(tmpDir: string): string | null {
    try {
        execFileSync("python3", ["-c", "import PIL"], {stdio: "ignore"});
    } catch {
        return null;
    }
    const file = path.join(tmpDir, "trimEmailPreview.py");
    fs.writeFileSync(file, TRIM_SCRIPT);
    return file;
}

async function renderCase(
    previewCase: PreviewCase,
    languageCode: string,
    options: Options,
    chrome: string,
    tmpDir: string,
    trimScriptFile: string | null
): Promise<{file: string; subject: string; trimmed: boolean}> {
    captured = null;
    await previewCase.send(languageCode);

    if (!captured) {
        throw new Error(`${previewCase.name} (${languageCode}) produced no email — the notifier returned without sending.`);
    }
    const mail: CapturedMail = captured;

    const leftovers = [...new Set([...mail.html.matchAll(/\{[a-zA-Z][a-zA-Z0-9]*\}/g)].map((m) => m[0]))];
    if (leftovers.length) {
        console.warn(`  ! ${previewCase.name} (${languageCode}) has unreplaced placeholders: ${leftovers.join(", ")}`);
    }

    const localeTag = resolveEmailLocaleTag(languageCode);
    const caseDir = path.join(options.outDir, previewCase.module, localeTag);
    fs.mkdirSync(caseDir, {recursive: true});

    const html = inlineCidImages(mail.html, mail.attachments);
    const htmlFile = options.keepHtml
        ? path.join(caseDir, `${previewCase.name}.html`)
        : path.join(tmpDir, `${previewCase.module}-${previewCase.name}-${localeTag}.html`);
    fs.writeFileSync(htmlFile, html);

    const pngFile = path.join(caseDir, `${previewCase.name}.png`);
    screenshot(chrome, htmlFile, pngFile, options.width, options.maxHeight);
    const trimmed = trimBottom(pngFile, trimScriptFile);

    return {file: pngFile, subject: mail.subject, trimmed};
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log(USAGE);
        return;
    }
    if (argv.includes("--list")) {
        printList();
        return;
    }

    const options = parseArgs(argv);
    const chrome = resolveChrome(options.chrome);

    installStubs();

    const cases = buildPreviewCases().filter(
        (c) => options.modules.includes(c.module) && (!options.only || c.name.includes(options.only))
    );
    if (cases.length === 0) {
        throw new Error("No preview cases matched the given --modules/--only filters. Run with --list to see what is available.");
    }

    fs.mkdirSync(options.outDir, {recursive: true});
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "email-previews-"));
    const trimScriptFile = prepareTrimScript(tmpDir);

    console.log(`Chrome:    ${chrome}`);
    console.log(`Output:    ${options.outDir}`);
    console.log(`Viewport:  ${options.width}px wide (trimming ${trimScriptFile ? "enabled" : "unavailable — install Pillow"})`);
    console.log(`Modules:   ${options.modules.join(", ")}`);
    console.log(`Locales:   ${options.languages.join(", ")}`);
    console.log(`Rendering: ${cases.length} email(s) x ${options.languages.length} locale(s)\n`);

    const index: {module: string; name: string; locale: string; subject: string; file: string}[] = [];
    let failures = 0;

    for (const languageCode of options.languages) {
        console.log(`${languageCode}`);
        for (const previewCase of cases) {
            try {
                const result = await renderCase(previewCase, languageCode, options, chrome, tmpDir, trimScriptFile);
                const relative = path.relative(options.outDir, result.file);
                index.push({
                    module: previewCase.module,
                    name: previewCase.name,
                    locale: resolveEmailLocaleTag(languageCode),
                    subject: result.subject,
                    file: relative,
                });
                console.log(`  ${relative.padEnd(64)} ${result.subject}`);
            } catch (err) {
                failures++;
                console.error(`  FAILED ${previewCase.module}-${previewCase.name}: ${(err as Error).message}`);
            }
        }
    }

    fs.writeFileSync(path.join(options.outDir, "index.json"), JSON.stringify(index, null, 2));
    fs.rmSync(tmpDir, {recursive: true, force: true});

    console.log(`\n${index.length} image(s) written to ${options.outDir}`);
    if (failures) {
        console.error(`${failures} case(s) failed.`);
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
