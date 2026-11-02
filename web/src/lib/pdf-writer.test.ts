import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { PAGE, createDocument, parties, pdfSafe, wrapLines, type Writer } from "./pdf-writer.ts";
import { renderBinderPdf, subjectivitiesBlock, type PolicyDocument } from "./policy-pdf.ts";

const RIGHT = PAGE.w - PAGE.margin;   // 558: nothing an issued document prints may pass it

/** What gets drawn on the page: each string, where it starts and where it ends. */
async function recording() {
  const { doc, w } = await createDocument({ title: "t", subject: "s", footer: "f" });
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const drawn: { text: string; x: number; y: number; end: number; bold: boolean }[] = [];
  const real = w.page.drawText.bind(w.page);
  w.page.drawText = (text, o) => {
    const isBold = o?.font?.name === bold.name;
    drawn.push({ text, x: o!.x!, y: o!.y!, end: o!.x! + (isBold ? bold : regular).widthOfTextAtSize(text, o!.size!), bold: isBold });
    real(text, o);
  };
  return { w: w as Writer, drawn };
}

test("pdfSafe: line breaks and tabs read as a space, not a question mark (CR-046)", () => {
  assert.equal(pdfSafe("a\r\nb\tc"), "a b c");
  assert.equal(pdfSafe("line one \n\n  line two"), "line one line two");
  assert.equal(pdfSafe("91342  ·  Carpentry"), "91342  ·  Carpentry", "deliberate double spaces stay");
  assert.equal(pdfSafe("smile \u{1F600}, arrow →"), "smile ??, arrow ->", "what the fonts can't draw is still replaced");
});

test("wrapLines keeps every word and cuts only a word wider than the column", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const words = "Signed and dated application with a currently valued five year loss run";
  const lines = wrapLines(words, font, 9, 120);
  assert.ok(lines.length > 1);
  assert.equal(lines.join(" "), words);
  for (const l of lines) assert.ok(font.widthOfTextAtSize(l, 9) <= 120, l);
  const long = "hannah.lindqvist@copperstateinsurancegroup.example";
  const cut = wrapLines(long, font, 9.5, 120);
  assert.ok(cut.length > 1);
  assert.equal(cut.join(""), long);
  for (const l of cut) assert.ok(font.widthOfTextAtSize(l, 9.5) <= 120, l);
  assert.deepEqual(wrapLines("", font, 9, 120), []);
  assert.deepEqual(wrapLines("W", font, 9, 1), ["W"], "a column narrower than one letter still ends");
});

test("parties: long producer and insured lines stay inside their columns (CR-118)", async () => {
  const { w, drawn } = await recording();
  const insured = ["Consolidated Amalgamated Hill Country Finish Carpentry & Millwork Restoration Holdings LLC", "4410 Long Street Name Boulevard", "Austin, TX 78701"];
  const producer = ["Copper State Insurance Group of the Greater Southwest Brokerage", "Hannah Lindqvist", "hannah.lindqvist@copperstateinsurancegroup.example", "(201) 555-0110"];
  parties(w, "Named insured and producer", insured, producer);
  const body = drawn.filter((d) => d.text !== "NAMED INSURED AND PRODUCER");
  const left = body.filter((d) => d.x === PAGE.margin);
  const right = body.filter((d) => d.x === 330);
  assert.equal(left.length + right.length, body.length);
  for (const d of left) assert.ok(d.end <= 314.01, `left column: "${d.text}" ends at ${d.end}`);
  for (const d of right) assert.ok(d.end <= RIGHT + 0.01, `right column: "${d.text}" ends at ${d.end}`);
  assert.equal(right.map((d) => d.text).join("").replaceAll(" ", ""), producer.join("").replaceAll(" ", ""), "nothing is lost");
  assert.ok(left[0].bold && right[0].bold, "the first line of each column is bold");
  assert.ok(!left.at(-1)!.bold && !right.at(-1)!.bold, "the rest is not");
  assert.ok(right.some((d) => d.text === "(201) 555-0110"), "the phone has its own line");
  assert.ok(w.y < Math.min(...body.map((d) => d.y)), "the cursor moves below the taller column");
});

test("binder: a long subjectivity wraps clear of its status (CR-109)", async () => {
  const { w, drawn } = await recording();
  const long = "Written confirmation from the broker of the full subcontractor certificate program, ".repeat(4).trim();
  subjectivitiesBlock(w, [
    { text: long, status: "open", due_date: "2026-12-31" },
    { text: "Signed and dated application", status: "received", due_date: null },
  ]);
  const status = drawn.find((d) => d.text === "OPEN - due 12/31/2026")!;
  assert.ok(status, "the status is printed");
  assert.ok(Math.abs(status.end - RIGHT) < 0.01, "and right-aligned");
  const received = drawn.find((d) => d.text === "Received")!;
  const lines = drawn.filter((d) => d.x === PAGE.margin);
  assert.ok(lines.length >= 4, "the text wraps");
  for (const d of lines) assert.ok(d.end < status.x, `"${d.text}" stops before the status column`);
  const first = lines.filter((d) => d.y > received.y);
  assert.ok(first.length >= 3, "the next item starts below every wrapped line");
  assert.equal(first[0].y, status.y, "the status sits on its item's first line");
  assert.equal(lines.at(-1)!.y, received.y);
});

test("a binder with a 300-character subjectivity and a line break renders", async () => {
  const doc: PolicyDocument = {
    policyNumber: "GL-26-00001", binderNumber: "BND-26-00001", quoteNumber: "Q-2026-0001", quoteVersion: 1, boundAt: new Date("2026-03-01T15:00:00Z"), boundBy: "pat",
    insuredName: "Hill Country Carpentry LLC", insuredAddress: ["1 Main St", "Austin, TX 78701"],
    producer: ["Copper State Insurance Group", "Hannah Lindqvist", "hannah.lindqvist@copperstateinsurancegroup.example", "(201) 555-0110"],
    effectiveDate: "2026-03-15", expirationDate: "2027-03-15", limits: [{ label: "Each occurrence", amount: 1_000_000 }], deductible: 2500,
    classCode: "91342", classDescription: "Carpentry", operations: "Finish carpentry", states: ["TX"], grossReceipts: 1_000_000,
    premium: 9000, policyFee: 250, surplusLinesTax: 400, surplusLinesTaxRate: 0.0485, homeState: "TX", total: 9650, rateVersion: "2026.1",
    subjectivities: [{ text: `${"x".repeat(150)}\n${"y ".repeat(75)}`, status: "open", due_date: "2026-03-31" }], forms: ["CG 00 01"],
  };
  const pdf = await PDFDocument.load(await renderBinderPdf(doc));
  assert.ok(pdf.getPageCount() >= 1);
});
