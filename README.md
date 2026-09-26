# The Keppler Rooms

A private, guided audio tour of four chromolithographs by **Joseph Keppler** (1838–1894),
from the covers and centerfolds of *Puck* — built as a self-contained static site.

A synthesized guide (warm neural voice) walks the visitor through four rooms,
choreographs their gaze across the picture, asks Socratic questions
(*What do you see? What do you think? What do you feel?*), and never rushes:
every question opens a private journal, and every answer stays on the visitor's device.

## The four rooms

| Room | Work | Date |
|------|------|------|
| One | *Sheol* — the Revised Version Bible joke, with Darwin & Voltaire on Charon's ferry | May 27, 1885 |
| Two | *The Return of the "Prodigal Father"* — Keppler's self-caricature homecoming | Oct 10, 1883 |
| Three | *The Bosses of the Senate* — the money-bag trusts | Jan 23, 1889 |
| Four | *Puck's Own Yorktown Celebration* — the whole cast of Puck on parade | Oct 19, 1881 |

All source imagery: Library of Congress, no known restrictions.

## Run it locally

```bash
cd art_experience
python3 -m http.server 8123
# open http://127.0.0.1:8123
```

(Any static server works. Serving over `file://` also works, but a local server is nicer
for audio preloading.)

## Deploy to a website

The runtime needs exactly four things:

```
index.html  css/  js/  assets/
```

Ship those and nothing else. Everything under `originals/`, `work/`, and
`master-*.tif` is heavy source material (~700 MB) and must not be uploaded;
`build/`, `data/`, `research/`, and `context/` are the tour's source and are safe
to publish but are not needed to serve it.

```bash
# rsync the ship set only
rsync -av --delete index.html css js assets user@host:/var/www/keppler-rooms/

# verify before and after
python3 tests/smoke_test.py
python3 tests/smoke_test.py --url https://your-host/keppler-rooms/
```

Total payload: ~18 MB images + ~6 MB audio. No build step, no dependencies,
no external requests — fonts are the system serif stack, so the page makes zero
third-party calls.

## Editing the tour

Everything the guide says lives in **`data/tour.json`** — narration text,
Socratic questions, curator hints, **per-room scholar notes** (shown in the in-app
"Notes & sources" drawer, key `N`), camera focus points (normalized `x, y, scale`
per beat), and dwell times for silent-looking beats.

After editing the script, regenerate audio (only changed beats re-synthesize).
One-time setup first — `work/` is gitignored scratch, so a fresh clone has no
virtualenv yet:

```bash
python3 -m venv work/venv
work/venv/bin/pip install -r requirements.txt   # edge-tts only

work/venv/bin/python build/generate_audio.py
```

Also needs `ffmpeg`/`ffprobe` on `PATH` (durations and non-MP3 conversion).
Synthesis needs internet at generation time only.

The script uses [edge-tts](https://github.com/rany2/edge-tts) (Microsoft neural voices,
needs internet at generation time only). Voice/rate are set in `tour.json` → `meta.voice` /
`meta.rate`. Generated MP3s land in `assets/audio/`, and the baked data file
`js/tour-data.js` is rewritten with durations.

If a narration MP3 is missing or fails, the app automatically falls back to the
browser's built-in speech synthesis — **for that one beat only**; the next beat
resumes the recorded voice (a startup health check also flags any missing files
in the console).

## Using your own voices (Colab TTS, voice cloning, etc.)

The narration is recorded audio, so any TTS that produces MP3s drops straight in:

```bash
# 1. export the script (id + text for all 35 spoken beats)
work/venv/bin/python build/export_beats.py            # → work/tts_export/beats.{json,txt}

# 2. synthesize on Colab however you like (XTTS, Bark, F5-TTS, Google TTS, a
#    cloned narrator voice…) — one file per beat, named  <beat_id>.mp3
#    (wav/m4a also accepted; converted automatically)

# 3. install the results
work/venv/bin/python build/adopt_external_audio.py --src path/to/your/output
```

The adopt script validates every file (playable, >2 KB, real duration), converts
non-MP3s, installs into `assets/audio/`, and re-bakes `js/tour-data.js` with the
new durations and cache-busting hashes. External audio is keyed to the current
narration text: if you later reword a beat in `tour.json`, only that beat reverts
to the edge-tts voice on the next build — re-synthesize it (or the whole set) and
re-adopt to keep one consistent voice.

## The scholarship layer

The narration is grounded in primary records (Library of Congress captions and
catalog descriptions, the 1885 Revised Version preface) and the scholarly
literature — West's *Satire on Stone* (the standard monograph), Kahn & West's
*What Fools These Mortals Be*, Hess & Kaplan's *The Ungentlemanly Art*, Marzio's
*The Democratic Art*, Fischer's *Them Damned Pictures*, Brown's *Beyond the Lines*,
and peer-reviewed work such as Richard R. John's "Robber Barons Redux"
(*Enterprise & Society*, 2012). Three files carry this layer:

- **`research/DOSSIER.md`** — the full curated context per room: records, iconography,
  reception, method, and a tiered bibliography ([PRIM]/[PEER]/[SCH]/[MUS]/[REF])
  with a standing list of widely-retold-but-unverified claims that must never be
  stated as fact.
- **`research/FACT-LEDGER.md`** — every factual claim spoken in the narration mapped
  to its source and confidence status. (Writing it already caught one arithmetic
  error: "twenty-three years after Gettysburg" → twenty-five.)
- **`context/AGENT-BRIEF.md`** — the prepped system context for a future interactive
  Socratic guide agent: role and voice, the VTS questioning protocol, per-work
  context cards with camera focus maps, a question bank, cross-links, guardrails,
  and a citation pocket. Load it plus the dossier as system context if you ever
  wire a live LLM guide; the site works fully without one.

## Pipeline provenance

- `originals/*.tif` — LOC master scans (58–148 MB each), kept out of git.
  - `sheol.tif` — LC-DIG-ppmsca-28201 (item [2011661750](https://www.loc.gov/item/2011661750/))
  - `prodigal_father.tif` — LC-DIG-ppmsca-28432 (item [92520934](https://www.loc.gov/item/92520934/))
  - `yorktown.tif` — LC-DIG-ppmsca-28522 (item [2012647294](https://www.loc.gov/item/2012647294/))
  - `bosses_senate.tif` — LC-USZC4-494 (item [2002718861](https://www.loc.gov/item/2002718861/))
- `assets/img/` — web derivatives: 4200px JPEG + WebP (full), 1600px JPEG (mid),
  320px thumb, 24px LQIP (inlined in `js/lqip.js`).
- To re-derive images from the TIFFs: `convert originals/<name>.tif -colorspace sRGB -resize 4200x4200> -strip -quality 84 assets/img/<name>_full.jpg` (etc.)

## Design notes

- **Camera = the guide's gaze.** Each narration beat can define a `focus`; the viewer
  eases there over ~3s (respecting `prefers-reduced-motion`). The visitor can grab the
  image at any time — drag to pan, wheel/pinch to zoom, double-click to zoom.
- **Two resolution tiers.** The 1600px layer paints instantly; the 4200px WebP fades in
  when zoomed past ~1.04×.
- **Privacy.** Journal, progress, and settings live in `localStorage` only. The journal
  is exportable as Markdown from the finale.
- **Accessibility.** Full transcript panel (T), keyboard controls (space, ←/→, C, T),
  reduced-motion support, `[hidden]`-safe styling.

## Keyboard

`space` play/pause · `←`/`→` previous/next beat · `T` transcript · `C` contents · `N` notes & sources · `Esc` close panels
