"""
resolve_domains.py — Resolve {slug -> merchant_domain} for each retailer.

The partners API gives us slug, name, rate, image and the Avios destination URL,
but NOT the merchant's actual shopping domain — which is what the extension needs
to match against the URL the user is currently on.

Resolution strategy (in order of preference):

  1. Manual override from `domain_overrides.json` (always wins).
  2. Slug heuristic — works out of the box for slugs that are basically the
     domain ("asos" -> asos.com, "freddies-flowers" -> freddiesflowers.com).
  3. (Optional, --click-out) Open the retailer's Avios page in a real browser,
     click "Shop now", let the affiliate redirect chain settle, record the
     destination domain, close the tab. We never submit a form or interact
     with the merchant site.

The Avios retailer detail page itself does NOT show the merchant URL — the
"Shop now" button just goes to a login redirect. So unless --click-out is on
(which requires you to be logged into avios.com in the same browser context),
we fall back to the heuristic guess.

For the extension to work, EVERY domain must be correct. Plan: run --click-out
once, hand-fix the small number that fail, commit `domain_overrides.json`,
and the next run is fast.

Usage
-----
    # Apply overrides + slug heuristic only (fast, partial accuracy)
    python resolve_domains.py

    # Slow but accurate: click-through every retailer (requires Playwright +
    # being signed into avios.com via cookies exported from your real browser)
    python resolve_domains.py --click-out --cookies cookies.json

    # Re-resolve specific ones
    python resolve_domains.py --slugs ebay-uk freddies-flowers --click-out
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse


# Domains that are part of the affiliate redirect chain — NOT the real merchant.
AFFILIATE_HOSTS = {
    "avios.com", "ba.com", "britishairways.com",
    "rewardengine.com", "cdn.rewardengine.com",
    "awin1.com", "awin.com", "dwin1.com", "dwin2.com",
    "rakutenadvertising.com", "rakuten.com", "linksynergy.com",
    "tradedoubler.com", "tradetracker.com",
    "impactradius-event.com", "impact.com", "pxf.io", "ojrq.net",
    "anrdoezrs.net", "tkqlhce.com", "kqzyfj.com", "jdoqocy.com",  # CJ
    "go.redirectingat.com", "redirectingat.com",  # Skimlinks
    "shareasale.com", "shrsl.com",
    "doubleclick.net", "google.com", "googleadservices.com",
    "facebook.com", "tiktok.com",
}


def is_affiliate_host(host: str) -> bool:
    if not host:
        return False
    host = host.lower()
    if host.startswith("www."):
        host = host[4:]
    if host in AFFILIATE_HOSTS:
        return True
    return any(host == h or host.endswith("." + h) for h in AFFILIATE_HOSTS)


def slug_to_guess(slug: str) -> list[str]:
    """
    Heuristic: derive likely merchant domain(s) from the Avios slug.
    Region suffixes (-uk, -us, ...) bias the TLD; otherwise we try .com first.
    """
    s = slug.lower()
    region = None
    for suffix in ("-uk", "-us", "-ie", "-eu", "-fr", "-de", "-es", "-it"):
        if s.endswith(suffix):
            region = suffix[1:]
            s = s[: -len(suffix)]
            break

    base_no_dashes = s.replace("-", "")
    base_dashes = s

    candidates: list[str] = []
    if region == "uk":
        candidates += [f"{base_no_dashes}.co.uk", f"{base_no_dashes}.com"]
    elif region == "us":
        candidates += [f"{base_no_dashes}.com"]
    else:
        candidates += [f"{base_no_dashes}.com", f"{base_no_dashes}.co.uk"]
    candidates += [f"{base_dashes}.com", f"{base_dashes}.co.uk"]

    seen, out = set(), []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out


def resolve_via_clickout(ctx, avios_url: str, *, timeout_ms: int = 15000) -> str | None:
    """
    Open the retailer's Avios page, click "Shop now", capture the final
    non-affiliate domain. Requires Playwright + an authenticated context.
    """
    from playwright.sync_api import TimeoutError as PWTimeout

    page = ctx.new_page()
    final_host: str | None = None
    try:
        page.goto(avios_url, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(1000)

        with ctx.expect_page(timeout=timeout_ms) as new_page_info:
            try:
                page.get_by_role("link", name=re.compile(r"shop\s*now", re.I))\
                    .first.click(timeout=5000)
            except Exception:
                page.get_by_text(re.compile(r"shop\s*now", re.I))\
                    .first.click(timeout=5000)
        popup = new_page_info.value

        try:
            popup.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
        except PWTimeout:
            pass
        popup.wait_for_timeout(2500)

        host = (urlparse(popup.url).hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        if host and not is_affiliate_host(host):
            final_host = host
        popup.close()
    except Exception as e:
        print(f"    click-out failed: {e}", file=sys.stderr)
    finally:
        page.close()
    return final_host


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="retailers.json")
    ap.add_argument("--overrides", default="domain_overrides.json")
    ap.add_argument("--slugs", nargs="*", help="Only resolve these slugs")
    ap.add_argument("--refresh", action="store_true",
                    help="Re-resolve even retailers that already have a domain")
    ap.add_argument("--click-out", action="store_true",
                    help="Use Playwright to follow Shop Now and capture the final domain. "
                         "Requires being signed into avios.com (see --cookies).")
    ap.add_argument("--cookies",
                    help="Path to a JSON cookie file for avios.com (export with a "
                         "Cookie-Editor browser extension). Required for --click-out: "
                         "without sign-in, 'Shop now' just goes to /api/auth/login.")
    ap.add_argument("--limit", type=int, default=0, help="Stop after N retailers")
    ap.add_argument("--headed", action="store_true", help="Show the browser")
    args = ap.parse_args()

    data_path = Path(args.data)
    payload = json.loads(data_path.read_text())
    retailers = payload["retailers"]

    overrides_path = Path(args.overrides)
    overrides: dict[str, list[str]] = {}
    if overrides_path.exists():
        raw = json.loads(overrides_path.read_text())
        overrides = {k: v for k, v in raw.items() if not k.startswith("_")}

    for slug, domains in overrides.items():
        if slug in retailers:
            retailers[slug]["domains"] = list(domains)
            retailers[slug]["domain_source"] = "override"

    work = list(retailers.keys()) if not args.slugs else \
           [s for s in args.slugs if s in retailers]
    if not args.refresh:
        work = [s for s in work if retailers[s].get("domain_source") != "override"
                                   and not retailers[s].get("domains")]
    if args.limit:
        work = work[: args.limit]

    print(f"Resolving {len(work)} retailers (overrides applied: {len(overrides)})",
          file=sys.stderr)

    needs_clickout = []
    for slug in work:
        r = retailers[slug]
        guesses = slug_to_guess(slug)
        if guesses:
            r["domains"] = [guesses[0]]
            r["domain_source"] = "guess"
            r["domain_candidates"] = guesses
            needs_clickout.append(slug)

    data_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))

    if not args.click_out:
        print("Skipping click-out (use --click-out to verify domains).",
              file=sys.stderr)
        print(f"{len(needs_clickout)} retailers have unverified guess-based domains.",
              file=sys.stderr)
        return 0

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("--click-out requires playwright. Install with:\n"
              "  pip install playwright && playwright install chromium",
              file=sys.stderr)
        return 1

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        ctx = browser.new_context(
            user_agent=("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/120.0.0.0 Safari/537.36"),
            locale="en-GB",
            viewport={"width": 1400, "height": 900},
        )
        if args.cookies:
            cookies = json.loads(Path(args.cookies).read_text())
            ctx.add_cookies(cookies)

        for i, slug in enumerate(needs_clickout, 1):
            print(f"[{i}/{len(needs_clickout)}] {slug}", file=sys.stderr)
            r = retailers[slug]
            host = resolve_via_clickout(ctx, r["avios_url"])
            if host:
                r["domains"] = [host]
                r["domain_source"] = "click_out"
            if i % 25 == 0:
                data_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))

        browser.close()

    data_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))

    unresolved = [s for s in needs_clickout
                  if retailers[s].get("domain_source") != "click_out"]
    if unresolved:
        log_path = data_path.with_suffix(".unresolved.txt")
        log_path.write_text("\n".join(unresolved))
        print(f"\n{len(unresolved)} retailers still on guess-based domains. "
              f"See {log_path}.", file=sys.stderr)
        print("Add manual entries to domain_overrides.json and re-run.",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
