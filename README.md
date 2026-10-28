# Truck Deals data

Data host for the Truck Deals app (Marcus's truck search, 150 mi around Hudson FL). This repo holds only data and the publishing helper; the app itself is a Grok Build project on grok.me.

- Live data: https://mjlembo88.github.io/truck-deals/data.json (GitHub Pages, `Access-Control-Allow-Origin: *`)
- `sample-data.json`: 3-listing test fixture (one price drop, one NEW, one conditional with a null VIN). Restore it with `cp sample-data.json data.json`.

## data.json schema

Top level: `updated_at` (ISO 8601 with offset), `groups` (`{"1": "G1 · ..."}`), `specs` (`radius_mi`, `center`, `criteria`, `notes`), `ranked` and `conditional` (lists of listings), `sources` (text).

Listing keys (all optional except rank, yr, mk, model, price, url): `rank`, `g`, `grp`, `grade`, `status`, `yr`, `mk`, `model`, `trim`, `eng`, `fuel`, `cond_new`, `cab`, `drv`, `mi`, `price`, `prev`, `price_history` (`date`, `price`), `doc`, `dealer`, `loc`, `d`, `src`, `url`, `vin` (may be null), `tow`, `tow_lb`, `tsrc`, `pay_lo`, `pay_hi`, `pay`, `rec`, `thumb` (listing photo: https URL hotlinked from the source, or `thumbs/<key>.jpg` cached copy in this repo), `flags`, `flag_tags`, `rec_n` (deep dive: NHTSA campaigns for the make/model/year, not VIN-specific), `rec_open` (unrepaired recalls for this VIN; absent = not checked) and `rec_open_src`, `dd_status` (confirmed / needs_check / excluded / kept), `dd_reason`, `dd_note` (Carfax/title/damage note shown on the card), `excluded` (true = hidden unless "Show excluded" is on), `excluded_reason`, `first_seen`, `last_checked`. `doc` is the listing's actual dealer fee when known (0 = already in the price).

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
- `status`: `confirmed` -> ranked section; `needs_check: <why>` -> conditional section ("Conditional · needs a check") with status `NEEDS CHECK: <why>`, a `needs_check` tag, and a highlighted line on the card; `excluded: ...` (or a salvage / rebuilt / flood title) on a record that is NOT already listed -> not imported, just reported.
- Records that match an EXISTING listing (VIN, else url, else dealer+year+model+price) update its deep-dive-owned fields every run: `dd_status`, `dd_reason`, `dd_note` (from the record's `flags` list, e.g. "Carfax: MINOR TO MODERATE DAMAGE"), `doc` (from `fee`; 0 when `fee_included` and the prices match, the fee itself when our price is the deep-dive price minus the fee) and `excluded`/`excluded_reason`. Hand-added listings are edited in `manual_listings.json`; generated listings get an `"overlay": true` entry there that `manual_merge.py` applies on every refresh (ignored if the listing disappears). Listings the importer created are fully deep-dive owned (status, flags, section, location, price/miles follow the file). Price/miles on other listings change only when the file is newer than their `last_checked`; differences are printed.
- An existing listing the deep dive excludes is never deleted: `excluded: true` + reason, hidden by default, visible with the "Show excluded" filter toggle (off by default, cleared by Reset). VINs in `PROTECT` (the #14 double cab) stay visible with `dd_status: kept`.
- Idempotent: re-running with the same file prints "no changes". Run: `python3 /workspace/truck-deals/import_deep_dive.py [--dry-run]`.
- Dedupe order: VIN; else url; else dealer + year + model + price.
- Missing listing URL but a VIN: `url` becomes a web search for the VIN and the flags say so.
- Dealer matched in `scripts/dealers.json`: `loc` becomes "<dealer>, <street address>" and coordinates/distance come from the table. Unknown dealers keep the record's location text and have no pin until added to the table.
- Online sellers (Carvana, Vroom): `online: true`, no pin, no distance. The app shows "Online · delivery", keeps them in the list at any distance setting, and leaves them off the map. Listings that are neither online nor located only show while the distance filter is at its maximum.

## Favorites
Star (☆/★) on every card and in every map popup. Favorites are stored only in the browser, in localStorage `truck-deals-favorites-v1` (JSON array of keys: VIN upper-cased, else the listing url), separate from the filter state (`td_filters_v1`), so they survive refreshes and data re-imports. The "★ Favorites only" filter is part of the saved filter state (schema v3; older saved states load with it off) and is cleared by Reset. Card and popup stars stay in sync; popup content is rebuilt on every open.

## Thumbnails
`/workspace/truck-deals/fetch_thumbs.py` fills missing `thumb` fields: one plain read-only GET of the listing page (browser UA, 20 s timeout, ~2 s between requests per host, no cookies/logins), then og:image, twitter:image, JSON-LD image or the first gallery image. Blocked pages (403/406/429, bot walls, captchas) are recorded and left empty, never worked around. Each image is test-loaded with a github.io Referer: if it loads and the URL isn't signed/expiring it is hotlinked, otherwise a ~480 px JPEG copy is saved to `thumbs/<key>.jpg` (total capped at 5 MB) and published by `publish_data.sh`. Results live in `/workspace/truck-deals/app/thumbs.json` (ok or failed + why); existing thumbs are never replaced; failures are retried after 3 days (14 for blocked pages). It runs from `import_deep_dive.py` (manual listings) and `manual_merge.py` (every refresh), or alone: `python3 fetch_thumbs.py [--dry-run] [--retry-failed]`. The app lazy-loads thumbs at a fixed aspect ratio and falls back to an inline SVG truck placeholder on error or when none exists. The service worker runtime-caches `thumbs/*.jpg` (cache `td-thumbs-v1`, max 150) instead of precaching them.

## Grid view and hidden trucks
- Grid/List toggle above the listings (localStorage `td_view_v1`, default grid; Reset filters never changes it). Grid: 2 columns on phones, 3 at ≥600 px, 4 at ≥900 px, 5 at ≥1200 px. Each tile: photo/placeholder, grade, star, year + model, trim, price, miles, distance, est. payment, status tags, a "Listing ↗" link ("VIN search ↗" for VIN web-search links; opens a new tab without expanding the tile) and Hide. Tapping a tile expands the full card inline across the row ("▲ Back to grid" collapses).
- Hide (🚫) on tiles, cards and map popups: localStorage `truck-deals-hidden-v1` (same VIN-then-url keys as favorites, independent of them). Hidden trucks drop out of tiles, cards and map; "Show hidden (N)" (saved filter, off by default, cleared by Reset) shows them dimmed with 👁 Unhide. Data is never changed.
