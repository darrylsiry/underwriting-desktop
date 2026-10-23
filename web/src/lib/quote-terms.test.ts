import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, addYears, formsFor, parseSubjectivities, suggestedSubjectivities } from "./quote-terms.ts";
import type { Flag } from "./referrals.ts";
import type { SubmissionData } from "./submission.ts";

const flag = (code: string): Flag => ({ code, severity: "warn", title: code, detail: "" });
const data = (applicant: Record<string, string>) => ({ applicant } as unknown as SubmissionData);

test("subjectivities follow the file's gaps", () => {
  assert.deepEqual(
    suggestedSubjectivities([flag("NO_LOSS_RUNS"), flag("CLASS_INFERRED")], data({ street: "", zip: "", fein: "86-1" })),
    [
      "Signed and dated application",
      "Five years of currently valued loss runs, satisfactory to the company",
      "Confirmation of operations and class code",
      "Complete named insured details (street, zip)",
    ],
  );
  assert.deepEqual(suggestedSubjectivities([], data({ street: "1 Main", zip: "1", fein: "1" })), ["Signed and dated application"]);
});

test("dates", () => {
  assert.equal(addYears("2026-11-01", 1), "2027-11-01");
  assert.equal(addDays("2026-12-15", 30), "2027-01-14");
});

test("subjectivity lines are cleaned", () => {
  assert.deepEqual(parseSubjectivities("1. Signed app\n- Loss runs\n\n• COIs \n5 years of loss runs\n2) Survey"),
    ["Signed app", "Loss runs", "COIs", "5 years of loss runs", "Survey"]);
});

test("forms follow the exposures", () => {
  const base = { states: ["TX"], subcontracted_pct: 0, residential_pct: 0, class_code: "92215" };
  assert.equal(formsFor(base).length, 4);
  const ny = formsFor({ states: ["NY", "NJ"], subcontracted_pct: 75, residential_pct: 20, class_code: "91583" });
  assert.ok(ny.some((f) => f.startsWith("Action Over")) && ny.some((f) => f.startsWith("Independent Contractors")));
});
