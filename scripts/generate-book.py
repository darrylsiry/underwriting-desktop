"""Generate the seeded in-force book: policies each underwriter already wrote in the prior policy system.

    python3 scripts/generate-book.py > web/migrations/policy/004_book_policies.sql
    python3 scripts/generate-book.py --renewal-columns > web/migrations/policy/005_book_rating_inputs.sql

The second form needs the rating service's code and database (run it from services/rating with its
venv and DATABASE_URL set): it picks rating inputs for each policy and computes the premium with the
real rating engine on rate version 2026.1, so a renewal can re-rate and compare the expiring policy
factor by factor. It never changes the first form's output.

    python3 scripts/generate-book.py --loss-experience > web/migrations/policy/016_book_loss_experience.sql
    python3 scripts/generate-book.py --renewal-losses > web/migrations/customer/007_book_renewal_losses.sql

These two set each policy's claims against five years of its rated premium, reading the premiums from
migration 005, so they need no database. They don't change the first two forms' output either.

The UW Desktop has only written a few policies itself, so without this the home page would have no
book and no renewals. Rows are deterministic (fixed seed). Dates are relative to the day the
migration runs (CURRENT_DATE + n), so renewals are always upcoming in a fresh demo. All names are
fictitious.
"""
import json
import random
import re
import sys
from pathlib import Path

rng = random.Random(20261023)
RENEWAL_COLUMNS = "--renewal-columns" in sys.argv
LOSS_EXPERIENCE = "--loss-experience" in sys.argv
RENEWAL_LOSSES = "--renewal-losses" in sys.argv
EXPIRING_RATE_VERSION = "2026.1"

UNDERWRITERS = [f"underwriter{i}" for i in range(1, 10)]

# class code -> (description, trade words for names, premium range)
CLASSES = {
    "91342": ("Carpentry - residential (interior finish)", ["Finish Carpentry", "Millwork", "Cabinet & Trim"], (6_000, 40_000)),
    "91560": ("Concrete construction (flatwork, foundations)", ["Concrete", "Flatwork", "Foundations"], (15_000, 140_000)),
    "91583": ("General contractor - remodel / renovation", ["Builders", "Construction", "Renovations"], (40_000, 420_000)),
    "92215": ("Electrical work - within buildings", ["Electric", "Electrical Contractors", "Power & Lighting"], (12_000, 110_000)),
    "97050": ("HVAC systems - commercial", ["Mechanical", "Air Systems", "HVAC Services"], (8_000, 75_000)),
    "98304": ("Painting - exterior / interior", ["Painting", "Coatings", "Painting & Restoration"], (5_000, 45_000)),
    "98482": ("Plumbing - commercial and industrial", ["Plumbing", "Pipe & Mechanical", "Plumbing Services"], (15_000, 160_000)),
    "98677": ("Roofing - residential", ["Roofing", "Roof Systems", "Exteriors"], (30_000, 260_000)),
}

STATES = ["TX", "FL", "GA", "SC", "AZ", "NV", "CO", "WY", "WA", "NY", "NJ"]
NEIGHBORS = {"TX": ["TX"], "FL": ["FL", "GA"], "GA": ["GA", "SC"], "SC": ["SC", "GA"], "AZ": ["AZ", "NV"],
             "NV": ["NV", "AZ"], "CO": ["CO", "WY"], "WY": ["WY", "CO"], "WA": ["WA"], "NY": ["NY", "NJ"], "NJ": ["NJ", "NY"]}
PLACES = {
    "TX": ["Brazos", "Hill Country", "Gulf Plains", "Pecos", "Trinity"], "FL": ["Suncoast", "Palm Harbor", "Everglades", "Gulf Breeze"],
    "GA": ["Chattahoochee", "Savannah River", "Blue Ridge"], "SC": ["Palmetto", "Lowcountry", "Congaree"],
    "AZ": ["Saguaro", "Mesa Verde", "Red Rock", "Sonoran"], "NV": ["Silver State", "High Desert", "Tahoe"],
    "CO": ["Summit", "Pikes Peak", "Front Range", "Aspen Grove"], "WY": ["Wind River", "Teton", "Bighorn"],
    "WA": ["Cascade", "Olympic", "Puget", "Rainier"], "NY": ["Hudson", "Empire", "Adirondack", "Finger Lakes"],
    "NJ": ["Garden State", "Pinelands", "Raritan"],
}
PRODUCERS = ["Alamo Specialty Brokers", "Big Sky Brokerage Group", "Catskill Specialty Agency", "Copper State Insurance Group",
             "Coral Gables Excess & Surplus", "Desert Peak Insurance Services", "Evergreen Wholesale Brokers",
             "Front Range Wholesale", "Hill Country Insurance Partners", "Lowcountry Wholesale Insurance",
             "Metro Excess & Surplus", "Puget Sound E&S", "Southern Risk Advisors", "Sunshine State Brokerage",
             "Turnpike Risk Partners"]
ENTITY = ["LLC", "Inc.", "Co.", "Group LLC", "Corp."]


def q(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"



# --- Rating inputs for each policy, priced by the real engine (migration 005) ------------------

LIMITS = ["1000000/2000000", "1000000/2000000", "1000000/2000000", "500000/1000000", "1000000/3000000", "2000000/4000000"]
DEDUCTIBLES = [0, 0, 1000, 2500, 2500, 5000, 10000, 25000]
# class -> (residential % choices, subcontracted % choices, max height choices)
EXPOSURE = {
    "91342": ([76, 100, 100], [0, 5, 10], [10, 12, 15]),
    "91560": ([0, 10, 30], [0, 10, 25], [0, 0, 10]),
    "91583": ([20, 40, 60], [50, 60, 75], [25, 30, 45]),
    "92215": ([0, 0, 15], [5, 10, 15], [20, 30, 30]),
    "97050": ([0, 0, 10], [10, 15, 25], [20, 30, 40]),
    "98304": ([60, 80, 100], [0, 10, 20], [15, 25, 30]),
    "98482": ([0, 10, 25], [10, 15, 30], [15, 20, 30]),
    "98677": ([76, 90, 100], [25, 40, 50], [30, 35, 45]),
}
SCHEDULE_REASONS = {
    "safety": (-5, "Written safety program with documented jobsite inspections"),
    "management": (-5, "Owner-managed with 15+ years in the trade"),
    "subcontractor_controls": (5, "Certificates of insurance collected inconsistently"),
    "loss_experience": (5, "Two liability claims in the last three years"),
}


def renewal_columns() -> None:
    from decimal import Decimal

    from app.engine import RatingInput, rate
    from app.db import pool
    from app.repository import load_tables

    rng2 = random.Random(20261030)  # separate stream: the first pass's names and dates stay the same
    pool.open(wait=True)
    with pool.connection() as conn:
        row = conn.execute("SELECT id FROM rate_versions WHERE label = %s", (EXPIRING_RATE_VERSION,)).fetchone()
    if row is None:
        sys.exit(f"rate version {EXPIRING_RATE_VERSION} not found in the rating database")
    tables = load_tables(row["id"])

    updates = []
    for number, code, states, home, (lo, hi) in policies:
        res_pct, sub_pct, heights = EXPOSURE[code]
        subcontracted = rng2.choice(sub_pct)
        occ, agg = (int(x) for x in rng2.choice(LIMITS).split("/"))
        inputs = {
            "class_code": code, "states": states, "home_state": home,
            "occurrence_limit": occ, "aggregate_limit": agg, "deductible": rng2.choice(DEDUCTIBLES),
            "residential_pct": rng2.choice(res_pct), "subcontracted_pct": subcontracted,
            "subcontractor_coi_required": subcontracted == 0 or rng2.random() < 0.85,
            "max_height_ft": rng2.choice(heights), "experience_mod": 1,
        }
        schedule = []
        if rng2.random() < 0.3:
            category = rng2.choice(list(SCHEDULE_REASONS))
            pct, rationale = SCHEDULE_REASONS[category]
            schedule.append({"category": category, "pct": pct, "rationale": rationale})
        schedule_mod = Decimal(1) + Decimal(sum(s["pct"] for s in schedule)) / 100

        # Premium scales with receipts (above the class minimum): rate $1M of receipts once, then
        # size the receipts so the premium lands in the class's range, rounded to $10,000.
        target = rng2.uniform(lo, hi)
        probe = rate(tables, RatingInput(gross_receipts=1_000_000, schedule_mod=schedule_mod, **inputs))
        receipts = max(100_000, round(1_000_000 * target / float(probe.premium) / 10_000) * 10_000)
        inputs["gross_receipts"] = receipts
        result = rate(tables, RatingInput(schedule_mod=schedule_mod, **inputs))
        updates.append(
            f"UPDATE book_policies SET rating_inputs = {q(json.dumps(inputs))}::jsonb, schedule = {q(json.dumps(schedule))}::jsonb,"
            f" rate_version = {q(EXPIRING_RATE_VERSION)}, premium = {result.premium} WHERE policy_number = {q(number)};"
        )

    print(f"""-- Rating inputs for the prior-system book, priced by the rating engine on rate version {EXPIRING_RATE_VERSION}
-- (generated by scripts/generate-book.py --renewal-columns). A renewal starts from these inputs, so the
-- expiring premium can be reproduced factor by factor and compared with the renewing terms.
ALTER TABLE book_policies ADD COLUMN rating_inputs jsonb;
ALTER TABLE book_policies ADD COLUMN schedule jsonb NOT NULL DEFAULT '[]';
ALTER TABLE book_policies ADD COLUMN rate_version text;
ALTER TABLE book_policies ADD COLUMN renewal_submission_id uuid;   -- the renewal submission (customer DB), once started

-- Policies written here can be renewed too; the renewal is a submission of kind 'renewal'.
ALTER TABLE policies ADD COLUMN renewal_status text NOT NULL DEFAULT 'not_started'
    CHECK (renewal_status IN ('not_started', 'in_progress', 'renewed', 'non_renewed'));
ALTER TABLE policies ADD COLUMN renewal_submission_id uuid;
ALTER TABLE policies ADD COLUMN renewed_from jsonb;                -- {{source, policy_id, policy_number}} when this policy is a renewal

-- A renewal quote carries a memo to the insured explaining what changed.
ALTER TABLE quotes ADD COLUMN memo_pdf bytea;
ALTER TABLE quotes ADD COLUMN renewal_summary jsonb;
""")
    print("\n".join(updates))


# --- Loss experience against five years of rated premium (migrations policy/016, customer/007) ------

# Each login sees only its own desk, so every desk runs about 25%, not just the book as a whole.
DESK_LOSS_RATIO = dict(zip(UNDERWRITERS, [0.25, 0.26, 0.24, 0.255, 0.245, 0.25, 0.265, 0.24, 0.255]))
EXPIRY_GROUPS = 4              # a desk's policies by expiry; each group runs at the desk's ratio, so it holds as policies expire
MIN_SHARE_WITH_CLAIMS = 0.45   # of a group's premium; below this a few accounts would have to carry all its losses
OPEN_SHARE = 0.25              # GL claims stay open for years, so about a quarter of five years' claims are still open
MAX_AVG_CLAIM = 0.6            # of the occurrence limit
MAX_POLICY_LOSS_RATIO = 1.3
HAZARD = {"98677": 1.4, "91583": 1.2, "91560": 1.0, "98482": 1.0, "92215": 0.9, "97050": 0.9, "91342": 0.8, "98304": 0.7}
SEVERITY = [0.25, 0.4, 0.6, 0.8, 1.0, 1.3, 1.8, 3.0]
# The renewals walked through in the build log (step-16): no new referral may get in the demo's way.
DEMO_SCRIPT = {"GL-25-70001", "GL-25-70008"}


def rated_book() -> dict:
    """Premium, occurrence limit and schedule per policy, as migration 005 left them."""
    sql = (Path(__file__).parent.parent / "web/migrations/policy/005_book_rating_inputs.sql").read_text()
    pattern = r"rating_inputs = '(.*?)'::jsonb, schedule = '(.*?)'::jsonb, rate_version = '[^']*', premium = (\d+) WHERE policy_number = '([^']+)'"
    return {number: {"premium": int(premium), "occurrence": json.loads(inputs)["occurrence_limit"], "schedule": [s["category"] for s in json.loads(schedule)]}
            for inputs, schedule, premium, number in re.findall(pattern, sql)}


def claim_count(p: dict) -> int:
    """The seed's count where it holds: an account writing this much isn't clean for five years, and a loss-experience debit quotes two claims."""
    sized = 3 if p["premium"] >= 250_000 else 2 if p["premium"] >= 150_000 else 0
    return max(p["claims"], sized, 2 if "loss_experience" in p["schedule"] else 0)


def loss_experience() -> dict:
    """policy_number -> {claims, incurred, open_claims}. Deterministic (fixed seed)."""
    # A separate stream, and a chosen seed: every desk stays within about 5 points of its target for 120 days,
    # underwriter1, the desk on the public screenshot, reads 24-26% for 90, the heavier trades run worse than the
    # lighter ones, and no two accounts on a desk show the same amount.
    rng3 = random.Random(20275475)
    rated = rated_book()
    out = {}
    for uw, target in DESK_LOSS_RATIO.items():
        desk = sorted(({**p, **rated[p["number"]]} for p in book if p["underwriter"] == uw), key=lambda p: (p["days"], p["number"]))
        for g in range(EXPIRY_GROUPS):
            group = desk[g * len(desk) // EXPIRY_GROUPS: (g + 1) * len(desk) // EXPIRY_GROUPS]
            claims = {p["number"]: claim_count(p) for p in group}
            total = sum(p["premium"] for p in group)
            for p in sorted((p for p in group if not claims[p["number"]]), key=lambda p: -p["premium"]):
                if sum(q["premium"] for q in group if claims[q["number"]]) >= MIN_SHARE_WITH_CLAIMS * total:
                    break
                claims[p["number"]] = 2 if p["premium"] > 100_000 else 1

            # Share the group's losses by size, hazard and luck. What a policy can't take goes to the others.
            weight = {p["number"]: p["premium"] * HAZARD[p["code"]] * rng3.choice(SEVERITY) for p in group if claims[p["number"]]}
            room = {p["number"]: min(claims[p["number"]] * MAX_AVG_CLAIM * p["occurrence"], MAX_POLICY_LOSS_RATIO * 5 * p["premium"]) for p in group}
            incurred = dict.fromkeys(weight, 0.0)
            left, active = target * 5 * total, set(weight)
            while left > 1 and active:
                shares, spill = sum(weight[k] for k in active), 0.0
                for k in list(active):
                    share = left * weight[k] / shares
                    if incurred[k] + share >= room[k]:
                        spill += incurred[k] + share - room[k]
                        incurred[k] = room[k]
                        active.discard(k)
                    else:
                        incurred[k] += share
                left = spill
            for p in group:
                out[p["number"]] = {"claims": claims[p["number"]], "incurred": round(incurred.get(p["number"], 0) / 100) * 100, "open_claims": p["open_claims"]}

        # The seed's open claims stay open; add more until about a quarter are, on every desk.
        still = max(2, round(sum(out[p["number"]]["claims"] for p in desk) * OPEN_SHARE)) - sum(out[p["number"]]["open_claims"] for p in desk)
        candidates = [p for p in desk if out[p["number"]]["claims"] and p["number"] not in DEMO_SCRIPT]
        rng3.shuffle(candidates)
        for p in candidates:
            o = out[p["number"]]
            if o["open_claims"]:
                continue
            if still <= 0:
                break
            o["open_claims"] = 2 if o["claims"] >= 3 and still >= 2 and rng3.random() < 0.3 else 1
            still -= o["open_claims"]
    return out


def print_loss_experience() -> None:
    print("""-- The prior-system book's loss experience (generated by scripts/generate-book.py --loss-experience).
-- The seed drew incurred as a share of one year's premium and 005 then re-rated the premiums, so five
-- years of losses over five years of premium read 2-10% on the desks, implausibly low for E&S contractors'
-- GL. Every desk now runs about 25% and holds near it as policies expire, with about a quarter of the
-- claims still open. Fictitious, like the rest of the book. 004's values stay as the record of the old ones.""")
    for number, o in sorted(loss_experience().items()):
        print(f"UPDATE book_policies SET claims = {o['claims']}, incurred = {o['incurred']}, open_claims = {o['open_claims']} WHERE policy_number = {q(number)};")


def print_renewal_losses() -> None:
    values = ",\n".join(f"    ({q(number)}, {o['claims']}, {o['incurred']}, {o['open_claims']})" for number, o in sorted(loss_experience().items()))
    print(f"""-- A renewal started before policy/016 holds the old totals in its snapshot of the expiring policy. Bring
-- them in line (generated by scripts/generate-book.py --renewal-losses), so the renewal page, its referrals
-- and the policy page agree. A referral cleared on the old totals reads as changed and asks to be cleared
-- again, which is what it's for; a bound file keeps its clearance and a quote already issued can still bind.
UPDATE submissions s
SET renewal_of = jsonb_set(s.renewal_of, '{{losses}}', jsonb_build_object('claims', v.claims, 'incurred', v.incurred, 'open_claims', v.open_claims))
FROM (VALUES
{values}
) AS v(policy_number, claims, incurred, open_claims)
WHERE s.kind = 'renewal' AND s.renewal_of->>'source' = 'book' AND s.renewal_of->>'policy_number' = v.policy_number;""")


rows, used, n = [], set(), 0
policies = []  # (policy_number, class code, states, home state, premium range) for the second pass
book = []  # the first pass's facts per policy, for the loss experience
for uw in UNDERWRITERS:
    # Each underwriter: 10-14 policies; at least 3 expire within 90 days so every desk has renewals to work.
    count = rng.randint(10, 14)
    offsets = [rng.randint(6, 30), rng.randint(31, 60), rng.randint(61, 90)] + [rng.randint(5, 365) for _ in range(count - 3)]
    for days in offsets:
        code = rng.choice(list(CLASSES))
        desc, trades, (lo, hi) = CLASSES[code]
        home = rng.choice(STATES)
        while True:
            name = f"{rng.choice(PLACES[home])} {rng.choice(trades)} {rng.choice(ENTITY)}"
            if name not in used:
                used.add(name)
                break
        states = NEIGHBORS[home][: rng.randint(1, len(NEIGHBORS[home]))]
        premium = round(rng.uniform(lo, hi) / 100) * 100
        claims = rng.choices([0, 1, 2, 3, 4], weights=[45, 25, 15, 10, 5])[0]
        # A share of one year's premium: loss_experience() replaces this with five years' worth (migration 016).
        # Left as it is so this pass still reproduces migration 004 exactly.
        incurred = 0 if claims == 0 else round(premium * rng.choice([0.05, 0.15, 0.3, 0.45, 0.7, 1.1, 1.6]) / 100) * 100
        open_claims = 0 if claims == 0 else rng.choices([0, 1], weights=[70, 30])[0]
        status = "in_progress" if days <= 45 and rng.random() < 0.35 else "not_started"
        n += 1
        policies.append((f"GL-25-{70000 + n:05d}", code, states, home, (lo, hi)))
        book.append({"number": f"GL-25-{70000 + n:05d}", "underwriter": uw, "code": code, "days": days, "claims": claims, "open_claims": open_claims})
        rows.append(
            f"({q(f'GL-25-{70000 + n:05d}')}, {q(name)}, {q(uw)}, {q(code)}, {q(desc)}, "
            f"ARRAY[{', '.join(q(s) for s in states)}], {q(home)}, {q(rng.choice(PRODUCERS))}, "
            f"CURRENT_DATE + {days - 365}, CURRENT_DATE + {days}, {premium}, {claims}, {incurred}, {open_claims}, {q(status)})"
        )
if RENEWAL_COLUMNS:
    renewal_columns()
    sys.exit(0)
if LOSS_EXPERIENCE:
    print_loss_experience()
    sys.exit(0)
if RENEWAL_LOSSES:
    print_renewal_losses()
    sys.exit(0)

print("""-- In-force book each underwriter already wrote in the prior policy system (seeded, fictitious).
-- Generated by scripts/generate-book.py; dates are relative to when this migration runs.
-- Policies written in the UW Desktop itself live in the policies table; the home page shows both.
CREATE TABLE book_policies (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_number    text NOT NULL UNIQUE,
    insured_name     text NOT NULL,
    underwriter      text NOT NULL,
    class_code       text NOT NULL,
    class_description text NOT NULL,
    states           text[] NOT NULL,
    home_state       text NOT NULL,
    producer         text NOT NULL,
    effective_date   date NOT NULL,
    expiration_date  date NOT NULL,
    premium          numeric(12,2) NOT NULL,
    claims           int NOT NULL DEFAULT 0,
    incurred         numeric(12,2) NOT NULL DEFAULT 0,
    open_claims      int NOT NULL DEFAULT 0,
    renewal_status   text NOT NULL DEFAULT 'not_started'
                     CHECK (renewal_status IN ('not_started', 'in_progress', 'renewed', 'non_renewed'))
);
CREATE INDEX book_policies_underwriter ON book_policies (underwriter, expiration_date);

INSERT INTO book_policies (policy_number, insured_name, underwriter, class_code, class_description, states, home_state,
                           producer, effective_date, expiration_date, premium, claims, incurred, open_claims, renewal_status)
VALUES""")
print(",\n".join(rows) + ";")
