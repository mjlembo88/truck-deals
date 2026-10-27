#!/usr/bin/env python3
"""Add derived fields to Truck Deals listings without touching existing values.

Adds, only where the key is missing or null:
  lat, lng  from scripts/dealers.json (loc match); left off if no match
  cab       from trim/model text ("Regular Cab", "Double Cab", "Crew Cab"...)
  fuel      from eng text (gas / diesel), else from the listing's group name
  tow_lb    the first number in the tow text
Anything that cannot be derived is set to null (cab/fuel/tow_lb) so the gap is
visible. Existing non-null values are never changed.

build_public_data.py calls enrich() on every publish. Standalone use
(in-place on the repo data.json): python3 scripts/enrich_data.py [--check]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TABLE = ROOT / "scripts" / "dealers.json"

CAB_RES = (
    (re.compile(r"\bcrew\b", re.I), "Crew Cab"),
    (re.compile(r"\b(double|extended|ext\.?|super\s*cab|quad)\s*cab\b|\bdouble\b|\bsupercab\b", re.I), "Double Cab"),
    (re.compile(r"\b(regular|reg\.?|standard)\s*cab\b", re.I), "Regular Cab"),
)


def load_dealers(path: Path = TABLE) -> list[dict]:
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("dealers") or []
    except FileNotFoundError:
        return []


def dealer_for(loc: object, dealers: list[dict]) -> dict | None:
    if not isinstance(loc, str) or not loc:
        return None
    low = loc.lower()
    for entry in dealers:
        if any(m and m.lower() in low for m in entry.get("match") or []):
            if isinstance(entry.get("lat"), (int, float)) and isinstance(entry.get("lng"), (int, float)):
                return entry
            return None
    return None


def derive_cab(listing: dict) -> str | None:
    text = " ".join(str(listing.get(k) or "") for k in ("trim", "model"))
    for rx, label in CAB_RES:
        if rx.search(text):
            return label
    return None


def derive_fuel(listing: dict, groups: dict) -> str | None:
    for text in (listing.get("eng"), listing.get("grp"), groups.get(str(listing.get("g")))):
        t = str(text or "").lower()
        if re.search(r"diesel|duramax|cummins|power\s*stroke|l5p|lml|lb7|lbz|lly|lmm", t):
            return "diesel"
        if re.search(r"\bgas\b|gasoline|\bl8t\b|\bl96\b", t):
            return "gas"
    return None


def derive_tow_lb(listing: dict) -> int | None:
    m = re.search(r"(\d{1,2},\d{3}|\d{4,5})", str(listing.get("tow") or ""))
    return int(m.group(1).replace(",", "")) if m else None


def enrich(data: dict, dealers: list[dict] | None = None) -> dict:
    """Mutates and returns data; returns a summary dict of what was added."""
    if dealers is None:
        dealers = load_dealers()
    groups = data.get("groups") if isinstance(data.get("groups"), dict) else {}
    summary: dict = {"coords": 0, "no_coords": [], "cab": [], "fuel": [], "tow_lb": [], "unknown": []}
    for section in ("ranked", "conditional"):
        for listing in data.get(section) or []:
            if not isinstance(listing, dict):
                continue
            rank = listing.get("rank")
            entry = dealer_for(listing.get("loc"), dealers)
            if entry and listing.get("lat") is None and listing.get("lng") is None:
                listing["lat"], listing["lng"] = entry["lat"], entry["lng"]
            if isinstance(listing.get("lat"), (int, float)):
                summary["coords"] += 1
            else:
                summary["no_coords"].append(rank)
            for key, fn in (("cab", derive_cab), ("fuel", lambda l: derive_fuel(l, groups)), ("tow_lb", derive_tow_lb)):
                if listing.get(key) in (None, ""):
                    value = fn(listing)
                    listing[key] = value
                    (summary[key] if value is not None else summary["unknown"]).append(
                        (rank, value) if value is not None else (rank, key)
                    )
    return summary


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(ROOT / "data.json"))
    ap.add_argument("--check", action="store_true", help="report only, do not write")
    args = ap.parse_args(argv)
    path = Path(args.data)
    data = json.loads(path.read_text(encoding="utf-8"))
    summary = enrich(data)
    print(json.dumps(summary))
    if not args.check:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
