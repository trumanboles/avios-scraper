"""Test scraper.normalize against the real API response shape."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from scraper import normalize


def test_normalize():
    fixture = json.loads(Path(__file__).with_name("test_fixture_api.json").read_text())
    partners = fixture["data"]["partners"]
    rows = [normalize(p) for p in partners]
    by_slug = {r.slug: r for r in rows}

    print(f"Normalized {len(rows)} entries:")
    for r in rows:
        print(f"  {r.slug:30s} | name={r.name!r:25s} | rate={r.rate_text!r}")
        print(f"  {'':30s} | url={r.avios_url}")

    # Apostrophe in name preserved
    dominos = by_slug["dominos-pizza"]
    assert dominos.name == "Domino's Pizza", f"got {dominos.name!r}"
    assert dominos.rate_text == "2 Avios / £1"
    assert dominos.was_rate == "", "wasRate=null should normalize to empty string"
    assert dominos.is_speedy is False

    # wasRate populated when present
    viator = by_slug["viator-uk"]
    assert viator.was_rate == "Was 4 Avios / £1"

    # destinationUrl with leading slash gets the canonical /en-GB/collect-avios prefix
    selfridges = by_slug["selfridges"]
    assert selfridges.avios_url == \
        "https://www.avios.com/en-GB/collect-avios/shopping/retailers/selfridges/", \
        f"got {selfridges.avios_url!r}"
    assert selfridges.image_url.startswith("https://cdn.rewardengine.com/")

    print("\nAll assertions passed.")


if __name__ == "__main__":
    test_normalize()
