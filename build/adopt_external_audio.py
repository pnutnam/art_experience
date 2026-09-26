#!/usr/bin/env python3
"""Install externally synthesized narration (e.g., from your Colab TTS run).

Takes a directory of files named  <beat_id>.mp3  (or .wav/.m4a — converted to
mp3 via ffmpeg), validates each against the current script, installs them into
assets/audio/, and re-bakes js/tour-data.js (durations + cache-busting) by
delegating to generate_audio.py, which will find everything healthy and
synthesize nothing.

Behavior with generate_audio.py afterward: a beat's audio is only regenerated
when its TEXT changes in data/tour.json. External audio therefore survives
rebuilds — but if you later edit a beat's wording, that one beat reverts to the
edge-tts voice unless you re-synthesize it. (Mixed voices for changed beats,
in other words — regenerate the lot if that bothers you.)

Usage:
  work/venv/bin/python build/adopt_external_audio.py --src work/tts_import [--force]
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AUDIO = ROOT / 'assets' / 'audio'


def beat_ids():
    tour = json.loads((ROOT / 'data' / 'tour.json').read_text())
    ids = [b['id'] for b in tour['welcome']['beats'] if b.get('audio')]
    for stop in tour['stops']:
        ids += [b['id'] for b in stop['beats'] if b.get('audio')]
    return set(ids)


def valid_audio(path: Path) -> bool:
    if path.stat().st_size < 2000:
        return False
    r = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
         '-of', 'csv=p=0', str(path)],
        capture_output=True, text=True,
    )
    try:
        return float(r.stdout.strip()) > 1.0
    except ValueError:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True, help='directory with <beat_id>.mp3/.wav/.m4a files')
    args = ap.parse_args()

    src = Path(args.src)
    if not src.is_dir():
        sys.exit(f'no such directory: {src}')
    ids = beat_ids()
    manifest_path = AUDIO / 'manifest.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}

    installed, unknown, bad = [], [], []
    import hashlib
    tour_text = {}
    tour = json.loads((ROOT / 'data' / 'tour.json').read_text())
    for b in tour['welcome']['beats'] + [b for s in tour['stops'] for b in s['beats']]:
        if b.get('audio'):
            tour_text[b['id']] = b['audio']
    voice = tour['meta'].get('voice', 'en-US-AndrewNeural')
    rate = tour['meta'].get('rate', '-8%')

    for f in sorted(src.iterdir()):
        stem, ext = f.stem, f.suffix.lower()
        if ext not in ('.mp3', '.wav', '.m4a'):
            continue
        if stem not in ids:
            unknown.append(f.name)
            continue
        if not valid_audio(f):
            bad.append(f.name)
            continue
        dest = AUDIO / f'{stem}.mp3'
        if ext != '.mp3':
            r = subprocess.run(
                ['ffmpeg', '-y', '-v', 'error', '-i', str(f),
                 '-codec:a', 'libmp3lame', '-qscale:a', '4', str(dest)],
                capture_output=True, text=True)
            if r.returncode != 0 or not valid_audio(dest):
                bad.append(f.name)
                continue
        else:
            shutil.copy2(f, dest)
        installed.append(stem)
        # Register under the CURRENT text hash so generate_audio.py keeps it
        # until the narration text for this beat changes.
        manifest[stem] = {
            'hash': hashlib.sha256(f'{voice}|{rate}|{tour_text[stem]}'.encode()).hexdigest()[:16],
            'file': f'{stem}.mp3',
            'provider': 'external',
        }

    manifest_path.write_text(json.dumps(manifest, indent=1))
    print(f'installed: {len(installed)} ({", ".join(installed) if installed else "-"})')
    if unknown: print(f'ignored (not beat ids): {unknown}')
    if bad: print(f'REJECTED (unplayable/too short): {bad}')

    if not installed:
        print('nothing installed; not rebuilding.')
        return
    # Delegate: bakes durations + js/tour-data.js (+ cache-bust), synthesizes nothing.
    subprocess.run(['work/venv/bin/python', 'build/generate_audio.py'], cwd=ROOT)
    print('done — open the site and listen.')


if __name__ == '__main__':
    main()
