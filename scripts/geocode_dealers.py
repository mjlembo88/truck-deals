#!/usr/bin/env python3
"""Keep scripts/dealers.json in step with data.json.

1. Finds every listing loc in data.json that no dealer entry matches and
   appends a stub entry (name and street address parsed from loc when present).
2. Geocodes every entry still missing lat/lng, once, with free no-key services:
   US Census geocoder for street addresses, Nominatim (1 req/s, User-Agent)
   as fallback and for city-only entries. Results are written back into
   dealers.json so they are hardcoded from then on.

Usage: python3 scripts/geocode_dealers.py [--data data.json] [--dry-run]
Entries that cannot be geocoded keep lat/lng null and are printed; fill in
"address" (or "city") by hand and rerun. The app skips listings without coords.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TABLE = ROOT / "scripts" / "dealers.json"
UA = "TruckDeals-dealer-geocoder/1.0 (github.com/mjlembo88/truck-deals)"
_last_nominatim = 0.0


def get_json(url: str) -> object:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)


def census(address: str) -> tuple[float, float] | None:
    q = urllib.parse.urlencode({"address": address, "benchmark": "Public_AR_Current", "format": "json"})
    try:
        data = get_json("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?" + q)
        matches = data["result"]["addressMatches"]
    except Exception as exc:  # noqa: BLE001
        print(f"  census error: {exc}")
        return None
    if not matches:
        return None
    c = matches[0]["coordinates"]
    return round(float(c["y"]), 6), round(float(c["x"]), 6)


def nominatim(query: str) -> tuple[float, float] | None:
    global _last_nominatim
    wait = 1.1 - (time.time() - _last_nominatim)
    if wait > 0:
        time.sleep(wait)
    _last_nominatim = time.time()
    q = urllib.parse.urlencode({"q": query, "format": "jsonv2", "limit": 1, "countrycodes": "us"})
    try:
        data = get_json("https://nominatim.openstreetmap.org/search?" + q)
    except Exception as exc:  # noqa: BLE001
        print(f"  nominatim error: {exc}")
        return None
    if not data:
        return None
    return round(float(data[0]["lat"]), 6), round(float(data[0]["lon"]), 6)


def matches(entry: dict, loc: str) -> bool:
    low = loc.lower()
    return any(m and m.lower() in low for m in entry.get("match") or [])


def stub_for(loc: str) -> dict:
    """Build a table entry from a loc like 'Name (phone), 123 Street, City'."""
    name = re.split(r"\s*\(|,", loc, maxsplit=1)[0].strip() or loc
    address = None
    m = re.search(r"\b(\d{2,6}\s+[^,]+,\s*[A-Za-z .'-]+)$", loc)
    if m:
        address = m.group(1).strip()
        if not re.search(r"\bFL\b", address):
            address += ", FL"
    entry = {"name": name, "address": address, "match": [name if name != loc else loc], "lat": None, "lng": None}
    if not address:
        city = loc.split(",")[-1].strip() if "," in loc else None
        entry["city"] = f"{city}, FL" if city else None
    return entry


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", default=str(ROOT / "data.json"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    table = json.loads(TABLE.read_text(encoding="utf-8"))
    dealers = table.setdefault("dealers", [])
    data = json.loads(Path(args.data).read_text(encoding="utf-8"))
    locs = sorted({str(l.get("loc") or "") for s in ("ranked", "conditional") for l in data.get(s) or [] if l.get("loc")})

    for loc in locs:
        if not any(matches(e, loc) for e in dealers):
            entry = stub_for(loc)
            print(f"new dealer from data: {entry['name']!r} (loc {loc!r})")
            dealers.append(entry)

    missing = []
    for e in dealers:
        if e.get("lat") is not None and e.get("lng") is not None:
            continue
        hit, how = None, None
        if e.get("address"):
            hit, how = census(e["address"]), "address"
            if not hit:
                hit = nominatim(e["address"])
        if not hit and e.get("city"):
            hit, how = nominatim(e["city"]), "city"
        if not hit and not e.get("address") and not e.get("city"):
            hit, how = nominatim(f"{e['name']}, Florida"), "name"
        if hit:
            e["lat"], e["lng"], e["precision"] = hit[0], hit[1], how
            print(f"geocoded {e['name']}: {hit[0]}, {hit[1]} ({how})")
        else:
            missing.append(e["name"])

    if args.dry_run:
        print("dry run, dealers.json not written")
    else:
        TABLE.write_text(json.dumps(table, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {TABLE} ({len(dealers)} dealers)")
    for name in missing:
        print(f"NEEDS ADDRESS: {name} (add address or city in dealers.json and rerun)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
