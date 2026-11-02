"""What the web tier and the sample generator mirror by hand, written out as data.

samples/schema.json is this module's output. Tests on both sides assert against it (tests/test_ingestion.py
and web/src/lib/submission.test.ts), so a change on one side fails until the other side follows. After a
deliberate change, from services/ingestion:

    python -m app.contract > ../../samples/schema.json
"""
import json

from app.acord import FIELD_MAP, LOSS_COLUMNS
from app.schema import FIELDS, REQUIRED_FOR_RATING


def contract() -> dict:
    return {
        "fields": FIELDS,
        "required_for_rating": REQUIRED_FOR_RATING,
        "acord_fields": FIELD_MAP,
        "loss_columns": list(LOSS_COLUMNS),
    }


if __name__ == "__main__":
    print(json.dumps(contract(), indent=2))
