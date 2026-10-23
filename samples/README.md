# Sample submissions

Eight synthetic E&S contractors GL submissions, each in a different mix of
formats, the way they'd really arrive from wholesale brokers:

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

`ground_truth/<case>.json` holds the correct extraction for each case. It's
used to score the ingestion service. Missing information is `null` or `""`.

Regenerate with:

```bash
uv run --with reportlab --with python-docx samples/generate.py
```

All names, addresses, and FEINs are fictitious. The forms imitate ACORD-style
layout and field naming but are not ACORD forms.
