# Segment Anything Model (SAM) API basics in Python and TypeScript

|                      |                                                                         |
| -------------------- | ----------------------------------------------------------------------- |
| **Section**          | [Segment Anything Model](https://dev.meta.ai/docs/cookbook/sam)         |
| **Docs**             | [Segmenting with prompts](https://dev.meta.ai/docs/sam/segmenting) · [Reading segmentation output](https://dev.meta.ai/docs/sam/reading-segmentation) · [Client libraries](https://dev.meta.ai/docs/sam/client-libraries) |
| **Time to complete** | ~15 min                                                                 |
| **Model**            | `sam-3.1`                                                         |
| **Languages**        | Python and TypeScript                                                   |
| **Prerequisites**    | Python 3.10+ or Node.js 20.17+, a local image or MP4, and a `MODEL_API_KEY` (create one in the [Model API dashboard](https://dev.meta.ai/)) |

These small examples show the two hosted SAM API request paths without the UI
and orchestration of the full
[API Playground](https://github.com/meta-models/meta-sam/tree/main/typescript/examples/api-playground):

- **Image:** send a local image as a data URL, stream the response, and parse it
  with the official `meta-sam` parser.
- **Video:** upload an MP4 with `purpose=user_data`, stream segmentation events,
  and parse cumulative frame and track records.

Both languages produce the same JSON summary and browser-viewable SVG mask
files. The code sends one short noun phrase per request; pass multiple concepts
to run separate requests and combine their summaries in application code.

## Setup

```bash
cd 07_sam/01_api_basics
export MODEL_API_KEY="your-model-api-key"
```

Python:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

TypeScript:

```bash
npm install
```

Both languages call the API through the official OpenAI SDK (`openai`) and decode
the output with the Segment Anything Model parser: `meta_sam_parser` in Python and
`@meta-sam/parser` in TypeScript. Both implement the same SAM 3 output protocol and
validate masks before exposing them.

The bundled `ducks.jpg` and `pingpong.mp4` are the same public test media used
by the API Playground. In the verified run, `duck` returned five masks and
`ping pong ball` returned one stable object across all 134 video frames.

## 1. Segment an image

Python:

```bash
python python/01_segment_image.py assets/ducks.jpg \
  --concept duck \
  --output output/python-image
```

TypeScript:

```bash
npx tsx typescript/01-segment-image.ts assets/ducks.jpg \
  --concept duck \
  --output output/typescript-image
```

Add another `--concept` to issue a separate request for another noun phrase:

```bash
python python/01_segment_image.py assets/ducks.jpg \
  --concept duck --concept water \
  --output output/python-multiple-concepts
```

Both image and video requests stream over the Responses API through the OpenAI
SDK; the parser decodes the streamed segmentation grammar. The example code never
parses the model's text grammar itself.

## 2. Upload and segment a video

Python:

```bash
python python/02_upload_and_segment_video.py assets/pingpong.mp4 \
  --concept "ping pong ball" \
  --output output/python-video
```

TypeScript:

```bash
npx tsx typescript/02-upload-and-segment-video.ts assets/pingpong.mp4 \
  --concept "ping pong ball" \
  --output output/typescript-video
```

Pass `--file-id file-...` to reuse a prior upload. Video requests use
`stream: true`; each parser snapshot is cumulative, while the final result
contains the complete frame and object history.

## Output

Each command writes:

| File           | Purpose                                                                         |
| -------------- | ------------------------------------------------------------------------------- |
| `summary.json` | Outcome, typed record counts, boxes, decoded masks, and track visibility ranges |
| `mask-*.svg`   | One decoded, browser-viewable mask per returned object and frame                |

For example, the image command prints a progress line and writes the files:

```text
$ python python/01_segment_image.py assets/ducks.jpg --concept duck --output output/python-image
Segmenting 'duck'...
Wrote 1 result(s) and 5 mask(s) to output/python-image
```

`summary.json` (abbreviated — one of the five records shown, from a real `sam-3.1` run):

```json
[
  {
    "concept": "duck",
    "media": "image",
    "outcome": "completed",
    "records": 10,
    "boxes": [
      { "object_id": "0", "frame": null, "left": 751, "top": 290, "right": 925, "bottom": 493 }
    ],
    "masks": [
      { "object_id": "0", "frame": null, "encoding": "lossless", "width": 174, "height": 203, "foreground_pixels": 10063 }
    ],
    "tracks": [],
    "diagnostics": []
  }
]
```

The examples fail clearly on HTTP errors, refusals, failed responses, malformed
parser records, and incomplete responses. A completed request with zero masks is
reported as a valid empty match, not an API error.

## What to copy next

| Developer task                              | Starting point                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| Segment a local image                       | `01_segment_image.py` or `01-segment-image.ts`                                 |
| Upload and stream a local video             | `02_upload_and_segment_video.py` or `02-upload-and-segment-video.ts`           |
| Inspect boxes, masks, and track IDs         | `summarize_result` or `summarizeResult` in the shared helper                   |
| Handle empty, incomplete, and failed output | `validate_result` or `validateResult` in the shared helper                     |
| Query multiple concepts                     | Repeat `--concept`; the scripts intentionally make one request per noun phrase |

Use the API Playground when you need interactive overlays, playback controls, or
React integration. These files are intentionally smaller copy-and-combine
building blocks.
