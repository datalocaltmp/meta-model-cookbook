#!/usr/bin/env node
// Copyright (c) Meta Platforms, Inc. and affiliates.
// All rights reserved.
//
// This source code is licensed under the license found in the
// LICENSE file in the root directory of this source tree.

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  decodeMaskToRaster,
  formats,
  parseResponsesStream,
} from "@meta-sam/parser";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed:\n${String(result.stderr ?? "")}`);
  }
  return result.stdout;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    values.set(argv[index]?.replace(/^--/, ""), argv[index + 1]);
  }
  return {
    video: path.resolve(values.get("video") ?? "work/sam-people/prepared.mp4"),
    events: path.resolve(values.get("events") ?? "work/sam-people/sam-events.sse"),
    output: path.resolve(values.get("output") ?? "output/sam-mask-preview-13s.png"),
    time: Number(values.get("time") ?? 13),
    fps: Number(values.get("fps") ?? 6),
  };
}

async function parseRecords(filename) {
  const raw = await readFile(filename, "utf8");
  const events = [];
  for (const block of raw.replace(/\r\n|\r/g, "\n").split("\n\n")) {
    const payload = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!payload || payload === "[DONE]") continue;
    events.push(JSON.parse(payload));
  }
  async function* normalizedEvents() {
    for (const event of events) {
      yield event;
      if (
        event.type === "response.content_part.done" &&
        event.part?.type === "output_text" &&
        typeof event.part.text === "string"
      ) {
        yield {
          type: "response.output_text.done",
          item_id: event.item_id,
          output_index: event.output_index,
          content_index: event.content_index,
          text: event.part.text,
        };
      }
    }
  }
  const parsed = parseResponsesStream(
    normalizedEvents(),
    formats.segmentation.video(),
  );
  return (await parsed.finalResult).records;
}

function latestMasks(records, frameIndex) {
  const latest = new Map();
  for (const record of records) {
    if (record.kind !== "mask" || record.frame?.frameIndex !== frameIndex) continue;
    const previous = latest.get(record.objectId);
    if (!previous || record.revision >= previous.revision) {
      latest.set(record.objectId, record);
    }
  }
  return [...latest.values()];
}

function blend(channel, color, alpha) {
  return Math.round(channel * (1 - alpha) + color * alpha);
}

function drawRectangle(pixels, width, height, bounds, color) {
  const setPixel = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const offset = (y * width + x) * 4;
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
    pixels[offset + 3] = 255;
  };
  for (let thickness = 0; thickness < 3; thickness += 1) {
    for (let x = bounds.left; x < bounds.right; x += 1) {
      setPixel(x, bounds.top + thickness);
      setPixel(x, bounds.bottom - 1 - thickness);
    }
    for (let y = bounds.top; y < bounds.bottom; y += 1) {
      setPixel(bounds.left + thickness, y);
      setPixel(bounds.right - 1 - thickness, y);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const probe = JSON.parse(
    String(
      run("ffprobe", [
        "-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=width,height", "-of", "json", options.video,
      ]),
    ),
  );
  const { width, height } = probe.streams[0];
  const frameIndex = Math.round(options.time * options.fps);
  const source = run(
    "ffmpeg",
    [
      "-v", "error", "-i", options.video, "-vf", `select=eq(n\\,${frameIndex})`,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
    ],
    { encoding: null },
  );
  const records = latestMasks(await parseRecords(options.events), frameIndex);
  const overlay = Buffer.from(source);
  const colors = [[0, 196, 180], [255, 171, 64], [88, 132, 255], [229, 90, 121]];

  records.forEach((record, index) => {
    const color = colors[index % colors.length];
    const raster = decodeMaskToRaster(record.mask);
    const bounds = record.bounds;
    for (let y = bounds.top; y < bounds.bottom; y += 1) {
      for (let x = bounds.left; x < bounds.right; x += 1) {
        const maskX = Math.min(
          record.mask.width - 1,
          Math.floor(((x - bounds.left) * record.mask.width) / (bounds.right - bounds.left)),
        );
        const maskY = Math.min(
          record.mask.height - 1,
          Math.floor(((y - bounds.top) * record.mask.height) / (bounds.bottom - bounds.top)),
        );
        if (raster[maskY * record.mask.width + maskX] !== 1) continue;
        const offset = (y * width + x) * 4;
        overlay[offset] = blend(overlay[offset], color[0], 0.48);
        overlay[offset + 1] = blend(overlay[offset + 1], color[1], 0.48);
        overlay[offset + 2] = blend(overlay[offset + 2], color[2], 0.48);
      }
    }
    drawRectangle(overlay, width, height, bounds, color);
  });

  const gap = 12;
  const combinedWidth = width * 2 + gap;
  const combined = Buffer.alloc(combinedWidth * height * 4, 255);
  for (let y = 0; y < height; y += 1) {
    source.copy(combined, (y * combinedWidth) * 4, y * width * 4, (y + 1) * width * 4);
    overlay.copy(
      combined,
      (y * combinedWidth + width + gap) * 4,
      y * width * 4,
      (y + 1) * width * 4,
    );
  }
  const pam = Buffer.concat([
    Buffer.from(`P7\nWIDTH ${combinedWidth}\nHEIGHT ${height}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`),
    combined,
  ]);
  await mkdir(path.dirname(options.output), { recursive: true });
  const temporary = `${options.output}.pam`;
  await writeFile(temporary, pam);
  run("ffmpeg", ["-y", "-loglevel", "error", "-i", temporary, options.output]);
  console.log(`Rendered ${records.length} masks at ${options.time}s: ${options.output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
