#!/usr/bin/env python3
# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
#
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.

from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from sam_api import segment_video, upload_video, write_outputs


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upload and segment one video.")
    parser.add_argument("video", type=Path, nargs="?")
    parser.add_argument("--file-id", help="reuse an existing Files API upload")
    parser.add_argument("--concept", required=True, help="short noun phrase")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.file_id is None and args.video is None:
        parser.error("provide a video path or --file-id")
    if args.file_id is not None and args.video is not None:
        parser.error("provide a video path or --file-id, not both")
    return args


async def main() -> None:
    args = parse_args()
    if args.file_id is None:
        if not args.video.is_file():
            raise FileNotFoundError(args.video)
        print(f"Uploading {args.video}...")
        file_id = await upload_video(args.video)
        print(f"Uploaded as {file_id}")
    else:
        file_id = args.file_id

    result = await segment_video(file_id, args.concept)
    write_outputs(args.output, [(args.concept, result)])


if __name__ == "__main__":
    asyncio.run(main())
