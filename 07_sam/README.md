# Segment Anything Model 3 (SAM 3)

Maps to the **SAM 3** section of the [Cookbook page](https://dev.meta.ai/docs/cookbook#sam-3).
Recipes for building with [SAM 3](https://dev.meta.ai/docs/sam/overview), the
segmentation model on the Meta Model API. You name what you want in a short noun
phrase and the model returns pixel masks for every match, holding each object's
identity across a whole video.

[Media segmentation](https://dev.meta.ai/docs/media-segmentation) covers the
capability end to end, [Segmenting with prompts](https://dev.meta.ai/docs/sam/segmenting)
explains how to phrase a request, and [Reading segmentation output](https://dev.meta.ai/docs/sam/reading-segmentation)
describes the record format these recipes parse. The recipes below turn those
masks and video tracks into finished applications.

## Recipes

| # | Recipe | What it does |
|---|---|---|
| 01 | [SAM API basics](01_api_basics/) | Segment images and videos in Python or TypeScript with the official `meta-sam` parsers. |
| 02 | [Video to animated sticker pack](02_video_to_sticker_pack/) | Track an animal through a video and export transparent, messaging-ready animated stickers. |
| 03 | [Multi-speaker headlocked captions](03_headlocked_speech_bubble_captions/) | Upload a conversation, map diarized voices to SAM-tracked people, and download the captioned video. |
