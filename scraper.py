"""
scraper.py — Pull the full Avios retailer list from the partners API.

The Avios shopping page uses an internal JSON endpoint:

    GET https://www.avios.com/collect-avios/shopping/api/partners/
        ?page=N
        &collectionMechanic=eStore,Manual
        &showHighestRate=true
        &rateUpTo=up%20to
        &fromText=From
        &wasRateText=Was

It returns 60 partners per page along with a `total` count, so we just
walk pages 0..ceil(total/60). No Playwright, no DOM scraping.

Each partner record looks like:
    {
      "rate": "Up to 12 Avios / £1",
      "wasRate": "Was up to 6 Avios / £1",         # may be null
      "logoSrc": "https://cdn.rewardengine.com/...jpg",
      "name": "Selfridges",
      "slug": "selfridges",
      "destinationUrl": "/retailers/selfridges",
      "isSpeedyAwarding": false
    }

Output: retailers.json with the same structure as before (slug-keyed dict)
so the rest of the pipeline (resolve_domains.py, the extension) doesn't change.

Usage
-----
    python scraper.py                  # full crawl, write retailers.json
    python scraper.py --category clothes-and-fashion
    python scraper.py --limit 2        # just first 2 pages (smoke test)
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

import urllib.request
import urllib.parse
import urllib.error


API_BASE = "https://www.avios.com/collect-avios/shopping/api/partners/"

# Default query — these are what the live site uses. The text fields just control
# how the `rate` / `wasRate` strings are formatted in the response; the data is the
# same either way.
DEFAULT_PARAMS = {
    "collectionMechanic": "eStore,Manual",
    "showHighestRate": "true",
    "rateUpTo": "up to",
    "fromText": "From",
    "wasRateText": "Was",
}

PAGE_SIZE = 60  # observed: each response returns 60 entries except possibly the last

# A real Chrome UA — the API does enforce some bot detection at the edge, so we
# present as a normal browser. We do NOT need cookies or auth for this endpoint
# (it's the public listing).
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-GB,en;q=0.9",
    "Referer": "https://www.avios.com/en-GB/collect-avios/shopping/retailers/",
}


@dataclass
class Retailer:
    slug: str
    name: str
    avios_url: str
    rate_text: str = ""
    was_rate: str = ""
    image_url: str = ""
    is_speedy: bool = False
    categories: list[str] = field(default_factory=list)


def fetch_page(page: int, *, category: str | None = None,
               extra_params: dict | None = None,
               retries: int = 3, backoff: float = 2.0) -> dict:
    """Fetch one page of the partners API. Raises on persistent failure."""
    params = dict(DEFAULT_PARAMS)
    params["page"] = str(page)
    if category:
        # The site uses ?c={category} on the listing page. Whether the API
        # accepts it as `category` or `c` we don't know for sure — we try `c`
        # first because that matches the front-end URL convention. If it's
        # wrong it just gets ignored (we'd see no filtering effect).
        params["c"] = category
    if extra_params:
        params.update(extra_params)

    url = API_BASE + "?" + urllib.parse.urlencode(params, safe=",")
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"HTTP {resp.status} for {url}")
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
            last_err = e
            if attempt < retries - 1:
                sleep_for = backoff * (2 ** attempt)
                print(f"    ! page {page} attempt {attempt + 1} failed ({e}); "
                      f"retrying in {sleep_for:.0f}s",
                      file=sys.stderr)
                time.sleep(sleep_for)
    raise RuntimeError(f"failed to fetch page {page}: {last_err}")


def normalize(p: dict) -> Retailer:
    """Turn an API record into our internal Retailer dataclass."""
    slug = (p.get("slug") or "").strip()
    dest = (p.get("destinationUrl") or "").strip()
    # destinationUrl is "/retailers/{slug}" — turn it into a full URL the
    # extension can use to send the user to the click-out page.
    if dest.startswith("/"):
        avios_url = "https://www.avios.com/en-GB/collect-avios/shopping" + dest
        if not avios_url.endswith("/"):
            avios_url += "/"
    else:
        avios_url = dest

    return Retailer(
        slug=slug,
        name=(p.get("name") or "").strip(),
        avios_url=avios_url,
        rate_text=(p.get("rate") or "").strip(),
        was_rate=(p.get("wasRate") or "").strip() if p.get("wasRate") else "",
        image_url=(p.get("logoSrc") or "").strip(),
        is_speedy=bool(p.get("isSpeedyAwarding")),
    )


def crawl(*, category: str | None = None, page_limit: int | None = None,
          delay: float = 0.4) -> dict[str, Retailer]:
    """Walk all pages and return a {slug: Retailer} dict."""
    retailers: dict[str, Retailer] = {}

    # First page tells us the total
    print("Fetching page 0...", file=sys.stderr)
    first = fetch_page(0, category=category)
    data = first.get("data", first)  # tolerate either wrapped or flat
    partners = data.get("partners", [])
    pagination = data.get("pagination", {})
    total = pagination.get("total", len(partners))
    page_size = pagination.get("entries", PAGE_SIZE) // max(1, pagination.get("page", 0) or 1) \
                if pagination.get("entries") and pagination.get("page") else PAGE_SIZE
    # `entries` in the response is cumulative-so-far, not per-page. Trust PAGE_SIZE.
    page_size = PAGE_SIZE

    for p in partners:
        r = normalize(p)
        if r.slug:
            retailers[r.slug] = r

    n_pages = (total + page_size - 1) // page_size
    if page_limit:
        n_pages = min(n_pages, page_limit)
    print(f"  total={total}, pages to fetch: {n_pages}", file=sys.stderr)

    for page in range(1, n_pages):
        if delay:
            time.sleep(delay)
        print(f"Fetching page {page}/{n_pages - 1}...", file=sys.stderr)
        try:
            payload = fetch_page(page, category=category)
        except Exception as e:
            print(f"  ! giving up on page {page}: {e}", file=sys.stderr)
            continue
        page_data = payload.get("data", payload)
        for p in page_data.get("partners", []):
            r = normalize(p)
            if r.slug and r.slug not in retailers:
                retailers[r.slug] = r

    return retailers


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="retailers.json")
    ap.add_argument("--category", help="Filter to a single category slug "
                                       "(experimental — endpoint may ignore it)")
    ap.add_argument("--limit", type=int, default=None,
                    help="Max number of pages to fetch (smoke testing)")
    ap.add_argument("--delay", type=float, default=0.4,
                    help="Seconds between page requests (be polite)")
    args = ap.parse_args()

    retailers = crawl(category=args.category, page_limit=args.limit, delay=args.delay)

    payload = {
        "scraped_at": int(time.time()),
        "source": API_BASE,
        "count": len(retailers),
        "retailers": {slug: asdict(r) for slug, r in sorted(retailers.items())},
    }
    Path(args.out).write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    print(f"\nWrote {len(retailers)} retailers to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
