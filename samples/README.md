# Sample submissions

Eighteen synthetic E&S contractors GL submissions, each in a different mix of
formats, the way they'd really arrive from wholesale brokers. The web app's
Submissions inbox reads this folder as the broker drop folder:

| Case | Risk | Delivered as |
|------|------|--------------|
| 01 | Commercial electrical, TX | Fillable ACORD-style 125/126 PDF + loss run |
| 02 | Residential roofing, FL/GA (tough risk: losses, 45% subbed, no sub COIs) | Fillable ACORD-style PDF + loss run |
| 03 | Commercial plumbing, GA/SC | **Flattened** ACORD-style PDF (no form fields; text only) |
| 04 | Residential finish carpentry, WA | Broker email (.eml) with loss run attached |
| 05 | Residential painting, AZ | Sparse broker email: many fields missing |
| 06 | NYC general contractor (Labor Law 240 exposure, large open claim) | ACORD-style 125 + supplemental questionnaire PDF |
| 07 | Concrete flatwork, AZ/NV | Wholesaler's own Word application (.docx) |
| 08 | Commercial HVAC, CO/WY | Fillable ACORD-style PDF + loss run |
| 09 | Tilt-wall concrete, TX (wrap-ups, $145K open slab claim) | Fillable ACORD-style PDF + loss run |
| 10 | Painting and pressure washing, SC/GA | Broker email (.eml) with loss run attached, 2 claims |
| 11 | Commercial/industrial plumbing, NJ/NY, $2M/$4M limits | **Flattened** ACORD-style PDF |
| 12 | Residential re-roofing, WA (35% subbed, no sub COIs, 3 losses, 1 open) | Fillable ACORD-style PDF + supplemental questionnaire |
| 13 | Commercial electrical and EV charging, CO/WY, $1M/$3M, clean losses | Wholesaler's Word application (.docx) |
| 14 | Commercial HVAC service, NV, 2 years in business | Sparse broker email: many fields missing |
| 15 | Miami GC, condo renovations, 80% subbed, 120 ft, $525K open claim | Fillable ACORD-style PDF + loss run |
| 16 | Finish carpentry, WY/CO, $500K/$1M, small account | Broker email with a clean loss run attached |
| 17 | Electrical and rooftop solar, NY (60% residential) | **Flattened** ACORD-style PDF |
| 18 | Concrete flatwork, GA/SC (no sub COIs, 1 open claim) | Wholesaler's Word application (.docx) |

`ground_truth/<case>.json` holds the correct extraction for each case. It's
used to score the ingestion service. Missing information is `null` or `""`.

Regenerate with:

```bash
uv run --with reportlab --with python-docx samples/generate.py          # every case
uv run --with reportlab --with python-docx samples/generate.py 09 10    # just these cases
```

Regenerate only the cases you changed: the PDFs embed today's date, so a full run
rewrites every file.

All names, addresses, and FEINs are fictitious. The forms imitate ACORD-style
layout and field naming but are not ACORD forms.
