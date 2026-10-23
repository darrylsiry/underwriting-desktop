// Shared one-column PDF layout for issued documents (quote, binder, policy) on
// pdf-lib's standard Helvetica: headings, label/value rows, wrapped paragraphs,
// page breaks with a footer on every page.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export const PAGE = { w: 612, h: 792, margin: 54 };
export const INK = rgb(0.06, 0.09, 0.16);
export const MUTED = rgb(0.39, 0.45, 0.55);
export const RULE = rgb(0.85, 0.88, 0.92);
export const ACCENT = rgb(0.31, 0.27, 0.9);

export const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
export const usDate = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
};

/** Standard PDF fonts only encode WinAnsi; replace anything else so drawing never throws. */
export function pdfSafe(text: string): string {
  return text
    .replace(/[‐-‒]/g, "-")
    .replace(/[→]/g, "->")
    .replace(/[^\x20-\x7E -ÿ–—‘’“”•…€]/g, "?");
}

export class Writer {
  page!: PDFPage;
  y = 0;
  constructor(private doc: PDFDocument, private font: PDFFont, private bold: PDFFont, private footer: string) {
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([PAGE.w, PAGE.h]);
    this.y = PAGE.h - PAGE.margin;
    this.page.drawText(pdfSafe(this.footer), { x: PAGE.margin, y: 28, size: 7, font: this.font, color: MUTED });
  }

  ensure(space: number) {
    if (this.y - space < PAGE.margin) this.newPage();
  }

  text(s: string, opts: { x?: number; size?: number; bold?: boolean; color?: typeof INK; right?: number } = {}) {
    const size = opts.size ?? 9.5;
    const font = opts.bold ? this.bold : this.font;
    const t = pdfSafe(s);
    const x = opts.right !== undefined ? opts.right - font.widthOfTextAtSize(t, size) : opts.x ?? PAGE.margin;
    this.page.drawText(t, { x, y: this.y, size, font, color: opts.color ?? INK });
  }

  /** Word-wrapped paragraph; returns after moving y below it. */
  para(s: string, opts: { x?: number; width?: number; size?: number; color?: typeof INK; bold?: boolean } = {}) {
    const size = opts.size ?? 9.5;
    const font = opts.bold ? this.bold : this.font;
    const x = opts.x ?? PAGE.margin;
    const width = opts.width ?? PAGE.w - PAGE.margin - x;
    let line = "";
    for (const word of pdfSafe(s).split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        this.ensure(size + 3);
        this.page.drawText(line, { x, y: this.y, size, font, color: opts.color ?? INK });
        this.y -= size + 3;
        line = word;
      } else {
        line = next;
      }
    }
    if (line) {
      this.ensure(size + 3);
      this.page.drawText(line, { x, y: this.y, size, font, color: opts.color ?? INK });
      this.y -= size + 3;
    }
  }

  heading(s: string) {
    this.ensure(40);
    this.y -= 14;
    this.text(s.toUpperCase(), { size: 8, bold: true, color: ACCENT });
    this.y -= 5;
    this.page.drawLine({ start: { x: PAGE.margin, y: this.y }, end: { x: PAGE.w - PAGE.margin, y: this.y }, thickness: 0.6, color: RULE });
    this.y -= 13;
  }

  row(label: string, value: string, opts: { bold?: boolean } = {}) {
    this.ensure(14);
    this.text(label, { color: MUTED, bold: opts.bold });
    this.text(value, { right: PAGE.w - PAGE.margin, bold: opts.bold });
    this.y -= 14;
  }
}

export async function createDocument(meta: { title: string; subject: string; footer: string }): Promise<{ doc: PDFDocument; w: Writer }> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(meta.title));
  doc.setSubject(meta.subject);
  doc.setCreator("Underwriting Desktop");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { doc, w: new Writer(doc, font, bold, meta.footer) };
}

const RIGHT = PAGE.w - PAGE.margin;

/** Kicker and reference on the first line, big title, then subtitle with up to two right-aligned lines. */
export function masthead(w: Writer, m: { reference: string; title: string; subtitle: string; right: string[] }) {
  w.text("UNDERWRITING DESKTOP SPECIALTY", { size: 9, bold: true, color: ACCENT });
  w.text(m.reference, { right: RIGHT, size: 9, bold: true });
  w.y -= 20;
  w.text(m.title, { size: 18, bold: true });
  w.y -= 14;
  w.text(m.subtitle, { size: 9.5, color: MUTED });
  for (const line of m.right) {
    w.text(line, { right: RIGHT, size: 9.5, color: MUTED });
    w.y -= 12;
  }
  if (!m.right.length) w.y -= 12;
}

/** Two columns: named insured (left) and producer (right). */
export function parties(w: Writer, title: string, insured: string[], producer: string[]) {
  w.heading(title);
  const top = w.y;
  insured.forEach((line, i) => { w.text(line, { bold: i === 0 }); w.y -= 13; });
  const leftBottom = w.y;
  w.y = top;
  producer.forEach((line, i) => { w.text(line, { x: 330, bold: i === 0 }); w.y -= 13; });
  w.y = Math.min(leftBottom, w.y);
}

export function premiumBlock(w: Writer, p: { premium: number; policyFee: number; surplusLinesTax: number; surplusLinesTaxRate: number; homeState: string; total: number }) {
  w.row("Premium", money(p.premium));
  w.row("Policy fee", money(p.policyFee));
  w.row(`Surplus lines tax and fees (${p.homeState}, ${(p.surplusLinesTaxRate * 100).toFixed(2)}%)`, money(p.surplusLinesTax));
  w.page.drawLine({ start: { x: 380, y: w.y + 10 }, end: { x: RIGHT, y: w.y + 10 }, thickness: 0.6, color: RULE });
  w.y -= 2;
  w.row("Total", money(p.total), { bold: true });
}

export function surplusLinesNotice(w: Writer) {
  w.heading("Surplus lines notice");
  w.para("This insurance is placed with an insurer not licensed in the insured's home state and is not protected by "
    + "the state insurance guaranty fund. Surplus lines tax is the responsibility of the surplus lines licensee.",
    { size: 8, color: MUTED });
}
