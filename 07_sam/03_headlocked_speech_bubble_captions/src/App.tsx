// Copyright (c) Meta Platforms, Inc. and affiliates.
// All rights reserved.
//
// This source code is licensed under the license found in the
// LICENSE file in the root directory of this source tree.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Download,
  FileVideo,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  Upload,
  Users,
} from 'lucide-react'
import { objectColor } from '@meta-sam/graphics'
import {
  decodeMaskToRaster,
  type SegmentationMaskRecord,
  type VideoSegmentationResult,
} from '@meta-sam/parser'
import { Video, type VideoRef } from '@meta-sam/react'
import './App.css'

type Bounds = [number, number, number, number]
type TrackFrame = { frameIndex: number; time: number; objectId: string; bounds: Bounds }
type Person = { id: string; label: string; prompt: string; trackIds: string[]; frames: TrackFrame[] }
type Rect = { left: number; top: number; right: number; bottom: number }
type Point = { x: number; y: number }
type Speaker = {
  id: string
  label: string
  snippetStart: number
  snippetEnd: number
  sampleText: string
}
type Turn = { speaker: string; start: number; end: number; text: string }
type DemoData = {
  video: string
  duration: number
  width: number
  height: number
  analysisFps: number
  speakers: Speaker[]
  people: Person[]
  turns: Turn[]
  segmentation: VideoSegmentationResult
}
type Mapping = Record<string, string>
type SpeakerEffect = 'spotlight' | 'halo' | 'mask' | 'none'
type JobStatus = {
  id: string
  filename: string
  phase: 'queued' | 'processing' | 'ready' | 'failed'
  progress: number
  message: string
  steps: Record<'transcript' | 'sam' | 'prepare', 'pending' | 'running' | 'done'>
  transcript: Array<{ speaker: string; startMs: number; endMs: number; transcript: string }>
  ready: boolean
  renderState: 'idle' | 'running' | 'ready' | 'failed'
  error: string | null
}

const speakerColors = ['#1877f2', '#0f8a7e', '#d15f2a', '#7c5cc4', '#b53668']
const speakerEffects: Array<{ id: SpeakerEffect; label: string }> = [
  { id: 'spotlight', label: 'Spotlight' },
  { id: 'halo', label: 'Halo' },
  { id: 'mask', label: 'Mask' },
  { id: 'none', label: 'None' },
]
const headAnchorCache = new WeakMap<SegmentationMaskRecord, Point>()

function colorAt(index: number) {
  return speakerColors[index] ?? `hsl(${(index * 137.5) % 360} 58% 42%)`
}

function nearestFrame(person: Person, frameIndex: number, time: number): TrackFrame | null {
  let low = 0
  let high = person.frames.length - 1
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2)
    if (person.frames[middle].frameIndex <= frameIndex) low = middle
    else high = middle - 1
  }
  const candidates = [person.frames[low], person.frames[low + 1]].filter(Boolean)
  const nearest = candidates.reduce<TrackFrame | null>((best, frame) => {
    if (!best) return frame
    return Math.abs(frame.frameIndex - frameIndex) < Math.abs(best.frameIndex - frameIndex) ? frame : best
  }, null)
  return nearest && Math.abs(nearest.time - time) <= 0.55 ? nearest : null
}

function activeTurn(turns: Turn[], time: number) {
  return turns.find((turn) => turn.start <= time && time < turn.end) ?? null
}

function captionChunk(turn: Turn, time: number) {
  const words = turn.text.split(/\s+/)
  const chunks: string[] = []
  for (let index = 0; index < words.length; index += 7) {
    chunks.push(words.slice(index, index + 7).join(' '))
  }
  const progress = Math.max(0, Math.min(0.999, (time - turn.start) / (turn.end - turn.start)))
  const index = Math.floor(progress * chunks.length)
  return {
    text: chunks[index],
    referenceTime: turn.start + ((index + 0.5) / chunks.length) * (turn.end - turn.start),
  }
}

function formatTime(value: number) {
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`
}

function ProcessingStep({ label, detail, state }: {
  label: string
  detail: string
  state: 'pending' | 'running' | 'done'
}) {
  return <div className={`processing-step is-${state}`}>
    <span className="step-icon">{state === 'done' ? <Check size={16} /> : state === 'running' ? <LoaderCircle className="spin" size={16} /> : null}</span>
    <span><strong>{label}</strong><small>{detail}</small></span>
  </div>
}

function overlapArea(left: Rect, right: Rect) {
  return Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left))
    * Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top))
}

function headRegion(bounds: Bounds): Rect {
  const [left, top, right, bottom] = bounds
  const width = right - left
  const height = bottom - top
  return {
    left: left + width * 0.2,
    top,
    right: right - width * 0.2,
    bottom: top + height * 0.3,
  }
}

function maskHeadAnchor(record: SegmentationMaskRecord | undefined, bounds: Bounds): Point {
  const [left, top, right] = bounds
  if (!record) return { x: (left + right) / 2, y: Math.max(0, top - 5) }
  const cached = headAnchorCache.get(record)
  if (cached) return cached
  const raster = decodeMaskToRaster(record.mask)
  const searchHeight = Math.max(1, Math.ceil(record.mask.height * 0.3))
  let firstRow = -1
  let totalX = 0
  let count = 0
  for (let y = 0; y < searchHeight; y += 1) {
    let rowCount = 0
    let rowTotalX = 0
    for (let x = 0; x < record.mask.width; x += 1) {
      if (raster[y * record.mask.width + x] !== 1) continue
      rowCount += 1
      rowTotalX += x
    }
    if (rowCount === 0) continue
    if (firstRow < 0) firstRow = y
    if (y > firstRow + Math.max(3, Math.round(record.mask.height * 0.04))) break
    totalX += rowTotalX
    count += rowCount
  }
  if (firstRow < 0 || count === 0) return { x: (left + right) / 2, y: Math.max(0, top - 5) }
  const anchor = {
    x: left + totalX / count,
    y: Math.max(0, top + firstRow - 5),
  }
  headAnchorCache.set(record, anchor)
  return anchor
}

function tetherPoint(className: string, left: number, top: number, width: number, height: number, anchor: Point): Point | null {
  if (className === 'is-rail') return null
  if (className === 'is-right') return { x: left, y: Math.max(top + 10, Math.min(top + height - 10, anchor.y)) }
  if (className === 'is-left') return { x: left + width, y: Math.max(top + 10, Math.min(top + height - 10, anchor.y)) }
  if (className === 'is-below') {
    return { x: Math.max(left + 10, Math.min(left + width - 10, anchor.x)), y: top }
  }
  return { x: Math.max(left + 10, Math.min(left + width - 10, anchor.x)), y: top + height }
}

function bubblePlacement(
  bounds: Bounds,
  anchor: Point,
  people: Bounds[],
  width: number,
  height: number,
  text: string,
  preferredSide?: string,
) {
  const [left, top, right, bottom] = bounds
  const centerX = anchor.x
  const headY = anchor.y
  const bubbleWidth = Math.min(width * 0.42, Math.max(220, text.length * 7.4))
  const charactersPerLine = Math.max(18, Math.floor((bubbleWidth - 28) / 9.5))
  const lineCount = Math.max(1, Math.ceil(text.length / charactersPerLine))
  const bubbleHeight = 30 + Math.min(3, lineCount) * 23
  const gap = 14
  const margin = 12
  const candidates = [
    { className: 'is-above', left: centerX - bubbleWidth / 2, top: top - gap - bubbleHeight, priority: 0 },
    { className: 'is-right', left: right + gap, top: headY - bubbleHeight / 2, priority: 1 },
    { className: 'is-left', left: left - gap - bubbleWidth, top: headY - bubbleHeight / 2, priority: 1 },
    { className: 'is-below', left: centerX - bubbleWidth / 2, top: bottom + gap, priority: 2 },
    { className: 'is-rail', left: Math.max(margin, Math.min(width - bubbleWidth - margin, centerX - bubbleWidth / 2)), top: height - bubbleHeight - margin, priority: 4 },
  ]
  const headRegions = people.map(headRegion)
  const bodyRegions = people.map(([personLeft, personTop, personRight, personBottom]) => ({
    left: personLeft, top: personTop, right: personRight, bottom: personBottom,
  }))
  const bubbleArea = bubbleWidth * bubbleHeight
  const diagonal = Math.hypot(width, height)

  const winner = candidates
    .map((candidate) => {
      const rectangle = {
        left: candidate.left,
        top: candidate.top,
        right: candidate.left + bubbleWidth,
        bottom: candidate.top + bubbleHeight,
      }
      const outside = rectangle.left < margin || rectangle.top < margin
        || rectangle.right > width - margin || rectangle.bottom > height - margin
      const faceOverlap = headRegions.reduce((total, region) => total + overlapArea(rectangle, region), 0) / bubbleArea
      const bodyOverlap = bodyRegions.reduce((total, region) => total + overlapArea(rectangle, region), 0) / bubbleArea
      const distance = Math.hypot(rectangle.left + bubbleWidth / 2 - centerX, rectangle.top + bubbleHeight / 2 - headY) / diagonal
      const sidePenalty = preferredSide && candidate.className !== preferredSide ? 1_000 : 0
      return {
        ...candidate,
        score: (outside ? 10_000 : 0) + faceOverlap * 1_500 + bodyOverlap * 30 + distance * 20 + candidate.priority * 3 + sidePenalty,
      }
    })
    .sort((first, second) => first.score - second.score)[0]

  const snappedLeft = Math.round(winner.left / 8) * 8
  const snappedTop = Math.round(winner.top / 8) * 8
  return {
    className: winner.className,
    left: snappedLeft,
    top: snappedTop,
    width: bubbleWidth,
    height: bubbleHeight,
    anchor,
    tether: tetherPoint(winner.className, snappedLeft, snappedTop, bubbleWidth, bubbleHeight, anchor),
  }
}

function App() {
  const [data, setData] = useState<DemoData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [jobId, setJobId] = useState('')
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null)
  const [uploading, setUploading] = useState(false)
  const [localVideo, setLocalVideo] = useState('')
  const [rendering, setRendering] = useState(false)
  const [downloadUrl, setDownloadUrl] = useState('')
  const [currentTime, setCurrentTime] = useState(0)
  const [currentFrame, setCurrentFrame] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [activeSpeaker, setActiveSpeaker] = useState('')
  const [mapping, setMapping] = useState<Mapping>({})
  const [playingSnippet, setPlayingSnippet] = useState(false)
  const [preview, setPreview] = useState(false)
  const [videoReady, setVideoReady] = useState(false)
  const [speakerEffect, setSpeakerEffect] = useState<SpeakerEffect>('spotlight')
  const videoRef = useRef<VideoRef>(null)
  const effectCanvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const snippetEnd = useRef<number | null>(null)

  useEffect(() => {
    if (!jobId || data) return
    let active = true
    const poll = async () => {
      try {
        const response = await fetch(`/api/jobs/${jobId}`)
        if (!response.ok) throw new Error(`Could not read job (${response.status})`)
        const status = await response.json() as JobStatus
        if (!active) return
        setJobStatus(status)
        if (status.phase === 'failed') throw new Error(status.error ?? 'Processing failed')
        if (status.ready) {
          const dataResponse = await fetch(`/api/jobs/${jobId}/data`)
          if (!dataResponse.ok) throw new Error('Could not load processed video data')
          const document = await dataResponse.json() as DemoData
          if (!active) return
          setData(document)
          setActiveSpeaker(document.speakers[0]?.id ?? '')
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Processing failed')
      }
    }
    void poll()
    const interval = window.setInterval(poll, 900)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [data, jobId])

  useEffect(() => () => {
    if (localVideo) URL.revokeObjectURL(localVideo)
  }, [localVideo])

  const selectedSpeaker = data?.speakers.find((speaker) => speaker.id === activeSpeaker)
  const completed = data ? Object.keys(mapping).length === data.speakers.length : false
  const turn = data ? activeTurn(data.turns, currentTime) : null
  const previewPerson = turn && data ? data.people.find((person) => person.id === mapping[turn.speaker]) : null
  const previewFrame = previewPerson ? nearestFrame(previewPerson, currentFrame, currentTime) : null
  const previewBounds = previewFrame?.bounds ?? null

  const masksByFrameAndObject = useMemo(() => {
    const records = new Map<string, SegmentationMaskRecord>()
    for (const record of data?.segmentation.records ?? []) {
      if (record.kind !== 'mask' || !record.frame) continue
      records.set(`${record.frame.frameIndex}:${record.objectId}`, record)
    }
    return records
  }, [data])

  const visiblePeople = useMemo(() => {
    if (!data) return []
    return data.people.flatMap((person, index) => {
      const frame = nearestFrame(person, currentFrame, currentTime)
      return frame ? [{ person, frame, bounds: frame.bounds, index }] : []
    })
  }, [currentFrame, currentTime, data])
  const previewChunk = turn ? captionChunk(turn, currentTime) : null
  const previewText = previewChunk?.text ?? ''
  const previewReferenceTime = previewChunk?.referenceTime
  const previewPersonId = previewPerson?.id
  const previewAnchor = previewFrame
    ? maskHeadAnchor(masksByFrameAndObject.get(`${previewFrame.frameIndex}:${previewFrame.objectId}`), previewFrame.bounds)
    : null
  let preferredSide: string | undefined
  if (data && previewPersonId && previewReferenceTime !== undefined) {
    const person = data.people.find((candidate) => candidate.id === previewPersonId)
    if (person) {
      const referenceFrameIndex = Math.round(previewReferenceTime * data.analysisFps)
      const referenceFrame = nearestFrame(person, referenceFrameIndex, previewReferenceTime)
      if (referenceFrame) {
        const referenceAnchor = maskHeadAnchor(
          masksByFrameAndObject.get(`${referenceFrame.frameIndex}:${referenceFrame.objectId}`),
          referenceFrame.bounds,
        )
        const peopleAtReference = data.people.flatMap((candidate) => {
          const frame = nearestFrame(candidate, referenceFrameIndex, previewReferenceTime)
          return frame ? [frame.bounds] : []
        })
        preferredSide = bubblePlacement(
          referenceFrame.bounds,
          referenceAnchor,
          peopleAtReference,
          data.width,
          data.height,
          previewText,
        ).className
      }
    }
  }
  const previewPlacement = previewBounds && previewAnchor && data
    ? bubblePlacement(
      previewBounds,
      previewAnchor,
      visiblePeople.map(({ bounds }) => bounds),
      data.width,
      data.height,
      previewText,
      preferredSide,
    )
    : null

  const hiddenObjectIds = useMemo(() => {
    if (!data || !preview) return []
    const objectIds = new Set(
      data.segmentation.records.flatMap((record) => 'objectId' in record ? [record.objectId] : []),
    )
    return [...objectIds]
  }, [data, preview])

  useEffect(() => {
    const canvas = effectCanvasRef.current
    if (!canvas || !data) return
    canvas.width = data.width
    canvas.height = data.height
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    if (!preview || speakerEffect === 'none' || !previewFrame) return
    const record = masksByFrameAndObject.get(`${previewFrame.frameIndex}:${previewFrame.objectId}`)
    if (!record?.bounds) return

    const raster = decodeMaskToRaster(record.mask)
    const maskCanvas = document.createElement('canvas')
    maskCanvas.width = record.mask.width
    maskCanvas.height = record.mask.height
    const maskContext = maskCanvas.getContext('2d')
    if (!maskContext) return
    const pixels = maskContext.createImageData(maskCanvas.width, maskCanvas.height)
    const color = colorAt(data.speakers.findIndex((speaker) => speaker.id === turn?.speaker))
    const numericColor = Number.parseInt(color.slice(1), 16)
    for (let index = 0; index < raster.length; index += 1) {
      if (raster[index] === 0) continue
      const offset = index * 4
      pixels.data[offset] = (numericColor >> 16) & 255
      pixels.data[offset + 1] = (numericColor >> 8) & 255
      pixels.data[offset + 2] = numericColor & 255
      pixels.data[offset + 3] = 255
    }
    maskContext.putImageData(pixels, 0, 0)
    const { left, top } = record.bounds

    if (speakerEffect === 'spotlight') {
      context.fillStyle = 'rgba(12, 16, 22, 0.34)'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.globalCompositeOperation = 'destination-out'
      context.drawImage(maskCanvas, left, top)
    } else if (speakerEffect === 'halo') {
      context.save()
      context.filter = `blur(${Math.max(8, Math.round(data.height * 0.025))}px)`
      context.globalAlpha = 0.88
      context.drawImage(maskCanvas, left, top)
      context.restore()
      context.globalCompositeOperation = 'destination-out'
      context.drawImage(maskCanvas, left, top)
    } else {
      context.globalAlpha = 0.28
      context.drawImage(maskCanvas, left, top)
    }
    context.globalAlpha = 1
    context.globalCompositeOperation = 'source-over'
  }, [data, masksByFrameAndObject, preview, previewFrame, speakerEffect, turn?.speaker])

  function playSample(speaker: Speaker) {
    const video = videoRef.current
    setActiveSpeaker(speaker.id)
    if (!video || !videoReady) return
    snippetEnd.current = speaker.snippetEnd
    setPlayingSnippet(true)
    void video.seek(speaker.snippetStart).then(() => video.play()).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Could not play the sample')
    })
  }

  function assignPerson(personId: string) {
    if (!data || !activeSpeaker) return
    const next = { ...mapping }
    for (const [speakerId, mappedPerson] of Object.entries(next)) {
      if (mappedPerson === personId && speakerId !== activeSpeaker) delete next[speakerId]
    }
    next[activeSpeaker] = personId
    setMapping(next)
    videoRef.current?.pause()
    setPlayingSnippet(false)
    snippetEnd.current = null
    const nextSpeaker = data.speakers.find((speaker) => !next[speaker.id])
    if (nextSpeaker) {
      playSample(nextSpeaker)
    }
  }

  function resetMapping() {
    if (!data) return
    setMapping({})
    setPreview(false)
    setActiveSpeaker(data.speakers[0]?.id ?? '')
  }

  function showPreview() {
    if (!data || !completed) return
    setPreview(true)
    const firstTurn = data.turns[0]
    if (videoRef.current && firstTurn) {
      void videoRef.current.seek(firstTurn.start).then(() => videoRef.current?.play())
    }
  }

  function handleTimeUpdate(time: number) {
    setCurrentTime(time)
    if (snippetEnd.current !== null && time >= snippetEnd.current) {
      videoRef.current?.pause()
      snippetEnd.current = null
      setPlayingSnippet(false)
    }
  }

  async function uploadVideo(file: File) {
    if (!file.type.startsWith('video/')) {
      setError('Choose a video file.')
      return
    }
    setError(null)
    setUploading(true)
    setData(null)
    setMapping({})
    setPreview(false)
    setVideoReady(false)
    setDownloadUrl('')
    const previewUrl = URL.createObjectURL(file)
    setLocalVideo(previewUrl)
    try {
      const body = new FormData()
      body.append('video', file)
      const response = await fetch('/api/jobs', { method: 'POST', body })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Upload failed')
      setJobId(result.id)
      setJobStatus(result)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function renderDownload() {
    if (!jobId || rendering) return
    setRendering(true)
    setError(null)
    try {
      const response = await fetch(`/api/jobs/${jobId}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapping, effect: speakerEffect }),
      })
      if (!response.ok) throw new Error('Could not start video rendering')
      for (;;) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000))
        const statusResponse = await fetch(`/api/jobs/${jobId}`)
        const status = await statusResponse.json() as JobStatus
        setJobStatus(status)
        if (status.renderState === 'ready') {
          setDownloadUrl(`/api/jobs/${jobId}/download`)
          break
        }
        if (status.renderState === 'failed') throw new Error(status.error ?? 'Rendering failed')
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Rendering failed')
    } finally {
      setRendering(false)
    }
  }

  function startOver() {
    setData(null)
    setJobId('')
    setJobStatus(null)
    setMapping({})
    setPreview(false)
    setDownloadUrl('')
    setError(null)
    setCurrentFrame(0)
    setCurrentTime(0)
    setVideoReady(false)
    setLocalVideo('')
  }

  if (!data) {
    const processing = Boolean(jobId)
    return <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup"><span className="brand-mark" aria-hidden="true">S3</span><div><strong>Speaker Mapping</strong><span>SAM 3 + Muse Voice</span></div></div>
        {processing && <button type="button" className="secondary-button compact-button" onClick={startOver}>New video</button>}
      </header>
      <section className={`upload-workspace ${processing ? 'is-processing' : ''}`}>
        <div className="upload-preview">
          {localVideo ? <video src={localVideo} controls /> : <div className="empty-preview"><FileVideo size={38} /><span>No video selected</span></div>}
        </div>
        <aside className="upload-panel">
          {!processing ? <>
            <span className="section-index">01 / UPLOAD</span>
            <h1>Choose a conversation video</h1>
            <input ref={fileInputRef} type="file" accept="video/*" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadVideo(file) }} />
            <button type="button" className="upload-dropzone" disabled={uploading} onClick={() => fileInputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void uploadVideo(file) }}>
              {uploading ? <LoaderCircle className="spin" size={26} /> : <Upload size={26} />}
              <strong>{uploading ? 'Uploading…' : 'Select or drop a video'}</strong>
              <span>MP4, MOV or WebM · up to 500 MB</span>
            </button>
          </> : <>
            <span className="section-index">02 / ANALYZE</span>
            <h1>{jobStatus?.message ?? 'Starting analysis'}</h1>
            <div className="progress-track"><span style={{ width: `${jobStatus?.progress ?? 5}%` }} /></div>
            <div className="processing-steps">
              <ProcessingStep label="Transcribe and diarize" detail="Muse Voice" state={jobStatus?.steps.transcript ?? 'running'} />
              <ProcessingStep label="Segment and track people" detail="SAM 3" state={jobStatus?.steps.sam ?? 'running'} />
              <ProcessingStep label="Prepare speaker mapping" detail="Local layout" state={jobStatus?.steps.prepare ?? 'pending'} />
            </div>
            {jobStatus?.transcript.length ? <div className="live-transcript"><span>TRANSCRIPT READY</span>{jobStatus.transcript.slice(0, 3).map((turn) => <p key={`${turn.speaker}-${turn.startMs}`}><strong>{turn.speaker}</strong>{turn.transcript}</p>)}</div> : null}
          </>}
          {error && <p className="error-message">{error}</p>}
        </aside>
      </section>
    </main>
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">S3</span>
          <div><strong>Speaker Mapping</strong><span>SAM 3 + Muse Voice</span></div>
        </div>
        <div className="topbar-actions"><div className="run-status"><span className="status-dot" />{data.speakers.length} voices · {data.people.length} people · {formatTime(data.duration)}</div><button type="button" className="secondary-button compact-button" onClick={startOver}>New video</button></div>
      </header>

      <div className="workspace">
        <section className="video-pane" aria-label="Video calibration">
          <div className="section-heading">
            <div><span className="section-index">01 / VIDEO</span><h1>{preview ? 'Caption preview' : `Map ${selectedSpeaker?.label}`}</h1></div>
            {!preview && <span className="instruction">Play the sample, then select the speaker.</span>}
          </div>

          <div className={`video-stage ${preview ? 'is-preview' : ''}`} style={{ aspectRatio: `${data.width} / ${data.height}` }}>
            <Video
              key={data.video}
              ref={videoRef}
              src={data.video}
              result={data.segmentation}
              hiddenIds={hiddenObjectIds}
              objectFit="contain"
              initialSeekTime={data.speakers[0]?.snippetStart ?? 0}
              className="sam-video"
              canvasProps={{ role: 'img', 'aria-label': 'Conversation video with SAM 3 person masks' }}
              onTimeChange={handleTimeUpdate}
              onFrame={({ time, frameIndex }) => {
                setCurrentTime(time)
                setCurrentFrame(frameIndex)
              }}
              onPlayingChange={(playing) => {
                setIsPlaying(playing)
                if (!playing) setPlayingSnippet(false)
              }}
              onLoadedMetadata={() => setVideoReady(true)}
              onError={(reason) => setError(reason.message)}
            />
            <canvas ref={effectCanvasRef} className="speaker-effect-canvas" aria-hidden="true" />
            <button
              type="button"
              className="stage-play-button"
              disabled={!videoReady}
              onClick={() => {
                if (!videoRef.current) return
                if (isPlaying) videoRef.current.pause()
                else void videoRef.current.play()
              }}
              aria-label={isPlaying ? 'Pause video' : 'Play video'}
              title={isPlaying ? 'Pause video' : 'Play video'}
            >
              {isPlaying ? <Pause size={17} /> : <Play size={17} />}
            </button>
            {!preview && visiblePeople.map(({ person, bounds, index }) => {
              const [left, top, right, bottom] = bounds
              const assignedSpeaker = Object.entries(mapping).find(([, id]) => id === person.id)?.[0]
              return (
                <button
                  type="button"
                  className={`track-box ${mapping[activeSpeaker] === person.id ? 'is-selected' : ''}`}
                  key={person.id}
                  style={{
                    left: `${(left / data.width) * 100}%`, top: `${(top / data.height) * 100}%`,
                    width: `${((right - left) / data.width) * 100}%`, height: `${((bottom - top) / data.height) * 100}%`,
                    '--track-color': objectColor(person.trackIds[0] ?? String(index)),
                  } as React.CSSProperties}
                  onClick={() => assignPerson(person.id)}
                  aria-label={`Select tracked ${person.label} as ${selectedSpeaker?.label}`}
                >
                  <span>{index + 1}</span><small>{assignedSpeaker ? `Speaker ${assignedSpeaker}` : person.label}</small>
                </button>
              )
            })}
            {preview && turn && previewPlacement && (
              <>
                {previewPlacement.tether && <svg className="caption-tether" viewBox={`0 0 ${data.width} ${data.height}`} preserveAspectRatio="none" aria-hidden="true">
                  <line x1={previewPlacement.tether.x} y1={previewPlacement.tether.y} x2={previewPlacement.anchor.x} y2={previewPlacement.anchor.y} />
                  <circle cx={previewPlacement.anchor.x} cy={previewPlacement.anchor.y} r="3" />
                </svg>}
                <div className={`caption-bubble ${previewPlacement.className}`} style={{
                  left: `${(previewPlacement.left / data.width) * 100}%`,
                  top: `${(previewPlacement.top / data.height) * 100}%`,
                  width: `${(previewPlacement.width / data.width) * 100}%`,
                  '--speaker-color': colorAt(data.speakers.findIndex((speaker) => speaker.id === turn.speaker)),
                } as React.CSSProperties}>
                  <span>Speaker {turn.speaker}</span>{previewText}
                </div>
              </>
            )}
          </div>

          <div className="timeline" aria-label="Diarized speaker timeline">
            <div className="timeline-labels"><span>{formatTime(currentTime)}</span><span>DIARIZED TURNS</span><span>{formatTime(data.duration)}</span></div>
            <div className="timeline-track">
              {data.turns.map((item, index) => (
                <button type="button" key={`${item.speaker}-${item.start}`} className="turn-segment" title={`Speaker ${item.speaker}: ${item.text}`}
                  style={{ left: `${(item.start / data.duration) * 100}%`, width: `${((item.end - item.start) / data.duration) * 100}%`, background: colorAt(data.speakers.findIndex((speaker) => speaker.id === item.speaker)), zIndex: data.turns.length - index }}
                  onClick={() => { if (videoRef.current) void videoRef.current.seek(item.start) }} aria-label={`Seek to Speaker ${item.speaker} at ${formatTime(item.start)}`} />
              ))}
              <span className="playhead" style={{ left: `${(currentTime / data.duration) * 100}%` }} />
            </div>
          </div>
        </section>

        <aside className="mapping-pane">
          <div className="section-heading compact">
            <div><span className="section-index">02 / {preview ? 'PREVIEW' : 'CALIBRATE'}</span><h2>{preview ? 'Speaker map' : 'Match each voice'}</h2></div>
            <span className="progress-count">{Object.keys(mapping).length}/{data.speakers.length}</span>
          </div>

          {!preview ? <>
            <div className="speaker-list">
              {data.speakers.map((speaker, index) => {
                const person = data.people.find((candidate) => candidate.id === mapping[speaker.id])
                const active = activeSpeaker === speaker.id
                return (
                  <button type="button" className={`speaker-row ${active ? 'is-active' : ''}`} key={speaker.id} onClick={() => playSample(speaker)}>
                    <span className="speaker-token" style={{ background: colorAt(index) }}>{speaker.id}</span>
                    <span className="speaker-copy"><strong>{speaker.label}</strong><small>{person ? person.label : 'Not mapped'}</small></span>
                    {person ? <CheckCircle2 size={19} /> : active && playingSnippet ? <Pause size={18} /> : <Play size={18} />}
                  </button>
                )
              })}
            </div>

            {selectedSpeaker && <section className="sample-panel" aria-live="polite">
              <div className="sample-meta"><span>VOICE SAMPLE · {formatTime(selectedSpeaker.snippetStart)}</span><button type="button" className="icon-button" onClick={() => playSample(selectedSpeaker)} title="Replay sample"><Play size={17} /></button></div>
              <blockquote>“{selectedSpeaker.sampleText}”</blockquote>
            </section>}

            <div className="people-legend">
              <span><Users size={16} /> PEOPLE IN VIDEO</span>
              {data.people.map((person, index) => {
                const assigned = Object.entries(mapping).find(([, id]) => id === person.id)?.[0]
                return <button
                  type="button"
                  key={person.id}
                  className="person-choice"
                  onClick={() => assignPerson(person.id)}
                  aria-label={`Assign ${person.label} to ${selectedSpeaker?.label}`}
                >
                  <i style={{ background: objectColor(person.trackIds[0] ?? String(index)) }}>{index + 1}</i><span>{person.label}</span><small>{assigned ? `Speaker ${assigned}` : 'Available'}</small>
                </button>
              })}
            </div>

            <div className="action-bar">
              <button type="button" className="secondary-button" onClick={resetMapping} disabled={!Object.keys(mapping).length}><RotateCcw size={17} /> Reset</button>
              <button type="button" className="primary-button" onClick={showPreview} disabled={!completed}><Check size={18} /> Preview captions</button>
            </div>
          </> : <>
            <div className="mapping-summary">
              {data.speakers.map((speaker, index) => {
                const person = data.people.find((candidate) => candidate.id === mapping[speaker.id])
                return <div className="summary-row" key={speaker.id}><span className="speaker-token" style={{ background: colorAt(index) }}>{speaker.id}</span><span><strong>{speaker.label}</strong><small>{person?.label}</small></span><Check size={18} /></div>
              })}
            </div>
            <div className="preview-status"><CheckCircle2 size={24} /><strong>Mapping complete</strong><span>Captions now follow the assigned SAM tracks.</span></div>
            <section className="effect-panel" aria-label="Active speaker effect">
              <span>ACTIVE SPEAKER EFFECT</span>
              <div className="effect-options">
                {speakerEffects.map((effect) => <button
                  type="button"
                  key={effect.id}
                  className={speakerEffect === effect.id ? 'is-active' : ''}
                  aria-pressed={speakerEffect === effect.id}
                  onClick={() => setSpeakerEffect(effect.id)}
                >{effect.label}</button>)}
              </div>
            </section>
            {error && <p className="error-message">{error}</p>}
            <div className="action-bar preview-actions">
              <button type="button" className="secondary-button" onClick={() => setPreview(false)}><ArrowLeft size={17} /> Edit mapping</button>
              <button type="button" className="primary-button" onClick={() => { if (!videoRef.current) return; void videoRef.current.seek(0).then(() => videoRef.current?.play()) }}><Play size={18} /> Play from start</button>
              {downloadUrl
                ? <a className="primary-button" href={downloadUrl} download><Download size={18} /> Download MP4</a>
                : <button type="button" className="primary-button" onClick={() => void renderDownload()} disabled={rendering}>{rendering ? <LoaderCircle className="spin" size={18} /> : <Download size={18} />}{rendering ? 'Rendering…' : 'Render video'}</button>}
            </div>
          </>}
        </aside>
      </div>
    </main>
  )
}

export default App
