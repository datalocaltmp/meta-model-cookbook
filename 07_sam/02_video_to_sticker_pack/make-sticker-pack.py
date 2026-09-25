#!/usr/bin/env python3
# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
#
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.

import argparse
import json
import math
import os
import re
import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageStat


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Segment an object from a video with the SAM API and create a short "
            "animated sticker pack."
        )
    )
    parser.add_argument(
        "input", type=Path, help="MP4/MOV video or segmented GIF/APNG/WebP"
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--object", required=True, help="Short SAM noun phrase, such as dog or cat"
    )
    parser.add_argument("--name", default="My Animated Pet")
    parser.add_argument("--publisher", default="SAM 3 Demo")
    parser.add_argument("--emoji", default="\U0001f43e")
    parser.add_argument(
        "--analysis-fps",
        type=float,
        help="override the source frame rate sent to SAM",
    )
    parser.add_argument("--max-dimension", type=int, default=960)
    parser.add_argument(
        "--events", type=Path, help="replay a saved events.ndjson without an API call"
    )
    parser.add_argument("--track-id", help="select one SAM object ID")
    parser.add_argument("--segment-padding", type=float, default=0.12)
    parser.add_argument(
        "--env-file",
        type=Path,
        default=Path(__file__).resolve().parent / ".env",
    )
    parser.add_argument("--keep-segmentation-work", action="store_true")
    parser.add_argument("--count", type=int, default=3)
    parser.add_argument("--clip-seconds", type=float, default=2.5)
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--outline", type=int, default=8)
    parser.add_argument("--feather", type=float, default=0.65)
    parser.add_argument("--quality", type=int, default=80)
    parser.add_argument("--max-bytes", type=int, default=450_000)
    parser.add_argument("--max-sticker-fps", type=float, default=15)
    args = parser.parse_args()
    if not 3 <= args.count <= 30:
        parser.error("--count must be between 3 and 30 for a WhatsApp sticker pack")
    if not 0.25 <= args.clip_seconds <= 10:
        parser.error("--clip-seconds must be between 0.25 and 10")
    if args.size != 512:
        parser.error("WhatsApp stickers must be exactly 512x512")
    if args.outline < 0 or args.outline > 32:
        parser.error("--outline must be between 0 and 32")
    if not 0 <= args.feather <= 3:
        parser.error("--feather must be between 0 and 3")
    if not 1 <= args.quality <= 100:
        parser.error("--quality must be between 1 and 100")
    if not 1 <= args.max_sticker_fps <= 30:
        parser.error("--max-sticker-fps must be between 1 and 30")
    if not args.input.is_file():
        parser.error(f"input does not exist: {args.input}")
    if args.events is not None and not args.events.is_file():
        parser.error(f"events file does not exist: {args.events}")
    if args.input.suffix.lower() not in {
        ".mp4",
        ".mov",
        ".m4v",
        ".gif",
        ".png",
        ".webp",
    }:
        parser.error("input must be an MP4, MOV, M4V, GIF, APNG, or WebP file")
    return args


def model_api_environment(env_file: Path) -> dict[str, str]:
    environment = dict(os.environ)
    if not env_file.is_file():
        return environment
    allowed = {"MODEL_API_KEY"}
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key not in allowed:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        environment[key] = value
    return environment


def segment_video(args: argparse.Namespace) -> tuple[Path, dict]:
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("Node.js is required to call the SAM API")
    demo_dir = Path(__file__).resolve().parent
    segmentation_dir = args.output / "segmentation"
    environment = model_api_environment(args.env_file)
    if args.events is None and not environment.get("MODEL_API_KEY"):
        raise RuntimeError(
            f"MODEL_API_KEY is missing from the environment and {args.env_file}"
        )
    command = [
        node,
        str(demo_dir / "create-segmented-gif.mjs"),
        "--input",
        str(args.input.resolve()),
        "--object",
        args.object,
        "--output",
        str(segmentation_dir.resolve()),
        "--max-dimension",
        str(args.max_dimension),
        "--canvas",
        str(args.size),
        "--padding",
        str(args.segment_padding),
    ]
    if args.analysis_fps is not None:
        command.extend(["--fps", str(args.analysis_fps)])
    if args.events is not None:
        command.extend(["--events", str(args.events.resolve())])
    if args.track_id is not None:
        command.extend(["--track-id", args.track_id])
    if args.keep_segmentation_work:
        command.append("--keep-work")
    print("Building the SAM cutout animation...")
    subprocess.run(command, cwd=demo_dir, env=environment, check=True)
    segmented_animation = segmentation_dir / "segmented-subject.png"
    summary_path = segmentation_dir / "summary.json"
    if not segmented_animation.is_file() or not summary_path.is_file():
        raise RuntimeError("SAM segmentation completed without the expected outputs")
    return segmented_animation, json.loads(summary_path.read_text(encoding="utf-8"))


def load_animation(filename: Path) -> tuple[list[Image.Image], list[int]]:
    image = Image.open(filename)
    frames: list[Image.Image] = []
    durations: list[int] = []
    for index in range(getattr(image, "n_frames", 1)):
        image.seek(index)
        frames.append(image.convert("RGBA").copy())
        durations.append(max(8, int(image.info.get("duration", 100))))
    return frames, durations


def fit_frame(frame: Image.Image, size: int) -> Image.Image:
    if frame.size == (size, size):
        return frame
    fitted = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    resized = frame.copy()
    resized.thumbnail((size, size), Image.Resampling.LANCZOS)
    fitted.alpha_composite(
        resized, ((size - resized.width) // 2, (size - resized.height) // 2)
    )
    return fitted


def add_outline(frame: Image.Image, pixels: int) -> Image.Image:
    if pixels == 0:
        return frame
    alpha = frame.getchannel("A")
    expanded = alpha.filter(ImageFilter.MaxFilter(pixels * 2 + 1))
    outline_alpha = ImageChops.subtract(expanded, alpha)
    outlined = Image.new("RGBA", frame.size, (255, 255, 255, 0))
    outlined.putalpha(outline_alpha)
    outlined.alpha_composite(frame)
    return outlined


def feather_edge(frame: Image.Image, radius: float) -> Image.Image:
    if radius == 0:
        return frame
    softened = frame.copy()
    softened.putalpha(frame.getchannel("A").filter(ImageFilter.GaussianBlur(radius)))
    return softened


def motion_scores(frames: list[Image.Image]) -> list[float]:
    thumbs = [frame.resize((96, 96), Image.Resampling.BILINEAR) for frame in frames]
    scores = [0.0]
    for previous, current in zip(thumbs, thumbs[1:]):
        difference = ImageChops.difference(previous, current)
        scores.append(sum(ImageStat.Stat(difference).mean))
    return scores


def choose_clips(
    frames: list[Image.Image], durations: list[int], count: int, clip_seconds: float
) -> list[tuple[int, int]]:
    average_duration = sum(durations) / len(durations)
    clip_frames = max(2, round(clip_seconds * 1000 / average_duration))
    scores = motion_scores(frames)
    clips: list[tuple[int, int]] = []
    for region_index in range(count):
        region_start = math.floor(len(frames) * region_index / count)
        region_end = math.floor(len(frames) * (region_index + 1) / count)
        region_length = max(1, region_end - region_start)
        length = min(clip_frames, region_length)
        best_start = region_start
        best_score = -1.0
        latest_start = max(region_start, region_end - length)
        for start in range(region_start, latest_start + 1):
            score = sum(scores[start : start + length])
            if score > best_score:
                best_score = score
                best_start = start
        clips.append((best_start, best_start + length))
    return clips


def stride_frames(
    frames: list[Image.Image], durations: list[int], stride: int
) -> tuple[list[Image.Image], list[int]]:
    selected_frames = frames[::stride]
    selected_durations = []
    for index in range(0, len(frames), stride):
        selected_durations.append(sum(durations[index : index + stride]))
    return selected_frames, selected_durations


def save_animated_webp(
    frames: list[Image.Image],
    durations: list[int],
    output: Path,
    initial_quality: int,
    max_bytes: int,
    max_fps: float,
) -> dict:
    attempts = []
    qualities = list(dict.fromkeys((initial_quality, 65, 50, 35, 20)))
    average_duration = sum(durations) / len(durations)
    source_fps = 1000 / average_duration
    rounded_fps = round(source_fps)
    if abs(source_fps - rounded_fps) < 0.75:
        source_fps = rounded_fps
    minimum_stride = max(1, math.ceil(source_fps / max_fps - 1e-6))
    for stride in range(minimum_stride, minimum_stride + 4):
        candidate_frames, candidate_durations = stride_frames(frames, durations, stride)
        for quality in qualities:
            candidate_frames[0].save(
                output,
                format="WEBP",
                save_all=True,
                append_images=candidate_frames[1:],
                duration=candidate_durations,
                loop=0,
                quality=quality,
                method=4,
                minimize_size=True,
                lossless=False,
            )
            size = output.stat().st_size
            attempts.append({"quality": quality, "stride": stride, "bytes": size})
            if size <= max_bytes:
                return {
                    "bytes": size,
                    "quality": quality,
                    "stride": stride,
                    "frames": len(candidate_frames),
                    "duration_ms": sum(candidate_durations),
                    "attempts": attempts,
                }
    raise RuntimeError(
        f"Could not reduce {output.name} below {max_bytes} bytes; "
        f"smallest result was {attempts[-1]['bytes']} bytes"
    )


def gif_frame(frame: Image.Image) -> Image.Image:
    alpha = frame.getchannel("A")
    palette = frame.convert("RGB").quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    transparent = alpha.point(lambda value: 255 if value < 128 else 0)
    palette.paste(255, mask=transparent)
    palette.info["transparency"] = 255
    return palette


def save_preview_gif(
    frames: list[Image.Image], durations: list[int], output: Path
) -> None:
    converted = [gif_frame(frame) for frame in frames]
    converted[0].save(
        output,
        format="GIF",
        save_all=True,
        append_images=converted[1:],
        duration=durations,
        loop=0,
        transparency=255,
        disposal=2,
        optimize=False,
    )


def checkerboard(size: int, cell: int = 24) -> Image.Image:
    image = Image.new("RGBA", (size, size), "white")
    draw = ImageDraw.Draw(image)
    for y in range(0, size, cell):
        for x in range(0, size, cell):
            if (x // cell + y // cell) % 2:
                draw.rectangle((x, y, x + cell - 1, y + cell - 1), fill="#e5e7eb")
    return image


def create_pack_preview(first_frames: list[Image.Image], output: Path) -> None:
    tile = 360
    label_height = 52
    canvas = Image.new("RGB", (tile * len(first_frames), tile + label_height), "white")
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default(size=24)
    for index, frame in enumerate(first_frames):
        background = checkerboard(tile)
        preview = frame.copy()
        preview.thumbnail((tile, tile), Image.Resampling.LANCZOS)
        background.alpha_composite(
            preview, ((tile - preview.width) // 2, (tile - preview.height) // 2)
        )
        x = index * tile
        canvas.paste(background.convert("RGB"), (x, 0))
        label = f"STICKER {index + 1}"
        bounds = draw.textbbox((0, 0), label, font=font)
        draw.text(
            (x + (tile - (bounds[2] - bounds[0])) / 2, tile + 12),
            label,
            font=font,
            fill="#111827",
        )
    canvas.save(output, optimize=True)


def slug(value: str) -> str:
    return re.sub(r"(^-|-$)", "", re.sub(r"[^a-z0-9]+", "-", value.lower()))


def public_path(filename: Path, output: Path) -> str:
    try:
        return str(filename.resolve().relative_to(output.resolve()))
    except ValueError:
        return filename.name


def main() -> None:
    args = parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    source_input = args.input.resolve()
    segmentation_summary = None
    if source_input.suffix.lower() in {".gif", ".png", ".webp"}:
        segmented_animation = source_input
    else:
        segmented_animation, segmentation_summary = segment_video(args)

    frames, durations = load_animation(segmented_animation)
    frames = [
        add_outline(
            feather_edge(fit_frame(frame, args.size), args.feather), args.outline
        )
        for frame in frames
    ]
    clips = choose_clips(frames, durations, args.count, args.clip_seconds)

    stickers = []
    first_frames = []
    for index, (start, end) in enumerate(clips, start=1):
        clip_frames = frames[start:end]
        clip_durations = durations[start:end]
        webp_name = f"sticker-{index:02d}.webp"
        gif_name = f"sticker-{index:02d}-preview.gif"
        webp_result = save_animated_webp(
            clip_frames,
            clip_durations,
            args.output / webp_name,
            args.quality,
            args.max_bytes,
            args.max_sticker_fps,
        )
        chosen_frames, chosen_durations = stride_frames(
            clip_frames, clip_durations, webp_result["stride"]
        )
        save_preview_gif(chosen_frames, chosen_durations, args.output / gif_name)
        first_frames.append(chosen_frames[0])
        stickers.append(
            {
                "image_file": webp_name,
                "preview_file": gif_name,
                "emojis": [args.emoji],
                "accessibility_text": f"Animated {args.object} sticker",
                "source_frames": [start, end - 1],
                **webp_result,
            }
        )

    tray = first_frames[0].copy()
    tray.thumbnail((96, 96), Image.Resampling.LANCZOS)
    tray_canvas = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
    tray_canvas.alpha_composite(tray, ((96 - tray.width) // 2, (96 - tray.height) // 2))
    tray_canvas.quantize(colors=128).save(args.output / "tray.png", optimize=True)
    create_pack_preview(first_frames, args.output / "pack-preview.png")

    identifier = slug(args.name) or "sam3-sticker-pack"
    manifest = {
        "sticker_packs": [
            {
                "identifier": identifier,
                "name": args.name,
                "publisher": args.publisher,
                "tray_image_file": "tray.png",
                "animated_sticker_pack": True,
                "stickers": [
                    {
                        key: value
                        for key, value in sticker.items()
                        if key in {"image_file", "emojis", "accessibility_text"}
                    }
                    for sticker in stickers
                ],
            }
        ]
    }
    (args.output / "contents.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    report = {
        "input": source_input.name,
        "segmented_animation": public_path(segmented_animation, args.output),
        "segmentation": segmentation_summary,
        "source_frames": len(frames),
        "stickers": stickers,
        "whatsapp_constraints": {
            "dimensions": "512x512",
            "max_bytes": args.max_bytes,
            "max_duration_ms": 10_000,
            "transparent_background": True,
        },
    }
    (args.output / "report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(args.output / "pack-preview.png")
    for sticker in stickers:
        print(
            f"{sticker['image_file']}: {sticker['bytes'] / 1024:.1f} KB, "
            f"{sticker['frames']} frames, {sticker['duration_ms'] / 1000:.2f}s"
        )


if __name__ == "__main__":
    main()
