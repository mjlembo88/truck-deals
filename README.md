# Truck Deals data

Data host for the Truck Deals app (Marcus's truck search, 150 mi around Hudson FL). This repo holds only data and the publishing helper; the app itself is a Grok Build project on grok.me.

- Live data: https://mjlembo88.github.io/truck-deals/data.json (GitHub Pages, `Access-Control-Allow-Origin: *`)
- `sample-data.json`: 3-listing test fixture (one price drop, one NEW, one conditional with a null VIN). Restore it with `cp sample-data.json data.json`.

## data.json schema

Top level: `updated_at` (ISO 8601 with offset), `groups` (`{"1": "G1 · ..."}`), `specs` (`radius_mi`, `center`, `criteria`, `notes`), `ranked` and `conditional` (lists of listings), `sources` (text).

Listing keys (all optional except rank, yr, mk, model, price, url): `rank`, `g`, `grp`, `grade`, `status`, `yr`, `mk`, `model`, `trim`, `eng`, `fuel`, `cond_new`, `cab`, `drv`, `mi`, `price`, `prev`, `price_history` (`date`, `price`), `doc`, `dealer`, `loc`, `d`, `src`, `url`, `vin` (may be null), `tow`, `tow_lb`, `tsrc`, `pay_lo`, `pay_hi`, `pay`, `rec`, `flags`, `flag_tags`, `first_seen`, `last_checked`.

## Privacy

`scripts/build_public_data.py` keeps only the schema keys above and drops everything else (`assumptions`, `checked`, `cond`, `nhm`, ...). It refuses to write if any remaining key name matches `assumption|apr|trade|credit|ssn|income|score`. No APR tiers, trade-in values or credit detail are ever published; payment info is limited to `pay_lo`, `pay_hi`, `pay` (estimate, info only).

## Publishing (twice a day, non-interactive)

Default source: `/workspace/truck-deals/app/data.json`, falling back to `/workspace/truck-deals/grade_a.json` (which currently fails validation, so nothing is written).

```bash
cd /workspace/truck-deals-data && ./scripts/publish_data.sh
```

It pulls `main`, runs the helper (exits non-zero and commits nothing if validation fails), commits and pushes `data.json` only if it changed, then prints the data URL and `updated_at`. Override the source with `./scripts/publish_data.sh --src PATH`. Validate only:

```bash
cd /workspace/truck-deals-data && python3 scripts/build_public_data.py --check --src PATH
```

GitHub Pages usually serves the new file within 1-2 minutes; the app needs no rebuild. Verify:

```bash
curl -s "https://mjlembo88.github.io/truck-deals/data.json?t=$(date +%s)" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["updated_at"], len(d["ranked"])+len(d["conditional"]))'
```

## App front end (GitHub Pages)

The PWA (`index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, `icons/`, `vendor/leaflet/`) is served from this repo at https://mjlembo88.github.io/truck-deals/. Its working copy is mirrored in `/workspace/truck-deals-pwa` on the box; keep the two in sync. Bump `CACHE_VERSION` in `sw.js` whenever an app file changes, and add any new asset to its `SHELL` list so phones precache it.

- **Dealer map:** Leaflet 1.9.4, self-hosted in `vendor/leaflet/` (sha256 matches the official SRI: js `20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=`, css `p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=`). Basemap is Esri World Dark Gray Canvas (base + reference; Light Gray in the light theme), no API key. Never use Carto, Mapbox or Google tiles. One marker per dealer location; popups list the trucks that pass the current filters. Tapping a card focuses its dealer; the card's Details button opens the detail view. Listings without `lat`/`lng` are skipped on the map.
- **Filters:** grade, cab style (regular / extended-double / crew, derived from `cab` + `trim`), price, miles, tow, distance, fuel, condition, dealer multi-select, NEW, drops, flagged. Saved in localStorage (`td_filters_v1`); Reset restores defaults.
- **Payment estimator:** collapsible panel; inputs saved in localStorage (`td_pay_v1`), never published. Rates, fees and tax live in `PAY_CONFIG` at the top of `app.js`.

## Dealer coordinates and derived fields

- `scripts/dealers.json`: static dealer table (`name`, `address`, `match` strings, `lat`, `lng`, `precision`). A listing gets coordinates when its `loc` contains one of an entry's `match` strings.
- `scripts/enrich_data.py`: adds `lat`/`lng` from the table, and fills `cab` (from trim/model text, e.g. "Regular Cab"), `fuel` (from engine or group text) and `tow_lb` (first number in `tow`) only where they are missing. It never changes an existing value; anything it cannot derive is set to null. `build_public_data.py` runs it on every publish, so `publish_data.sh` keeps these fields. Run it alone with `python3 scripts/enrich_data.py` (in place) or `--check`.
- `scripts/geocode_dealers.py`: finds every `loc` in `data.json` that no table entry matches, appends a stub (name and street address parsed from `loc`), and geocodes entries missing coordinates once (US Census geocoder for street addresses, Nominatim at 1 req/s with a User-Agent as fallback / for city-only entries). Results are written into `dealers.json`.

### Adding a dealer

1. Publish or copy the new listings into `data.json` as usual.
2. `python3 scripts/geocode_dealers.py` (or add the entry by hand with a full street `address` first, then run it). Check any `NEEDS ADDRESS` lines, fill `address` or `city`, and rerun.
3. `python3 scripts/enrich_data.py` (or the next `publish_data.sh`) merges the coordinates into `data.json`.
4. Commit `scripts/dealers.json` with the data. The app needs no change.

## Manual listings (kept across refreshes)

The private refresh (`/workspace/truck-deals/mk_grade_a.py runs/<date>-<am|pm>.json`) rebuilds `/workspace/truck-deals/app/data.json` from `grade_a.json`. Listings that the generator does not track live in `/workspace/truck-deals/app/manual_listings.json` and are merged in on every run by `/workspace/truck-deals/manual_merge.py`:

- Dedupe key is the VIN (case-insensitive), else the `url`. If a manual entry matches a generated listing, the manual fields win for that listing; otherwise it is appended to its `section` (`ranked` or `conditional`) and re-ranked after the generated listings. No other listing is changed.
- Group names for manual groups come from the file's `groups` map. Group 5 is `US 19 · GM HD gas (dealers on 19)` (Coast Buick GMC, Castriota, Ferman Tarpon Springs); group 6 is reserved for deep-dive used finds.
- Edit a manual listing by editing `manual_listings.json`; the next refresh plus `scripts/publish_data.sh` publishes it.
- Dry-run a refresh without touching live files: `python3 mk_grade_a.py runs/<run>.json --out-dir /tmp/td-dry` (writes `grade_a.json`, `app/data.json`, the md and html under that folder).

### Truck Deal Finder deep-dive import

`/workspace/truck-deals/import_deep_dive.py` reads `/workspace/truck-search/deep_dive_used.json` (a list of records or `{"listings": [...]}`) and appends new used-truck finds to `manual_listings.json`. It runs automatically at the start of every merge and is a no-op if the file is missing; run it alone with `python3 import_deep_dive.py [--src PATH] [--dry-run]`.

- Field aliases: year/yr, make/mk, model, trim, engine/eng, fuel, cab, drive/drv, mileage/miles/mi, price, doc_fee/doc, dealer/dealer_name + address/location/loc, url/link, vin, tow/tow_lb, lat/lng (or lon), distance/d, grade, g.
- Dedupes by VIN (else url) against the manual file and the generated listings; existing entries are never overwritten. Records missing year, make, model, price or url are skipped and reported.
- Coordinates come from the record or from `scripts/dealers.json` (matched on loc); distance `d` to Hudson FL is computed from them. Without coordinates `d` stays null and the app hides the listing, so add the dealer to `scripts/dealers.json` (`scripts/geocode_dealers.py`).
- New entries get group 6, `status` "NEW (Truck Deal Finder deep dive)", `flag_tags` `["deep_dive"]`, `cond_new` false and a one-point price history.

### Deep-dive import rules (Oct 27 update)

- The importer reads Truck Deal Finder's schema as-is: `dealer`, `loc`, `phone`, `yr`, `model` (make prefix such as "Chevrolet Silverado 2500HD" is split into `mk`/`model`), `trim`, `cab`, `fuel` (text kept as `eng`, normalized to gas/diesel), `miles`, `price`, `fee` (-> `doc`), `vin`, `url`, `tow_lb` (text such as "14,500-16,000 est." kept in `tow`, first number in `tow_lb`), `status`, `title`, `wheels`, `recalls` (count), `notes`, `source`, `rank`.
- `status`: `confirmed` -> ranked section; `needs_check: <why>` -> conditional section ("Conditional · needs a check") with status `NEEDS CHECK: <why>`, a `needs_check` tag, and a highlighted line on the card; `excluded: ...` (or a salvage / rebuilt / flood title) -> not imported, just reported.
- Dedupe order: VIN; else url; else dealer + year + model + price.
- Missing listing URL but a VIN: `url` becomes a web search for the VIN and the flags say so.
- Dealer matched in `scripts/dealers.json`: `loc` becomes "<dealer>, <street address>" and coordinates/distance come from the table. Unknown dealers keep the record's location text and have no pin until added to the table.
- Online sellers (Carvana, Vroom): `online: true`, no pin, no distance. The app shows "Online · delivery", keeps them in the list at any distance setting, and leaves them off the map. Listings that are neither online nor located only show while the distance filter is at its maximum.
