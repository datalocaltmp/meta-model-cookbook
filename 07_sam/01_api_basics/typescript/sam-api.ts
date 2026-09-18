/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  decodeMaskToRaster,
  decodeMaskToSVGPath,
  parseImageStream,
  parseVideoStream,
  recordsOfKind,
  type ImageSegmentationResult,
  type ResponsesEvent,
  type SegmentationResult,
  type VideoSegmentationResult,
} from '@meta-sam/parser';
import OpenAI, { toFile } from 'openai';

const BASE_URL = 'https://api.meta.ai/v1';
const MODEL = 'sam-3.1';

function client(): OpenAI {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Set MODEL_API_KEY before calling the Segment Anything Model API.',
    );
  }
  return new OpenAI({ baseURL: BASE_URL, apiKey });
}

function mediaType(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.mov':
      return 'video/quicktime';
    case '.mp4':
      return 'video/mp4';
    default:
      throw new Error(`Could not infer a media type for ${filename}.`);
  }
}

function responseInput(prompt: string, media: Record<string, string>): unknown[] {
  const phrase = prompt.trim();
  if (!phrase) throw new Error('The concept must be a short noun phrase.');
  return [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: phrase }, media],
    },
  ];
}

// The SDK streams typed Responses events; the parser reads the same wire shape,
// so the stream is passed straight through (cast to the parser's event type).
type EventStream = AsyncIterable<ResponsesEvent>;

// The API streams `response.content_part.done` but not `response.output_text.done`,
// which the parser uses to finalize a text lane — synthesize it from the content part.
async function* normalizedEvents(stream: AsyncIterable<unknown>): EventStream {
  const completed = new Set<string>();
  for await (const raw of stream) {
    const event = raw as {
      type?: string;
      item_id?: unknown;
      output_index?: unknown;
      content_index?: unknown;
      part?: { type?: unknown; text?: unknown } | null;
    };
    const lane = `${String(event.item_id)}:${String(event.output_index)}:${String(event.content_index)}`;
    if (event.type === 'response.output_text.done') {
      if (!completed.has(lane)) {
        completed.add(lane);
        yield event as unknown as ResponsesEvent;
      }
      continue;
    }
    yield event as unknown as ResponsesEvent;
    if (
      event.type === 'response.content_part.done' &&
      !completed.has(lane) &&
      event.part &&
      typeof event.part === 'object' &&
      event.part.type === 'output_text' &&
      typeof event.part.text === 'string'
    ) {
      completed.add(lane);
      yield {
        type: 'response.output_text.done',
        item_id: event.item_id,
        output_index: event.output_index,
        content_index: event.content_index,
        text: event.part.text,
      } as unknown as ResponsesEvent;
    }
  }
}

export async function segmentImage(
  filename: string,
  concept: string,
): Promise<ImageSegmentationResult> {
  const bytes = await readFile(filename);
  const image = {
    type: 'input_image',
    image_url: `data:${mediaType(filename)};base64,${bytes.toString('base64')}`,
  };
  const stream = await client().responses.create({
    model: MODEL,
    stream: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: responseInput(concept, image) as any,
  });
  return parseImageStream(normalizedEvents(stream)).finalResult;
}

export async function uploadVideo(filename: string): Promise<string> {
  const bytes = await readFile(filename);
  const uploaded = await client().files.create({
    file: await toFile(bytes, path.basename(filename), {
      type: mediaType(filename),
    }),
    purpose: 'user_data',
  });
  if (typeof uploaded.id !== 'string' || !uploaded.id.startsWith('file-')) {
    throw new Error('The Files API returned an invalid file ID.');
  }
  return uploaded.id;
}

export async function segmentVideo(
  fileId: string,
  concept: string,
): Promise<VideoSegmentationResult> {
  if (!fileId.startsWith('file-')) {
    throw new Error("Expected a Files API ID beginning with 'file-'.");
  }
  const stream = await client().responses.create({
    model: MODEL,
    stream: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: responseInput(concept, { type: 'input_video', file_id: fileId }) as any,
  });
  const parsed = parseVideoStream(normalizedEvents(stream));
  for await (const snapshot of parsed) {
    if (snapshot.revision === 1 || snapshot.revision % 30 === 0) {
      console.log(`revision=${snapshot.revision} records=${snapshot.records.length}`);
    }
  }
  return parsed.finalResult;
}

export function validateResult(result: SegmentationResult): void {
  if (result.outcome.status !== 'completed') {
    throw new Error(
      `Segmentation was incomplete: ${result.outcome.reason} (${result.outcome.detail ?? ''})`,
    );
  }
  const errors = result.diagnostics.filter((item) => item.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `The parser rejected records: ${errors.map((item) => `line ${item.line}: ${item.message}`).join('; ')}`,
    );
  }
}

export interface ResultSummary {
  readonly concept: string;
  readonly media: 'image' | 'video';
  readonly outcome: string;
  readonly records: number;
  readonly boxes: readonly Record<string, string | number | null>[];
  readonly masks: readonly Record<string, string | number | null>[];
  readonly tracks: readonly Record<string, string | number>[];
  readonly diagnostics: readonly Record<string, string | number>[];
}

export function summarizeResult(
  result: SegmentationResult,
  concept: string,
): ResultSummary {
  const boxes = recordsOfKind(result.records, 'box');
  const masks = recordsOfKind(result.records, 'mask');
  const tracks = new Map<string, Set<number>>();
  for (const record of [...boxes, ...masks]) {
    if (record.frame == null) continue;
    const frames = tracks.get(record.objectId) ?? new Set<number>();
    frames.add(record.frame.frameIndex);
    tracks.set(record.objectId, frames);
  }
  return {
    concept,
    media: result.media,
    outcome: result.outcome.status,
    records: result.records.length,
    boxes: boxes.map((record) => ({
      object_id: record.objectId,
      frame: record.frame?.frameIndex ?? null,
      left: record.left,
      top: record.top,
      right: record.right,
      bottom: record.bottom,
    })),
    masks: masks.map((record) => ({
      object_id: record.objectId,
      frame: record.frame?.frameIndex ?? null,
      encoding: record.mask.encoding,
      width: record.mask.width,
      height: record.mask.height,
      foreground_pixels: decodeMaskToRaster(record.mask).reduce(
        (total, value) => total + value,
        0,
      ),
    })),
    tracks: [...tracks.entries()]
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([objectId, frameSet]) => {
        const frames = [...frameSet].sort((left, right) => left - right);
        return {
          object_id: objectId,
          first_frame: frames[0]!,
          last_frame: frames.at(-1)!,
          visible_frames: frames.length,
        };
      }),
    diagnostics: result.diagnostics.map((item) => ({
      severity: item.severity,
      code: item.code,
      line: item.line,
      message: item.message,
    })),
  };
}

export async function writeOutputs(
  output: string,
  results: readonly (readonly [string, SegmentationResult])[],
): Promise<void> {
  await mkdir(output, { recursive: true });
  const summaries: ResultSummary[] = [];
  let maskIndex = 0;
  for (const [concept, result] of results) {
    validateResult(result);
    summaries.push(summarizeResult(result, concept));
    for (const record of recordsOfKind(result.records, 'mask')) {
      const svgPath = decodeMaskToSVGPath(record.mask);
      await writeFile(
        path.join(output, `mask-${String(maskIndex).padStart(4, '0')}.svg`),
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${record.mask.width} ${record.mask.height}">\n  <path d="${svgPath}" fill="black"/>\n</svg>\n`,
      );
      maskIndex += 1;
    }
  }
  await writeFile(
    path.join(output, 'summary.json'),
    `${JSON.stringify(summaries, null, 2)}\n`,
  );
  console.log(`Wrote ${summaries.length} result(s) and ${maskIndex} mask(s) to ${output}`);
}
