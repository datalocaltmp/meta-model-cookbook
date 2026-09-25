#!/usr/bin/env python3
# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
#
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.

import argparse
import json
import os
import subprocess
import tempfile
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_URL = "https://api.meta.ai/v1/asr/transcribe"
DEFAULT_MODEL = "muse-voice-transcribe-1.0"


def load_env(path: Path) -> dict[str, str]:
    environment = dict(os.environ)
    if not path.is_file():
        return environment
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.removeprefix("export ").split("=", 1)
        environment.setdefault(key.strip(), value.strip().strip("\"'"))
    return environment


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run Muse Voice diarization on a video."
    )
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "work/transcript.json")
    parser.add_argument("--env-file", type=Path, default=ROOT / ".env")
    args = parser.parse_args()

    environment = load_env(args.env_file)
    token = environment.get("MODEL_API_KEY")
    if not token:
        raise RuntimeError("MODEL_API_KEY is not set")

    with tempfile.TemporaryDirectory() as temporary_directory:
        audio = Path(temporary_directory) / "audio.wav"
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(args.input),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "24000",
                "-sample_fmt",
                "s16",
                str(audio),
            ],
            check=True,
        )
        request = {
            "mode": "DIARIZATION",
            "model": DEFAULT_MODEL,
            "audioEncoding": "WAV",
        }
        boundary = f"----sam-demo-{uuid.uuid4().hex}"
        body = b"".join(
            [
                f'--{boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n'.encode(),
                json.dumps(request).encode(),
                b"\r\n",
                f'--{boundary}\r\nContent-Disposition: form-data; name="audio"; filename="audio.wav"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode(),
                audio.read_bytes(),
                b"\r\n",
                f"--{boundary}--\r\n".encode(),
            ]
        )
        api_request = urllib.request.Request(
            DEFAULT_URL,
            data=body,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(api_request, timeout=300) as response:
                result = json.loads(response.read())
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:500]
            raise RuntimeError(
                f"Muse Voice returned HTTP {error.code}: {detail}"
            ) from error

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(args.output)


if __name__ == "__main__":
    main()
