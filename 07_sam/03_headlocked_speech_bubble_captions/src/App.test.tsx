// Copyright (c) Meta Platforms, Inc. and affiliates.
// All rights reserved.
//
// This source code is licensed under the license found in the
// LICENSE file in the root directory of this source tree.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

vi.mock('@meta-sam/graphics', () => ({
  SegmentationRenderer: class {
    dispose() {}
  },
  objectColor: () => '#1677ff',
}))

vi.mock('@meta-sam/parser', () => ({
  decodeMaskToRaster: () => new Uint8Array(),
}))

vi.mock('@meta-sam/react', async () => {
  const React = await import('react')
  return {
    Video: React.forwardRef(function MockVideo(props: Record<string, unknown>, ref) {
      const elementRef = React.useRef<HTMLVideoElement>(null)
      React.useImperativeHandle(ref, () => ({
        play: async () => { (props.onPlayingChange as ((playing: boolean) => void) | undefined)?.(true) },
        pause: () => { (props.onPlayingChange as ((playing: boolean) => void) | undefined)?.(false) },
        seek: async (time: number) => {
          if (elementRef.current) elementRef.current.currentTime = time
          ;(props.onTimeChange as ((time: number) => void) | undefined)?.(time)
          ;(props.onFrame as ((frame: { time: number; frameIndex: number }) => void) | undefined)?.({ time, frameIndex: Math.round(time * 6) })
        },
      }))
      return <video
        ref={elementRef}
        onTimeUpdate={(event) => {
          const time = event.currentTarget.currentTime
          ;(props.onTimeChange as ((time: number) => void) | undefined)?.(time)
          ;(props.onFrame as ((frame: { time: number; frameIndex: number }) => void) | undefined)?.({ time, frameIndex: Math.round(time * 6) })
        }}
      />
    }),
  }
})

const demo = {
  video: '/multi-speaker.mp4',
  duration: 60,
  width: 854,
  height: 480,
  analysisFps: 6,
  speakers: [
    { id: 'A', label: 'Speaker A', snippetStart: 1, snippetEnd: 4, sampleText: 'First sample' },
    { id: 'B', label: 'Speaker B', snippetStart: 30, snippetEnd: 34, sampleText: 'Second sample' },
  ],
  people: [
    { id: 'person-1', label: 'Person 1', prompt: 'people', trackIds: ['1'], frames: [{ frameIndex: 6, time: 1, objectId: '1', bounds: [151, 44, 348, 422] }, { frameIndex: 78, time: 13, objectId: '1', bounds: [151, 44, 348, 422] }] },
    { id: 'person-2', label: 'Person 2', prompt: 'people', trackIds: ['2'], frames: [{ frameIndex: 6, time: 1, objectId: '2', bounds: [493, 56, 687, 418] }, { frameIndex: 78, time: 13, objectId: '2', bounds: [493, 56, 687, 418] }, { frameIndex: 180, time: 30, objectId: '2', bounds: [200, 30, 706, 480] }] },
  ],
  turns: [
    { speaker: 'A', start: 0, end: 29, text: 'First person speaking' },
    { speaker: 'B', start: 30, end: 59, text: 'Second person speaking' },
  ],
  segmentation: { media: 'video', revision: 1, records: [], diagnostics: [], rawOutput: '', outcome: { status: 'completed' } },
}

describe('speaker mapping', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/data')) return { ok: true, json: async () => demo }
      return {
        ok: true,
        json: async () => ({
          id: 'job-1', filename: 'sample.mp4', phase: 'ready', progress: 100,
          message: 'Ready', steps: { transcript: 'done', sam: 'done', prepare: 'done' },
          transcript: [], ready: true, renderState: 'idle', error: null,
        }),
      }
    }))
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:video'), revokeObjectURL: vi.fn() })
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  })

  async function uploadAndOpen() {
    const view = render(<App />)
    const input = view.container.querySelector('input[type="file"]')
    expect(input).not.toBeNull()
    if (input) fireEvent.change(input, { target: { files: [new File(['video'], 'sample.mp4', { type: 'video/mp4' })] } })
    await screen.findByRole('heading', { name: 'Map Speaker A' })
    return view
  }

  it('maps each diarized voice to one visual track', async () => {
    await uploadAndOpen()

    fireEvent.click(screen.getByRole('button', { name: 'Assign Person 1 to Speaker A' }))
    expect(screen.getByRole('heading', { name: 'Map Speaker B' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Assign Person 2 to Speaker B' }))
    const preview = screen.getByRole('button', { name: 'Preview captions' })
    expect(preview).toBeEnabled()

    fireEvent.click(preview)
    expect(screen.getByRole('heading', { name: 'Caption preview' })).toBeVisible()
    expect(screen.getByText('Mapping complete')).toBeVisible()
  })

  it('renders the number of people supplied by the API data', async () => {
    const expandedDemo = {
      ...demo,
      people: [
        ...demo.people,
        { id: 'person-3', label: 'Person 3', prompt: 'people', trackIds: ['3'], frames: [{ frameIndex: 6, time: 1, objectId: '3', bounds: [300, 10, 450, 400] }] },
      ],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/data')) return { ok: true, json: async () => expandedDemo }
      return { ok: true, json: async () => ({ id: 'job-1', phase: 'ready', ready: true, steps: {}, transcript: [] }) }
    }))

    const { container } = await uploadAndOpen()

    expect(container.querySelectorAll('.person-choice')).toHaveLength(3)
    expect(screen.getByText(/2 voices · 3 people/)).toBeVisible()
  })

  it('uses the caption rail when side placement would cover another face', async () => {
    const { container } = await uploadAndOpen()
    fireEvent.click(screen.getByRole('button', { name: 'Assign Person 1 to Speaker A' }))
    fireEvent.click(screen.getByRole('button', { name: 'Assign Person 2 to Speaker B' }))
    fireEvent.click(screen.getByRole('button', { name: 'Preview captions' }))

    const video = container.querySelector('video')
    expect(video).not.toBeNull()
    if (video) {
      video.currentTime = 13
      fireEvent.timeUpdate(video)
    }

    expect(container.querySelector('.caption-bubble')).toHaveClass('is-rail')
  })
})
