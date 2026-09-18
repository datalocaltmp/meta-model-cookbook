#!/usr/bin/env python3
# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
#
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.

import argparse
import bisect
import json
import math
import subprocess
from pathlib import Path

try:
    from meta_sam_parser import SegmentationMask, decode_mask_to_raster
except ModuleNotFoundError as error:
    raise SystemExit(
        "meta_sam_parser is required. Install it (pip install meta_sam_parser) "
        "as described in this cookbook's README."
    ) from error

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageFont


def nearest_frame(person: dict, seconds: float) -> dict | None:
    frames = person["frames"]
    times = [frame["time"] for frame in frames]
    index = bisect.bisect_left(times, seconds)
    candidates = frames[max(0, index - 1) : min(len(frames), index + 1)]
    if not candidates:
        return None
    nearest = min(candidates, key=lambda frame: abs(frame["time"] - seconds))
    return nearest if abs(nearest["time"] - seconds) <= 0.55 else None


def surrounding_frames(
    person: dict, seconds: float
) -> tuple[dict | None, dict | None, float]:
    frames = person["frames"]
    times = [frame["time"] for frame in frames]
    index = bisect.bisect_left(times, seconds)
    previous = frames[max(0, index - 1)] if frames else None
    following = frames[min(index, len(frames) - 1)] if frames else None
    if previous is None or following is None:
        return previous, following, 0
    gap = following["time"] - previous["time"]
    progress = 0 if gap <= 0 else max(0, min(1, (seconds - previous["time"]) / gap))
    return previous, following, progress


def mask_index(segmentation: dict) -> dict[tuple[int, str], dict]:
    latest = {}
    for record in segmentation["records"]:
        if record.get("kind") != "mask" or "frame" not in record:
            continue
        key = (record["frame"]["frameIndex"], str(record["objectId"]))
        if key not in latest or record["revision"] >= latest[key]["revision"]:
            latest[key] = record
    return latest


def decode_record_mask(
    record: dict, cache: dict[tuple[int, str], Image.Image]
) -> Image.Image:
    key = (record["frame"]["frameIndex"], str(record["objectId"]))
    if key in cache:
        return cache[key]
    encoded = record["mask"]
    raster = decode_mask_to_raster(
        SegmentationMask(
            encoding=encoded["encoding"],
            payload=encoded["payload"],
            width=encoded["width"],
            height=encoded["height"],
        )
    )
    decoded = Image.frombytes("L", (encoded["width"], encoded["height"]), raster).point(
        lambda value: value * 255
    )
    cache[key] = decoded
    return decoded


def full_frame_mask(
    record: dict, decoded: Image.Image, size: tuple[int, int]
) -> Image.Image:
    mask = Image.new("L", size, 0)
    bounds = record["bounds"]
    mask.paste(decoded, (bounds["left"], bounds["top"]))
    return mask


def interpolated_effect_mask(
    person: dict,
    seconds: float,
    records: dict[tuple[int, str], dict],
    decoded_cache: dict[tuple[int, str], Image.Image],
    size: tuple[int, int],
) -> Image.Image | None:
    previous, following, progress = surrounding_frames(person, seconds)
    if previous is None or following is None:
        return None
    nearest = previous if progress < 0.5 else following
    if abs(nearest["time"] - seconds) > 0.55:
        return None
    record = records.get((nearest["frameIndex"], nearest["objectId"]))
    if record is None:
        return None
    decoded = decode_record_mask(record, decoded_cache)

    can_interpolate = (
        previous["objectId"] == following["objectId"]
        and following["time"] - previous["time"] <= 0.55
    )
    if can_interpolate:
        bounds = [
            previous["bounds"][index]
            + (following["bounds"][index] - previous["bounds"][index]) * progress
            for index in range(4)
        ]
    else:
        bounds = nearest["bounds"]
    left, top, right, bottom = [round(value) for value in bounds]
    target_width = max(1, right - left)
    target_height = max(1, bottom - top)
    if decoded.size != (target_width, target_height):
        decoded = decoded.resize(
            (target_width, target_height), Image.Resampling.NEAREST
        )
    mask = Image.new("L", size, 0)
    mask.paste(decoded, (left, top))
    return mask


def head_anchor(
    record: dict | None,
    decoded: Image.Image | None,
    bounds: list[float],
    cache: dict[tuple[int, str], tuple[float, float]],
) -> tuple[float, float]:
    left, top, right, _ = bounds
    if record is None or decoded is None:
        return ((left + right) / 2, max(0, top - 5))
    key = (record["frame"]["frameIndex"], str(record["objectId"]))
    if key in cache:
        return cache[key]
    pixels = decoded.load()
    search_height = max(1, math.ceil(decoded.height * 0.3))
    first_row = None
    x_total = 0
    count = 0
    for y in range(search_height):
        row = [x for x in range(decoded.width) if pixels[x, y] != 0]
        if not row:
            continue
        if first_row is None:
            first_row = y
        if y > first_row + max(3, round(decoded.height * 0.04)):
            break
        x_total += sum(row)
        count += len(row)
    if first_row is None or count == 0:
        return ((left + right) / 2, max(0, top - 5))
    anchor = (left + x_total / count, max(0, top + first_row - 5))
    cache[key] = anchor
    return anchor


def emphasize_speaker(
    image: Image.Image,
    mask: Image.Image | None,
    effect: str,
) -> Image.Image:
    if effect == "none" or mask is None:
        return image
    if effect == "spotlight":
        muted = ImageEnhance.Brightness(
            ImageEnhance.Color(image).enhance(0.78)
        ).enhance(0.82)
        muted.paste(image, mask=mask)
        return muted

    layer = Image.new("RGBA", image.size, (24, 119, 242, 0))
    if effect == "mask":
        layer.putalpha(mask.point(lambda value: round(value * 0.28)))
    else:
        radius = max(4, round(min(image.size) * 0.025))
        blurred = mask.filter(ImageFilter.GaussianBlur(radius))
        halo = ImageChops.subtract(blurred, mask)
        layer.putalpha(halo.point(lambda value: min(220, round(value * 1.4))))
    image.alpha_composite(layer)
    return image


def active_caption(turns: list[dict], seconds: float) -> tuple | None:
    for turn_index, turn in enumerate(turns):
        if turn["start"] <= seconds < turn["end"]:
            words = turn["text"].split()
            chunks = [words[index : index + 7] for index in range(0, len(words), 7)]
            progress = max(
                0,
                min(0.999, (seconds - turn["start"]) / (turn["end"] - turn["start"])),
            )
            chunk_index = math.floor(progress * len(chunks))
            return (
                turn_index,
                chunk_index,
                turn["speaker"],
                " ".join(chunks[chunk_index]),
            )
    return None


def overlap_area(left: tuple, right: tuple) -> float:
    return max(0, min(left[2], right[2]) - max(left[0], right[0])) * max(
        0, min(left[3], right[3]) - max(left[1], right[1])
    )


def choose_placement(
    subject: list[float],
    anchor: tuple[float, float],
    people: list[list[float]],
    bubble_size: tuple[int, int],
    canvas_size: tuple[int, int],
) -> dict:
    width, height = canvas_size
    bubble_width, bubble_height = bubble_size
    left, top, right, bottom = subject
    center_x, head_y = anchor
    gap, margin = 14, 12
    candidates = [
        ("above", center_x - bubble_width / 2, top - gap - bubble_height, 0),
        ("right", right + gap, head_y - bubble_height / 2, 1),
        ("left", left - gap - bubble_width, head_y - bubble_height / 2, 1),
        ("below", center_x - bubble_width / 2, bottom + gap, 2),
        (
            "rail",
            max(
                margin,
                min(width - bubble_width - margin, center_x - bubble_width / 2),
            ),
            height - bubble_height - margin,
            4,
        ),
    ]
    heads = []
    bodies = []
    for bounds in people:
        person_left, person_top, person_right, person_bottom = bounds
        person_width = person_right - person_left
        person_height = person_bottom - person_top
        heads.append(
            (
                person_left + person_width * 0.2,
                person_top,
                person_right - person_width * 0.2,
                person_top + person_height * 0.3,
            )
        )
        bodies.append(tuple(bounds))
    area = bubble_width * bubble_height
    diagonal = math.hypot(width, height)

    def score(candidate: tuple) -> float:
        _, x, y, priority = candidate
        rectangle = (x, y, x + bubble_width, y + bubble_height)
        outside = (
            x < margin
            or y < margin
            or rectangle[2] > width - margin
            or rectangle[3] > height - margin
        )
        faces = sum(overlap_area(rectangle, region) for region in heads) / area
        bodies_score = sum(overlap_area(rectangle, region) for region in bodies) / area
        distance = (
            math.dist(
                (x + bubble_width / 2, y + bubble_height / 2),
                (center_x, head_y),
            )
            / diagonal
        )
        return (
            (10_000 if outside else 0)
            + faces * 1_500
            + bodies_score * 30
            + distance * 20
            + priority * 3
        )

    side, x, y, _ = min(candidates, key=score)
    return {"side": side, "left": round(x / 8) * 8, "top": round(y / 8) * 8}


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for filename in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ):
        if Path(filename).is_file():
            return ImageFont.truetype(filename, size)
    return ImageFont.load_default(size=size)


def wrap_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.ImageFont,
    maximum: int,
) -> list[str]:
    lines = []
    current = ""
    for word in text.split():
        candidate = f"{current} {word}".strip()
        if current and draw.textbbox((0, 0), candidate, font=font)[2] > maximum:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines[:3]


def draw_caption(
    image: Image.Image,
    text: str,
    speaker: str,
    subject: list[float],
    anchor: tuple[float, float],
    people: list[list[float]],
    cached: dict | None,
) -> dict:
    width, height = image.size
    font = load_font(max(18, round(height * 0.045)))
    label_font = load_font(max(10, round(height * 0.022)))
    measure = ImageDraw.Draw(image)
    lines = wrap_text(measure, text, font, round(width * 0.38))
    boxes = [measure.textbbox((0, 0), line, font=font) for line in lines]
    text_width = max(box[2] - box[0] for box in boxes)
    line_height = max(box[3] - box[1] for box in boxes)
    padding_x, padding_y = round(width * 0.02), round(height * 0.018)
    label_height = round(height * 0.035)
    bubble_size = (
        text_width + padding_x * 2,
        label_height + line_height * len(lines) + padding_y * 2,
    )
    placement = cached or choose_placement(
        subject, anchor, people, bubble_size, image.size
    )
    left, top = placement["left"], placement["top"]
    right, bottom = left + bubble_size[0], top + bubble_size[1]
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    fill = (255, 255, 255, 194)
    head_x, head_y = anchor
    if placement["side"] == "right":
        tether = (left, max(top + 10, min(bottom - 10, head_y)))
    elif placement["side"] == "left":
        tether = (right, max(top + 10, min(bottom - 10, head_y)))
    elif placement["side"] == "below":
        tether = (max(left + 10, min(right - 10, head_x)), top)
    elif placement["side"] == "above":
        tether = (max(left + 10, min(right - 10, head_x)), bottom)
    else:
        tether = None
    if tether:
        draw.line((tether, anchor), fill=fill, width=max(3, round(height * 0.007)))
        radius = max(2, round(height * 0.005))
        draw.ellipse(
            (head_x - radius, head_y - radius, head_x + radius, head_y + radius),
            fill=fill,
        )
    draw.rounded_rectangle((left, top, right, bottom), radius=6, fill=fill)
    if placement["side"] == "rail":
        draw.rectangle((left, top, left + 4, bottom), fill=(24, 119, 242, 255))
    draw.text(
        (left + padding_x, top + padding_y),
        f"SPEAKER {speaker}",
        font=label_font,
        fill=(24, 119, 242, 255),
    )
    y = top + padding_y + label_height
    for line in lines:
        draw.text((left + padding_x, y), line, font=font, fill=(23, 25, 29, 255))
        y += line_height
    image.alpha_composite(layer)
    return placement


def main() -> None:
    parser = argparse.ArgumentParser(description="Render mapped captions into an MP4.")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--mapping", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--fps", type=float, default=30)
    parser.add_argument(
        "--effect",
        choices=("spotlight", "halo", "mask", "none"),
        default="spotlight",
    )
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    data = json.loads(args.data.read_text(encoding="utf-8"))
    mapping = json.loads(args.mapping.read_text(encoding="utf-8"))
    people_by_id = {person["id"]: person for person in data["people"]}
    masks = mask_index(data["segmentation"])
    decoded_masks = {}
    head_anchors = {}
    width, height = int(data["width"]), int(data["height"])
    frame_bytes = width * height * 4
    decoder = subprocess.Popen(
        [
            "ffmpeg",
            "-loglevel",
            "error",
            "-i",
            str(args.input),
            "-vf",
            f"fps={args.fps},scale={width}:{height}:flags=lanczos",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "pipe:1",
        ],
        stdout=subprocess.PIPE,
    )
    encoder = subprocess.Popen(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-s",
            f"{width}x{height}",
            "-r",
            str(args.fps),
            "-i",
            "pipe:0",
            "-i",
            str(args.input),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0?",
            "-c:v",
            "libx264",
            "-crf",
            "19",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            "-movflags",
            "+faststart",
            str(args.output),
        ],
        stdin=subprocess.PIPE,
    )
    if decoder.stdout is None or encoder.stdin is None:
        raise RuntimeError("Could not open FFmpeg pipes")

    cached_placements = {}
    frame_index = 0
    while True:
        frame = decoder.stdout.read(frame_bytes)
        if not frame:
            break
        if len(frame) != frame_bytes:
            raise RuntimeError("FFmpeg returned a partial frame")
        image = Image.frombytes("RGBA", (width, height), frame)
        seconds = frame_index / args.fps
        caption = active_caption(data["turns"], seconds)
        if caption:
            turn_index, chunk_index, speaker, text = caption
            person = people_by_id.get(mapping.get(speaker))
            subject_frame = nearest_frame(person, seconds) if person else None
            visible = [
                frame["bounds"]
                for candidate in data["people"]
                if (frame := nearest_frame(candidate, seconds))
            ]
            if subject_frame:
                subject = subject_frame["bounds"]
                mask_record = masks.get(
                    (subject_frame["frameIndex"], subject_frame["objectId"])
                )
                decoded_mask = (
                    decode_record_mask(mask_record, decoded_masks)
                    if mask_record
                    else None
                )
                effect_mask = interpolated_effect_mask(
                    person,
                    seconds,
                    masks,
                    decoded_masks,
                    image.size,
                )
                image = emphasize_speaker(image, effect_mask, args.effect)
                anchor = head_anchor(mask_record, decoded_mask, subject, head_anchors)
                cache_key = (turn_index, chunk_index)
                cached_placements[cache_key] = draw_caption(
                    image,
                    text,
                    speaker,
                    subject,
                    anchor,
                    visible,
                    cached_placements.get(cache_key),
                )
        encoder.stdin.write(image.tobytes())
        frame_index += 1

    decoder.stdout.close()
    encoder.stdin.close()
    decoder_status = decoder.wait()
    encoder_status = encoder.wait()
    if decoder_status or encoder_status:
        raise RuntimeError(
            f"FFmpeg failed: decoder={decoder_status}, encoder={encoder_status}"
        )
    print(args.output)


if __name__ == "__main__":
    main()
