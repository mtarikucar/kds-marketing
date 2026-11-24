# Composed posts: rendering slides and story frames

Content agents no longer hand the owner one AI-generated poster per post. A post is built from
the workspace's **real photo materials**, laid out by a **fixed template**, with its short texts
**drawn by the server** (image models misspell Turkish; the server draws exactly the text it is
given). This page tells a content agent how to use the four tools and what they refuse.

| Tool | Permission | What it does |
|---|---|---|
| `jeeta.studio.post_templates` | `content.work` | Templates, slots and limits; the brand tokens; the render history and the cover to use next |
| `jeeta.studio.post_render` | `content.work` | Renders one slide or story frame, stores it and adds it to the library |
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
- `material.id`: a post proposal's material (`jeeta.studio.posts_propose`).

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
