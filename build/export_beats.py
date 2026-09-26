#!/usr/bin/env python3
"""Export the narration script for external TTS (e.g., a Colab notebook).

Writes, for every spoken beat:
  <outdir>/beats.json   [{"id", "text", "stop", "kind"}, ...]
  <outdir>/beats.txt    one line per beat:  <id><TAB><text>

Synthesize however you like (XTTS, Bark, F5-TTS, Google Cloud TTS, …), name each
output file exactly  <beat_id>.mp3  (or .wav — see adopt script), then run:
  work/venv/bin/python build/adopt_external_audio.py --src <your_output_dir>

Usage:
  work/venv/bin/python build/export_beats.py [--out work/tts_export]
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='work/tts_export')
    args = ap.parse_args()
    out = ROOT / args.out
    out.mkdir(parents=True, exist_ok=True)

    tour = json.loads((ROOT / 'data' / 'tour.json').read_text())
    beats = []
    for b in tour['welcome']['beats']:
        if b.get('audio'):
            beats.append({'id': b['id'], 'text': b['audio'], 'stop': '_welcome', 'kind': b['kind']})
    for stop in tour['stops']:
        for b in stop['beats']:
            if b.get('audio'):
                beats.append({'id': b['id'], 'text': b['audio'], 'stop': stop['id'], 'kind': b['kind']})

    (out / 'beats.json').write_text(json.dumps(beats, ensure_ascii=False, indent=1))
    with open(out / 'beats.txt', 'w') as f:
        for b in beats:
            f.write(f"{b['id']}\t{b['text']}\n")

    words = sum(len(b['text'].split()) for b in beats)
    print(f"exported {len(beats)} beats (~{words} words) to {out}/")
    print("next: synthesize to <id>.mp3 files, then adopt with")
    print("  work/venv/bin/python build/adopt_external_audio.py --src <dir>")


if __name__ == '__main__':
    main()
