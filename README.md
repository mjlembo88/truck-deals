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
