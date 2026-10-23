"""Generate synthetic E&S contractors GL submissions from samples/cases.py.

    uv run --with reportlab --with python-docx samples/generate.py

Writes samples/submissions/<case-id>/* (the files a broker would send) and
samples/ground_truth/<case-id>.json (the correct extraction, for scoring).

The ACORD-style forms only imitate the layout and field naming of ACORD
125/126. They are not reproductions of copyrighted ACORD forms.
"""
import json
import shutil
from datetime import date
from email.message import EmailMessage
from pathlib import Path

from docx import Document
from docx.shared import Pt
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

from cases import CASES

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "submissions"
TRUTH = ROOT / "ground_truth"
PAGE_W, PAGE_H = letter
MARGIN = 36
NAVY = colors.HexColor("#1f2f4f")


# --- value formatting (how a broker would type them) -------------------------

def money(v):
    return "" if v is None else f"${v:,.0f}"


def us_date(iso):
    if not iso:
        return ""
    y, m, d = iso.split("-")
    return f"{m}/{d}/{y}"


def yn(v):
    return "" if v is None else ("Y" if v else "N")


def pct(v):
    return "" if v is None else f"{v}%"


def num(v):
    return "" if v is None else f"{v:,}"


# --- ACORD-style form layout -------------------------------------------------
# Each section is a list of rows; each row a list of (label, field_name, value, width_fraction).

def acord125_sections(c):
    a, p, pol, ops = c["applicant"], c["producer"], c["policy"], c["operations"]
    losses = c["loss_history"][:3]
    loss_rows = []
    for i, letter_ in enumerate("ABC"):
        loss = losses[i] if i < len(losses) else {}
        loss_rows.append([
            ("Date of Occurrence", f"LossHistory_OccurrenceDate_{letter_}", us_date(loss.get("date")), 0.17),
            ("Description of Loss", f"LossHistory_OccurrenceDescription_{letter_}", loss.get("description", ""), 0.53),
            ("Amount Incurred", f"LossHistory_TotalIncurredAmount_{letter_}", money(loss.get("incurred")), 0.15),
            ("Status", f"LossHistory_ClaimStatusCode_{letter_}", loss.get("status", ""), 0.15),
        ])
    return [
        ("AGENCY / PRODUCER", [
            [("Agency", "Producer_FullName_A", p["agency"], 0.5), ("Contact Name", "Producer_ContactPerson_FullName_A", p["contact"], 0.5)],
            [("Phone", "Producer_ContactPerson_PhoneNumber_A", p["phone"], 0.4), ("E-Mail", "Producer_ContactPerson_EmailAddress_A", p["email"], 0.6)],
        ]),
        ("POLICY INFORMATION", [
            [("Proposed Eff Date", "Policy_EffectiveDate_A", us_date(pol["effective_date"]), 0.25),
             ("Proposed Exp Date", "Policy_ExpirationDate_A", us_date(pol["expiration_date"]), 0.25),
             ("Line of Business", "Policy_LineOfBusiness_A", "Commercial General Liability", 0.5)],
        ]),
        ("APPLICANT INFORMATION", [
            [("Name (First Named Insured)", "NamedInsured_FullName_A", a["name"], 0.6), ("DBA", "NamedInsured_DBA_A", a["dba"], 0.4)],
            [("Mailing Address", "NamedInsured_MailingAddress_LineOne_A", a["street"], 0.45),
             ("City", "NamedInsured_MailingAddress_CityName_A", a["city"], 0.25),
             ("State", "NamedInsured_MailingAddress_StateOrProvinceCode_A", a["state"], 0.1),
             ("Zip", "NamedInsured_MailingAddress_PostalCode_A", a["zip"], 0.2)],
            [("FEIN", "NamedInsured_TaxIdentifier_A", a["fein"], 0.25),
             ("Legal Entity", "NamedInsured_LegalEntity_A", a["entity_type"], 0.25),
             ("Years in Business", "NamedInsured_BusinessStartYears_A", num(a["years_in_business"]), 0.2),
             ("Website", "NamedInsured_Primary_WebsiteAddress_A", a["website"], 0.3)],
        ]),
        ("NATURE OF BUSINESS / DESCRIPTION OF OPERATIONS", [
            [("Description of Primary Operations", "CommercialPolicy_OperationsDescription_A", ops["description"], 1.0)],
        ]),
        ("PRIOR CARRIER INFORMATION (GENERAL LIABILITY)", [
            [("Prior Carrier", "PriorCoverage_GeneralLiability_InsurerFullName_A", c["prior"]["carrier"], 0.6),
             ("Prior Premium", "PriorCoverage_GeneralLiability_TotalPremiumAmount_A", money(c["prior"]["premium"]), 0.4)],
        ]),
        ("LOSS HISTORY (LAST 5 YEARS)", loss_rows),
    ]


def acord126_sections(c):
    pol, ops = c["policy"], c["operations"]
    return [
        ("COVERAGES / LIMITS", [
            [("Each Occurrence", "GeneralLiability_EachOccurrence_LimitAmount_A", money(pol["occurrence_limit"]), 0.25),
             ("General Aggregate", "GeneralLiability_GeneralAggregate_LimitAmount_A", money(pol["aggregate_limit"]), 0.25),
             ("Products-Comp/Op Agg", "GeneralLiability_ProductsAndCompletedOperations_AggregateLimitAmount_A", money(pol["products_aggregate_limit"]), 0.25),
             ("Deductible (BI/PD)", "GeneralLiability_PropertyDamage_DeductibleAmount_A", money(pol["deductible"]), 0.25)],
        ]),
        ("SCHEDULE OF HAZARDS", [
            [("Class Code", "GeneralLiability_Hazard_ClassCode_A", ops["class_code"], 0.15),
             ("Premium Basis", "GeneralLiability_Hazard_PremiumBasisCode_A", "S (Gross Sales)", 0.2),
             ("Exposure", "GeneralLiability_Hazard_Exposure_A", money(ops["gross_receipts"]), 0.25),
             ("States of Operation", "GeneralLiability_Hazard_LocationStates_A", ", ".join(ops["states"]), 0.4)],
        ]),
        ("CONTRACTORS", [
            [("Annual Payroll", "GeneralLiability_Contractor_PayrollAmount_A", money(ops["payroll"]), 0.33),
             ("Number of Employees", "GeneralLiability_Contractor_EmployeeCount_A", num(ops["employees"]), 0.33),
             ("% Work Subcontracted", "GeneralLiability_Contractor_SubcontractedPercent_A", pct(ops["subcontracted_pct"]), 0.34)],
            [("Certificates Required From Subs (Y/N)", "GeneralLiability_Contractor_SubcontractorCertificateIndicator_A", yn(ops["subcontractor_coi_required"]), 0.5),
             ("Wrap-Up / OCIP / CCIP Projects (Y/N)", "GeneralLiability_Contractor_WrapUpIndicator_A", yn(ops["wrap_up_projects"]), 0.5)],
            [("% Residential Work", "GeneralLiability_Contractor_ResidentialPercent_A", pct(ops["residential_pct"]), 0.33),
             ("% New Construction", "GeneralLiability_Contractor_NewConstructionPercent_A", pct(ops["new_construction_pct"]), 0.33),
             ("Max Height of Work (ft)", "GeneralLiability_Contractor_MaximumHeightFeet_A", num(ops["max_height_ft"]), 0.34)],
        ]),
    ]


def draw_form_page(cv, title, subtitle, sections, fillable, applicant_name):
    cv.setFillColor(NAVY)
    cv.rect(0, PAGE_H - 60, PAGE_W, 60, fill=1, stroke=0)
    cv.setFillColor(colors.white)
    cv.setFont("Helvetica-Bold", 13)
    cv.drawString(MARGIN, PAGE_H - 30, title)
    cv.setFont("Helvetica", 8)
    cv.drawString(MARGIN, PAGE_H - 46, subtitle)
    cv.drawRightString(PAGE_W - MARGIN, PAGE_H - 30, f"Date: {date.today().strftime('%m/%d/%Y')}")
    if applicant_name:
        cv.drawRightString(PAGE_W - MARGIN, PAGE_H - 46, f"Applicant: {applicant_name}")
    y = PAGE_H - 80
    usable = PAGE_W - 2 * MARGIN
    for heading, rows in sections:
        cv.setFillColor(colors.HexColor("#dfe6f2"))
        cv.rect(MARGIN, y - 14, usable, 14, fill=1, stroke=0)
        cv.setFillColor(NAVY)
        cv.setFont("Helvetica-Bold", 8)
        cv.drawString(MARGIN + 4, y - 10, heading)
        y -= 18
        for row in rows:
            tall = any(len(str(v)) > 110 for _, _, v, _ in row)
            box_h = 34 if tall else 16
            x = MARGIN
            for label, name, value, frac in row:
                w = usable * frac - 4
                cv.setFillColor(colors.HexColor("#4a5568"))
                cv.setFont("Helvetica", 6.5)
                cv.drawString(x + 1, y - 7, label.upper())
                if fillable:
                    cv.acroForm.textfield(
                        name=name, tooltip=label, value=str(value), x=x, y=y - 10 - box_h, width=w, height=box_h,
                        fontSize=8, borderWidth=0.5, borderColor=colors.HexColor("#9aa5b8"),
                        fillColor=colors.HexColor("#f5f8ff"), textColor=colors.black,
                        fieldFlags="multiline" if tall else "",
                    )
                else:
                    cv.setStrokeColor(colors.HexColor("#9aa5b8"))
                    cv.rect(x, y - 10 - box_h, w, box_h, stroke=1, fill=0)
                    cv.setFillColor(colors.black)
                    cv.setFont("Helvetica", 8)
                    text = cv.beginText(x + 3, y - 10 - 11)
                    for line in wrap(str(value), int(w / 4.1)):
                        text.textLine(line)
                    cv.drawText(text)
                x += usable * frac
            y -= box_h + 14
        y -= 4
    cv.setFont("Helvetica-Oblique", 6.5)
    cv.setFillColor(colors.HexColor("#718096"))
    cv.drawString(MARGIN, 24, "Synthetic sample for demonstration. Layout modeled on ACORD-style applications; not an ACORD form.")


def wrap(text, width):
    words, lines, cur = text.split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 > width:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    return lines + [cur] if cur else lines


def acord_pdf(c, path, fillable=True, include_126=True):
    cv = canvas.Canvas(str(path), pagesize=letter)
    cv.setTitle(f"Commercial Insurance Application - {c['applicant']['name']}")
    draw_form_page(cv, "COMMERCIAL INSURANCE APPLICATION", "APPLICANT INFORMATION SECTION (ACORD 125-style)",
                   acord125_sections(c), fillable, None)
    if include_126:
        cv.showPage()
        draw_form_page(cv, "COMMERCIAL GENERAL LIABILITY SECTION", "ACORD 126-style",
                       acord126_sections(c), fillable, c["applicant"]["name"])
    cv.save()


# --- loss run ------------------------------------------------------------------

def loss_run_pdf(c, path):
    cv = canvas.Canvas(str(path), pagesize=letter)
    carrier = c["prior"]["carrier"]
    cv.setTitle(f"Loss Run - {c['applicant']['name']}")
    cv.setFont("Helvetica-Bold", 15)
    cv.drawString(MARGIN, PAGE_H - 50, carrier.upper())
    cv.setFont("Helvetica", 10)
    cv.drawString(MARGIN, PAGE_H - 66, "Commercial General Liability - Loss Run Report")
    cv.drawString(MARGIN, PAGE_H - 92, f"Insured: {c['applicant']['name']}")
    cv.drawString(MARGIN, PAGE_H - 106, f"Policy No: GL-{c['applicant']['fein'][-4:]}-{c['policy']['effective_date'][:4]}")
    cv.drawString(MARGIN, PAGE_H - 120, f"Valued as of: {date.today().strftime('%m/%d/%Y')}    Experience period: 5 years")
    y = PAGE_H - 150
    cols = [("Claim #", 70), ("Date of Loss", 75), ("Description", 230), ("Status", 55), ("Total Incurred", 80)]
    cv.setFillColor(colors.HexColor("#e2e8f0"))
    cv.rect(MARGIN, y - 4, PAGE_W - 2 * MARGIN, 16, fill=1, stroke=0)
    cv.setFillColor(colors.black)
    cv.setFont("Helvetica-Bold", 8.5)
    x = MARGIN + 4
    for name, w in cols:
        cv.drawString(x, y, name)
        x += w
    cv.setFont("Helvetica", 8.5)
    total = 0
    for i, loss in enumerate(c["loss_history"], start=1):
        y -= 18
        x = MARGIN + 4
        row = [f"CL{c['applicant']['zip'] or '00000'}{i:02d}", us_date(loss["date"]), loss["description"][:52], loss["status"], money(loss["incurred"])]
        for (_, w), v in zip(cols, row):
            cv.drawString(x, y, v)
            x += w
        total += loss["incurred"]
    if not c["loss_history"]:
        y -= 18
        cv.drawString(MARGIN + 4, y, "NO LOSSES REPORTED FOR THE EXPERIENCE PERIOD")
    y -= 26
    cv.setFont("Helvetica-Bold", 9)
    cv.drawString(MARGIN + 4, y, f"Total claims: {len(c['loss_history'])}      Total incurred: {money(total)}")
    cv.save()


# --- broker emails -------------------------------------------------------------

def email_body(c, sparse):
    a, p, pol, ops = c["applicant"], c["producer"], c["policy"], c["operations"]
    if sparse:
        return f"""Hi team,

Quick one for you - new venture-ish painting contractor out of {a['city']}, {a['name']}.
Been in business about {a['years_in_business']} years, {ops['employees']} guys, roughly {money(ops['gross_receipts'])} in sales.
{ops['description']}

Looking for {money(pol['occurrence_limit'])}/{money(pol['aggregate_limit'])}, effective {us_date(pol['effective_date'])}.
No prior coverage that I know of. Can you give me an indication? Will get you a full app if the number works.

Thanks,
{p['contact']}
{p['agency']}
{p['phone']}
"""
    loss = c["loss_history"]
    loss_line = (f"One claim in the last five years ({money(loss[0]['incurred'])}, closed) - loss runs attached."
                 if loss else "Clean loss history, loss runs attached.")
    return f"""Hi there,

Please see below for a new submission I'd like you to quote. Renewal currently with {c['prior']['carrier']}
at {money(c['prior']['premium'])}, they're non-renewing the class so we're marketing it.

Insured: {a['name']}
Address: {a['street']}, {a['city']}, {a['state']} {a['zip']}
FEIN: {a['fein']} - {a['entity_type']}, in business {a['years_in_business']} years

Operations: {ops['description']}
Work is {ops['residential_pct']}% residential, essentially all remodel (no new construction).
They self-perform almost everything - subs maybe {ops['subcontracted_pct']}% of costs and they collect COIs.
Max working height is about {ops['max_height_ft']} ft (ladders only). Operates in {', '.join(ops['states'])} only.

Projected gross receipts: {money(ops['gross_receipts'])}
Payroll: {money(ops['payroll'])}, {ops['employees']} employees

Coverage requested: {money(pol['occurrence_limit'])} per occurrence / {money(pol['aggregate_limit'])} aggregate,
{money(pol['products_aggregate_limit'])} products-completed ops, {money(pol['deductible'])} deductible.
Effective {us_date(pol['effective_date'])}.

{loss_line}

Appreciate the look - let me know if you need anything else.

{p['contact']}
{p['agency']} | {p['phone']} | {p['email']}
"""


def broker_email(c, path, attachments=(), sparse=False):
    msg = EmailMessage()
    msg["From"] = f"{c['producer']['contact']} <{c['producer']['email']}>"
    msg["To"] = "submissions@underwriting-desk.example"
    msg["Subject"] = f"New submission - {c['applicant']['name']} - Contractors GL"
    msg["Date"] = "Thu, 22 Oct 2026 09:14:00 -0500"
    msg.set_content(email_body(c, sparse))
    for att in attachments:
        msg.add_attachment(att.read_bytes(), maintype="application", subtype="pdf", filename=att.name)
    path.write_bytes(bytes(msg))


# --- supplemental questionnaire (non-fillable PDF, Q&A prose) ---------------

def questionnaire_pdf(c, path):
    pol, ops = c["policy"], c["operations"]
    qa = [
        ("Describe all operations performed by the applicant.", ops["description"]),
        ("Primary ISO class code for the operations.", ops["class_code"]),
        ("Projected gross receipts for the next 12 months.", money(ops["gross_receipts"])),
        ("Total annual payroll (excluding subcontractor costs) and number of employees.",
         f"{money(ops['payroll'])} payroll, {ops['employees']} full-time employees."),
        ("What percentage of work is subcontracted? Do you obtain certificates of insurance naming you as additional insured?",
         f"About {ops['subcontracted_pct']}% of total job costs are paid to subcontractors. "
         + ("Yes - COIs with AI endorsements and hold-harmless agreements are required from all subs." if ops["subcontractor_coi_required"] else "No.")),
        ("Breakdown of work: residential vs. commercial; new construction vs. remodel.",
         f"{ops['residential_pct']}% residential / {100 - ops['residential_pct']}% commercial. "
         f"{ops['new_construction_pct']}% new construction / {100 - ops['new_construction_pct']}% renovation and remodel."),
        ("Maximum height at which work is performed? Is scaffolding used?",
         f"Up to {ops['max_height_ft']} feet on exterior facade work. Scaffolding is erected by a licensed subcontractor."),
        ("States in which you operate.", ", ".join(ops["states"])),
        ("Do you participate in wrap-up (OCIP/CCIP) programs?", "Yes" if ops["wrap_up_projects"] else "No"),
        ("Are any projects subject to New York Labor Law 240/241?", "Yes, NYC projects are subject to Labor Law 240/241." if "NY" in ops["states"] else "No"),
        ("Limits requested.",
         f"{money(pol['occurrence_limit'])} each occurrence, {money(pol['aggregate_limit'])} general aggregate, "
         f"{money(pol['products_aggregate_limit'])} products/completed operations aggregate. Deductible: {money(pol['deductible'])}."),
    ]
    cv = canvas.Canvas(str(path), pagesize=letter)
    cv.setTitle(f"Contractors Supplemental Questionnaire - {c['applicant']['name']}")
    cv.setFont("Helvetica-Bold", 14)
    cv.drawString(MARGIN, PAGE_H - 50, "CONTRACTORS SUPPLEMENTAL QUESTIONNAIRE")
    cv.setFont("Helvetica", 10)
    cv.drawString(MARGIN, PAGE_H - 68, f"Applicant: {c['applicant']['name']}")
    y = PAGE_H - 100
    for i, (q, a) in enumerate(qa, start=1):
        cv.setFont("Helvetica-Bold", 9)
        for line in wrap(f"{i}. {q}", 105):
            cv.drawString(MARGIN, y, line)
            y -= 12
        cv.setFont("Helvetica", 9)
        for line in wrap(a, 110):
            cv.drawString(MARGIN + 14, y, line)
            y -= 12
        y -= 8
    cv.drawString(MARGIN, y - 10, f"Signed: ____________________   Title: President   Date: {date.today().strftime('%m/%d/%Y')}")
    cv.save()


# --- Word application (wholesaler's own non-ACORD form) ---------------------

def word_application(c, path):
    a, p, pol, ops = c["applicant"], c["producer"], c["policy"], c["operations"]
    doc = Document()
    doc.styles["Normal"].font.size = Pt(10)
    doc.add_heading("Contractor's General Liability Application", level=1)
    doc.add_paragraph(f"Submitted by {p['agency']} ({p['contact']}, {p['email']}, {p['phone']})")

    def table(title, rows):
        doc.add_heading(title, level=2)
        t = doc.add_table(rows=0, cols=2)
        t.style = "Light Grid Accent 1"
        for k, v in rows:
            cells = t.add_row().cells
            cells[0].text, cells[1].text = k, str(v)

    table("Applicant", [
        ("Legal name", a["name"]), ("Trade name", a["dba"]),
        ("Address", f"{a['street']}\n{a['city']}, {a['state']} {a['zip']}"),
        ("Tax ID", a["fein"]), ("Organization type", a["entity_type"]),
        ("Years in business", a["years_in_business"]), ("Website", a["website"]),
    ])
    table("Coverage requested", [
        ("Effective date", us_date(pol["effective_date"])),
        ("Expiration date", us_date(pol["expiration_date"])),
        ("Limits", f"{money(pol['occurrence_limit'])} / {money(pol['aggregate_limit'])} / {money(pol['products_aggregate_limit'])} (Occ / Agg / Products-CO)"),
        ("Deductible", money(pol["deductible"])),
    ])
    table("Operations", [
        ("Description", ops["description"]), ("Class code", ops["class_code"]),
        ("States", ", ".join(ops["states"])),
        ("Gross receipts (next 12 mo.)", money(ops["gross_receipts"])),
        ("Payroll", money(ops["payroll"])), ("Employees", ops["employees"]),
        ("Subcontracted costs", pct(ops["subcontracted_pct"])),
        ("COIs obtained from subs?", "Yes" if ops["subcontractor_coi_required"] else "No"),
        ("Residential work", pct(ops["residential_pct"])),
        ("New construction", pct(ops["new_construction_pct"])),
        ("Maximum height", f"{ops['max_height_ft']} ft (ground level flatwork)"),
        ("Wrap-up projects?", "Yes" if ops["wrap_up_projects"] else "No"),
    ])
    table("Prior insurance", [("Carrier", c["prior"]["carrier"]), ("Expiring premium", money(c["prior"]["premium"]))])
    doc.add_heading("Loss history (5 years)", level=2)
    if c["loss_history"]:
        for loss in c["loss_history"]:
            doc.add_paragraph(f"{us_date(loss['date'])} - {loss['description']} - {money(loss['incurred'])} incurred ({loss['status']})", style="List Bullet")
    else:
        doc.add_paragraph("No losses.")
    doc.save(str(path))


# --- driver --------------------------------------------------------------------

def build(c):
    d = OUT / c["id"]
    d.mkdir(parents=True)
    slug = c["id"].split("-", 1)[1]
    fmts = c["formats"]
    loss_run = d / f"{slug}-loss-run.pdf"
    if "loss_run" in fmts:
        loss_run_pdf(c, loss_run)
    if "acord_fillable" in fmts:
        acord_pdf(c, d / f"{slug}-acord-application.pdf", fillable=True, include_126="questionnaire" not in fmts)
    if "acord_flattened" in fmts:
        acord_pdf(c, d / f"{slug}-application-scan.pdf", fillable=False)
    if "questionnaire" in fmts:
        questionnaire_pdf(c, d / f"{slug}-supplemental-questionnaire.pdf")
    if "word_application" in fmts:
        word_application(c, d / f"{slug}-application.docx")
    if "broker_email" in fmts:
        broker_email(c, d / f"{slug}-submission-email.eml", attachments=[loss_run])
        loss_run.unlink()  # it travels inside the email
    if "broker_email_sparse" in fmts:
        broker_email(c, d / f"{slug}-submission-email.eml", sparse=True)
    truth = {k: v for k, v in c.items() if k not in ("id", "formats")}
    (TRUTH / f"{c['id']}.json").write_text(json.dumps(truth, indent=2) + "\n")


def main():
    for p in (OUT, TRUTH):
        shutil.rmtree(p, ignore_errors=True)
        p.mkdir()
    for c in CASES:
        build(c)
        print(f"{c['id']}: {', '.join(sorted(f.name for f in (OUT / c['id']).iterdir()))}")


if __name__ == "__main__":
    main()
