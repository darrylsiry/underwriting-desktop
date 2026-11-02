"""Deterministic extraction from fillable ACORD-style PDFs (125/126 field names).

Form fields are read exactly as the broker typed them, so they get confidence
1.0 and never cost an API call.
"""
from typing import TYPE_CHECKING

from app.schema import FieldValue, Loss, NormalizeError, normalize, to_date, to_int

if TYPE_CHECKING:
    from app.documents import Document  # documents.py imports this module to decide what reaches extract()

FIELD_MAP = {
    "Producer_FullName_A": "producer.agency",
    "Producer_ContactPerson_FullName_A": "producer.contact",
    "Producer_ContactPerson_PhoneNumber_A": "producer.phone",
    "Producer_ContactPerson_EmailAddress_A": "producer.email",
    "Policy_EffectiveDate_A": "policy.effective_date",
    "Policy_ExpirationDate_A": "policy.expiration_date",
    "NamedInsured_FullName_A": "applicant.name",
    "NamedInsured_DBA_A": "applicant.dba",
    "NamedInsured_MailingAddress_LineOne_A": "applicant.street",
    "NamedInsured_MailingAddress_CityName_A": "applicant.city",
    "NamedInsured_MailingAddress_StateOrProvinceCode_A": "applicant.state",
    "NamedInsured_MailingAddress_PostalCode_A": "applicant.zip",
    "NamedInsured_TaxIdentifier_A": "applicant.fein",
    "NamedInsured_LegalEntity_A": "applicant.entity_type",
    "NamedInsured_BusinessStartYears_A": "applicant.years_in_business",
    "NamedInsured_Primary_WebsiteAddress_A": "applicant.website",
    "CommercialPolicy_OperationsDescription_A": "operations.description",
    "PriorCoverage_GeneralLiability_InsurerFullName_A": "prior.carrier",
    "PriorCoverage_GeneralLiability_TotalPremiumAmount_A": "prior.premium",
    "GeneralLiability_EachOccurrence_LimitAmount_A": "policy.occurrence_limit",
    "GeneralLiability_GeneralAggregate_LimitAmount_A": "policy.aggregate_limit",
    "GeneralLiability_ProductsAndCompletedOperations_AggregateLimitAmount_A": "policy.products_aggregate_limit",
    "GeneralLiability_PropertyDamage_DeductibleAmount_A": "policy.deductible",
    "GeneralLiability_Hazard_ClassCode_A": "operations.class_code",
    "GeneralLiability_Hazard_Exposure_A": "operations.gross_receipts",
    "GeneralLiability_Hazard_LocationStates_A": "operations.states",
    "GeneralLiability_Contractor_PayrollAmount_A": "operations.payroll",
    "GeneralLiability_Contractor_EmployeeCount_A": "operations.employees",
    "GeneralLiability_Contractor_SubcontractedPercent_A": "operations.subcontracted_pct",
    "GeneralLiability_Contractor_SubcontractorCertificateIndicator_A": "operations.subcontractor_coi_required",
    "GeneralLiability_Contractor_WrapUpIndicator_A": "operations.wrap_up_projects",
    "GeneralLiability_Contractor_ResidentialPercent_A": "operations.residential_pct",
    "GeneralLiability_Contractor_NewConstructionPercent_A": "operations.new_construction_pct",
    "GeneralLiability_Contractor_MaximumHeightFeet_A": "operations.max_height_ft",
}


LOSS_ROWS = "ABCDEF"
LOSS_COLUMNS = ("OccurrenceDate", "OccurrenceDescription", "TotalIncurredAmount", "ClaimStatusCode")


def has_mapped_fields(form_fields: dict[str, str]) -> bool:
    """Whether any field this module reads is filled, so extract() has something to return."""
    return any(v and (k in FIELD_MAP or k.startswith("LossHistory_")) for k, v in form_fields.items())


def extract(doc: "Document") -> tuple[list[FieldValue], list[Loss], list[str]]:
    """Return (field values, loss rows, warnings) from a fillable ACORD-style PDF."""
    values, warnings = [], []
    for name, path in FIELD_MAP.items():
        raw = doc.form_fields.get(name, "")
        try:
            value = normalize(path, raw)
        except NormalizeError as e:
            warnings.append(f"{doc.filename}: {e}")
            continue
        if value is not None:
            values.append(FieldValue(path, value, 1.0, "form_field", "stated", doc.filename, f"{name} = {raw}"))

    losses = []
    for row in LOSS_ROWS:
        when, description, incurred, status = (doc.form_fields.get(f"LossHistory_{name}_{row}", "") for name in LOSS_COLUMNS)
        if not (when or description or incurred or status):
            continue
        if not when:
            warnings.append(f"{doc.filename}: loss row {row} has no date and was not read "
                            f"({description or 'no description'}, {incurred or 'no amount'})")
            continue
        try:
            losses.append(Loss(to_date(when), description, to_int(incurred or "0"), status, doc.filename))
        except NormalizeError as e:
            warnings.append(f"{doc.filename}: loss row {row}: {e}")
            continue
        if not incurred:
            warnings.append(f"{doc.filename}: loss row {row} has no amount and was read as $0 "
                            f"({when}, {description or 'no description'})")
    return values, losses, warnings
