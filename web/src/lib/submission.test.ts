import assert from "node:assert/strict";
import { test } from "node:test";
import { FIELD_DEFS, REQUIRED_FOR_RATING, SECTIONS, attention, formatValue, fromInput, getPath, isEmpty, sameValue, setPath, toInput, type FieldDef, type FieldMeta, type FieldType, type SubmissionData, type Value } from "./submission.ts";

// CR-014: what an underwriter types on the intake review becomes the submission of record.

const def = (type: FieldType, label = "Field"): FieldDef => ({ path: "x.y", label, type });
const meta = (o: Partial<FieldMeta> = {}): FieldMeta => ({ value: "v", confidence: 0.95, method: "form_field", basis: "stated", source_document: "a.pdf", snippet: "", ...o });

test("blank input: an empty string for text, nothing for everything else", () => {
  assert.equal(fromInput(def("str"), "   "), "");
  for (const t of ["state", "states", "int", "money", "pct", "bool", "date"] as const) assert.equal(fromInput(def(t), "  "), null, t);
});

test("text is trimmed and otherwise kept", () => {
  assert.equal(fromInput(def("str"), "  Hill Country Carpentry, LLC  "), "Hill Country Carpentry, LLC");
});

test("a state is two letters, upper-cased", () => {
  assert.equal(fromInput(def("state"), " tx "), "TX");
  for (const bad of ["T", "TEX", "T1", "New York"]) assert.throws(() => fromInput(def("state", "Home state"), bad), /Home state: use a 2-letter state code/, bad);
});

test("a state list takes any separator, upper-cases and drops repeats", () => {
  assert.deepEqual(fromInput(def("states"), "tx, nm; AZ/co  tx"), ["TX", "NM", "AZ", "CO"]);
  assert.throws(() => fromInput(def("states", "States"), "TX, Texas"), /States: use 2-letter state codes/);
});

test("numbers accept how brokers type them, and round to whole units", () => {
  assert.equal(fromInput(def("money"), "$1,250,000"), 1_250_000);
  assert.equal(fromInput(def("money"), " 2,500.50 "), 2501);
  assert.equal(fromInput(def("int"), "12"), 12);
  assert.equal(fromInput(def("pct"), "35%"), 35);
  assert.equal(fromInput(def("money"), "0"), 0);
});

test("anything that isn't a sensible number is refused, naming the field", () => {
  for (const bad of ["abc", "12k", "-5", "$-100", "1.2.3", "Infinity"]) assert.throws(() => fromInput(def("money", "Receipts"), bad), /^Error: Receipts: ".*" is not a number$/, bad);
  assert.throws(() => fromInput(def("pct", "Subcontracted"), "101"), /Subcontracted: must be 0–100/);
  assert.equal(fromInput(def("pct"), "100"), 100);
});

test("yes and no, in the forms people use", () => {
  for (const y of ["y", "Y", "yes", "YES", "true"]) assert.equal(fromInput(def("bool"), y), true, y);
  for (const n of ["n", "No", "false"]) assert.equal(fromInput(def("bool"), n), false, n);
  assert.throws(() => fromInput(def("bool", "COIs"), "maybe"), /COIs: answer yes or no/);
});

test("a date is YYYY-MM-DD", () => {
  assert.equal(fromInput(def("date"), " 2026-12-01 "), "2026-12-01");
  for (const bad of ["12/01/2026", "2026-1-1", "2026-13-45", "soon"]) assert.throws(() => fromInput(def("date", "Effective"), bad), /Effective: use YYYY-MM-DD/, bad);
});

test("what an input shows parses back to the same value, for every kind of field", () => {
  const samples: [FieldType, Value][] = [["str", "Acme"], ["state", "TX"], ["states", ["TX", "NM"]], ["int", 12], ["money", 1_250_000], ["pct", 35], ["bool", true], ["bool", false], ["date", "2026-12-01"]];
  for (const [t, v] of samples) assert.deepEqual(fromInput(def(t), toInput(t, v)), v, t);
  assert.equal(toInput("money", null), "");
});

test("sameValue treats every kind of empty alike", () => {
  assert.ok(sameValue("", null));
  assert.ok(sameValue(null, []));
  assert.ok(sameValue(["TX"], ["TX"]));
  assert.ok(!sameValue(["TX"], ["NM"]));
  assert.ok(!sameValue(0, null), "zero is an answer");
  assert.ok(!sameValue(false, null), "so is no");
  assert.ok(!isEmpty(0) && !isEmpty(false) && isEmpty("") && isEmpty(null) && isEmpty([]));
});

test("getPath and setPath read and write one field, and a missing section reads as empty", () => {
  const data = { applicant: { name: "Acme" }, loss_history: [] } as unknown as SubmissionData;
  assert.equal(getPath(data, "applicant.name"), "Acme");
  assert.equal(getPath(data, "operations.class_code"), null);
  setPath(data, "applicant.state", "TX");
  assert.equal(getPath(data, "applicant.state"), "TX");
  assert.equal(getPath(data, "applicant.name"), "Acme");
});

test("attention says why a field needs a look, most pressing first", () => {
  const required = REQUIRED_FOR_RATING[0];
  assert.equal(attention(required, "", undefined, false), "Required for rating");
  assert.equal(attention("applicant.dba", "", undefined, false), null);
  assert.equal(attention(required, "Acme", meta({ basis: "inferred", confidence: 0.2 }), true), "Documents disagree");
  assert.equal(attention(required, "Acme", meta({ basis: "inferred", confidence: 0.2 }), false), "Inferred, not stated");
  assert.equal(attention(required, "Acme", meta({ confidence: 0.89 }), false), "Low confidence");
  assert.equal(attention(required, "Acme", meta({ confidence: 0.9 }), false), null);
  assert.equal(attention(required, "Acme", undefined, false), null);
});

test("values read back the way the review screen shows them", () => {
  assert.equal(formatValue("money", 1_250_000), "$1,250,000");
  assert.equal(formatValue("pct", 35), "35%");
  assert.equal(formatValue("bool", false), "no");
  assert.equal(formatValue("states", ["TX", "NM"]), "TX, NM");
  assert.equal(formatValue("str", ""), "—");
});

test("every section's fields are in FIELD_DEFS, one path each", () => {
  const paths = FIELD_DEFS.map((d) => d.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.deepEqual(paths, SECTIONS.flatMap((s) => s.fields.map((f) => f.path)));
});
