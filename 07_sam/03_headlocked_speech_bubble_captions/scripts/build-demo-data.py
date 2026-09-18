#!/usr/bin/env python3
# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
#
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def center(bounds: list[int]) -> tuple[float, float]:
    return ((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2)


def track_segments(document: dict, min_area_ratio: float) -> list[dict]:
    width = document["width"]
    height = document["height"]
    by_object = defaultdict(list)
    for frame in document["frames"]:
        for candidate in frame["people"]:
            bounds = candidate["bounds"]
            area_ratio = (
                (bounds["right"] - bounds["left"])
                * (bounds["bottom"] - bounds["top"])
                / (width * height)
            )
            if area_ratio < min_area_ratio:
                continue
            by_object[str(candidate["objectId"])].append(
                {
                    "frameIndex": frame["frameIndex"],
                    "time": round(frame["timeSeconds"], 3),
                    "objectId": str(candidate["objectId"]),
                    "bounds": [
                        bounds["left"],
                        bounds["top"],
                        bounds["right"],
                        bounds["bottom"],
                    ],
                }
            )

    minimum_frames = max(2, round(document["fps"] * 0.5))
    maximum_gap = max(0.5, 2.5 / document["fps"])
    segments = []
    for object_id, frames in by_object.items():
        current = [frames[0]]
        for frame in frames[1:]:
            if frame["time"] - current[-1]["time"] > maximum_gap:
                if len(current) >= minimum_frames:
                    segments.append({"objectId": object_id, "frames": current})
                current = []
            current.append(frame)
        if len(current) >= minimum_frames:
            segments.append({"objectId": object_id, "frames": current})
    return sorted(segments, key=lambda segment: segment["frames"][0]["time"])


def build_people(document: dict, min_area_ratio: float) -> list[dict]:
    lanes = []
    object_lanes = {}
    width = document["width"]
    height = document["height"]

    for segment in track_segments(document, min_area_ratio):
        object_id = segment["objectId"]
        first = segment["frames"][0]
        if object_id in object_lanes:
            lane_index = object_lanes[object_id]
        else:
            available = [
                (index, lane)
                for index, lane in enumerate(lanes)
                if lane["frames"][-1]["time"] < first["time"]
            ]
            if available:
                first_center = center(first["bounds"])
                diagonal = math.hypot(width, height)
                lane_index = min(
                    available,
                    key=lambda item: (
                        math.dist(center(item[1]["frames"][-1]["bounds"]), first_center)
                        / diagonal
                        + min(
                            1,
                            (first["time"] - item[1]["frames"][-1]["time"]) / 10,
                        )
                        * 0.15
                    ),
                )[0]
            else:
                lane_index = len(lanes)
                lanes.append({"objectIds": [], "frames": []})
            object_lanes[object_id] = lane_index

        lane = lanes[lane_index]
        if object_id not in lane["objectIds"]:
            lane["objectIds"].append(object_id)
        lane["frames"].extend(segment["frames"])
        lane["frames"].sort(key=lambda frame: frame["time"])

    if not lanes:
        raise RuntimeError("No persistent person tracks were found")

    frames_at_time = defaultdict(dict)
    for lane_index, lane in enumerate(lanes):
        deduplicated = {frame["time"]: frame for frame in lane["frames"]}
        lane["frames"] = list(deduplicated.values())
        for frame in lane["frames"]:
            frames_at_time[frame["time"]][lane_index] = frame["bounds"]
    reference_time, _ = max(
        frames_at_time.items(), key=lambda item: (len(item[1]), -item[0])
    )
    lanes.sort(
        key=lambda lane: center(
            next(
                (
                    frame["bounds"]
                    for frame in lane["frames"]
                    if frame["time"] == reference_time
                ),
                lane["frames"][0]["bounds"],
            )
        )[0]
    )

    return [
        {
            "id": f"person-{index}",
            "label": f"Person {index}",
            "prompt": document["object"],
            "trackIds": lane["objectIds"],
            "frames": lane["frames"],
        }
        for index, lane in enumerate(lanes, start=1)
    ]


def speaker_sample(speaker_id: str, turns: list[dict]) -> dict:
    candidates = [turn for turn in turns if turn["speaker"] == speaker_id]
    representative = max(candidates, key=lambda turn: turn["end"] - turn["start"])
    duration = representative["end"] - representative["start"]
    snippet_start = representative["start"] + min(0.8, duration * 0.2)
    return {
        "id": speaker_id,
        "label": f"Speaker {speaker_id}",
        "snippetStart": round(snippet_start, 2),
        "snippetEnd": round(min(snippet_start + 4, representative["end"]), 2),
        "sampleText": representative["text"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build browser data from Muse Voice and SAM output."
    )
    parser.add_argument(
        "--transcript", type=Path, default=ROOT / "work/transcript.json"
    )
    parser.add_argument(
        "--tracks", type=Path, default=ROOT / "work/sam-people/tracks.json"
    )
    parser.add_argument(
        "--segmentation",
        type=Path,
        default=ROOT / "work/sam-people/segmentation.json",
    )
    parser.add_argument(
        "--output", type=Path, default=ROOT / "public/demo-data.json"
    )
    parser.add_argument("--video-url", default="/multi-speaker.mp4")
    parser.add_argument("--min-area-ratio", type=float, default=0.02)
    args = parser.parse_args()

    transcript = read_json(args.transcript)
    tracks = read_json(args.tracks)
    segmentation = read_json(args.segmentation)
    turns = [
        {
            "speaker": turn["speaker"],
            "start": turn["startMs"] / 1000,
            "end": turn["endMs"] / 1000,
            "text": turn["transcript"],
        }
        for turn in transcript["turns"]
    ]
    people = build_people(tracks, args.min_area_ratio)
    speaker_ids = list(dict.fromkeys(turn["speaker"] for turn in turns))
    speakers = [speaker_sample(speaker_id, turns) for speaker_id in speaker_ids]

    output = {
        "video": args.video_url,
        "duration": transcript["audioDurationMs"] / 1000,
        "width": tracks["width"],
        "height": tracks["height"],
        "analysisFps": tracks["fps"],
        "speakers": speakers,
        "turns": turns,
        "people": people,
        "segmentation": segmentation,
    }
    destination = args.output
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(destination)


if __name__ == "__main__":
    main()
