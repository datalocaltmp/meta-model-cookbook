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

from sam_api import segment_image, write_outputs


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Segment concepts in one image.")
    parser.add_argument("image", type=Path)
    parser.add_argument(
        "--concept",
        action="append",
        required=True,
        help="short noun phrase; repeat to make a separate request",
    )
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    if not args.image.is_file():
        raise FileNotFoundError(args.image)
    results = []
    for concept in args.concept:
        print(f"Segmenting {concept!r}...")
        results.append((concept, await segment_image(args.image, concept)))
    write_outputs(args.output, results)


if __name__ == "__main__":
    asyncio.run(main())
