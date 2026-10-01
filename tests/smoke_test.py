#!/usr/bin/env python3
"""Smoke test for The Keppler Rooms.

Catches the failure classes that actually break a deploy: a stale
js/tour-data.js, an asset that didn't make it into the payload, a beat with no
audio, or a stray heavyweight file that would be uploaded by accident.

Stdlib only. Two modes:

    python3 tests/smoke_test.py                     # check the working tree
    python3 tests/smoke_test.py --url https://host/ # check a live deployment

Exit code 0 = all green, 1 = at least one failure.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import hashlib
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Everything the browser needs, and nothing else. Keep in sync with README.
SHIP_FILES = ("index.html",)
SHIP_DIRS = ("css", "js", "assets")

# Payload budget. Current build is ~24 MB; leave headroom but catch a stray
# master TIFF (50-150 MB) being swept into the upload.
MAX_TOTAL_BYTES = 60 * 1024 * 1024
MAX_SINGLE_BYTES = 6 * 1024 * 1024

# Mirrors MIN_SCALE / MAX_SCALE in js/viewer.js.
MIN_SCALE, MAX_SCALE = 1.0, 5.5

# Cloudflare sits in front of the deployed site and 403s the default
# "Python-urllib" agent, which would fail every check for reasons that have
# nothing to do with the site. A smoke test emulates a visitor, so send a
# visitor's user-agent.
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126 Safari/537.36"
)

failures: list[str] = []
notes: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    if ok:
        print(f"  PASS  {name}" + (f"  ({detail})" if detail else ""))
    else:
        print(f"  FAIL  {name}" + (f"  ({detail})" if detail else ""))
        failures.append(name + (f" — {detail}" if detail else ""))


def note(msg: str) -> None:
    print(f"  ..    {msg}")
    notes.append(msg)


# ---------------------------------------------------------------- data contract

def load_tour_data(source: str | None) -> dict:
    """Parse js/tour-data.js from the working tree or from a URL."""
    if source:
        raw = fetch(source.rstrip("/") + "/js/tour-data.js").decode()
    else:
        raw = (ROOT / "js" / "tour-data.js").read_text()
    m = re.search(r"window\.TOUR_DATA\s*=\s*(\{.*\})\s*;?\s*$", raw.strip(), re.S)
    if not m:
        raise ValueError("js/tour-data.js does not assign window.TOUR_DATA")
    return json.loads(m.group(1))


def all_beats(data: dict):
    for stop in [data["welcome"]] + data["stops"]:
        for beat in stop["beats"]:
            yield stop, beat


# ---------------------------------------------------------------------- checks

def check_ship_set() -> None:
    print("\nship set (index.html css/ js/ assets/)")
    total = 0
    oversized = []
    for name in SHIP_FILES:
        p = ROOT / name
        check(f"{name} exists", p.is_file())
        if p.is_file():
            total += p.stat().st_size
    for d in SHIP_DIRS:
        p = ROOT / d
        check(f"{d}/ exists", p.is_dir())
        if not p.is_dir():
            continue
        for f in sorted(p.rglob("*")):
            if not f.is_file():
                continue
            size = f.stat().st_size
            total += size
            if size > MAX_SINGLE_BYTES:
                oversized.append(f"{f.relative_to(ROOT)} ({size / 1e6:.1f} MB)")

    # A heavyweight file inside the ship set means it WILL be uploaded — hard gate.
    check("no heavyweight file inside the ship set", not oversized, "; ".join(oversized))
    check(
        "ship set total within budget",
        total <= MAX_TOTAL_BYTES,
        f"{total / 1e6:.1f} MB (limit {MAX_TOTAL_BYTES / 1e6:.0f} MB)",
    )

    # Source material outside the ship set is fine to keep locally, but make the
    # cost of a naive "upload the whole folder" visible on every run.
    ship_roots = set(SHIP_DIRS) | set(SHIP_FILES)
    strays = [
        f"{p.relative_to(ROOT)} ({p.stat().st_size / 1e6:.0f} MB)"
        for p in sorted(ROOT.rglob("*"))
        if p.is_file()
        and p.relative_to(ROOT).parts[0] not in ship_roots
        and not p.relative_to(ROOT).parts[0].startswith(".")
        and p.stat().st_size > MAX_SINGLE_BYTES
    ]
    if strays:
        note("outside the allowlist, never uploaded: " + ", ".join(strays))
        note("deploy the allowlist (index.html css js assets) — do not upload the folder wholesale")
    else:
        note("no heavyweight source material found outside the ship set")


def check_index_references() -> None:
    print("\nindex.html references")
    html = (ROOT / "index.html").read_text()
    for ref in re.findall(r'(?:src|href)="([^"#][^"]*)"', html):
        if ref.startswith(("data:", "http:", "https:")):
            continue
        # strip the ?v=<hash> cache buster used for js/tour-data.js and js/lqip.js
        path = ref.split("?", 1)[0]
        check(f"{path} resolves", (ROOT / path).is_file())
    for want in ("js/tour-data.js", "js/app.js", "js/viewer.js", "js/lqip.js", "css/style.css"):
        check(f"index.html loads {want}", want in html)


def check_data_contract(data: dict) -> None:
    print("\ntour-data.js contract")
    for key in ("meta", "welcome", "stops", "durations", "audioBase", "images"):
        check(f"has '{key}'", key in data)
    if not all(k in data for k in ("welcome", "stops", "durations", "images")):
        return

    beats = list(all_beats(data))
    spoken = [(s, b) for s, b in beats if b.get("audio")]
    check("welcome has beats", bool(data["welcome"].get("beats")))
    check("tour has 4 rooms", len(data["stops"]) == 4, f"{len(data['stops'])}")
    check("every beat has an id", all(b.get("id") for _, b in beats))
    ids = [b["id"] for _, b in beats]
    check("beat ids unique", len(ids) == len(set(ids)))

    durations = data["durations"]
    missing = [b["id"] for _, b in spoken if b["id"] not in durations]
    check("every spoken beat has a baked duration", not missing, ", ".join(missing))
    bad = [k for k, v in durations.items() if not isinstance(v, (int, float)) or v <= 0]
    check("all durations positive numbers", not bad, ", ".join(bad))
    note(f"{len(beats)} beats ({len(spoken)} spoken) · {len(durations)} durations")


def check_assets(data: dict) -> None:
    print("\nasset graph")
    base = data.get("audioBase", "assets/audio/")
    spoken = [b for _, b in all_beats(data) if b.get("audio")]

    missing_audio = [
        b["id"] for b in spoken
        if not (ROOT / f"{base}{b['id']}.mp3").is_file()
    ]
    check("every spoken beat has an MP3", not missing_audio, ", ".join(missing_audio))

    on_disk = {p.name for p in (ROOT / base.rstrip("/")).glob("*.mp3")}
    orphan = sorted(on_disk - {f"{b['id']}.mp3" for b in spoken})
    check("no orphan MP3s on disk", not orphan, ", ".join(orphan))

    for name, paths in data["images"].items():
        for tier in ("mid", "full", "webp", "thumb"):
            check(f"{name}_{tier} present", (ROOT / paths[tier]).is_file(), paths[tier])

    lqip = (ROOT / "js" / "lqip.js").read_text()
    check("js/lqip.js defines window.LQIP", "window.LQIP" in lqip)
    for name in data["images"]:
        check(f"LQIP placeholder for {name}", re.search(rf'"{name}"\s*:', lqip) is not None)


def check_view_logic(data: dict) -> None:
    print("\nview logic consistency")
    app = (ROOT / "js" / "app.js").read_text()

    m = re.search(r"const ASPECTS\s*=\s*\{([^}]*)\}", app)
    aspect_keys = set(re.findall(r"(\w+)\s*:", m.group(1))) if m else set()
    check(
        "ASPECTS covers every image",
        aspect_keys == set(data["images"]),
        f"app.js {sorted(aspect_keys)} vs tour-data {sorted(data['images'])}",
    )

    out_of_range = []
    for stop in data["stops"]:
        for beat in stop["beats"]:
            f = beat.get("focus")
            if not f:
                continue
            x, y, s = f.get("x"), f.get("y"), f.get("scale")
            if not (0 <= x <= 1 and 0 <= y <= 1 and MIN_SCALE <= s <= MAX_SCALE):
                out_of_range.append(f"{beat['id']}={f}")
    check("all focus points in range", not out_of_range, "; ".join(out_of_range))

    for stop in data["stops"]:
        if not stop.get("image"):
            check(f"room '{stop['id']}' declares an image", False)
    check("every room declares an image", all(s.get("image") for s in data["stops"]))
    check(
        "room images all known",
        all(s["image"] in data["images"] for s in data["stops"]),
    )


def check_accessibility(data: dict) -> None:
    """Guard the fixes that keep this thing usable without sight or a mouse.

    Cheap static checks: a regression here is invisible to the asset-graph and
    data-contract checks, and invisible to anyone who can see and click.
    """
    print("\naccessibility")
    html = (ROOT / "index.html").read_text()
    app = (ROOT / "js" / "app.js").read_text()
    viewer = (ROOT / "js" / "viewer.js").read_text()

    # Every artwork needs a real description. The whole point of the site is
    # looking at pictures; an empty alt made it invisible to screen readers.
    for stop in data["stops"]:
        alt = (stop.get("alt") or "").strip()
        check(f"'{stop['id']}' has artwork alt text", len(alt) >= 60, f"{len(alt)} chars")
    check("welcome has backdrop alt text", len((data["welcome"].get("alt") or "").strip()) >= 30)
    check("alt text is passed to the viewer", "stop.alt" in app and "setImage(" in viewer)
    check("viewer sets alt on the image tier", "this.mid.alt" in viewer)

    # aria-label is ignored on a generic div, so the label has to be on
    # something with a role.
    check("viewer container has a role", re.search(r'id="viewer"[^>]*\brole=', html) is not None)
    check("viewer frame is focusable", re.search(r"tabIndex\s*=\s*0", viewer) is not None)
    check("viewer frame has a role", "setAttribute('role'" in viewer)
    check("viewer is keyboard operable", "keydown" in viewer and "zoomBy" in viewer)
    check("focus ring is styled", ":focus-visible" in (ROOT / "css" / "style.css").read_text())

    # A tablist must contain tabs. These are beat jumpers, not tabs, so the
    # group role plus aria-current is the honest pattern.
    check("beat dots are not a tablist", 'role="tablist"' not in html)
    check("beat dots use a group role", re.search(r'id="beat-dots"[^>]*role="group"', html) is not None)
    check("active beat marked with aria-current", "aria-current" in app)

    # Panels announce their state.
    check("beat changes announced politely", re.search(r'id="now-playing"[^>]*aria-live', html) is not None)
    check("panel toggles initialised at boot", app.count("syncPanelButtons()") >= 2)


def check_data_durability(data: dict) -> None:
    """A written reflection must survive every way of leaving its card.

    The only paths that used to save were the Continue button and a 350ms
    debounce, so typing and then pressing → or Leave threw the answer away.
    """
    print("\njournal durability")
    app = (ROOT / "js" / "app.js").read_text()
    check("a draft flush helper exists", "function flushDraft(" in app)
    check("beat changes flush the draft", re.search(r"function goTo\([^)]*\)\s*\{\s*flushDraft\(\)", app) is not None)
    check("finishing the tour flushes the draft", re.search(r"function finishTour\(\)\s*\{\s*flushDraft\(\)", app) is not None)
    check("leaving the tour flushes the draft", re.search(r"btnExit\.addEventListener\('click', \(\) => \{\s*flushDraft\(\)", app) is not None)
    check("page unload flushes the draft", "pagehide" in app)


def check_image_tier_fallback(data: dict) -> None:
    """The hi-res tier must degrade, not stampede.

    The old guard compared the resolved absolute .src against a relative path,
    so it was always true and a missing image re-requested itself in a loop
    (measured: 999 error events in 3.2s).
    """
    print("\nimage tier fallback")
    viewer = (ROOT / "js" / "viewer.js").read_text()
    check("no absolute-vs-relative src comparison",
          "this.full.src !== paths.full" not in viewer)
    check("fallback walks a bounded candidate list",
          re.search(r"const candidates = \[paths\.webp, paths\.full\]", viewer) is not None)
    # The retry guard must be a counter against the candidate count, not a
    # comparison against a URL. Assert the shape, not the surrounding comment.
    check("fallback gives up rather than retrying",
          re.search(r"if \(tier >= candidates\.length\)", viewer) is not None)
    check("exhausted fallback drops the hi-res src",
          re.search(r"if \(tier >= candidates\.length\)\s*\{[^}]*removeAttribute\('src'\)",
                    viewer) is not None)


def check_cache_busting(data: dict) -> None:
    """Every ship-set reference must carry a content hash.

    index.html is served DYNAMIC and everything else is cached for 4h, so an
    unbusted app.js or style.css is a code change visitors never receive.
    """
    print("\ncache busting")
    html = (ROOT / "index.html").read_text()
    stale = []
    for rel in ("js/lqip.js", "js/tour-data.js", "js/viewer.js", "js/app.js",
                "css/style.css"):
        m = re.search(rf'{re.escape(rel)}(?:\?v=([0-9a-f]+))?', html)
        if not m:
            continue
        if not m.group(1):
            stale.append(f"{rel} (no ?v=)")
            continue
        actual = hashlib.sha1((ROOT / rel).read_bytes()).hexdigest()[:8]
        if m.group(1) != actual:
            stale.append(f"{rel} (index says {m.group(1)}, file is {actual})")
    check("all ship-set refs hashed and current", not stale, "; ".join(stale))

    gen = (ROOT / "build" / "generate_audio.py").read_text()
    for rel in ("js/app.js", "js/viewer.js", "css/style.css"):
        check(f"build re-hashes {rel}", rel in gen)


def check_js_syntax() -> None:
    print("\njs syntax")
    try:
        subprocess.run(["node", "--version"], capture_output=True, check=True)
    except (OSError, subprocess.CalledProcessError):
        note("node not available — skipping syntax check")
        return
    for f in sorted((ROOT / "js").glob("*.js")):
        r = subprocess.run(["node", "--check", str(f)], capture_output=True, text=True)
        check(f"{f.name} parses", r.returncode == 0, r.stderr.strip().splitlines()[0] if r.stderr else "")


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def check_live(url: str) -> None:
    """Verify the same ship set is actually served and healthy."""
    print(f"\nlive deployment — {url}")
    base = url.rstrip("/")

    paths = ["index.html", "css/style.css", "js/app.js", "js/viewer.js", "js/tour-data.js", "js/lqip.js"]
    data = load_tour_data(base)
    paths += [f"{data.get('audioBase', 'assets/audio/')}{b['id']}.mp3" for _, b in all_beats(data) if b.get("audio")]
    for name, p in data["images"].items():
        paths += [p["mid"], p["thumb"]]

    bad = []
    for p in paths:
        try:
            size = len(fetch(base + "/" + p))
            if size == 0:
                bad.append(f"{p} -> empty body")
        except Exception as e:  # noqa: BLE001
            bad.append(f"{p} -> {e}")
    check(f"all {len(paths)} ship files served 200 with a body", not bad, "; ".join(bad[:5]))


# ---------------------------------------------------------------------- driver

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", help="also verify a live deployment (e.g. https://host/keppler-rooms/)")
    args = ap.parse_args()

    print("The Keppler Rooms — smoke test")
    print(f"root: {ROOT}")

    try:
        data = load_tour_data(args.url if args.url else None)
    except Exception as e:  # noqa: BLE001
        print(f"\n  FAIL  js/tour-data.js unparsable — {e}")
        return 1

    check_ship_set()
    check_index_references()
    check_data_contract(data)
    check_assets(data)
    check_view_logic(data)
    check_accessibility(data)
    check_data_durability(data)
    check_image_tier_fallback(data)
    check_cache_busting(data)
    check_js_syntax()
    if args.url:
        check_live(args.url)

    print("\n" + "=" * 60)
    if failures:
        print(f"FAILED — {len(failures)} problem(s):")
        for f in failures:
            print(f"  ✗ {f}")
        return 1
    print("ALL GREEN")
    return 0


if __name__ == "__main__":
    sys.exit(main())
