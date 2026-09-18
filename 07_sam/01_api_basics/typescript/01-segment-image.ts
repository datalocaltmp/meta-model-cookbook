#!/usr/bin/env -S npx tsx
/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { access } from 'node:fs/promises';

import { segmentImage, writeOutputs } from './sam-api.js';

function optionValues(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && index + 1 < process.argv.length) {
      values.push(process.argv[index + 1]!);
      index += 1;
    }
  }
  return values;
}

const filename = process.argv[2]?.startsWith('--') ? undefined : process.argv[2];
const concepts = optionValues('--concept');
const output = optionValues('--output').at(-1);
if (!filename || concepts.length === 0 || !output) {
  throw new Error(
    'Usage: 01-segment-image.ts <image> --concept <noun> [--concept <noun>] --output <dir>',
  );
}
await access(filename);

const results = [];
for (const concept of concepts) {
  console.log(`Segmenting ${JSON.stringify(concept)}...`);
  results.push([concept, await segmentImage(filename, concept)] as const);
}
await writeOutputs(output, results);
