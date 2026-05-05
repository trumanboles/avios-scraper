import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from resolve_domains import slug_to_guess, is_affiliate_host


def test_slug_guesses():
    cases = [
        ("asos", ["asos.com", "asos.co.uk"]),
        ("ebay-uk", ["ebay.co.uk", "ebay.com"]),
        ("freddies-flowers", ["freddiesflowers.com", "freddiesflowers.co.uk"]),
        ("lookfantastic", ["lookfantastic.com", "lookfantastic.co.uk"]),
    ]
    for slug, expected_first_two in cases:
        guesses = slug_to_guess(slug)
        print(f"  {slug:30s} -> {guesses[:3]}")
        for d in expected_first_two:
            assert d in guesses, f"{d!r} not in guesses for {slug}: {guesses}"
    print("Slug heuristic OK.")


def test_affiliate_filter():
    assert is_affiliate_host("avios.com")
    assert is_affiliate_host("www.avios.com")
    assert is_affiliate_host("cdn.rewardengine.com")
    assert is_affiliate_host("go.redirectingat.com")
    assert not is_affiliate_host("johnlewis.com")
    assert not is_affiliate_host("freddiesflowers.com")
    print("Affiliate filter OK.")


if __name__ == "__main__":
    test_slug_guesses()
    test_affiliate_filter()
    print("All tests passed.")
