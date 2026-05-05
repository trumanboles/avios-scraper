# avios-scraper

Pulls the full Avios retailer list directly from the internal partners API and
produces `retailers.json` — the data the Chrome extension consumes.

## How it works

The Avios shopping page loads retailers from this endpoint (discovered via
DevTools — it's what the "Load more" button calls):

```
GET https://www.avios.com/collect-avios/shopping/api/partners/
    ?page=N
    &collectionMechanic=eStore,Manual
    &showHighestRate=true
    &rateUpTo=up%20to&fromText=From&wasRateText=Was
```

60 partners per page, ~37 pages total (~2,200 retailers). Each record has
`name`, `slug`, `rate`, `wasRate`, `logoSrc`, `destinationUrl`, and an
`isSpeedyAwarding` flag. **Crucially it does NOT include the merchant's
actual website domain** — that's what `resolve_domains.py` is for.

## Two scripts

1. **`scraper.py`** — walks all pages, normalizes the records, writes
   `retailers.json`. Pure stdlib (`urllib`); no Playwright. Takes ~30s.

2. **`resolve_domains.py`** — for each retailer, figures out the merchant's
   real domain via three strategies in order:
   - Manual override from `domain_overrides.json` (always wins)
   - Slug heuristic — `freddies-flowers` → `freddiesflowers.com`, etc.
   - `--click-out` mode (Playwright): visits the Avios page, clicks "Shop now",
     records where the affiliate redirect chain lands.

   **Click-out requires being signed in to avios.com** — when logged out, the
   "Shop now" button just goes to a login redirect. Pass `--cookies cookies.json`
   with cookies exported from your real browser (use a "Cookie-Editor"
   extension and export `avios.com` cookies as JSON).

## Setup

```bash
# Just the scraper
# (nothing to install — uses stdlib)

# For --click-out domain resolution:
pip install playwright
playwright install chromium
```

## Run

```bash
# Step 1: pull the full list (fast — pure HTTP, no browser)
python scraper.py

# Step 2a: resolve domains using overrides + slug heuristic (fast, partial accuracy)
python resolve_domains.py

# Step 2b: also verify via click-out (slow but accurate; requires sign-in)
python resolve_domains.py --click-out --cookies cookies.json

# Single retailer
python resolve_domains.py --slugs ebay-uk --click-out --cookies cookies.json
```

After the first full run, look at any retailers where `domain_source` is
`"guess"` and the guess looks wrong — fix those by adding entries to
`domain_overrides.json`. Re-run `resolve_domains.py` (without `--refresh`)
and only the ones still missing get re-attempted.

## Output schema

```json
{
  "scraped_at": 1730812345,
  "source": "https://www.avios.com/collect-avios/shopping/api/partners/",
  "count": 2202,
  "retailers": {
    "freddies-flowers": {
      "slug": "freddies-flowers",
      "name": "Freddie's Flowers",
      "avios_url": "https://www.avios.com/en-GB/collect-avios/shopping/retailers/freddies-flowers/",
      "rate_text": "5 Avios / £1",
      "was_rate": "Was 3 Avios / £1",
      "image_url": "https://cdn.rewardengine.com/upload/...",
      "is_speedy": false,
      "categories": [],
      "domains": ["freddiesflowers.com"],
      "domain_source": "override"
    }
  }
}
```

`domain_source` is one of:
- `"override"` — from `domain_overrides.json` (trustworthy)
- `"click_out"` — verified by following the affiliate redirect (trustworthy)
- `"guess"` — heuristic from slug (NOT trustworthy; verify before relying)

## Tests

```bash
python test_extract.py   # API response → Retailer normalization
python test_resolve.py   # slug heuristic + affiliate-domain filter
```

## Note on the unused `categories` field

The partners API doesn't include category info per-retailer, even though the
front-end has category filters. The categories field exists on the output for
extension UX (e.g. "you're shopping at a Travel partner"), but populating it
would require a separate pass — either calling the API once per category and
intersecting, or scraping each retailer's detail page. Skipped for the MVP.
