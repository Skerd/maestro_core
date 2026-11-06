import {PDFDocument, PDFFont, PDFPage, StandardFonts, rgb} from "pdf-lib";

/** A4 in points, with the margin every generated document uses. */
export const PDF_PAGE = {width: 595, height: 842, margin: 40};

export const PDF_COLORS = {
    primary: rgb(0.12, 0.28, 0.53),
    text: rgb(0.1, 0.1, 0.1),
    muted: rgb(0.45, 0.45, 0.45),
    border: rgb(0.8, 0.82, 0.85),
    altRow: rgb(0.95, 0.96, 0.98),
};

/** The standard fonts only encode WinAnsi; anything else would throw, so it is replaced. */
export function safePdfText(text: string | number | undefined): string {
    return String(text ?? "").replace(/[^\x20-\x7E\xA0-\xFF€—–‘’“”•]/g, "?");
}

/** `decimals` is the currency's `decimalPlaces` (GLB-08): JPY prints none, KWD three. */
export function pdfMoney(amount: number, currency?: string, decimals = 2): string {
    const formatted = amount.toLocaleString("en-US", {minimumFractionDigits: decimals, maximumFractionDigits: decimals});
    return currency ? `${currency} ${formatted}` : formatted;
}

/** Splits text into lines that fit `width`. */
export function wrapPdfText(text: string, font: PDFFont, size: number, width: number): string[] {
    const lines: string[] = [];
    for (const paragraph of safePdfText(text).split(/\r?\n/)) {
        let current = "";
        for (const word of paragraph.split(" ")) {
            const next = current ? `${current} ${word}` : word;
            if (font.widthOfTextAtSize(next, size) > width && current) {
                lines.push(current);
                current = word;
            } else {
                current = next;
            }
        }
        lines.push(current);
    }
    return lines;
}

export type PdfFonts = {regular: PDFFont; bold: PDFFont};

export async function embedStandardFonts(doc: PDFDocument): Promise<PdfFonts> {
    return {regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold)};
}

/** Writes top to bottom, starting a new page when the next block does not fit. */
export class PdfWriter {
    page: PDFPage;
    y: number;

    constructor(private doc: PDFDocument, readonly fonts: PdfFonts) {
        this.page = doc.addPage([PDF_PAGE.width, PDF_PAGE.height]);
        this.y = PDF_PAGE.height - PDF_PAGE.margin;
    }

    ensure(height: number): void {
        if (this.y - height >= PDF_PAGE.margin) return;
        this.page = this.doc.addPage([PDF_PAGE.width, PDF_PAGE.height]);
        this.y = PDF_PAGE.height - PDF_PAGE.margin;
    }

    text(text: string, options: {x?: number; size?: number; bold?: boolean; color?: ReturnType<typeof rgb>} = {}): void {
        const size = options.size ?? 10;
        this.page.drawText(safePdfText(text), {
            x: options.x ?? PDF_PAGE.margin,
            y: this.y,
            size,
            font: options.bold ? this.fonts.bold : this.fonts.regular,
            color: options.color ?? PDF_COLORS.text,
        });
    }

    paragraph(text: string, size = 9, color = PDF_COLORS.muted): void {
        for (const line of wrapPdfText(text, this.fonts.regular, size, PDF_PAGE.width - PDF_PAGE.margin * 2)) {
            this.ensure(size + 4);
            this.text(line, {size, color});
            this.y -= size + 4;
        }
    }

    rule(thickness = 0.5): void {
        this.page.drawLine({start: {x: PDF_PAGE.margin, y: this.y}, end: {x: PDF_PAGE.width - PDF_PAGE.margin, y: this.y}, thickness, color: PDF_COLORS.border});
    }

    gap(height: number): void {
        this.y -= height;
    }
}
