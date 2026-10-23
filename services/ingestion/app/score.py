"""Score extraction against samples/ground_truth.

    docker compose exec ingestion python -m app.score /samples [--case 04] [--no-claude] [-v]

For each case: fields the ground truth has (correct / wrong / missed), values we
filled where the ground truth is empty (extra), and loss rows matched by date
and amount. Runs the same pipeline as POST /extract, so it calls Claude unless
--no-claude is given.
"""
import argparse
import json
import re
from pathlib import Path

from app import pipeline
from app.main import rateable_classes
from app.schema import FIELDS


def same(path: str, expected, actual) -> bool:
    if isinstance(expected, str) and isinstance(actual, str):
        e, a = (re.sub(r"[^a-z0-9]", "", s.lower()) for s in (expected, actual))
        if path == "operations.description":  # wording may be trimmed; compare words
            ew, aw = set(expected.lower().split()), set(actual.lower().split())
            return len(ew & aw) / max(len(ew), 1) >= 0.8
        return e == a
    if isinstance(expected, list) and isinstance(actual, list):
        return sorted(expected) == sorted(actual)
    return expected == actual


def score_case(case_dir: Path, truth: dict, classes: list[dict], use_claude: bool) -> dict:
    files = [(p.name, p.read_bytes()) for p in sorted(case_dir.iterdir()) if p.is_file() and not p.name.startswith(".")]
    result = pipeline.run(files, classes, use_claude=use_claude)
    got = result["submission"]
    rows = {"correct": [], "wrong": [], "missed": [], "extra": []}
    for path in FIELDS:
        section, name = path.split(".")
        expected, actual = truth[section][name], got[section][name]
        empty_e, empty_a = expected in (None, ""), actual in (None, "")
        if empty_e and empty_a:
            continue
        if empty_e:
            rows["extra"].append((path, expected, actual))
        elif empty_a:
            rows["missed"].append((path, expected, actual))
        elif same(path, expected, actual):
            rows["correct"].append((path, expected, actual))
        else:
            rows["wrong"].append((path, expected, actual))
    want = {(l["date"], l["incurred"]) for l in truth["loss_history"]}
    have = {(l["date"], l["incurred"]) for l in got["loss_history"]}
    return {"rows": rows, "losses": (len(want & have), len(want), len(have - want)), "result": result}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("samples", type=Path)
    ap.add_argument("--case", help="only cases whose folder starts with this, e.g. 04")
    ap.add_argument("--no-claude", action="store_true")
    ap.add_argument("-v", "--verbose", action="store_true", help="print every wrong/missed/extra value")
    args = ap.parse_args()

    classes = rateable_classes()
    totals = {"correct": 0, "wrong": 0, "missed": 0, "extra": 0}
    print(f"{'case':28} {'correct':>8} {'wrong':>6} {'missed':>7} {'extra':>6}  losses   tokens in/out")
    for case_dir in sorted((args.samples / "submissions").iterdir()):
        if not case_dir.is_dir() or (args.case and not case_dir.name.startswith(args.case)):
            continue
        truth = json.loads((args.samples / "ground_truth" / f"{case_dir.name}.json").read_text())
        s = score_case(case_dir, truth, classes, not args.no_claude)
        for k in totals:
            totals[k] += len(s["rows"][k])
        usage = (s["result"]["claude"] or {}).get("usage", {})
        matched, want, extra_losses = s["losses"]
        print(f"{case_dir.name:28} {len(s['rows']['correct']):>8} {len(s['rows']['wrong']):>6} "
              f"{len(s['rows']['missed']):>7} {len(s['rows']['extra']):>6}  {matched}/{want}"
              f"{f' +{extra_losses}' if extra_losses else '':4} {usage.get('input_tokens', '-')}/{usage.get('output_tokens', '-')}")
        if args.verbose:
            for kind in ("wrong", "missed", "extra"):
                for path, expected, actual in s["rows"][kind]:
                    print(f"    {kind:6} {path}: expected {expected!r}, got {actual!r}")
            for w in s["result"]["warnings"]:
                print(f"    warning: {w}")
    graded = totals["correct"] + totals["wrong"] + totals["missed"]
    print(f"\nAccuracy on ground-truth fields: {totals['correct']}/{graded} = {totals['correct'] / max(graded, 1):.1%}"
          f"  (wrong {totals['wrong']}, missed {totals['missed']}, extra {totals['extra']})")


if __name__ == "__main__":
    main()
