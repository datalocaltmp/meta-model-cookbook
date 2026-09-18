// Copyright (c) Meta Platforms, Inc. and affiliates.
// All rights reserved.
//
// This source code is licensed under the license found in the
// LICENSE file in the root directory of this source tree.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import dotenv from 'dotenv'
import express from 'express'
import multer from 'multer'
import { createServer as createViteServer } from 'vite'

const appRoot = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = appRoot
const runtimeRoot = path.join(projectRoot, 'runtime')
const uploadsRoot = path.join(runtimeRoot, 'uploads')
dotenv.config({ path: path.resolve(projectRoot, '.env'), override: true })
const port = Number(process.env.PORT ?? 5174)
const virtualenvPython = path.join(projectRoot, '.venv', 'bin', 'python')
const python = process.env.PYTHON ?? (existsSync(virtualenvPython) ? virtualenvPython : 'python')

await mkdir(uploadsRoot, { recursive: true })

const app = express()
const upload = multer({ dest: uploadsRoot, limits: { fileSize: 500 * 1024 * 1024 } })
const jobs = new Map()

async function restoreCompletedJobs() {
  const entries = await readdir(runtimeRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'uploads') continue
    const directory = path.join(runtimeRoot, entry.name)
    const input = path.join(directory, 'input.mp4')
    const transcriptPath = path.join(directory, 'transcript.json')
    const samDir = path.join(directory, 'sam')
    const dataPath = path.join(directory, 'demo-data.json')
    const outputPath = path.join(directory, 'captioned.mp4')
    if (![input, transcriptPath, path.join(samDir, 'tracks.json'), dataPath].every(existsSync)) continue
    const transcript = JSON.parse(await readFile(transcriptPath, 'utf8'))
    jobs.set(entry.name, {
      id: entry.name,
      filename: 'uploaded-video.mp4',
      directory,
      input,
      transcriptPath,
      samDir,
      dataPath,
      outputPath,
      phase: 'ready',
      progress: 100,
      message: 'Ready to map speakers',
      steps: { transcript: 'done', sam: 'done', prepare: 'done' },
      transcript: transcript.turns ?? [],
      renderState: existsSync(outputPath) ? 'ready' : 'idle',
      error: null,
    })
  }
}

await restoreCompletedJobs()

app.use(express.json({ limit: '1mb' }))

function publicJob(job) {
  return {
    id: job.id,
    filename: job.filename,
    phase: job.phase,
    progress: job.progress,
    message: job.message,
    steps: job.steps,
    transcript: job.transcript,
    ready: job.phase === 'ready',
    renderState: job.renderState,
    error: job.error,
  }
}

function update(job, values) {
  Object.assign(job, values)
}

function run(command, args, cwd = projectRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env })
    let output = ''
    let error = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { error += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(error || output || `${command} exited with ${code}`))
    })
  })
}

async function processJob(job) {
  try {
    update(job, { phase: 'processing', progress: 12, message: 'Reading audio and video' })
    const transcriptTask = run(python, [
      path.join(projectRoot, 'scripts/transcribe.py'),
      job.input,
      '--output', job.transcriptPath,
    ]).then(async () => {
      const transcript = JSON.parse(await readFile(job.transcriptPath, 'utf8'))
      update(job, {
        progress: job.steps.sam === 'done' ? 82 : 46,
        message: job.steps.sam === 'done' ? 'Preparing speaker mapping' : 'Tracking people with SAM 3',
        steps: { ...job.steps, transcript: 'done' },
        transcript: transcript.turns ?? [],
      })
    })
    const segmentationTask = run('node', [
      path.join(projectRoot, 'scripts/segment-people.mjs'),
      '--input', job.input,
      '--object', 'people',
      '--output', job.samDir,
    ]).then(() => {
      update(job, {
        progress: job.steps.transcript === 'done' ? 82 : 58,
        message: job.steps.transcript === 'done' ? 'Preparing speaker mapping' : 'Transcribing speakers',
        steps: { ...job.steps, sam: 'done' },
      })
    })
    await Promise.all([transcriptTask, segmentationTask])

    await run(python, [
      path.join(projectRoot, 'scripts/build-demo-data.py'),
      '--transcript', job.transcriptPath,
      '--tracks', path.join(job.samDir, 'tracks.json'),
      '--segmentation', path.join(job.samDir, 'segmentation.json'),
      '--output', job.dataPath,
      '--video-url', `/api/jobs/${job.id}/analysis-video`,
    ])
    update(job, {
      phase: 'ready',
      progress: 100,
      message: 'Ready to map speakers',
      steps: { transcript: 'done', sam: 'done', prepare: 'done' },
    })
  } catch (error) {
    update(job, {
      phase: 'failed',
      message: 'Processing failed',
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

app.post('/api/jobs', upload.single('video'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'A video file is required.' })
  const id = randomUUID()
  const directory = path.join(runtimeRoot, id)
  await mkdir(directory, { recursive: true })
  const input = path.join(directory, 'input.mp4')
  await rename(request.file.path, input)
  const job = {
    id,
    filename: request.file.originalname,
    directory,
    input,
    transcriptPath: path.join(directory, 'transcript.json'),
    samDir: path.join(directory, 'sam'),
    dataPath: path.join(directory, 'demo-data.json'),
    outputPath: path.join(directory, 'captioned.mp4'),
    phase: 'queued',
    progress: 5,
    message: 'Upload complete',
    steps: { transcript: 'running', sam: 'running', prepare: 'pending' },
    transcript: [],
    renderState: 'idle',
    error: null,
  }
  jobs.set(id, job)
  void processJob(job)
  return response.status(202).json(publicJob(job))
})

app.get('/api/jobs/:id', (request, response) => {
  const job = jobs.get(request.params.id)
  if (!job) return response.status(404).json({ error: 'Job not found.' })
  return response.json(publicJob(job))
})

app.get('/api/jobs/:id/data', (request, response) => {
  const job = jobs.get(request.params.id)
  if (!job || job.phase !== 'ready') return response.status(404).json({ error: 'Data is not ready.' })
  return response.sendFile(job.dataPath)
})

app.get('/api/jobs/:id/video', (request, response) => {
  const job = jobs.get(request.params.id)
  if (!job) return response.status(404).end()
  return response.sendFile(job.input)
})

app.get('/api/jobs/:id/analysis-video', (request, response) => {
  const job = jobs.get(request.params.id)
  if (!job || job.phase !== 'ready') return response.status(404).end()
  return response.sendFile(path.join(job.samDir, 'prepared.mp4'))
})

app.post('/api/jobs/:id/render', async (request, response) => {
  const job = jobs.get(request.params.id)
  if (!job || job.phase !== 'ready') return response.status(404).json({ error: 'Job is not ready.' })
  if (!request.body?.mapping || typeof request.body.mapping !== 'object') {
    return response.status(400).json({ error: 'Speaker mapping is required.' })
  }
  const supportedEffects = new Set(['spotlight', 'halo', 'mask', 'none'])
  const effect = supportedEffects.has(request.body.effect) ? request.body.effect : 'spotlight'
  if (job.renderState === 'running') return response.status(202).json(publicJob(job))
  const mappingPath = path.join(job.directory, 'mapping.json')
  await writeFile(mappingPath, `${JSON.stringify(request.body.mapping, null, 2)}\n`)
  update(job, { renderState: 'running', message: 'Rendering captioned video', error: null })
  void run(python, [
    path.join(projectRoot, 'scripts/render-captioned-video.py'),
    '--input', job.input,
    '--data', job.dataPath,
    '--mapping', mappingPath,
    '--output', job.outputPath,
    '--effect', effect,
  ]).then(() => {
    update(job, { renderState: 'ready', message: 'Download is ready', error: null })
  }).catch((error) => {
    update(job, {
      renderState: 'failed',
      message: 'Rendering failed',
      error: error instanceof Error ? error.message : String(error),
    })
  })
  return response.status(202).json(publicJob(job))
})

app.get('/api/jobs/:id/download', (request, response) => {
  const job = jobs.get(request.params.id)
  if (!job || job.renderState !== 'ready') return response.status(404).end()
  return response.download(job.outputPath, `headlocked-${job.filename.replace(/\.[^.]+$/, '')}.mp4`)
})

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(appRoot, 'dist')))
  app.get('*', (_request, response) => response.sendFile(path.join(appRoot, 'dist/index.html')))
} else {
  const vite = await createViteServer({ root: appRoot, server: { middlewareMode: true }, appType: 'spa' })
  app.use(vite.middlewares)
}

app.listen(port, '127.0.0.1', () => {
  console.log(`Speaker Mapping demo: http://127.0.0.1:${port}`)
})
