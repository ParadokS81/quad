#!/usr/bin/env python3
"""Thin faster-whisper wrapper for Quad processing module.

Transcribes all .ogg/.flac files in a directory and outputs JSON to stdout.
Progress and errors go to stderr.

Usage:
    python3 scripts/transcribe.py <audio_dir> [--model MODEL] [--language LANG] [--initial-prompt PROMPT]
"""

import argparse
import json
import sys
from pathlib import Path

from faster_whisper import WhisperModel


def transcribe_file(model: WhisperModel, audio_path: str, language: str, initial_prompt: str) -> dict:
    kwargs = dict(
        language=language,
        beam_size=5,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=300, speech_pad_ms=200),
        word_timestamps=True,
    )
    if initial_prompt:
        kwargs["initial_prompt"] = initial_prompt

    segments, info = model.transcribe(audio_path, **kwargs)

    result_segments = []
    for seg in segments:
        entry = {
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "text": seg.text.strip(),
            "avg_logprob": round(seg.avg_logprob, 4),
        }
        if seg.words:
            entry["words"] = [
                {"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word, "probability": round(w.probability, 4)}
                for w in seg.words
            ]
        result_segments.append(entry)

    return {"segments": result_segments, "language": info.language, "duration": round(info.duration, 3)}


def main():
    parser = argparse.ArgumentParser(description="Transcribe audio files with faster-whisper")
    parser.add_argument("audio_dir", help="Directory containing .ogg/.flac audio files")
    parser.add_argument("--model", default="small", help="Whisper model name (default: small)")
    parser.add_argument("--language", default="en", help="Language code (default: en)")
    parser.add_argument("--initial-prompt", default="", help="Initial prompt to bias vocabulary")
    args = parser.parse_args()

    audio_path = Path(args.audio_dir)
    if not audio_path.is_dir():
        print(f"Error: {args.audio_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    audio_files = sorted(audio_path.glob("*.ogg")) + sorted(audio_path.glob("*.flac"))
    if not audio_files:
        print(f"No .ogg or .flac files found in {args.audio_dir}", file=sys.stderr)
        json.dump({"tracks": {}}, sys.stdout)
        sys.exit(0)

    print(f"Loading model '{args.model}'...", file=sys.stderr)
    model = WhisperModel(args.model, device="auto", compute_type="default")

    tracks = {}
    for f in audio_files:
        name = f.stem.split("-", 1)[1] if "-" in f.stem and f.stem.split("-", 1)[0].isdigit() else f.stem
        print(f"Transcribing {name} ({f.name})...", file=sys.stderr)
        tracks[name] = transcribe_file(model, str(f), args.language, args.initial_prompt)

    json.dump({"tracks": tracks}, sys.stdout)


if __name__ == "__main__":
    main()
