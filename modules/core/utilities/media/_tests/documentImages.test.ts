import {describe, expect, it} from "vitest";
import AdmZip from "adm-zip";
import sharp from "sharp";
import {PDFDocument} from "pdf-lib";
import {documentImages, UnreadableDocumentError} from "@coreModule/utilities/media/documentImages";

const picture = (side: number, color = "#cc3355") =>
    sharp({create: {width: side, height: side, channels: 3, background: color}}).png().toBuffer();

/** A PDF of `pages` pages, the first with a photo-sized picture on it. */
async function pdfWithPicture(pages: number): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    const image = await pdf.embedPng(await picture(300));
    for (let index = 0; index < pages; index++) {
        const page = pdf.addPage([400, 400]);
        if (index === 0) page.drawImage(image, {x: 50, y: 50, width: 300, height: 300});
    }
    return Buffer.from(await pdf.save());
}

function zipOf(entries: Record<string, Buffer | string>): Buffer {
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(entries)) zip.addFile(name, typeof content === "string" ? Buffer.from(content) : content);
    return zip.toBuffer();
}

describe("documentImages (D177)", () => {
    it("renders a PDF's first pages, no more than asked", async () => {
        const pages = await documentImages(await pdfWithPicture(3), 2);
        expect(pages).toHaveLength(2);
        const {width, height} = await sharp(pages[0]).metadata();
        expect(width).toBeGreaterThan(100);
        expect(height).toBeGreaterThan(100);
        // The picture is on the first page: it is not blank.
        const {channels} = await sharp(pages[0]).stats();
        expect(channels[1].mean).toBeLessThan(250);
    });

    it("takes the pictures inside Office and OpenDocument files, largest first, icons left out", async () => {
        const docx = zipOf({
            "[Content_Types].xml": "<Types/>",
            "word/document.xml": "<w:document/>",
            "word/media/image1.png": await picture(16),
            "word/media/image2.png": await picture(200),
            "word/media/image3.png": await picture(120),
        });
        const pictures = await documentImages(docx, 10);
        expect(await Promise.all(pictures.map(async (p) => (await sharp(p).metadata()).width))).toEqual([200, 120]);

        const odt = zipOf({mimetype: "application/vnd.oasis.opendocument.text", "content.xml": "<office/>", "Pictures/photo.png": await picture(150)});
        expect(await documentImages(odt, 10)).toHaveLength(1);
        expect(await documentImages(zipOf({"word/document.xml": "<w:document/>"}), 10)).toEqual([]);
    });

    it("cannot read a broken PDF or a 97-2003 Office file", async () => {
        await expect(documentImages(Buffer.from("%PDF-1.4 not really a pdf"), 2)).rejects.toBeInstanceOf(UnreadableDocumentError);
        const ole = Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(504)]);
        await expect(documentImages(ole, 2)).rejects.toBeInstanceOf(UnreadableDocumentError);
    });
});
