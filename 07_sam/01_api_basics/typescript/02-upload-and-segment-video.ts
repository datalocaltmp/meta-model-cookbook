#!/usr/bin/env -S npx tsx
/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { access } from 'node:fs/promises';

import { segmentVideo, uploadVideo, writeOutputs } from './sam-api.js';

function optionValue(name: string): string | undefined {
  const index = process.argv.lastIndexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const filename = process.argv[2]?.startsWith('--') ? undefined : process.argv[2];
const existingFileId = optionValue('--file-id');
const concept = optionValue('--concept');
const output = optionValue('--output');
if ((!filename && !existingFileId) || (filename && existingFileId) || !concept || !output) {
  throw new Error(
    'Usage: 02-upload-and-segment-video.ts [video | --file-id file-...] --concept <noun> --output <dir>',
  );
}

let fileId = existingFileId;
if (filename) {
  await access(filename);
  console.log(`Uploading ${filename}...`);
  fileId = await uploadVideo(filename);
  console.log(`Uploaded as ${fileId}`);
}

const result = await segmentVideo(fileId!, concept);
await writeOutputs(output, [[concept, result]]);
