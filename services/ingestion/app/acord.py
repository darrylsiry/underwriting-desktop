"""Deterministic extraction from fillable ACORD-style PDFs (AcroForm fields)."""

from .documents import Document
from .schema import coerce, is_blank

FIELD_MAP = {
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
    "Producer_FullName_A": "producer.agency",
    "Producer_ContactPerson_FullName_A": "producer.contact",
    "Producer_ContactPerson_EmailAddress_A": "producer.email",
    "Producer_ContactPerson_PhoneNumber_A": "producer.phone",
    "Policy_EffectiveDate_A": "policy.effective_date",
    "Policy_ExpirationDate_A": "policy.expiration_date",
    "GeneralLiability_EachOccurrence_LimitAmount_A": "policy.occurrence_limit",
    "GeneralLiability_GeneralAggregate_LimitAmount_A": "policy.aggregate_limit",
    "GeneralLiability_ProductsAndCompletedOperations_AggregateLimitAmount_A": "policy.products_aggregate_limit",
    "GeneralLiability_PropertyDamage_DeductibleAmount_A": "policy.deductible",
    "CommercialPolicy_OperationsDescription_A": "operations.description",
    "GeneralLiability_Hazard_ClassCode_A": "operations.class_code",
    "GeneralLiability_Hazard_LocationStates_A": "operations.states",
    "GeneralLiability_Hazard_Exposure_A": "operations.gross_receipts",
    "GeneralLiability_Contractor_PayrollAmount_A": "operations.payroll",
    "GeneralLiability_Contractor_EmployeeCount_A": "operations.employees",
    "GeneralLiability_Contractor_SubcontractedPercent_A": "operations.subcontracted_pct",
    "GeneralLiability_Contractor_SubcontractorCertificateIndicator_A": "operations.subcontractor_coi_required",
    "GeneralLiability_Contractor_ResidentialPercent_A": "operations.residential_pct",
    "GeneralLiability_Contractor_NewConstructionPercent_A": "operations.new_construction_pct",
    "GeneralLiability_Contractor_MaximumHeightFeet_A": "operations.max_height_ft",
    "GeneralLiability_Contractor_WrapUpIndicator_A": "operations.wrap_up_projects",
    "PriorCoverage_GeneralLiability_InsurerFullName_A": "prior.carrier",
    "PriorCoverage_GeneralLiability_TotalPremiumAmount_A": "prior.premium",
}


def extract(doc: Document) -> tuple[list[dict], list[dict]]:
    """Return (field candidates, loss rows) read straight from form fields."""
    fields = []
    for name, path in FIELD_MAP.items():
        raw = doc.form_fields.get(name, "")
        value = coerce(path, raw)
        if is_blank(value):
            continue
        fields.append({
            "path": path, "value": value, "confidence": 1.0, "method": "form_field",
            "document": doc.filename, "source": f"{name} = {raw!r}",
        })
    losses = []
    for row in "ABCDEFGH":
        when = doc.form_fields.get(f"LossHistory_OccurrenceDate_{row}", "")
        if not when:
            continue
        losses.append({
            "date": coerce("policy.effective_date", when),
            "description": doc.form_fields.get(f"LossHistory_OccurrenceDescription_{row}", ""),
            "incurred": coerce("prior.premium", doc.form_fields.get(f"LossHistory_TotalIncurredAmount_{row}", "")),
            "status": doc.form_fields.get(f"LossHistory_ClaimStatusCode_{row}", ""),
            "confidence": 1.0, "method": "form_field", "document": doc.filename,
            "source": f"LossHistory row {row}",
        })
    return fields, losses
