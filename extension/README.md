# Avios Shopping Reminder Extension (MV3)

Chrome extension that reminds you to click through the Avios shopping portal when you land on a known partner domain.

## Build data

From repository root:

```bash
python3 scraper.py
python3 resolve_domains.py
node extension/data/build-data.js
```

This generates `extension/data/retailers.json` as a domain-keyed lookup for fast matching.

## Load unpacked in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` folder

## Behavior

- Background service worker listens to main-frame `webNavigation.onCommitted`
- Matches current hostname against domain-keyed data with subdomain fallback
- Two reminder modes:
  - Banner (in-page, dismissable, auto-hide)
  - Badge-only (icon badge + popup flow)
- Suppression:
  - Referrer from Avios/affiliate hosts
  - 30-minute domain cooldown after dismiss
  - per-domain skip list
  - optional verified-only mode (`override`/`click_out`)

## Data refreshes

- On install: tries remote fetch and caches in `chrome.storage.local`
- Weekly via `chrome.alarms`
- Manual refresh button in Options page
- Falls back to bundled `extension/data/retailers.json` if remote fetch fails

## Test walkthrough

Use default mode (**Banner**) first:

1. Visit `https://www.selfridges.com`  
   Expect: banner appears (or badge in badge mode), with Avios rate and CTA.
2. Visit `https://www.freddiesflowers.com`  
   Expect: same partner reminder behavior.
3. Visit `https://www.wikipedia.org`  
   Expect: no reminder and no partner card in popup.

In **Badge-only** mode:
- Extension icon shows a badge on partner domains.
- Clicking icon opens popup with partner details and a `Go via Avios` button.
