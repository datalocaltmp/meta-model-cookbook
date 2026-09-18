#!/usr/bin/env node
// Copyright (c) Meta Platforms, Inc. and affiliates.
// All rights reserved.
//
// This source code is licensed under the license found in the
// LICENSE file in the root directory of this source tree.

import { spawnSync } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  parseVideoStream,
} from "@meta-sam/parser";

function usage() {
  return `Usage: node segment-people.mjs --input <video> --object <phrase> --output <directory>

Options:
  --fps <number>             Override the source frame rate (default: preserve source)
  --max-dimension <pixels>   Longest analysis edge (default: 960)
`;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help") return { help: true };
    if (!key.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`Invalid argument: ${key}\n\n${usage()}`);
    }
    values.set(key.slice(2), argv[index + 1]);
    index += 1;
  }

  const input = values.get("input");
  const object = values.get("object")?.trim();
  const output = values.get("output");
  if (!input || !object || !output) {
    throw new Error(`--input, --object, and --output are required.\n\n${usage()}`);
  }
  const fpsValue = values.get("fps");
  const fps = fpsValue === undefined ? null : Number(fpsValue);
  const maxDimension = Number(values.get("max-dimension") ?? 960);
  if (fps !== null && !(fps > 0 && fps <= 120)) {
    throw new Error("--fps must be between 0 and 120.");
  }
  if (!Number.isInteger(maxDimension) || maxDimension < 128) {
    throw new Error("--max-dimension must be an integer of at least 128.");
  }
  return {
    help: false,
    input: path.resolve(input),
    object,
    output: path.resolve(output),
    fps,
    maxDimension,
    model: "sam-3.1",
    baseURL: "https://api.meta.ai/v1",
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.encoding ?? "utf8",
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    stdio: options.stdio ?? "pipe",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed:\n${result.stderr ?? ""}${result.stdout ?? ""}`,
    );
  }
  return result.stdout;
}

function probeVideo(filename, countFrames = false) {
  const fields = countFrames
    ? "stream=width,height,avg_frame_rate,nb_read_frames"
    : "stream=width,height,avg_frame_rate:format=duration";
  const body = JSON.parse(
    run("ffprobe", [
      "-v",
      "error",
      ...(countFrames ? ["-count_frames"] : []),
      "-select_streams",
      "v:0",
      "-show_entries",
      fields,
      "-of",
      "json",
      filename,
    ]),
  );
  const stream = body.streams?.[0];
  if (!stream) throw new Error(`No video stream found in ${filename}.`);
  const [rateNumerator, rateDenominator] = String(stream.avg_frame_rate)
    .split("/")
    .map(Number);
  const fps = rateDenominator ? rateNumerator / rateDenominator : rateNumerator;
  if (!(fps > 0)) throw new Error(`Could not determine frame rate for ${filename}.`);
  return {
    width: Number(stream.width),
    height: Number(stream.height),
    fps,
    frames: countFrames ? Number(stream.nb_read_frames) : undefined,
    duration:
      body.format?.duration === undefined
        ? undefined
        : Number(body.format.duration),
  };
}

function even(value) {
  return Math.max(2, Math.round(value / 2) * 2);
}

async function prepareVideo(options) {
  const source = probeVideo(options.input);
  const scale = Math.min(
    1,
    options.maxDimension / Math.max(source.width, source.height),
  );
  const width = even(source.width * scale);
  const height = even(source.height * scale);
  const output = path.join(options.output, "prepared.mp4");
  const filters = [];
  if (options.fps !== null) filters.push(`fps=${options.fps}`);
  filters.push(`scale=${width}:${height}:flags=lanczos`);
  run(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-i",
      options.input,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-vf",
      filters.join(","),
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      output,
    ],
    { stdio: "inherit" },
  );
  return { path: output, ...probeVideo(output, true) };
}

async function requestSegmentation(options, prepared) {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) throw new Error("MODEL_API_KEY is not set.");
  const upload = JSON.parse(
    run(
      "curl",
      [
        "-sS",
        "--fail-with-body",
        "--retry",
        "4",
        "--retry-all-errors",
        "--retry-max-time",
        "180",
        `${options.baseURL}/files`,
        "-H",
        `Authorization: Bearer ${apiKey}`,
        "-F",
        "purpose=user_data",
        "-F",
        `file=@${prepared.path};type=video/mp4`,
      ],
      { maxBuffer: 2 * 1024 * 1024 },
    ),
  );
  if (!upload.id) throw new Error("The SAM API returned no file ID.");

  const request = {
    model: options.model,
    stream: true,
    metadata: { mask_encoding: "one_bit" },
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: options.object },
          { type: "input_video", file_id: upload.id },
        ],
      },
    ],
  };
  const requestPath = path.join(options.output, "sam-request.json");
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  const raw = run(
    "curl",
    [
      "-sS",
      "--fail-with-body",
      "--retry",
      "4",
      "--retry-all-errors",
      "--retry-max-time",
      "180",
      "-N",
      `${options.baseURL}/responses`,
      "-H",
      `Authorization: Bearer ${apiKey}`,
      "-H",
      "Content-Type: application/json",
      "--data-binary",
      `@${requestPath}`,
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  await writeFile(path.join(options.output, "sam-events.sse"), raw);

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

  const parsed = parseVideoStream(normalizedEvents());
  const result = await parsed.finalResult;
  await writeFile(path.join(options.output, "sam-segmentation.txt"), result.rawOutput);
  if (result.outcome.status !== "completed") {
    throw new Error(`SAM segmentation failed: ${JSON.stringify(result.outcome)}`);
  }
  await writeFile(
    path.join(options.output, "segmentation.json"),
    `${JSON.stringify({ ...result, rawOutput: "" }, null, 2)}\n`,
  );
  return result;
}

function extractPeopleTracks(records, prepared) {
  const latest = new Map();
  for (const record of records) {
    if (record.kind !== "mask" || !record.frame || !record.bounds) continue;
    const key = `${record.frame.frameIndex}:${record.objectId}`;
    const previous = latest.get(key);
    if (!previous || record.revision >= previous.revision) latest.set(key, record);
  }

  const frames = new Map();
  for (const record of latest.values()) {
    const frameIndex = record.frame.frameIndex;
    const candidates = frames.get(frameIndex) ?? [];
    candidates.push(record);
    frames.set(frameIndex, candidates);
  }

  return [...frames.entries()]
    .sort(([left], [right]) => left - right)
    .map(([frameIndex, candidates]) => {
      return {
        frameIndex,
        timeSeconds: frameIndex / prepared.fps,
        people: candidates
          .map((record) => ({
            objectId: String(record.objectId),
            bounds: record.bounds,
            mask: record.mask,
          }))
          .sort((left, right) => left.bounds.left - right.bounds.left),
      };
    });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  await mkdir(options.output, { recursive: true });
  const prepared = await prepareVideo(options);
  const result = await requestSegmentation(options, prepared);
  const frames = extractPeopleTracks(result.records, prepared);
  if (frames.length === 0) {
    throw new Error(`SAM returned no tracks for "${options.object}".`);
  }
  const output = {
    input: options.input,
    object: options.object,
    model: options.model,
    width: prepared.width,
    height: prepared.height,
    fps: prepared.fps,
    sourceFrameCount: prepared.frames,
    trackedFrameCount: frames.length,
    objectIds: [
      ...new Set(
        frames.flatMap((frame) =>
          frame.people.map((person) => person.objectId),
        ),
      ),
    ],
    frames,
    diagnostics: result.diagnostics,
  };
  const filename = path.join(options.output, "tracks.json");
  await writeFile(filename, `${JSON.stringify(output, null, 2)}\n`);
  const megabytes = (await stat(prepared.path)).size / 1024 / 1024;
  console.log(
    `Tracked ${output.objectIds.length} object tracks across ${frames.length}/${prepared.frames} frames in ${megabytes.toFixed(1)} MB analysis video.`,
  );
  console.log(filename);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
