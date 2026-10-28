#!/usr/bin/env python3
"""Build the public Truck Deals data.json from a private source file.

Keeps only the public schema. Drops everything else (assumptions, checked,
cond, nhm, and any other non-public key) and prints what was dropped.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from enrich_data import enrich  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PRIMARY_SRC = Path("/workspace/truck-deals/app/data.json")
FALLBACK_SRC = Path("/workspace/truck-deals/grade_a.json")

TOP_KEYS = ("updated_at", "groups", "specs", "ranked", "conditional", "sources")
TOP_KEY_SET = set(TOP_KEYS)

LISTING_KEYS = (
    "rank",
    "g",
    "grp",
    "grade",
    "status",
    "yr",
    "mk",
    "model",
    "trim",
    "eng",
    "fuel",
    "cond_new",
    "cab",
    "drv",
    "mi",
    "price",
    "prev",
    "price_history",
    "doc",
    "dealer",
    "loc",
    "online",
    "lat",
    "lng",
    "d",
    "src",
    "url",
    "thumb",
    "vin",
    "tow",
    "tow_lb",
    "tsrc",
    "pay_lo",
    "pay_hi",
    "pay",
    "rec",
    "rec_n",
    "rec_open",
    "rec_open_src",
    "flags",
    "flag_tags",
    "dd_status",
    "dd_reason",
    "dd_note",
    "excluded",
    "excluded_reason",
    "first_seen",
    "last_checked",
)
LISTING_KEY_SET = set(LISTING_KEYS)
SPEC_KEYS = ("radius_mi", "center", "criteria", "notes")
SPEC_KEY_SET = set(SPEC_KEYS)
HISTORY_KEYS = ("date", "price")

OFFSET_RE = re.compile(r"(?:Z|[+-]\d{2}:\d{2})$")
FORBIDDEN_RE = re.compile(r"assumption|apr|trade|credit|ssn|income|score", re.IGNORECASE)


def default_src() -> str:
    if PRIMARY_SRC.is_file():
        return str(PRIMARY_SRC)
    return str(FALLBACK_SRC)


def valid_updated_at(value: object) -> bool:
    if not isinstance(value, str) or not OFFSET_RE.search(value):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def valid_price(value: object) -> bool:
    if value is None:
        return True
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return True


def clean_history(value: object, path: str, dropped: list[str]) -> object:
    if not isinstance(value, list):
        return value
    cleaned = []
    for index, point in enumerate(value):
        if not isinstance(point, dict):
            cleaned.append(point)
            continue
        kept = {}
        for key, item in point.items():
            if key in HISTORY_KEYS:
                kept[key] = item
            else:
                dropped.append(f"{path}[{index}].{key}")
        ordered = {key: kept[key] for key in HISTORY_KEYS if key in kept}
        cleaned.append(ordered)
    return cleaned


def clean_listing(listing: object, path: str, dropped: list[str]) -> object:
    if not isinstance(listing, dict):
        return listing
    kept = {}
    for key, value in listing.items():
        if key not in LISTING_KEY_SET:
            dropped.append(f"{path}.{key}")
            continue
        if key == "price_history":
            kept[key] = clean_history(value, f"{path}.price_history", dropped)
        elif key == "thumb":
            # remote https image or a cached copy committed under thumbs/
            if isinstance(value, str) and (re.match(r"^https://[^\s\"'<>]+$", value) or re.match(r"^thumbs/[A-Za-z0-9_-]+\.(jpg|webp)$", value)):
                kept[key] = value
            else:
                dropped.append(f"{path}.thumb")
        else:
            kept[key] = value
    return {key: kept[key] for key in LISTING_KEYS if key in kept}


def clean_specs(value: object, dropped: list[str]) -> object:
    if not isinstance(value, dict):
        return value
    kept = {}
    for key, item in value.items():
        if key in SPEC_KEY_SET:
            kept[key] = item
        else:
            dropped.append(f"specs.{key}")
    return {key: kept[key] for key in SPEC_KEYS if key in kept}


def clean_groups(value: object, dropped: list[str], notes: list[str]) -> object:
    """Public schema is {id: name}. The private file stores a list of objects."""
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            public_key = str(key)
            if isinstance(item, str):
                out[public_key] = item
            elif isinstance(item, dict):
                name = item.get("name") if isinstance(item.get("name"), str) else None
                if name is None and isinstance(item.get("grp"), str):
                    name = item.get("grp")
                out[public_key] = name if name is not None else ""
                for extra in item:
                    if extra not in ("name", "grp") or (extra == "grp" and "name" in item):
                        dropped.append(f"groups.{public_key}.{extra}")
            else:
                out[public_key] = item
        return out
    if isinstance(value, list):
        notes.append("normalized groups from a list to a dict keyed by g")
        out = {}
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                dropped.append(f"groups[{index}]")
                continue
            key = str(item.get("g", index + 1))
            name = item.get("name") if isinstance(item.get("name"), str) else ""
            out[key] = name
            for extra in item:
                if extra not in ("g", "name"):
                    dropped.append(f"groups[{index}].{extra}")
        return out
    return value


def build(raw: object) -> tuple[dict | None, list[str], list[str], list[str]]:
    dropped: list[str] = []
    notes: list[str] = []
    errors: list[str] = []
    if not isinstance(raw, dict):
        return None, dropped, notes, ["source must be a JSON object"]
    for key in raw:
        if key not in TOP_KEY_SET:
            dropped.append(str(key))
    out: dict = {}
    if "updated_at" in raw:
        out["updated_at"] = raw["updated_at"]
    if "groups" in raw:
        out["groups"] = clean_groups(raw["groups"], dropped, notes)
    if "specs" in raw:
        out["specs"] = clean_specs(raw["specs"], dropped)
    for section in ("ranked", "conditional"):
        if section not in raw:
            continue
        value = raw[section]
        if not isinstance(value, list):
            out[section] = value
            continue
        out[section] = [
            clean_listing(item, f"{section}[{index}]", dropped) for index, item in enumerate(value)
        ]
    if "sources" in raw:
        out["sources"] = raw["sources"]
    # Add dealer coordinates (scripts/dealers.json) and derived cab/fuel/tow_lb
    # where missing. Never overwrites a value the source already has.
    summary = enrich(out)
    notes.append(
        f"enriched: coords on {summary['coords']} listing(s), no coords {summary['no_coords']}, "
        f"cab+{len(summary['cab'])} fuel+{len(summary['fuel'])} tow_lb+{len(summary['tow_lb'])}, "
        f"undetermined {summary['unknown']}"
    )
    errors.extend(validate(out))
    return out, dropped, notes, errors


def find_forbidden(obj: object, path: str, errors: list[str]) -> None:
    if isinstance(obj, dict):
        for key, value in obj.items():
            child = f"{path}.{key}" if path else str(key)
            if FORBIDDEN_RE.search(str(key)):
                errors.append(f"forbidden key: {child}")
            find_forbidden(value, child, errors)
    elif isinstance(obj, list):
        for index, value in enumerate(obj):
            find_forbidden(value, f"{path}[{index}]", errors)


def present_text(value: object) -> bool:
    return isinstance(value, str) and value.strip() != ""


def validate(out: dict) -> list[str]:
    errors: list[str] = []
    for key in ("updated_at", "groups", "specs", "ranked", "conditional"):
        if key not in out:
            errors.append(f"missing required key: {key}")
    if "updated_at" in out and not valid_updated_at(out["updated_at"]):
        errors.append("updated_at must be ISO 8601 with a timezone offset")
    if "groups" in out and not isinstance(out["groups"], dict):
        errors.append("groups must be a dict")
    if "specs" in out and not isinstance(out["specs"], dict):
        errors.append("specs must be a dict")
    for section in ("ranked", "conditional"):
        if section not in out:
            continue
        listings = out[section]
        if not isinstance(listings, list):
            errors.append(f"{section} must be a list")
            continue
        for index, listing in enumerate(listings):
            where = f"{section}[{index}]"
            if not isinstance(listing, dict):
                errors.append(f"{where} must be an object")
                continue
            rank = listing.get("rank", None)
            if "rank" not in listing or rank is None or rank == "" or isinstance(rank, bool):
                errors.append(f"{where} missing rank")
            elif not isinstance(rank, (int, float, str)):
                errors.append(f"{where} missing rank")
            yr = listing.get("yr", None)
            if "yr" not in listing or yr is None or yr == "" or isinstance(yr, bool):
                errors.append(f"{where} missing yr")
            if not present_text(listing.get("mk")):
                errors.append(f"{where} missing mk")
            if not present_text(listing.get("model")):
                errors.append(f"{where} missing model")
            if "price" not in listing:
                errors.append(f"{where} missing price")
            elif not valid_price(listing.get("price")):
                errors.append(f"{where} price must be a number or null")
            if not present_text(listing.get("url")):
                errors.append(f"{where} missing url")
    find_forbidden(out, "", errors)
    return errors


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def print_dropped(dropped: list[str], notes: list[str]) -> None:
    for note in notes:
        print(note)
    if dropped:
        print(f"dropped {len(dropped)} key(s):")
        for item in dropped:
            print(f"drop {item}")
    else:
        print("dropped none")


def listing_count(out: dict, section: str) -> int:
    value = out.get(section)
    return len(value) if isinstance(value, list) else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the public Truck Deals data.json")
    parser.add_argument("--src", default=None, help="source JSON (default: private app data, else grade_a.json)")
    parser.add_argument("--out", default=None, help="output path (default: data.json in the repo root)")
    parser.add_argument("--check", action="store_true", help="validate only; do not write output")
    args = parser.parse_args(argv)

    src = Path(args.src) if args.src else Path(default_src())
    out_path = Path(args.out) if args.out else (ROOT / "data.json")

    try:
        with src.open(encoding="utf-8") as handle:
            raw = json.load(handle)
    except FileNotFoundError:
        print(f"source not found: {src}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as exc:
        print(f"invalid JSON: {exc}", file=sys.stderr)
        return 1

    built, dropped, notes, errors = build(raw)
    print_dropped(dropped, notes)
    if errors or built is None:
        for error in errors:
            print(error, file=sys.stderr)
        print("validation failed, output not written", file=sys.stderr)
        return 1

    ranked = listing_count(built, "ranked")
    conditional = listing_count(built, "conditional")
    print(f"listings ranked={ranked} conditional={conditional} total={ranked + conditional}")
    print(f"updated_at {built.get('updated_at')}")

    if args.check:
        print("check only, not written")
        return 0

    text = json.dumps(built, ensure_ascii=False, indent=2) + "\n"
    atomic_write(out_path, text)
    print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
