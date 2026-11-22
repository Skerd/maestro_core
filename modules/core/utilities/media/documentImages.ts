import {execFile} from 'child_process';
import {promises as fs} from 'fs';
import os from 'os';
import path from 'path';
import {randomUUID} from 'crypto';
import sharp from 'sharp';

/** Longest one Ghostscript run may take before the document counts as unreadable. */
const GHOSTSCRIPT_TIMEOUT_MS = 30_000;
/** PDF pages are rendered small: the check scales every picture to 224×224 anyway. */
const PDF_PAGE_DPI = 48;
/** Pictures smaller than this on both sides are icons and bullets, not photos. */
const MIN_PICTURE_SIDE = 64;

/**
 * The document cannot be checked: a PDF Ghostscript cannot render (broken or password protected), an Office file that
 * is not a readable zip, or a 97-2003 Office file, whose pictures sit in a binary format the check does not read.
 * Recorded as not checked; trying again will not help.
 */
export class UnreadableDocumentError extends Error {}

/** Pictures of Office Open XML (`word|xl|ppt/media/`) and OpenDocument (`Pictures/`) files. */
const OFFICE_PICTURE = /^((word|xl|ppt)\/media|Pictures)\/[^/]+\.(png|jpe?g|gif|bmp|tiff?|webp)$/i;

/** The pictures of a .docx/.xlsx/.pptx or OpenDocument file, largest first, icons left out. */
async function officePictures(document: Buffer, max: number): Promise<Buffer[]> {
    let entries: {entryName: string; getData(): Buffer}[];
    try {
        const AdmZip = require('adm-zip');
        entries = new AdmZip(document).getEntries();
    } catch (error) {
        throw new UnreadableDocumentError(`not a readable Office file: ${error instanceof Error ? error.message : String(error)}`);
    }
    const pictures = entries.filter((entry) => OFFICE_PICTURE.test(entry.entryName)).map((entry) => entry.getData())
        .sort((a, b) => b.length - a.length);
    const kept: Buffer[] = [];
    for (const picture of pictures) {
        if (kept.length >= max) break;
        const {width = 0, height = 0} = await sharp(picture).metadata().catch(() => ({width: 0, height: 0}));
        if (width >= MIN_PICTURE_SIDE || height >= MIN_PICTURE_SIDE) kept.push(picture);
    }
    return kept;
}

/** The first `max` pages of a PDF, rendered by Ghostscript in its sandbox (`-dSAFER`) as PNGs. */
async function pdfPages(document: Buffer, max: number): Promise<Buffer[]> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `moderation-${randomUUID()}-`));
    try {
        const input = path.join(dir, 'document.pdf');
        await fs.writeFile(input, document);
        await new Promise<void>((resolve, reject) => {
            execFile('gs', [
                '-dSAFER', '-dBATCH', '-dNOPAUSE', '-q',
                '-sDEVICE=png16m', `-r${PDF_PAGE_DPI}`, '-dFirstPage=1', `-dLastPage=${max}`, '-dUseCropBox',
                `-sOutputFile=${path.join(dir, 'page-%d.png')}`, input,
            ], {timeout: GHOSTSCRIPT_TIMEOUT_MS}, (error, _stdout, stderr) => {
                if (!error) return resolve();
                const message = `gs failed: ${error.message} ${String(stderr).slice(0, 300)}`;
                // A numeric exit code means Ghostscript ran and refused the file; a missing program or a timeout is the server's.
                reject(typeof error.code === 'number' && !error.killed ? new UnreadableDocumentError(message) : new Error(message));
            });
        });
        const pages = (await fs.readdir(dir)).filter((name) => /^page-\d+\.png$/.test(name))
            .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
        if (pages.length === 0) throw new UnreadableDocumentError('Ghostscript rendered no page');
        return Promise.all(pages.map((name) => fs.readFile(path.join(dir, name))));
    } finally {
        await fs.rm(dir, {recursive: true, force: true}).catch(() => undefined);
    }
}

/**
 * The pictures of a document for the content check (D177): a PDF's first `max` pages, rendered, or the pictures inside
 * a .docx/.xlsx/.pptx. Throws `UnreadableDocumentError` for a document it cannot read, a plain error when Ghostscript
 * is missing or times out.
 */
export async function documentImages(document: Buffer, max: number): Promise<Buffer[]> {
    if (document.subarray(0, 5).toString('latin1') === '%PDF-') return pdfPages(document, max);
    if (document.subarray(0, 2).toString('latin1') === 'PK') return officePictures(document, max);
    throw new UnreadableDocumentError('a 97-2003 Office file: its pictures are not checked');
}
