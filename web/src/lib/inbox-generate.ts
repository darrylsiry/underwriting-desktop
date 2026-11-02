// When the broker drop folder runs low, the app writes new submissions into it: fictitious risks
// rendered as the documents a broker sends (an ACORD-style application, fillable or flattened, a
// loss run, a cover email, a supplemental questionnaire) in the same mix as the curated samples,
// so an audience never finds the inbox empty. Filesystem and pdf-lib only, no database, so
// node:test can drive it against a temp folder.
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFForm, type PDFPage } from "pdf-lib";
import { folderTitle, readInbox } from "./inbox-files.ts";
import type { Loss } from "./submission";
import { between, buildSyntheticCase, rng, weighted, type SyntheticCase } from "./synthetic-risk.ts";

/** Below this many unpicked submissions, INBOX_TOP_UP new ones are generated. */
export const INBOX_MIN_OUTSTANDING = 5;
export const INBOX_TOP_UP = 10;

type Case = {
  applicant: Record<string, string | number>; producer: Record<string, string>; policy: Record<string, string | number>;
  operations: Record<string, string | number | boolean | string[]>; prior: { carrier: string; premium: number }; loss_history: Loss[];
};

// ---- value formatting (how a broker types them; what ingestion's ACORD reader parses) ----------

const money = (v: unknown) => (v === null || v === undefined || v === "" ? "" : `$${Math.round(Number(v)).toLocaleString("en-US")}`);
const usDate = (iso: unknown) => { if (!iso) return ""; const [y, m, d] = String(iso).split("-"); return `${m}/${d}/${y}`; };
const yn = (v: unknown) => (v === null || v === undefined ? "" : v ? "Y" : "N");
const pct = (v: unknown) => (v === null || v === undefined ? "" : `${v}%`);
const num = (v: unknown) => (v === null || v === undefined ? "" : Number(v).toLocaleString("en-US"));
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

// ---- ACORD-style form layout: sections of rows of (label, field name, value, width fraction) ------

type Field = { label: string; name: string; value: string; frac: number };
type Section = [string, Field[][]];

function acord125Sections(c: Case): Section[] {
  const { applicant: a, producer: p, policy: pol, operations: ops } = c;
  const lossRows: Field[][] = ["A", "B", "C"].map((letter, i) => {
    const loss = c.loss_history[i];
    return [
      { label: "Date of Occurrence", name: `LossHistory_OccurrenceDate_${letter}`, value: usDate(loss?.date), frac: 0.17 },
      { label: "Description of Loss", name: `LossHistory_OccurrenceDescription_${letter}`, value: str(loss?.description), frac: 0.53 },
      { label: "Amount Incurred", name: `LossHistory_TotalIncurredAmount_${letter}`, value: money(loss?.incurred), frac: 0.15 },
      { label: "Status", name: `LossHistory_ClaimStatusCode_${letter}`, value: str(loss?.status), frac: 0.15 },
    ];
  });
  return [
    ["AGENCY / PRODUCER", [
      [{ label: "Agency", name: "Producer_FullName_A", value: p.agency, frac: 0.5 }, { label: "Contact Name", name: "Producer_ContactPerson_FullName_A", value: p.contact, frac: 0.5 }],
      [{ label: "Phone", name: "Producer_ContactPerson_PhoneNumber_A", value: p.phone, frac: 0.4 }, { label: "E-Mail", name: "Producer_ContactPerson_EmailAddress_A", value: p.email, frac: 0.6 }],
    ]],
    ["POLICY INFORMATION", [[
      { label: "Proposed Eff Date", name: "Policy_EffectiveDate_A", value: usDate(pol.effective_date), frac: 0.25 },
      { label: "Proposed Exp Date", name: "Policy_ExpirationDate_A", value: usDate(pol.expiration_date), frac: 0.25 },
      { label: "Line of Business", name: "Policy_LineOfBusiness_A", value: "Commercial General Liability", frac: 0.5 },
    ]]],
    ["APPLICANT INFORMATION", [
      [{ label: "Name (First Named Insured)", name: "NamedInsured_FullName_A", value: str(a.name), frac: 0.6 }, { label: "DBA", name: "NamedInsured_DBA_A", value: str(a.dba), frac: 0.4 }],
      [{ label: "Mailing Address", name: "NamedInsured_MailingAddress_LineOne_A", value: str(a.street), frac: 0.45 },
       { label: "City", name: "NamedInsured_MailingAddress_CityName_A", value: str(a.city), frac: 0.25 },
       { label: "State", name: "NamedInsured_MailingAddress_StateOrProvinceCode_A", value: str(a.state), frac: 0.1 },
       { label: "Zip", name: "NamedInsured_MailingAddress_PostalCode_A", value: str(a.zip), frac: 0.2 }],
      [{ label: "FEIN", name: "NamedInsured_TaxIdentifier_A", value: str(a.fein), frac: 0.25 },
       { label: "Legal Entity", name: "NamedInsured_LegalEntity_A", value: str(a.entity_type), frac: 0.25 },
       { label: "Years in Business", name: "NamedInsured_BusinessStartYears_A", value: num(a.years_in_business), frac: 0.2 },
       { label: "Website", name: "NamedInsured_Primary_WebsiteAddress_A", value: str(a.website), frac: 0.3 }],
    ]],
    ["NATURE OF BUSINESS / DESCRIPTION OF OPERATIONS", [[{ label: "Description of Primary Operations", name: "CommercialPolicy_OperationsDescription_A", value: str(ops.description), frac: 1.0 }]]],
    ["PRIOR CARRIER INFORMATION (GENERAL LIABILITY)", [[
      { label: "Prior Carrier", name: "PriorCoverage_GeneralLiability_InsurerFullName_A", value: c.prior.carrier, frac: 0.6 },
      { label: "Prior Premium", name: "PriorCoverage_GeneralLiability_TotalPremiumAmount_A", value: money(c.prior.premium), frac: 0.4 },
    ]]],
    ["LOSS HISTORY (LAST 5 YEARS)", lossRows],
  ];
}

function acord126Sections(c: Case): Section[] {
  const { policy: pol, operations: ops } = c;
  return [
    ["COVERAGES / LIMITS", [[
      { label: "Each Occurrence", name: "GeneralLiability_EachOccurrence_LimitAmount_A", value: money(pol.occurrence_limit), frac: 0.25 },
      { label: "General Aggregate", name: "GeneralLiability_GeneralAggregate_LimitAmount_A", value: money(pol.aggregate_limit), frac: 0.25 },
      { label: "Products-Comp/Op Agg", name: "GeneralLiability_ProductsAndCompletedOperations_AggregateLimitAmount_A", value: money(pol.products_aggregate_limit), frac: 0.25 },
      { label: "Deductible (BI/PD)", name: "GeneralLiability_PropertyDamage_DeductibleAmount_A", value: money(pol.deductible), frac: 0.25 },
    ]]],
    ["SCHEDULE OF HAZARDS", [[
      { label: "Class Code", name: "GeneralLiability_Hazard_ClassCode_A", value: str(ops.class_code), frac: 0.15 },
      { label: "Premium Basis", name: "GeneralLiability_Hazard_PremiumBasisCode_A", value: "S (Gross Sales)", frac: 0.2 },
      { label: "Exposure", name: "GeneralLiability_Hazard_Exposure_A", value: money(ops.gross_receipts), frac: 0.25 },
      { label: "States of Operation", name: "GeneralLiability_Hazard_LocationStates_A", value: (ops.states as string[]).join(", "), frac: 0.4 },
    ]]],
    ["CONTRACTORS", [
      [{ label: "Annual Payroll", name: "GeneralLiability_Contractor_PayrollAmount_A", value: money(ops.payroll), frac: 0.33 },
       { label: "Number of Employees", name: "GeneralLiability_Contractor_EmployeeCount_A", value: num(ops.employees), frac: 0.33 },
       { label: "% Work Subcontracted", name: "GeneralLiability_Contractor_SubcontractedPercent_A", value: pct(ops.subcontracted_pct), frac: 0.34 }],
      [{ label: "Certificates Required From Subs (Y/N)", name: "GeneralLiability_Contractor_SubcontractorCertificateIndicator_A", value: yn(ops.subcontractor_coi_required), frac: 0.5 },
       { label: "Wrap-Up / OCIP / CCIP Projects (Y/N)", name: "GeneralLiability_Contractor_WrapUpIndicator_A", value: yn(ops.wrap_up_projects), frac: 0.5 }],
      [{ label: "% Residential Work", name: "GeneralLiability_Contractor_ResidentialPercent_A", value: pct(ops.residential_pct), frac: 0.33 },
       { label: "% New Construction", name: "GeneralLiability_Contractor_NewConstructionPercent_A", value: pct(ops.new_construction_pct), frac: 0.33 },
       { label: "Max Height of Work (ft)", name: "GeneralLiability_Contractor_MaximumHeightFeet_A", value: num(ops.max_height_ft), frac: 0.34 }],
    ]],
  ];
}

// ---- drawing -------------------------------------------------------------------------------------

const PAGE_W = 612, PAGE_H = 792, MARGIN = 36;
const NAVY = rgb(0x1f / 255, 0x2f / 255, 0x4f / 255), WHITE = rgb(1, 1, 1), BLACK = rgb(0, 0, 0);
const BAND = rgb(0xdf / 255, 0xe6 / 255, 0xf2 / 255), LABEL = rgb(0x4a / 255, 0x55 / 255, 0x68 / 255);
const BORDER = rgb(0x9a / 255, 0xa5 / 255, 0xb8 / 255), FILL = rgb(0xf5 / 255, 0xf8 / 255, 1), NOTE = rgb(0x71 / 255, 0x80 / 255, 0x96 / 255);

type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont };
async function fontsOf(doc: PDFDocument): Promise<Fonts> {
  const [regular, bold, italic] = await Promise.all([doc.embedFont(StandardFonts.Helvetica), doc.embedFont(StandardFonts.HelveticaBold), doc.embedFont(StandardFonts.HelveticaOblique)]);
  return { regular, bold, italic };
}

/** Standard fonts only carry WinAnsi: keep the text to characters they can draw. */
const ascii = (s: string) => s.replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7e]/g, "");

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (cur.length + w.length + 1 > width) { lines.push(cur); cur = w; } else cur = `${cur} ${w}`.trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

function formPage(doc: PDFDocument, form: PDFForm, f: Fonts, title: string, subtitle: string, sections: Section[], fillable: boolean, applicantName: string | null, today: string) {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: PAGE_H - 60, width: PAGE_W, height: 60, color: NAVY });
  page.drawText(title, { x: MARGIN, y: PAGE_H - 34, size: 13, font: f.bold, color: WHITE });
  page.drawText(subtitle, { x: MARGIN, y: PAGE_H - 50, size: 8, font: f.regular, color: WHITE });
  const right = (text: string, y: number) => page.drawText(text, { x: PAGE_W - MARGIN - f.regular.widthOfTextAtSize(text, 8), y, size: 8, font: f.regular, color: WHITE });
  right(`Date: ${today}`, PAGE_H - 34);
  if (applicantName) right(`Applicant: ${ascii(applicantName)}`, PAGE_H - 50);
  let y = PAGE_H - 80;
  const usable = PAGE_W - 2 * MARGIN;
  for (const [heading, rows] of sections) {
    page.drawRectangle({ x: MARGIN, y: y - 14, width: usable, height: 14, color: BAND });
    page.drawText(heading, { x: MARGIN + 4, y: y - 10, size: 8, font: f.bold, color: NAVY });
    y -= 18;
    for (const row of rows) {
      const tall = row.some((c) => c.value.length > 110);
      const boxH = tall ? 34 : 16;
      let x = MARGIN;
      for (const c of row) {
        const w = usable * c.frac - 4;
        const value = ascii(c.value);
        page.drawText(c.label.toUpperCase(), { x: x + 1, y: y - 7, size: 6.5, font: f.regular, color: LABEL });
        if (fillable) {
          const field = form.createTextField(c.name);
          // The widget comes first: pdf-lib stores the font size in the appearance string it creates then.
          field.addToPage(page, { x, y: y - 10 - boxH, width: w, height: boxH, borderWidth: 0.5, borderColor: BORDER, backgroundColor: FILL, textColor: BLACK, font: f.regular });
          if (tall) field.enableMultiline();
          field.setFontSize(8);
          field.setText(value);
        } else {
          page.drawRectangle({ x, y: y - 10 - boxH, width: w, height: boxH, borderWidth: 0.5, borderColor: BORDER });
          wrap(value, Math.floor(w / 4.1)).slice(0, tall ? 3 : 1).forEach((line, i) => page.drawText(line, { x: x + 3, y: y - 10 - 11 - i * 9, size: 8, font: f.regular, color: BLACK }));
        }
        x += usable * c.frac;
      }
      y -= boxH + 14;
    }
    y -= 4;
  }
  page.drawText("Synthetic sample for demonstration. Layout modeled on ACORD-style applications; not an ACORD form.", { x: MARGIN, y: 24, size: 6.5, font: f.italic, color: NOTE });
  return page;
}

async function acordPdf(c: Case, fillable: boolean, include126: boolean, today: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Commercial Insurance Application - ${c.applicant.name}`);
  const f = await fontsOf(doc);
  const form = doc.getForm();
  formPage(doc, form, f, "COMMERCIAL INSURANCE APPLICATION", "APPLICANT INFORMATION SECTION (ACORD 125-style)", acord125Sections(c), fillable, null, today);
  if (include126) formPage(doc, form, f, "COMMERCIAL GENERAL LIABILITY SECTION", "ACORD 126-style", acord126Sections(c), fillable, String(c.applicant.name), today);
  return doc.save();
}

function textLines(page: PDFPage, f: PDFFont, lines: { text: string; x: number; y: number; size?: number; font?: PDFFont }[]) {
  for (const l of lines) page.drawText(ascii(l.text), { x: l.x, y: l.y, size: l.size ?? 8.5, font: l.font ?? f, color: BLACK });
}

async function lossRunPdf(c: Case, today: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Loss Run - ${c.applicant.name}`);
  const f = await fontsOf(doc);
  const page = doc.addPage([PAGE_W, PAGE_H]);
  textLines(page, f.regular, [
    { text: c.prior.carrier.toUpperCase(), x: MARGIN, y: PAGE_H - 50, size: 15, font: f.bold },
    { text: "Commercial General Liability - Loss Run Report", x: MARGIN, y: PAGE_H - 66, size: 10 },
    { text: `Insured: ${c.applicant.name}`, x: MARGIN, y: PAGE_H - 92, size: 10 },
    { text: `Policy No: GL-${String(c.applicant.fein).slice(-4)}-${String(c.policy.effective_date).slice(0, 4)}`, x: MARGIN, y: PAGE_H - 106, size: 10 },
    { text: `Valued as of: ${today}    Experience period: 5 years`, x: MARGIN, y: PAGE_H - 120, size: 10 },
  ]);
  let y = PAGE_H - 150;
  const cols: [string, number][] = [["Claim #", 70], ["Date of Loss", 75], ["Description", 230], ["Status", 55], ["Total Incurred", 80]];
  page.drawRectangle({ x: MARGIN, y: y - 4, width: PAGE_W - 2 * MARGIN, height: 16, color: rgb(0xe2 / 255, 0xe8 / 255, 0xf0 / 255) });
  let x = MARGIN + 4;
  for (const [name, w] of cols) { page.drawText(name, { x, y, size: 8.5, font: f.bold, color: BLACK }); x += w; }
  let total = 0;
  c.loss_history.forEach((loss, i) => {
    y -= 18; x = MARGIN + 4;
    const row = [`CL${c.applicant.zip || "00000"}${String(i + 1).padStart(2, "0")}`, usDate(loss.date), loss.description.slice(0, 52), loss.status, money(loss.incurred)];
    row.forEach((v, k) => { page.drawText(ascii(v), { x, y, size: 8.5, font: f.regular, color: BLACK }); x += cols[k][1]; });
    total += loss.incurred;
  });
  if (!c.loss_history.length) { y -= 18; page.drawText("NO LOSSES REPORTED FOR THE EXPERIENCE PERIOD", { x: MARGIN + 4, y, size: 8.5, font: f.regular, color: BLACK }); }
  y -= 26;
  page.drawText(`Total claims: ${c.loss_history.length}      Total incurred: ${money(total)}`, { x: MARGIN + 4, y, size: 9, font: f.bold, color: BLACK });
  return doc.save();
}

async function questionnairePdf(c: Case, today: string): Promise<Uint8Array> {
  const { policy: pol, operations: ops } = c;
  const states = ops.states as string[];
  const qa: [string, string][] = [
    ["Describe all operations performed by the applicant.", str(ops.description)],
    ["Primary ISO class code for the operations.", str(ops.class_code)],
    ["Projected gross receipts for the next 12 months.", money(ops.gross_receipts)],
    ["Total annual payroll (excluding subcontractor costs) and number of employees.", `${money(ops.payroll)} payroll, ${ops.employees} full-time employees.`],
    ["What percentage of work is subcontracted? Do you obtain certificates of insurance naming you as additional insured?",
      `About ${ops.subcontracted_pct}% of total job costs are paid to subcontractors. ${ops.subcontractor_coi_required ? "Yes - COIs with AI endorsements and hold-harmless agreements are required from all subs." : "No."}`],
    ["Breakdown of work: residential vs. commercial; new construction vs. remodel.",
      `${ops.residential_pct}% residential / ${100 - Number(ops.residential_pct)}% commercial. ${ops.new_construction_pct}% new construction / ${100 - Number(ops.new_construction_pct)}% renovation and remodel.`],
    ["Maximum height at which work is performed? Is scaffolding used?",
      `Up to ${ops.max_height_ft} feet${Number(ops.max_height_ft) >= 40 ? " on exterior facade work. Scaffolding is erected by a licensed subcontractor." : ". Ladders and lifts only, no scaffolding."}`],
    ["States in which you operate.", states.join(", ")],
    ["Do you participate in wrap-up (OCIP/CCIP) programs?", ops.wrap_up_projects ? "Yes" : "No"],
    ["Are any projects subject to New York Labor Law 240/241?", states.includes("NY") ? "Yes, NY projects are subject to Labor Law 240/241." : "No"],
    ["Limits requested.", `${money(pol.occurrence_limit)} each occurrence, ${money(pol.aggregate_limit)} general aggregate, ${money(pol.products_aggregate_limit)} products/completed operations aggregate. Deductible: ${money(pol.deductible)}.`],
  ];
  const doc = await PDFDocument.create();
  doc.setTitle(`Contractors Supplemental Questionnaire - ${c.applicant.name}`);
  const f = await fontsOf(doc);
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawText("CONTRACTORS SUPPLEMENTAL QUESTIONNAIRE", { x: MARGIN, y: PAGE_H - 50, size: 14, font: f.bold, color: BLACK });
  page.drawText(ascii(`Applicant: ${c.applicant.name}`), { x: MARGIN, y: PAGE_H - 68, size: 10, font: f.regular, color: BLACK });
  let y = PAGE_H - 100;
  qa.forEach(([q, a], i) => {
    for (const line of wrap(`${i + 1}. ${q}`, 105)) { page.drawText(ascii(line), { x: MARGIN, y, size: 9, font: f.bold, color: BLACK }); y -= 12; }
    for (const line of wrap(a, 110)) { page.drawText(ascii(line), { x: MARGIN + 14, y, size: 9, font: f.regular, color: BLACK }); y -= 12; }
    y -= 8;
  });
  page.drawText(`Signed: ____________________   Title: President   Date: ${today}`, { x: MARGIN, y: y - 10, size: 9, font: f.regular, color: BLACK });
  return doc.save();
}

// ---- the broker's email --------------------------------------------------------------------------

function emailBody(c: Case, sparse: boolean): string {
  const { applicant: a, producer: p, policy: pol, operations: ops } = c;
  if (sparse) {
    return `Hi team,

Quick one for you - newer contractor out of ${a.city}, ${a.name}.
Been in business about ${a.years_in_business} years, ${ops.employees} guys, roughly ${money(ops.gross_receipts)} in sales.
${ops.description}

Looking for ${money(pol.occurrence_limit)}/${money(pol.aggregate_limit)}, effective ${usDate(pol.effective_date)}.
No prior coverage that I know of. Can you give me an indication? Will get you a full app if the number works.

Thanks,
${p.contact}
${p.agency}
${p.phone}
`;
  }
  const loss = c.loss_history;
  const open = loss.filter((l) => l.status === "Open").length;
  const lossLine = !loss.length ? "Clean loss history, loss runs attached."
    : loss.length === 1 ? `One claim in the last five years (${money(loss[0].incurred)}, ${loss[0].status.toLowerCase()}) - loss runs attached.`
    : `${loss.length} claims in the last five years, ${money(loss.reduce((s, l) => s + l.incurred, 0))} total incurred${open ? `, ${open} still open` : ", all closed"} - loss runs attached.`;
  const priorLine = c.prior.carrier ? `Renewal currently with ${c.prior.carrier}\nat ${money(c.prior.premium)}, they're non-renewing the class so we're marketing it.`
    : "No prior GL coverage - they've been on a project-specific policy through the GC.";
  const nc = Number(ops.new_construction_pct);
  const work = !nc ? "essentially all remodel (no new construction)" : `about ${nc}% new construction`;
  const subs = ops.subcontractor_coi_required ? `subs maybe ${ops.subcontracted_pct}% of costs and they collect COIs` : `subs about ${ops.subcontracted_pct}% of costs; they don't always get certificates`;
  return `Hi there,

Please see below for a new submission I'd like you to quote. ${priorLine}

Insured: ${a.name}
Address: ${a.street}, ${a.city}, ${a.state} ${a.zip}
FEIN: ${a.fein} - ${a.entity_type}, in business ${a.years_in_business} years

Operations: ${ops.description}
Work is ${ops.residential_pct}% residential, ${work}.
They self-perform most of it - ${subs}.
Max working height is about ${ops.max_height_ft} ft. Operates in ${(ops.states as string[]).join(", ")} only.
${ops.wrap_up_projects ? "Some larger jobs are written under OCIP/CCIP wrap-ups." : "No wrap-up (OCIP/CCIP) projects."}

Projected gross receipts: ${money(ops.gross_receipts)}
Payroll: ${money(ops.payroll)}, ${ops.employees} employees

Coverage requested: ${money(pol.occurrence_limit)} per occurrence / ${money(pol.aggregate_limit)} aggregate,
${money(pol.products_aggregate_limit)} products-completed ops, ${money(pol.deductible)} deductible.
Effective ${usDate(pol.effective_date)}.

${lossLine}

Appreciate the look - let me know if you need anything else.

${p.contact}
${p.agency} | ${p.phone} | ${p.email}
`;
}

/** An RFC 822 message, multipart when it carries attachments (what the ingestion service parses). */
function emailFile(c: Case, sparse: boolean, attachments: { name: string; bytes: Uint8Array }[], sent: Date): string {
  const headers = [
    `From: ${c.producer.contact} <${c.producer.email}>`, "To: submissions@underwriting-desk.example",
    `Subject: New submission - ${c.applicant.name} - Contractors GL`, `Date: ${sent.toUTCString().replace("GMT", "+0000")}`, "MIME-Version: 1.0",
  ];
  const body = emailBody(c, sparse).replace(/\n/g, "\r\n");
  if (!attachments.length) return [...headers, 'Content-Type: text/plain; charset="utf-8"', "Content-Transfer-Encoding: 8bit", "", body].join("\r\n");
  const boundary = "----=_uwdesk_" + Math.abs(hash(c.applicant.name + sent.toISOString())).toString(16);
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset="utf-8"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}`,
    ...attachments.map((a) => `--${boundary}\r\nContent-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${a.name}"\r\n\r\n${Buffer.from(a.bytes).toString("base64").replace(/(.{76})/g, "$1\r\n")}`),
    `--${boundary}--\r\n`,
  ];
  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", parts.join("\r\n")].join("\r\n");
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

// ---- building folders ----------------------------------------------------------------------------

/** The document mix a generated submission arrives in, weighted like the curated samples. */
const FORMATS: [string, number][] = [
  ["acord_fillable+loss_run", 40], ["acord_fillable+broker_email", 20], ["acord_flattened+loss_run", 15], ["broker_email_sparse", 10], ["acord_fillable+questionnaire", 15],
];

/** Folder stamp: YYYYMMDD-HHMM (UTC), so generated folders sort newest first and read as a date. */
export const inboxStamp = (now: Date) => now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");

export type GeneratedSubmission = { folder: string; name: string; files: string[]; formats: string; trips: string | null };

// CR-128: a folder is written under a name the inbox never lists (isSafeName rejects the leading dot)
// and renamed when complete, so nobody can pick up a submission with only some of its documents.
const TEMP_PREFIX = ".tmp-";
const TEMP_MAX_AGE_MS = 60 * 60_000;

/** Render one case's documents into `dir/<stamp>-<slug>`, which appears only once all of them are written. */
export async function writeSubmission(dir: string, c: SyntheticCase, formats: string, now: Date): Promise<GeneratedSubmission> {
  const kase = c.data as unknown as Case;
  const folder = `${inboxStamp(now)}-${c.slug}`;
  const full = path.join(dir, `${TEMP_PREFIX}${folder}-${crypto.randomUUID().slice(0, 8)}`);   // unique: two servers sharing the folder can write the same case
  fs.mkdirSync(full, { recursive: true });
  try {
    const today = usDate(now.toISOString().slice(0, 10));
    const files: string[] = [];
    const write = (name: string, bytes: Uint8Array | string) => { fs.writeFileSync(path.join(full, name), bytes); files.push(name); };
    const fmts = new Set(formats.split("+"));
    let lossRun: Uint8Array | null = null;
    if (fmts.has("loss_run") || fmts.has("broker_email")) lossRun = await lossRunPdf(kase, today);
    if (fmts.has("loss_run")) write(`${c.slug}-loss-run.pdf`, lossRun!);
    if (fmts.has("acord_fillable")) write(`${c.slug}-acord-application.pdf`, await acordPdf(kase, true, !fmts.has("questionnaire"), today));
    if (fmts.has("acord_flattened")) write(`${c.slug}-application-scan.pdf`, await acordPdf(kase, false, true, today));
    if (fmts.has("questionnaire")) write(`${c.slug}-supplemental-questionnaire.pdf`, await questionnairePdf(kase, today));
    const sent = new Date(now.getTime() - between(rng(hash(folder)), 1, 9) * 3_600_000);
    if (fmts.has("broker_email")) write(`${c.slug}-submission-email.eml`, emailFile(kase, false, [{ name: `${c.slug}-loss-run.pdf`, bytes: lossRun! }], sent));
    if (fmts.has("broker_email_sparse")) write(`${c.slug}-submission-email.eml`, emailFile(kase, true, [], sent));
    try {
      fs.renameSync(full, path.join(dir, folder));
    } catch (err) {
      // Another server finished the same case first: its folder stands, and ours is the copy to drop.
      if (!["ENOTEMPTY", "EEXIST"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
      fs.rmSync(full, { recursive: true, force: true });
    }
    return { folder, name: c.name, files, formats, trips: c.trips };
  } catch (err) {
    fs.rmSync(full, { recursive: true, force: true });
    throw err;
  }
}

/** A process stopped mid-write leaves its temp folder behind. The inbox ignores it; an hour on, it can go. */
function sweepStaleTemp(dir: string, now: Date) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith(TEMP_PREFIX)) continue;
    const full = path.join(dir, e.name);
    if (now.getTime() - fs.statSync(full).mtimeMs > TEMP_MAX_AGE_MS) fs.rmSync(full, { recursive: true, force: true });
  }
}

/**
 * Generate `count` new submissions into the drop folder. Deterministic for a given minute (the
 * stamp seeds the generator), so two servers topping up at once produce the same folders. Names
 * already in the folder are avoided.
 */
export async function generateInboxSubmissions(dir: string, count: number, now = new Date()): Promise<GeneratedSubmission[]> {
  sweepStaleTemp(dir, now);
  const r = rng(hash(inboxStamp(now)) ^ count);
  const taken = new Set(readInbox(dir).map((f) => folderTitle(f.folder)));
  const out: GeneratedSubmission[] = [];
  for (let attempts = 0; out.length < count && attempts < count * 3; attempts++) {
    const effective = new Date(now.getTime() + between(r, 20, 75) * 86_400_000).toISOString().slice(0, 10);
    const c = buildSyntheticCase(r, { effective, referrals: "any" }, taken);
    if (fs.existsSync(path.join(dir, `${inboxStamp(now)}-${c.slug}`))) continue;   // same minute, same case: already there
    out.push(await writeSubmission(dir, c, weighted(r, FORMATS), now));
  }
  return out;
}
