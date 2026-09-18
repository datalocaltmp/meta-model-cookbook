#!/usr/bin/env node
// Copyright (c) Meta Platforms, Inc. and affiliates.
// All rights reserved.
//
// This source code is licensed under the license found in the
// LICENSE file in the root directory of this source tree.

import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  decodeMaskToRaster,
  parseVideoStream,
  recordsOfKind,
} from "@meta-sam/parser";

const here = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  return `Usage:
  node sam3-animal-gif-demo/create-segmented-gif.mjs \\
    --input <video.mp4> --object <noun phrase> [options]

Options:
  --output <directory>       Output directory (default: output/<object>)
  --fps <number>             Override source frame rate (default: preserve source)
  --max-dimension <pixels>   Longest prepared-video edge (default: 960)
  --canvas <pixels>          Square cutout frame size (default: 512)
  --padding <ratio>          Padding around the largest subject box (default: 0.12)
  --events <events.ndjson>   Replay saved API events without another model call
  --track-id <id>            Select one SAM object ID (default: longest track)
  --keep-work                Keep prepared video and intermediate frames
  --help                     Show this message
`.replace("sam3-animal-gif-demo/", "");
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help") return { help: true };
    if (key === "--keep-work") {
      values.set("keep-work", true);
      continue;
    }
    if (!key.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`Invalid argument: ${key}\n\n${usage()}`);
    }
    values.set(key.slice(2), argv[index + 1]);
    index += 1;
  }

  const input = values.get("input");
  const object = values.get("object")?.trim();
  if (!input || !object)
    throw new Error(`--input and --object are required.\n\n${usage()}`);
  const fpsValue = values.get("fps");
  const fps = fpsValue === undefined ? null : Number(fpsValue);
  const maxDimension = Number(values.get("max-dimension") ?? 960);
  const canvas = Number(values.get("canvas") ?? 512);
  const padding = Number(values.get("padding") ?? 0.12);
  if (fps !== null && !(fps > 0 && fps <= 120))
    throw new Error("--fps must be between 0 and 120.");
  if (!Number.isInteger(maxDimension) || maxDimension < 128) {
    throw new Error("--max-dimension must be an integer of at least 128.");
  }
  if (!Number.isInteger(canvas) || canvas < 64 || canvas > 2048) {
    throw new Error("--canvas must be an integer between 64 and 2048.");
  }
  if (!(padding >= 0 && padding <= 1))
    throw new Error("--padding must be between 0 and 1.");

  const slug = object
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return {
    help: false,
    input: path.resolve(input),
    object,
    output: path.resolve(
      values.get("output") ?? path.join(here, "output", slug || "subject"),
    ),
    fps,
    maxDimension,
    canvas,
    padding,
    events: values.has("events") ? path.resolve(values.get("events")) : null,
    trackId: values.get("track-id") ?? null,
    keepWork: values.get("keep-work") === true,
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
  const args = [
    "-v",
    "error",
    ...(countFrames ? ["-count_frames"] : []),
    "-select_streams",
    "v:0",
    "-show_entries",
    countFrames
      ? "stream=width,height,nb_read_frames,avg_frame_rate"
      : "stream=width,height,avg_frame_rate:format=duration",
    "-of",
    "json",
    filename,
  ];
  const body = JSON.parse(run("ffprobe", args));
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

function preparedDimensions(width, height, maxDimension) {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return { width: even(width * scale), height: even(height * scale) };
}

async function prepareVideo(options, workDir) {
  const source = probeVideo(options.input);
  const target = preparedDimensions(
    source.width,
    source.height,
    options.maxDimension,
  );
  const output = path.join(workDir, "prepared.mp4");
  const filters = [];
  if (options.fps !== null) filters.push(`fps=${options.fps}`);
  filters.push(`scale=${target.width}:${target.height}:flags=lanczos`);
  console.log(
    `Preparing ${source.width}x${source.height} video as ${target.width}x${target.height} at ${options.fps ?? source.fps} FPS...`,
  );
  run(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-i",
      options.input,
      "-vf",
      filters.join(","),
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      output,
    ],
    { stdio: "inherit" },
  );
  const prepared = probeVideo(output, true);
  return { path: output, ...prepared };
}

function extractSsePayloads(state, chunk, final = false) {
  state.buffer += chunk;
  const payloads = [];
  for (;;) {
    const newline = state.buffer.indexOf("\n");
    if (newline < 0) break;
    let line = state.buffer.slice(0, newline);
    state.buffer = state.buffer.slice(newline + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length === 0) {
      if (state.data.length > 0) payloads.push(state.data.join("\n"));
      state.data = [];
    } else if (line.startsWith("data:")) {
      state.data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (final) {
    let line = state.buffer;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.startsWith("data:")) state.data.push(line.slice(5).replace(/^ /, ""));
    if (state.data.length > 0) payloads.push(state.data.join("\n"));
    state.buffer = "";
    state.data = [];
  }
  return payloads;
}

async function* streamedEvents(source, outputDir, metrics) {
  const rawFile = await open(path.join(outputDir, "events.sse"), "w");
  const eventFile = await open(path.join(outputDir, "events.ndjson"), "w");
  const decoder = new TextDecoder();
  const state = { buffer: "", data: [] };
  try {
    for await (const chunk of source) {
      if (metrics.firstResponseSeconds === null) {
        metrics.firstResponseSeconds = (performance.now() - metrics.start) / 1000;
      }
      await rawFile.write(chunk);
      for (const payload of extractSsePayloads(state, decoder.decode(chunk, { stream: true }))) {
        if (payload.length === 0 || payload === "[DONE]") continue;
        const event = JSON.parse(payload);
        await eventFile.write(`${JSON.stringify(event)}\n`);
        yield event;
      }
    }
    for (const payload of extractSsePayloads(state, decoder.decode(), true)) {
      if (payload.length === 0 || payload === "[DONE]") continue;
      const event = JSON.parse(payload);
      await eventFile.write(`${JSON.stringify(event)}\n`);
      yield event;
    }
  } finally {
    await Promise.all([rawFile.close(), eventFile.close()]);
  }
}

async function* savedEvents(filename, outputDir) {
  const body = await readFile(filename, "utf8");
  await writeFile(path.join(outputDir, "events.ndjson"), body.endsWith("\n") ? body : `${body}\n`);
  for (const line of body.split(/\r?\n/)) {
    if (line.trim().length > 0) yield JSON.parse(line);
  }
}

async function* normalizedEvents(source) {
  let laneDone = false;
  for await (const event of source) {
    if (event.type === "response.output_text.done") {
      if (!laneDone) yield event;
      laneDone = true;
      continue;
    }
    yield event;
    if (
      !laneDone &&
      event.type === "response.content_part.done" &&
      event.part?.type === "output_text" &&
      typeof event.part.text === "string"
    ) {
      laneDone = true;
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

async function* curlResponse(url, apiKey, requestPath) {
  const child = spawn("curl", [
    "-sS",
    "--fail",
    "--retry",
    "4",
    "--retry-all-errors",
    "--retry-max-time",
    "180",
    "-N",
    url,
    "-H",
    `Authorization: Bearer ${apiKey}`,
    "-H",
    "Content-Type: application/json",
    "--data-binary",
    `@${requestPath}`,
  ]);
  let errorOutput = "";
  let exited = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    errorOutput += chunk;
  });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      exited = true;
      resolve(code);
    });
  });
  try {
    for await (const chunk of child.stdout) yield chunk;
    const code = await exit;
    if (code !== 0) {
      throw new Error(`curl failed (${code}): ${errorOutput.trim()}`);
    }
  } finally {
    if (!exited) child.kill();
  }
}

async function finishSegmentation(source, outputDir) {
  const result = await parseVideoStream(normalizedEvents(source)).finalResult;
  await writeFile(path.join(outputDir, "segmentation.txt"), result.rawOutput);
  if (result.outcome.status !== "completed") {
    throw new Error(
      `Segmentation did not complete: ${JSON.stringify(result.outcome)}`,
    );
  }
  if (result.diagnostics.length > 0) {
    await writeFile(
      path.join(outputDir, "diagnostics.json"),
      `${JSON.stringify(result.diagnostics, null, 2)}\n`,
    );
  }
  await writeFile(
    path.join(outputDir, "segmentation.json"),
    `${JSON.stringify({ ...result, rawOutput: "" }, null, 2)}\n`,
  );
  return result;
}

async function segmentVideo(options, prepared, outputDir) {
  if (options.events !== null) {
    console.log(`Replaying saved events from ${options.events}...`);
    const result = await finishSegmentation(savedEvents(options.events, outputDir), outputDir);
    return {
      result,
      uploadSeconds: 0,
      firstResponseSeconds: 0,
      requestSeconds: 0,
    };
  }

  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) {
    throw new Error("MODEL_API_KEY is not set. Export it before running this recipe.");
  }
  const bytes = (await stat(prepared.path)).size;
  console.log(`Uploading prepared video (${(bytes / 1024 / 1024).toFixed(1)} MB)...`);
  const uploadStart = performance.now();
  const uploaded = JSON.parse(
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
  if (typeof uploaded.id !== "string" || uploaded.id.length === 0) {
    throw new Error("The SAM API returned an invalid file ID.");
  }
  const uploadSeconds = (performance.now() - uploadStart) / 1000;
  console.log(`Uploaded as ${uploaded.id} in ${uploadSeconds.toFixed(2)}s.`);

  const requestBody = {
    model: options.model,
    stream: true,
    metadata: { mask_encoding: "one_bit" },
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: options.object },
          { type: "input_video", file_id: uploaded.id },
        ],
      },
    ],
  };
  const requestPath = path.join(outputDir, "request.json");
  await writeFile(
    requestPath,
    `${JSON.stringify(requestBody, null, 2)}\n`,
  );
  const metrics = { start: performance.now(), firstResponseSeconds: null };
  const result = await finishSegmentation(
    streamedEvents(
      curlResponse(`${options.baseURL}/responses`, apiKey, requestPath),
      outputDir,
      metrics,
    ),
    outputDir,
  );
  const requestSeconds = (performance.now() - metrics.start) / 1000;
  const firstResponseSeconds = metrics.firstResponseSeconds ?? requestSeconds;
  console.log(`First response byte after ${firstResponseSeconds.toFixed(2)}s.`);
  return { result, uploadSeconds, firstResponseSeconds, requestSeconds };
}

function selectTrack(records, requestedTrackId) {
  const latest = new Map();
  for (const record of recordsOfKind(records, "mask")) {
    if (
      record.frame === undefined ||
      record.bounds === undefined
    ) {
      continue;
    }
    const frameIndex = record.frame.frameIndex;
    const key = `${frameIndex}:${record.objectId}`;
    const previous = latest.get(key);
    if (previous === undefined || record.revision >= previous.revision) {
      latest.set(key, record);
    }
  }
  const statistics = new Map();
  for (const record of latest.values()) {
    const current = statistics.get(record.objectId) ?? {
      objectId: record.objectId,
      frames: 0,
      totalArea: 0,
    };
    current.frames += 1;
    current.totalArea +=
      (record.bounds.right - record.bounds.left) *
      (record.bounds.bottom - record.bounds.top);
    statistics.set(record.objectId, current);
  }
  const candidates = [...statistics.values()].sort(
    (left, right) =>
      right.frames - left.frames || right.totalArea - left.totalArea,
  );
  if (candidates.length === 0) return { frames: new Map(), candidates, selected: null };
  const selected = requestedTrackId
    ? candidates.find((candidate) => candidate.objectId === requestedTrackId)
    : candidates[0];
  if (selected === undefined) {
    throw new Error(
      `Track ${requestedTrackId} was not found. Available IDs: ${candidates.map(({ objectId }) => objectId).join(", ")}`,
    );
  }
  const frames = new Map();
  for (const record of latest.values()) {
    if (record.objectId !== selected.objectId) continue;
    const frameIndex = record.frame.frameIndex;
    const frameMasks = frames.get(frameIndex) ?? [];
    frameMasks.push({ record, raster: decodeMaskToRaster(record.mask) });
    frames.set(frameIndex, frameMasks);
  }
  return { frames, candidates, selected };
}

function subjectBounds(frameMasks) {
  return frameMasks.reduce(
    (bounds, { record }) => ({
      left: Math.min(bounds.left, record.bounds.left),
      top: Math.min(bounds.top, record.bounds.top),
      right: Math.max(bounds.right, record.bounds.right),
      bottom: Math.max(bounds.bottom, record.bounds.bottom),
    }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
  );
}

function maskContains(frameMasks, x, y) {
  for (const { record, raster } of frameMasks) {
    const bounds = record.bounds;
    if (
      x < bounds.left ||
      x >= bounds.right ||
      y < bounds.top ||
      y >= bounds.bottom
    ) {
      continue;
    }
    const maskX = Math.min(
      record.mask.width - 1,
      Math.floor(
        ((x - bounds.left) * record.mask.width) / (bounds.right - bounds.left),
      ),
    );
    const maskY = Math.min(
      record.mask.height - 1,
      Math.floor(
        ((y - bounds.top) * record.mask.height) / (bounds.bottom - bounds.top),
      ),
    );
    if (raster[maskY * record.mask.width + maskX] === 1) return true;
  }
  return false;
}

function renderCutout(
  source,
  sourceWidth,
  sourceHeight,
  frameMasks,
  canvas,
  side,
  center,
) {
  const [centerX, centerY] = center;
  const output = Buffer.alloc(canvas * canvas * 4);
  for (let outputY = 0; outputY < canvas; outputY += 1) {
    const sourceY = Math.round(
      centerY + ((outputY + 0.5) / canvas - 0.5) * side,
    );
    if (sourceY < 0 || sourceY >= sourceHeight) continue;
    for (let outputX = 0; outputX < canvas; outputX += 1) {
      const sourceX = Math.round(
        centerX + ((outputX + 0.5) / canvas - 0.5) * side,
      );
      if (
        sourceX < 0 ||
        sourceX >= sourceWidth ||
        !maskContains(frameMasks, sourceX, sourceY)
      ) {
        continue;
      }
      const sourceOffset = (sourceY * sourceWidth + sourceX) * 4;
      const outputOffset = (outputY * canvas + outputX) * 4;
      output[outputOffset] = source[sourceOffset];
      output[outputOffset + 1] = source[sourceOffset + 1];
      output[outputOffset + 2] = source[sourceOffset + 2];
      output[outputOffset + 3] = 255;
    }
  }
  return output;
}

async function renderFrames(options, prepared, result, workDir) {
  const selection = selectTrack(result.records, options.trackId);
  const masksByFrame = selection.frames;
  if (masksByFrame.size === 0) {
    throw new Error(
      `SAM returned no masks for the noun phrase "${options.object}".`,
    );
  }
  const frameIndexes = [...masksByFrame.keys()]
    .filter((frameIndex) => frameIndex >= 0 && frameIndex < prepared.frames)
    .sort((left, right) => left - right);
  if (frameIndexes.length === 0)
    throw new Error("SAM mask frames do not overlap the video.");

  const smoothingRadius = Math.max(1, Math.round(prepared.fps * 0.25));
  const centers = new Map();
  const cropSides = new Map();
  for (const frameIndex of frameIndexes) {
    let totalX = 0;
    let totalY = 0;
    let totalEdge = 0;
    let totalWeight = 0;
    for (const neighbor of frameIndexes) {
      const distance = Math.abs(neighbor - frameIndex);
      if (distance > smoothingRadius) continue;
      const bounds = subjectBounds(masksByFrame.get(neighbor));
      const weight = smoothingRadius + 1 - distance;
      totalX += ((bounds.left + bounds.right) / 2) * weight;
      totalY += ((bounds.top + bounds.bottom) / 2) * weight;
      totalEdge +=
        Math.max(bounds.right - bounds.left, bounds.bottom - bounds.top) * weight;
      totalWeight += weight;
    }
    centers.set(frameIndex, [totalX / totalWeight, totalY / totalWeight]);
    cropSides.set(
      frameIndex,
      (totalEdge / totalWeight) * (1 + options.padding * 2),
    );
  }
  const rawPath = path.join(workDir, "prepared.rgba");
  console.log(`Decoding ${prepared.frames} source frames...`);
  run(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-i",
      prepared.path,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      rawPath,
    ],
    { stdio: "inherit" },
  );

  const frameBytes = prepared.width * prepared.height * 4;
  const source = Buffer.alloc(frameBytes);
  const raw = await open(rawPath, "r");
  const framesDir = path.join(workDir, "cutout-frames");
  await mkdir(framesDir, { recursive: true });
  let heldFrames = 0;
  let lastRendered = null;
  let lastDetectedFrame = -Infinity;
  const maximumHoldFrames = Math.max(1, Math.round(prepared.fps * 0.15));
  try {
    for (let frameIndex = 0; frameIndex < prepared.frames; frameIndex += 1) {
      const { bytesRead } = await raw.read(
        source,
        0,
        frameBytes,
        frameIndex * frameBytes,
      );
      if (bytesRead !== frameBytes) break;
      const frameMasks = masksByFrame.get(frameIndex);
      let rgba;
      if (frameMasks !== undefined) {
        rgba = renderCutout(
          source,
          prepared.width,
          prepared.height,
          frameMasks,
          options.canvas,
          cropSides.get(frameIndex),
          centers.get(frameIndex),
        );
        lastRendered = rgba;
        lastDetectedFrame = frameIndex;
      } else if (
        lastRendered !== null &&
        frameIndex - lastDetectedFrame <= maximumHoldFrames
      ) {
        rgba = lastRendered;
        heldFrames += 1;
      } else {
        rgba = Buffer.alloc(options.canvas * options.canvas * 4);
      }
      const header = Buffer.from(
        `P7\nWIDTH ${options.canvas}\nHEIGHT ${options.canvas}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`,
      );
      const filename = path.join(
        framesDir,
        `frame-${String(frameIndex).padStart(5, "0")}.pam`,
      );
      await writeFile(filename, Buffer.concat([header, rgba]));
    }
  } finally {
    await raw.close();
  }
  return {
    framesDir,
    renderedFrames: prepared.frames,
    detectedFrames: frameIndexes.length,
    heldFrames,
    selectedObjectId: selection.selected.objectId,
    candidateTracks: selection.candidates,
  };
}

function encodeAnimation(prepared, framesDir, outputDir) {
  const input = path.join(framesDir, "frame-%05d.pam");
  const apng = path.join(outputDir, "segmented-subject.png");
  console.log("Encoding lossless RGBA animation...");
  run(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-framerate",
      String(prepared.fps),
      "-i",
      input,
      "-plays",
      "0",
      "-f",
      "apng",
      apng,
    ],
    { stdio: "inherit" },
  );
  return { apng };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  await access(options.input, constants.R_OK);
  await mkdir(options.output, { recursive: true });
  const workDir = path.join(options.output, "work");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  const prepared = await prepareVideo(options, workDir);
  const segmented = await segmentVideo(options, prepared, options.output);
  const rendered = await renderFrames(
    options,
    prepared,
    segmented.result,
    workDir,
  );
  const animations = encodeAnimation(
    prepared,
    rendered.framesDir,
    options.output,
  );
  const objectIds = new Set(
    recordsOfKind(segmented.result.records, "mask").map(
      (record) => record.objectId,
    ),
  );
  const summary = {
    input: path.basename(options.input),
    object: options.object,
    model: options.model,
    preparedVideo: {
      width: prepared.width,
      height: prepared.height,
      frames: prepared.frames,
      fps: prepared.fps,
    },
    detectedFrames: rendered.detectedFrames,
    renderedFrames: rendered.renderedFrames,
    heldFrames: rendered.heldFrames,
    objectIds: [...objectIds],
    selectedObjectId: rendered.selectedObjectId,
    candidateTracks: rendered.candidateTracks,
    timingSeconds: {
      upload: segmented.uploadSeconds,
      firstResponse: segmented.firstResponseSeconds,
      segmentation: segmented.requestSeconds,
    },
    outputs: { apng: path.basename(animations.apng) },
    diagnostics: segmented.result.diagnostics,
  };
  await writeFile(
    path.join(options.output, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  if (!options.keepWork) await rm(workDir, { recursive: true, force: true });
  console.log(`Done: ${animations.apng}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
