// Copyright (c) Meta Platforms, Inc. and affiliates.
// All rights reserved.
//
// This source code is licensed under the license found in the
// LICENSE file in the root directory of this source tree.

import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const demo = {
  video: '/sample.mp4',
  duration: 60,
  width: 854,
  height: 480,
  analysisFps: 6,
  speakers: [
    { id: 'A', label: 'Speaker A', snippetStart: 1, snippetEnd: 4, sampleText: 'First sample' },
    { id: 'B', label: 'Speaker B', snippetStart: 30, snippetEnd: 34, sampleText: 'Second sample' },
  ],
  people: [
    { id: 'person-1', label: 'Person 1', prompt: 'people', trackIds: ['1'], frames: [{ frameIndex: 6, time: 1, objectId: '1', bounds: [151, 44, 348, 422] }] },
    { id: 'person-2', label: 'Person 2', prompt: 'people', trackIds: ['2'], frames: [{ frameIndex: 180, time: 30, objectId: '2', bounds: [200, 30, 706, 480] }] },
  ],
  turns: [
    { speaker: 'A', start: 0, end: 29, text: 'First person speaking' },
    { speaker: 'B', start: 30, end: 59, text: 'Second person speaking' },
  ],
  segmentation: { media: 'video', revision: 1, records: [], diagnostics: [], rawOutput: '', outcome: { status: 'completed' } },
}

test.beforeEach(async ({ page }) => {
  const job = {
    id: 'job-1', filename: 'sample.mp4', phase: 'ready', progress: 100,
    message: 'Ready', steps: { transcript: 'done', sam: 'done', prepare: 'done' },
    transcript: [], ready: true, renderState: 'idle', error: null,
  }
  await page.route('**/api/jobs/job-1/data', (route) => route.fulfill({ json: demo }))
  await page.route('**/sample.mp4', async (route) => route.fulfill({
    contentType: 'video/mp4',
    body: await readFile(new URL('../assets/sample-input.mp4', import.meta.url)),
  }))
  await page.route('**/api/jobs/job-1', (route) => route.fulfill({ json: job }))
  await page.route('**/api/jobs', (route) => route.fulfill({ status: 202, json: job }))
})

async function uploadSample(page: Page) {
  await page.goto('/')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'sample.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('video'),
  })
}

test('maps two speakers and previews captions', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  await uploadSample(page)

  await expect(page.getByRole('heading', { name: 'Map Speaker A' })).toBeVisible()
  await expect(page.locator('.person-choice')).toHaveCount(2)

  await page.getByRole('button', { name: 'Assign Person 1 to Speaker A' }).click()
  await expect(page.getByRole('heading', { name: 'Map Speaker B' })).toBeVisible()
  await page.getByRole('button', { name: 'Assign Person 2 to Speaker B' }).click()

  const preview = page.getByRole('button', { name: 'Preview captions' })
  await expect(preview).toBeEnabled()
  await preview.click()
  await expect(page.getByRole('heading', { name: 'Caption preview' })).toBeVisible()
  await expect(page.getByText('Mapping complete')).toBeVisible()

  await page.screenshot({ path: 'test-results/desktop-preview.png', fullPage: true })
})

test('calibration layout fits a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await uploadSample(page)
  await expect(page.getByRole('heading', { name: 'Map Speaker A' })).toBeVisible()
  await expect(page.locator('.video-stage')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Match each voice' })).toBeVisible()
  await page.screenshot({ path: 'test-results/mobile-calibration.png', fullPage: true })
})
