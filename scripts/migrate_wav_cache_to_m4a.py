#!/usr/bin/env python3
"""Convert legacy Trans WAV cache files to AAC-LC/M4A in place."""

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import uuid
from pathlib import Path

MAX_M4A_BYTES = 20 * 1024 * 1024


def parse_args():
    parser = argparse.ArgumentParser(
        description="Convert reader_data/tts_cache/*.wav to 80 kbps mono AAC-LC/M4A.",
    )
    parser.add_argument(
        "--project-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="Trans project root (default: parent of scripts directory)",
    )
    parser.add_argument(
        "--keep-source",
        action="store_true",
        help="Keep WAV files after conversion and database update",
    )
    return parser.parse_args()


def valid_m4a(ffprobe, path):
    if not path.is_file() or not 0 < path.stat().st_size <= MAX_M4A_BYTES:
        return False
    result = subprocess.run(
        [
            ffprobe, "-v", "error", "-show_entries",
            "stream=codec_name,profile,channels,sample_rate:format=duration",
            "-of", "json", str(path),
        ],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        return False
    try:
        payload = json.loads(result.stdout)
        stream = payload["streams"][0]
        duration = float(payload["format"]["duration"])
    except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError):
        return False
    return (
        stream.get("codec_name") == "aac"
        and stream.get("profile") == "LC"
        and int(stream.get("channels", 0)) == 1
        and int(stream.get("sample_rate", 0)) == 24000
        and duration > 0
    )


def convert_file(ffmpeg, ffprobe, source, target):
    if valid_m4a(ffprobe, target):
        return target.stat().st_size, False
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    command = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "24000",
        "-c:a",
        "aac",
        "-profile:a",
        "aac_low",
        "-b:a",
        "80k",
        "-movflags",
        "+faststart",
        "-f",
        "ipod",
        str(temporary),
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=90, check=False)
        if result.returncode != 0 or not temporary.is_file() or temporary.stat().st_size <= 0:
            detail = result.stderr.strip() or "ffmpeg did not create a valid output file"
            raise RuntimeError(detail)
        if not valid_m4a(ffprobe, temporary):
            raise RuntimeError("ffmpeg output is not valid 24 kHz mono AAC-LC/M4A")
        source_stat = source.stat()
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
        os.utime(target, (source_stat.st_atime, source_stat.st_mtime))
        return target.stat().st_size, True
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def update_offline_refs(database_path, converted):
    if not database_path.is_file() or not converted:
        return 0
    connection = sqlite3.connect(database_path, timeout=30)
    try:
        connection.execute("PRAGMA busy_timeout=30000")
        with connection:
            changed = 0
            for cache_key, size_bytes in converted.items():
                cursor = connection.execute(
                    """
                    UPDATE offline_tts_refs
                    SET audio_format = 'm4a', size_bytes = ?
                    WHERE cache_key = ? AND audio_format = 'wav'
                    """,
                    (size_bytes, cache_key),
                )
                changed += cursor.rowcount
            return changed
    finally:
        connection.close()


def main():
    args = parse_args()
    project_root = args.project_root.resolve()
    cache_dir = project_root / "reader_data" / "tts_cache"
    database_path = project_root / "reader_data" / "tts_offline.sqlite3"
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        print("error: ffmpeg and ffprobe must both be available in PATH", file=sys.stderr)
        return 2
    if not cache_dir.is_dir():
        print(f"No cache directory found: {cache_dir}")
        return 0

    sources = sorted(path for path in cache_dir.glob("*.wav") if path.is_file())
    if not sources:
        print("No legacy WAV cache files found.")
        return 0

    converted = {}
    removable = []
    failures = 0
    created = 0
    for source in sources:
        target = source.with_suffix(".m4a")
        try:
            size_bytes, was_created = convert_file(ffmpeg, ffprobe, source, target)
            converted[source.stem] = size_bytes
            removable.append(source)
            created += int(was_created)
            print(f"ok: {source.name} -> {target.name}")
        except Exception as exc:
            failures += 1
            print(f"failed: {source.name}: {exc}", file=sys.stderr)

    try:
        updated_refs = update_offline_refs(database_path, converted)
    except sqlite3.Error as exc:
        print(f"error: could not update offline cache database: {exc}", file=sys.stderr)
        print("WAV sources were retained; fix the database issue and run the script again.", file=sys.stderr)
        return 1

    removed = 0
    if not args.keep_source:
        for source in removable:
            try:
                source.unlink()
                removed += 1
            except OSError as exc:
                print(f"warning: could not remove {source}: {exc}", file=sys.stderr)

    print(
        f"Done: {len(converted)} usable M4A files, {created} converted, "
        f"{updated_refs} offline references updated, {removed} WAV files removed, "
        f"{failures} failures."
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
