"""Score the ingestion pipeline against samples/ground_truth.

Run from the repo root:
    uv run --project services/ingestion python services/ingestion/eval_samples.py [case-prefix ...]

Prints per-case field accuracy, every miss, and how well confidence separates
right from wrong answers. Calls Claude once per case (in parallel).
"""

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from app.pipeline import ingest  # noqa: E402
from app.schema import FIELDS  # noqa: E402

SAMPLES = Path(__file__).resolve().parents[2] / "samples"


def norm(path, v):
    if v in (None, "", []):
        return None
    if isinstance(v, str):
        return " ".join(v.lower().replace(".", "").replace(",", "").split())
    if isinstance(v, list):
        return sorted(v)
    return v


def score(case: str) -> dict:
    files = [(p.name, p.read_bytes()) for p in sorted((SAMPLES / "submissions" / case).iterdir())]
    truth = json.loads((SAMPLES / "ground_truth" / f"{case}.json").read_text())
    result = ingest(files)
    rows = []
    for f in result["fields"]:
        section, key = f["path"].split(".")
        want, got = truth[section][key], f["value"]
        if f["path"] == "operations.description":  # free text: only check presence
            ok = (want in (None, "")) == (got in (None, ""))
        else:
            ok = norm(f["path"], want) == norm(f["path"], got)
        rows.append({"path": f["path"], "ok": ok, "want": want, "got": got, "confidence": f["confidence"],
                     "method": f["method"], "source": f["source"]})
    want_losses = sorted((l["date"], l["incurred"]) for l in truth["loss_history"])
    got_losses = sorted((l["date"], l["incurred"]) for l in result["submission"]["loss_history"])
    return {"case": case, "rows": rows, "losses_ok": want_losses == got_losses, "want_losses": want_losses,
            "got_losses": got_losses, "warnings": result["warnings"], "elapsed_ms": result["elapsed_ms"]}


def main():
    cases = sorted(p.stem for p in (SAMPLES / "ground_truth").glob("*.json"))
    if len(sys.argv) > 1:
        cases = [c for c in cases if any(c.startswith(a) for a in sys.argv[1:])]
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(score, cases))

    right = wrong = 0
    conf_right, conf_wrong = [], []
    for r in results:
        n_ok = sum(x["ok"] for x in r["rows"])
        right += n_ok
        wrong += len(r["rows"]) - n_ok
        print(f"\n{r['case']}: {n_ok}/{len(r['rows'])} fields, losses {'ok' if r['losses_ok'] else 'MISMATCH'}"
              f", {r['elapsed_ms'] / 1000:.1f}s")
        for w in r["warnings"]:
            print(f"  ! {w}")
        if not r["losses_ok"]:
            print(f"  losses: want {r['want_losses']} got {r['got_losses']}")
        for x in r["rows"]:
            if x["got"] not in (None, "", []):
                (conf_right if x["ok"] else conf_wrong).append(x["confidence"])
            if not x["ok"]:
                print(f"  x {x['path']}: want {x['want']!r} got {x['got']!r} "
                      f"({x['confidence']:.2f} {x['method']}: {(x['source'] or '')[:80]})")
    total = right + wrong
    print(f"\nOverall: {right}/{total} fields correct ({100 * right / total:.1f}%), "
          f"loss histories {sum(r['losses_ok'] for r in results)}/{len(results)}")
    if conf_right:
        print(f"Mean confidence when right: {sum(conf_right) / len(conf_right):.2f} (n={len(conf_right)})")
    if conf_wrong:
        print(f"Mean confidence when wrong: {sum(conf_wrong) / len(conf_wrong):.2f} (n={len(conf_wrong)})")
    assert len(FIELDS) * len(results) == total


if __name__ == "__main__":
    main()
