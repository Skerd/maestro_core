import {applyPlaceholders, type EmailStrings} from "@coreModule/utilities/emails/emailLocale";

/**
 * Shared building blocks for client emails (property management, car rental,
 * dental clinic) so they render with the same shell, palette and typography as
 * the core auth emails (`core/utilities/emails/templates/*`).
 */

export const EMAIL_FONT = "'Montserrat','Helvetica Neue',Helvetica,Arial,sans-serif";

export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export function currentYear(): string {
    return new Date().getFullYear().toString();
}

/**
 * Layout slots every client template shares. `headingKey`/`preheaderKey`
 * select the per-notification copy (e.g. `headingCreated`, `preheaderReminder1`).
 */
export function layoutStrings(strings: EmailStrings, headingKey: string, preheaderKey: string): Record<string, string> {
    return {
        htmlLang: strings.htmlLang ?? "en",
        preheader: strings[preheaderKey] ?? "",
        heading: strings[headingKey] ?? "",
        ignore: strings.ignore ?? "",
        footerNote: strings.footerNote ?? "",
        copyright: strings.copyright ?? "",
    };
}

/** The highlighted strip used by the core templates for security/attachment notes. */
export function noteHtml(text: string): string {
    if (!text.trim()) {
        return "";
    }
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">
  <tr>
    <td style="padding:24px 0 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">
        <tr>
          <td bgcolor="#faf7f1" style="background-color:#faf7f1;border-left:3px solid #cca250;border-radius:0 8px 8px 0;padding:15px 18px;font-family:${EMAIL_FONT};font-size:13px;font-weight:400;line-height:170%;color:#6b5a3c;">${escapeHtml(
        text
    )}</td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

export type SummaryRow = {label: string; value: string};

/** A label/value card (reservation summary, sale summary, installment details). */
export function summaryCardHtml(title: string, rows: SummaryRow[]): string {
    if (rows.length === 0) {
        return "";
    }

    const rowHtml = rows
        .map((r, index) => {
            const border = index === rows.length - 1 ? "" : "border-bottom:1px solid #f2f3f5;";
            return `<tr>
            <td class="a-sum-label" style="padding:11px 0;${border}font-family:${EMAIL_FONT};font-size:13px;font-weight:400;line-height:160%;color:#8a9099;width:45%;vertical-align:top;">${escapeHtml(
                r.label
            )}</td>
            <td class="a-sum-value" style="padding:11px 0;${border}font-family:${EMAIL_FONT};font-size:14px;font-weight:600;line-height:160%;color:#111114;vertical-align:top;text-align:right;">${escapeHtml(
                r.value
            )}</td>
          </tr>`;
        })
        .join("");

    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">
  <tr>
    <td style="padding:24px 0 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border:1px solid #eceef1;border-radius:10px;">
        <tr>
          <td bgcolor="#f7f8fa" style="background-color:#f7f8fa;border-radius:10px 10px 0 0;padding:14px 20px;font-family:${EMAIL_FONT};font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;line-height:150%;color:#9aa0a8;">${escapeHtml(
        title
    )}</td>
        </tr>
        <tr>
          <td style="padding:4px 20px 14px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">${rowHtml}</table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

/** Adds a row only when the value has content. */
export function pushRow(rows: SummaryRow[], label: string | undefined, value: string | undefined | null): void {
    if (value?.trim()) {
        rows.push({label: label ?? "", value: value.trim()});
    }
}

/** Resolves `{key}` copy from the locale file, applying the given values. */
export function localized(strings: EmailStrings, key: string, values: Record<string, string> = {}): string {
    return applyPlaceholders(strings[key] ?? "", values);
}

/**
 * The gold call-to-action button of the core auth emails, followed by the plain
 * link for clients that block buttons. `url` must already be safe to put in an
 * attribute (built by the server, not typed by a user).
 */
export function ctaButtonHtml(label: string, url: string, fallbackLabel: string): string {
    const href = escapeHtml(url);
    return `<table role="presentation" class="a-btn" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">
  <tr>
    <td align="center" style="padding:32px 0 4px;">
      <!--[if mso]>
      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:50px;v-text-anchor:middle;width:300px;" arcsize="20%" stroke="f" fillcolor="#cca250">
        <w:anchorlock/>
        <center style="color:#111114;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${escapeHtml(label)}</center>
      </v:roundrect>
      <![endif]-->
      <!--[if !mso]><!-->
      <a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:16px 38px;font-family:${EMAIL_FONT};font-size:15px;font-weight:700;line-height:100%;color:#111114;text-decoration:none;background-color:#cca250;border-radius:10px;">${escapeHtml(label)}</a>
      <!--<![endif]-->
    </td>
  </tr>
</table>
<p style="margin:28px 0 0;font-family:${EMAIL_FONT};font-size:12px;font-weight:400;line-height:170%;color:#8a9099;">${escapeHtml(fallbackLabel)}</p>
<p style="margin:6px 0 0;font-family:${EMAIL_FONT};font-size:12px;line-height:170%;word-break:break-all;">
  <a href="${href}" target="_blank" rel="noopener" style="color:#b8873a;text-decoration:underline;">${href}</a>
</p>`;
}
