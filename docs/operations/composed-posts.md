# Composed posts: rendering slides and story frames

Content agents no longer hand the owner one AI-generated poster per post. A post is built from
the workspace's **real photo materials**, laid out by a **fixed template**, with its short texts
**drawn by the server** (image models misspell Turkish; the server draws exactly the text it is
given). This page tells a content agent how to use the five tools and what they refuse; the
fifth, the photo reel, is a short vertical video made the same way ([Photo reels](#photo-reels)).

| Tool | Permission | What it does |
|---|---|---|
| `jeeta.studio.post_templates` | `content.work` | Templates, slots and limits; the brand tokens; the render history and the cover to use next |
| `jeeta.studio.post_render` | `content.work` | Renders one slide or story frame, stores it and adds it to the library |
| `jeeta.studio.reel_render` | `content.work` | Renders a photo reel (a vertical MP4 of 3 to 8 photos), stores it and adds it to the library |
| `jeeta.studio.brand_get` | `content.work` or `content.manage` | The workspace's brand tokens, as set and as drawn |
| `jeeta.studio.brand_set` | `content.manage` | Replaces the brand tokens at their revision |

None of them needs an approved strategy; all need an active workspace. There is no panel screen
for them yet.

## Templates

Slides are 1080 x 1350 (a carousel), story frames 1080 x 1920. Each role has at least two
variants that differ in composition, not only in colour:

| Role | Frame | Variants | Slots |
|---|---|---|---|
| `cover` | slide | `full_bottom`, `full_top`, `framed_dark` | `photo`, `heading`, `line` |
| `second_cover` | slide | `pair_top`, `pair_bottom` | `photo_1`, `photo_2`, `heading`, `line` |
| `steps` | slide | `photo_top`, `photo_bottom` | `photo`, `heading`, `step_1`..`step_3` |
| `closeup` | slide | `card_bottom`, `card_top` | `photo`, `label`, `heading`, `line` |
| `items` | slide | `columns`, `rows` | `heading`, `photo_n`, `name_n`, `line_n`, `price_n` (n = 1, 2), `note` |
| `cta` | slide | `photos_top`, `photos_bottom` | `photo_1`, `photo_2`, `heading`, `line`, `site`, `slogan` |
| `moment` | story | `text_bottom`, `text_top` | `photo`, `label`, `heading`, `line` |
| `question` | story | `photo_top`, `photo_full` | `photo`, `label`, `heading` (+ an empty poll sticker area) |
| `item` | story | `card_bottom`, `framed_dark` | `photo`, `label`, `name`, `line`, `price` (+ an empty link sticker area) |

`jeeta.studio.post_templates` lists every slot with `kind` (`photo`, `text` or `price`),
`required`, and for text `max_chars`, `max_lines` and `width` at the template's size. Read it
before writing the texts.

Rules the renderer keeps:

- **Text is drawn exactly as given.** No casing is changed (write Turkish capitals yourself:
  `İ`, not `I`), nothing is shortened, clipped or shrunk. Words wrap; a line feed is a break.
- **A text that does not fit is refused**: `VALIDATION` with `details.reason` `text_overflow`,
  `slot`, `max_chars`, `max_lines` and `details.cause`: `too_long` (over `max_chars`),
  `too_many_lines` (with `lines_needed`), `word_too_wide` (one word, named in `details.word`, is
  wider than the slot on its own: use a shorter word) or `collides` (on an `item` story, a long
  `label` would run into the brand chip; `details.with` names it). Shorten that text and render
  again. A text can be under `max_chars` and still not fit (wide letters): the pixel measure
  decides.
- A character no bundled font draws is `VALIDATION` `unsupported_character`. The bundled fonts
  (Bricolage Grotesque and Figtree, SIL Open Font License 1.1) draw Turkish and `₺`; a body font
  without `₺` takes it from the other family.
- Stories keep their top and bottom 250 px free of text. A `question` or `item` story answers
  `sticker_area`: leave it empty, the platform's poll or link sticker goes there when posting.

## Photos

A photo slot takes `{material_id, focus_x?, focus_y?}`: a live, filed, **analysed** JPEG, PNG or
WebP material (not `not_shareable`, at most 25 MB stored). A material whose analysis is not
complete yet is refused with `CONFLICT` `source_not_analysed` (`details.retryable: true`;
`details.unanalysed_material_id` names it): analyse it first (it is in your work list), then render
again. For a rendered slide used as a photo, every photo it was drawn from must be analysed. What no one checked for faces, names and
marks is never drawn into a post. A brand logo not analysed yet is left out of the brand chip,
and the answer says so under `brand_fallbacks`. The focus (0 to 1 from the left and top) is the point a crop keeps in
view; the middle by default. All photos bound to an olay must be the **same** olay; genel photos
may join them.

## What a render becomes

The image is stored as a Studio file (JPEG by default; `output: "png"` on request) and added to
the library as a material in the same call, so the answer already holds what the next call
needs:

- `file.id`: a piece's medium (`jeeta.studio.piece_submit`), in slide order for a carousel.
- `material.id`: a post proposal's material (`jeeta.studio.posts_propose`), or a content area
  version's material (`jeeta.content.area_deliver`), see [The three paths](#the-three-paths).

A rendered image is never a "new material" of its olay: it opens no content area, answers no
shoot request and fills no season prompt (otherwise each render would ask for content made of
itself).

The material's origin is decided by the server, never by the caller. `material.composition`
records the renderer, role, variant and the source materials. If **any** source (a photo or the
brand logo) is AI-generated, the material is AI-generated (`ai_generated: true`, generator
`jeeta-compose`), so labelling duties still apply. It takes its sources' olay, people, `depicts`
and the most restrictive share permission; when a source has no permission, neither does the
composition, and a person decides in the panel as for any material.

JPEG is the default because Instagram's publishing API takes JPEG for feed images and story
images (the story gate refuses other image types, `story_image_jpeg_only`).

The same request key answers the same render again (another input under the same key is a
`CONFLICT`; a render erased since is `CONFLICT` `render_erased`). Rendering byte-identical output
again with a new key answers the earlier material with `reused: true`. If the brand logo changes
while a render is drawn, the render is refused (`CONFLICT` `brand_logo_changed`): call again.

A rendered material is created analysed: it takes its labels, quality, people, `depicts` and
permission from its (analysed) sources, its analysis keeps them as its own, and it never appears
as a `studio_material_analysis` item in your work list. `jeeta.studio.material_analysis_claim`
and `material_analysis_retry` refuse it (`CONFLICT` `composed_material`), so no analysis can make
it more shareable than its sources.

### A composition follows its sources

What happens to a source happens to every slide or story drawn from it, and to what was drawn
from those in turn:

- A source deleted, erased with a person, or erased by the retention rule: the composition is
  redacted with it (its file goes with the files cleanup), so it can no longer be proposed or
  published. A composition never outlives a source.
- A source's permission revoked or made `not_shareable` / `product_only`: the composition's
  permission is cleared, for a person to decide again.
- A person or a `depicts` flag added to a source after the render: the composition gets it too
  (and loses its permission), so a person's erasure finds it.

## Variety

Consecutive posts must not look alike. The render history is the library itself (every composed
material). `jeeta.studio.post_templates` answers `cover.last_variant`, `cover.next_variant` and
`last_variants` per role. A cover in the variant of the workspace's last rendered cover is
refused, `CONFLICT` `cover_variant_repeats` with `details.next_variant`, unless the call passes
`allow_repeat: true` (use it only when the owner asked for that look). Rotate the other roles'
variants too.

## Brand tokens

`background`, `ink`, `accent`, `muted` (`#rrggbb`), `heading_font` and `body_font`
(`bricolage_grotesque` or `figtree`), `brand_name` (at most 32 characters; the brand chip shows
it with its first letter, or with the logo) and `logo_material_id` (a live image material, or
null). A workspace that never set them is drawn with neutral defaults. Every text pair is checked
against WCAG AA for large text (3:1; the templates draw no text under 24 px): ink on background,
white on ink, muted on background, accent against ink. A failing pair is stored as given but
drawn with a fallback, and every answer names it under `fallbacks` / `brand_fallbacks`.
`jeeta.studio.brand_set` takes `expected_revision` from `jeeta.studio.brand_get`, and refuses a
brand name with a character no bundled font draws (`VALIDATION` `unsupported_character`).

## Example: a three-slide carousel

```text
1. jeeta.studio.post_templates {}
   -> cover.next_variant = "full_top", slots and limits, brand
2. jeeta.studio.post_render {
     "request_key": "carousel-2026-11-24-cover",
     "role": "cover", "variant": "full_top",
     "texts": {"heading": "Sabah ışığında küçük bir masa.", "line": "Yeni düzen · el yapımı"},
     "photos": {"photo": {"material_id": "<anchor photo>", "focus_y": 0.6}},
     "counter": {"index": 1, "total": 3}
   } -> {file: {id: F1}, material: {id: M1}, ai_generated: false, ...}
3. jeeta.studio.post_render { ..."role": "steps", "variant": "photo_top",
     "texts": {"heading": "...", "step_1": "...", "step_2": "..."},
     "photos": {"photo": {"material_id": "<detail photo>"}}, "counter": {"index": 2, "total": 3} }
   -> F2 / M2
4. jeeta.studio.post_render { ..."role": "cta", "variant": "photos_bottom", ... "counter": {"index": 3, "total": 3} }
   -> F3 / M3
5. jeeta.studio.piece_submit for the carousel slot with media [F1, F2, F3] in order
   (or jeeta.studio.posts_propose with material_ids [M1, M2, M3], format carousel).
```

If step 2 answers `text_overflow` for `heading`, shorten the heading and call again with a new
request key. If it answers `cover_variant_repeats`, render the `details.next_variant` instead.

## The three paths

A rendered image is used exactly like an uploaded photo of the same olay, never more: it is
eligible where its photos are, and the publication fence and the source cascades above still
apply.

**1. A content area** (work item `content_area`). Render from the area's own materials and name
the area; the image is then the area's (for as long as every photo it was drawn from is), so it
is delivered by its `material.id`. No separate attach step. The brand logo drawn in its chip is the
workspace's and never needs to be one of the area's materials.

```text
jeeta.content.area_claim {project_id, expected_revision}             -> claim_token
jeeta.studio.post_render {request_key, role, variant, texts,
  photos: {photo: {material_id: <one of the area's materials>}},
  project_id: <the area>}                                             -> material.id M
jeeta.content.area_deliver {project_id, claim_token, request_key, summary,
  versions: [{format, text, material_ids: [M], hypothesis_id, ...}]}   -> the package waits for the owner
```

A photo that is not the area's is refused before drawing: `CONFLICT` `source_not_in_area`,
`details.missing` names it. Either add it first with
`jeeta.studio.project_materials {project_id, expected_revision, add: [<material ids>]}` (the area's
current `revision` from `jeeta.studio.project_get`), or choose one of the area's materials. A
delivery that names a rendered image of other photos is refused with `material_not_in_area`,
`composed: true`, `missing_sources` and a `hint`; fix it before the next delivery (three refused
deliveries hold the area for the owner).

**2. A post request** (`jeeta.studio.post_requests`).

```text
jeeta.studio.post_render {...}                                        -> material.id M
jeeta.studio.posts_propose {request_id, request_key,
  posts: [{format, capability_id, publish_at, material_ids: [M], subject, hypothesis_id}]}
```

**3. A planned slot** (`jeeta.studio.pending`, feed post, carousel or story).

```text
jeeta.studio.post_render {...}                                        -> file.id F (one per slide)
jeeta.studio.piece_submit {slot_id, expected_revision, request_key, text,
  media: [{"kind": "file", "id": F}, ...]}                             -> the slot is ready for the owner
```

A story takes one JPEG image (the default output). A carousel takes 2 to 10 images in order.

## Limits on the server

Rendering runs on the blocking thread pool, two renders at a time. A render takes its turn before
any source is read, so a waiting render holds no image; at most four wait (up to 30 s each), and
one more is refused at once with `UPSTREAM_UNAVAILABLE` `renderer_busy`: try again shortly.

A source is read only when it is at most 25 MB stored, and decoded only if it is JPEG, PNG or
WebP, at most 8000 px on a side and 24 megapixels, and its decoded size is at most 100 MB (checked
from its header, before decoding). The EXIF orientation is applied to the small resampled part,
never to the whole photo, and the photo is dropped as soon as it is drawn.

Worst case per render: the encoded sources held (at most two photos and the logo, 3 x 25 MB =
75 MB), one decoded source (at most 100 MB), a progressive JPEG decoder's working buffers (up to
about 72 MB at 24 MP), and the canvas, mask and resampled part (about 30 MB): about 280 MB, so
about 560 MB for two renders at once. A typical render (one 12 MP JPEG of a few MB) peaks near
60 MB.

## Photo reels

`jeeta.studio.reel_render` makes a short vertical video from 3 to 8 of the library's photos:
each photo slowly zooms and drifts under its caption, consecutive parts crossfade, the brand
chip sits on every photo, an optional title card opens it and an optional closing card (heading,
site, slogan) ends it. It is made the way a slide is: from the workspace's own analysed photos,
with texts drawn by the server exactly as given, in the brand tokens.

```text
jeeta.studio.post_templates {}          -> reel: limits and text slots
jeeta.studio.reel_render {
  "request_key": "reel-2026-11-25-atolye",
  "photos": [
    {"material_id": "<photo 1>", "text": "Sabah: tezgâh hazırlanıyor"},
    {"material_id": "<photo 2>", "text": "Kalıplar dökülüyor", "focus_y": 0.4},
    {"material_id": "<photo 3>"}
  ],
  "title_text": "Atölyeden bir gün",
  "closing": {"heading": "Siparişler açık", "site": "ornek.com.tr", "slogan": "Elde yapılır."},
  "photo_ms": 3000,
  "project_id": "<the content area, when the reel is for one>"
} -> {file: {id: F}, material: {id: M}, ai_generated, duration_ms, frames, formats,
      brand_fallbacks, reused, next}
```

All fields but `request_key` and `photos` are optional. Without `title_text` there is no title
card; without any `closing` text there is no closing card.

### What the file is

| | |
|---|---|
| Container | MP4, `moov` before `mdat` ("fast start"), no edit list, no fragments |
| Video | H.264 Constrained Baseline, level 4.0, 1080 x 1920, 30 fps constant, 4:2:0 (`yuv420p`), BT.709 limited range, an IDR picture every 2 s (closed GOP), about 6 Mbit/s |
| Audio | none: the file has no audio track |
| Length | each photo `photo_ms` (2500 to 4000, 3000 by default), the title card 2 s, the closing card 2.5 s, 0.4 s crossfades shared by neighbouring parts: 3 photos at 2.5 s without cards last 6.7 s, 8 photos at 4 s with both cards 32.9 s |

Instagram's Reels specification (Graph API, `IG User Media`) asks for MP4 or MOV with the `moov`
atom at the front and no edit lists, H.264 or HEVC, progressive scan, closed GOP, 4:2:0, 23 to
60 fps, at most 1920 px wide, 3 s to 15 min and at most 300 MB; it describes the audio codec
(AAC) but does not require an audio track. TikTok's Content Posting API takes MP4 (recommended),
H.264 (recommended), 23 to 60 fps, 360 to 4096 px a side, up to 10 minutes and 4 GB, and states no
audio requirement. So the reel has no audio track, not a silent one: the owner adds music in the
Instagram or TikTok app. Only a real upload proves that a platform accepts it.

### Limits and texts

`jeeta.studio.post_templates` answers `reel`: the photo count, `photo_ms`, the card and crossfade
lengths, the longest reel, the text-free bands and the text slots.

| Slot | Field in the call | Size | At most |
|---|---|---|---|
| `title` | `title_text` | heading font, 100 px | 48 characters, 4 lines |
| `caption` | `photos[n].text` | heading font, 72 px | 60 characters, 3 lines of 858 px |
| `heading` | `closing.heading` | heading font, 88 px | 44 characters, 3 lines |
| `site` | `closing.site` | 48 px | 28 characters, 1 line |
| `slogan` | `closing.slogan` | 40 px | 40 characters, 2 lines |

The templates' text rule holds: a text that does not fit is refused, `VALIDATION`
`text_overflow`, with `details.slot` naming the field (`photos.2.text`, `title_text`,
`closing.site`, ...), `max_chars`, `max_lines` and `cause`; nothing is clipped or shrunk. No text
is drawn in the top 250 px, the bottom 420 px or, for captions, the right 150 px, where Reels and
TikTok draw the account, the caption, the sound and the buttons.

### Refusals

| Code | `details.reason` | What to do |
|---|---|---|
| `VALIDATION` | `photo_count` | give 3 to 8 photos |
| `VALIDATION` | `duplicate_photo` (`details.field` is `photos.N.material_id`) | each photo once |
| `VALIDATION` | `text_overflow`, `invalid_text`, `empty_text`, `unsupported_character` | shorten or fix the named text |
| `VALIDATION` | `photo_ms_out_of_range`, `focus_out_of_range`, `title_invalid` | fix the value |
| `VALIDATION` | `source_erased`, `source_unfiled`, `source_not_image`, `source_not_shareable`, `source_too_large`, `source_restricted`, `source_not_freed`, `mixed_olays` | as for a slide's photo; a video, a reel included, is no photo |
| `VALIDATION` | `sources_too_large` | the photos and the logo take at most 100 MB stored, together |
| `VALIDATION` | `source_unreadable` | the named photo cannot be decoded |
| `CONFLICT` | `source_not_analysed` (`retryable: true`, `unanalysed_material_id`) | analyse it, then call again |
| `CONFLICT` | `source_not_in_area` (`details.missing`) | add the photos to the area, or use its own |
| `CONFLICT` | `render_erased`, `brand_logo_changed`, `duplicate_material_file`, another input under the key | as for a slide |
| `UPSTREAM_UNAVAILABLE` | `renderer_busy` | a reel is rendering and two wait already, or the wait passed 90 s: try again shortly |
| `UPSTREAM_UNAVAILABLE` | `render_timed_out` | the render passed its 150 s limit and was stopped; nothing was stored |

### What a reel becomes

A reel is a composed material exactly as a rendered slide is, and every rule of
[What a render becomes](#what-a-render-becomes) and
[A composition follows its sources](#a-composition-follows-its-sources) holds for it.
`material.composition` names the renderer `jeeta-reel`, role `reel`, variant `photo_reel`, frame
`reel` and its sources (the photos in order, then the logo, which is also named in `logo`). It
is AI-generated (generator `jeeta-reel`) when any source is. It takes its photos' olay, people,
`depicts`, labels and most restrictive permission. It is created analysed and is never analysis
work, never a new material of any trigger. It is redacted with any source, loses its permission
with any source's, takes a person or `depicts` added to a source later, becomes unusable with a
source, stays behind the publication fence, and is an area's while all its photos are (the logo
aside). The same request key answers the same reel again.

A reel's composition names a role (`reel`) and a frame (`reel`) that a build before photo reels
does not read: rolling the server back past this release after reels were made breaks reading
the library until it is rolled forward again.

### The three paths

```text
1. A content area (work item content_area)
jeeta.content.area_claim {project_id, expected_revision}            -> claim_token
jeeta.studio.reel_render {request_key, photos: [<the area's photos>], ..., project_id}
                                                                     -> material.id M
jeeta.content.area_deliver {project_id, claim_token, request_key, summary,
  versions: [{format: "reel", text, material_ids: [M], capability_id, hypothesis_id}]}
                                                                     -> the package waits for the owner

2. A post request (jeeta.studio.post_requests)
jeeta.studio.reel_render {...}                                       -> material.id M
jeeta.studio.posts_propose {request_id, request_key,
  posts: [{format: "reel", capability_id, publish_at, material_ids: [M], subject, hypothesis_id}]}

3. A planned slot (jeeta.studio.pending: a reel or a TikTok video)
jeeta.studio.reel_render {...}                                       -> file.id F
jeeta.studio.piece_submit {slot_id, expected_revision, request_key, text,
  media: [{"kind": "file", "id": F}]}                                -> the slot is ready for the owner
```

On a TikTok account the format is `tiktok_video`. A reel is also a valid Instagram story video
(3 to 60 s, fast start).

### On the server

The video is encoded by OpenH264 (Cisco's encoder, BSD-2-Clause), compiled from its source into
the `jeeta` binary by the `openh264` crate: nothing is installed on the host, no ffmpeg is used,
and no Cisco-provided binary is downloaded or loaded. The MP4 container is written by `jt_render`
itself. Cisco's patent coverage applies only to its own binary (and only for personal,
non-remunerated use), so a commercial deployment's H.264 patent position (the Via LA AVC pool) is
the operator's to settle, whichever encoder is used.

One reel renders at a time, in a queue of its own, so slides and stories are not held up; at most
two wait, each up to 90 s, and a render is stopped past 150 s. It runs on the blocking thread
pool with two encoder threads. A reel waiting for its turn holds no photo. Every text is measured
before any photo is decoded. Each photo is decoded only when its part begins, reduced at once to
a working copy 12 % larger than the frame (about 10 MB), and its encoded bytes and decoded pixels
are dropped there; at most two parts are held at once (during a crossfade), and each frame is
converted and encoded as soon as it is drawn: no frame is kept. The encoded stream is kept until
it is stored, at most 80 MB (a 33 s reel is about 20 MB).

Each frame is drawn and converted to YUV in two bands on two threads while the encoder, on a
third, encodes the frame before; three frame buffers circulate between them. OpenH264 uses its
SIMD assembly when `nasm` is present at build time (the CI test and release jobs install it; it
is a build tool, nothing on the host) and plain C otherwise, several times slower. Measured on a
8-thread laptop, release build with the assembly: 8 photos at 3 s with both cards (24.9 s, 747
frames) in 21.7 s, peak 132 MB for the whole process; 8 photos at 4 s with both cards (32.9 s,
987 frames, the longest) in 28 s, peak 136 MB. Built without the assembly, the longest took
76 s (the same file, bit for bit), still inside the 150 s limit.
