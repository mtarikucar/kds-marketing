# Jeeta brand assets

- `jeeta-mark.png`: exact copy of the existing official `frontend/public/logo-mark.png`, matching the owner-provided logo. Used in the application brand and favicon; not redrawn.
- `jeeta-welcome-560.webp`, `jeeta-welcome-840.webp`: responsive, alpha-transparent exports of a newly generated welcoming pose based on the owner-provided voxel mascot. Preserve its dark curly block hair, black sunglasses, navy suit and orange pocket square/tie clip. Display on public account screens only. Original generation remains outside the repository at `/workspace/generated_images/exec-ef14ebba-894d-4f16-89ab-024d03c2b59e.png` in the design workspace.
- `work-complete.svg`: original completed-work illustration using the brand's navy, blue and orange growth curve. Used only for the empty pending-work state.
- `jeeta-guide.webp`: a second generated pose, seated with a laptop, exported with transparency at 520px (39 KB). Used as a decorative companion to the desktop setup checklist. Original: `/workspace/generated_images/exec-96af9f2f-3044-4918-98d8-38e30d3ae3aa.png` in the design workspace.
- `scenes/*.svg`: nine original vector assets remain available for conversations, prospects, campaigns, studio, connections, team, wallet, activity and strategy. The Unslop pass removed redundant scenes from administration and inbox empty states so operational pages prioritize their records and next action. Retained uses stay decorative; filtered results explain how to clear filters.

The mascot and work illustration are decorative; nearby text provides the content and actions. The logo sits beside the accessible product name. No new text is embedded in the generated illustration. No animations or third-party asset requests are required. On small screens the large public introduction is hidden; the picture fallback is the existing small brand mark, so the desktop mascot isn't fetched.

## Typeface

The interface uses self-hosted IBM Plex Sans variable WOFF2 files in
`rust/panel/public/fonts/` for Latin and Latin Extended characters, including
Turkish. They are distributed under the [SIL Open Font License 1.1](../../operations/licenses/IBM-Plex-Sans-OFL.txt),
with IBM’s copyright notice preserved. The license lives under `docs/operations/`
so the existing release packager includes it alongside the fonts; documentation
stays outside browser assets.

## Task guides added on 2026-11-05

Three new transparent illustrations were generated using the existing `jeeta-guide.webp` mascot as a visual reference. Export: ImageMagick, maximum 480×480, WebP quality 82, alpha preserved. Combined transfer size is approximately 91 KB. On screen they appear at 80–112px, with adjacent explanatory text and empty alt text.

| Asset | Activity and use | Original generation in this workspace |
| --- | --- | --- |
| `guide-setup.webp` | Plugging an orange cable into a navy docking station; empty capabilities, onboarding, empty team | `/workspace/generated_images/exec-fdd49f75-4126-4021-b65c-b24618b49305.png` |
| `guide-conversations.webp` | Listening with a headset beside speech cards; truly empty people list | `/workspace/generated_images/exec-5dfd6aa5-0d12-4352-823d-bccd9b148784.png` |
| `guide-plan.webp` | Placing a card on a physical planning board; empty home queue and material upload | `/workspace/generated_images/exec-2f8c8c0f-2807-4546-9719-555c094374d1.png` |

Shared generation direction: preserve the reference mascot’s voxel dark curly hair, black sunglasses, navy suit, white shirt and orange accents; matte detailed voxel 3D, soft studio lighting, one physical activity, restrained navy/orange, no text, letters, logos, watermark or floating filler; full subject within a square transparent frame with padding and readable at small sizes. Each prompt specifies the activity above. The provided official logo remains unchanged.

These illustrations replace or support empty-state guidance. Populated operational pages do not acquire large decorative hero images.

## Editorial scenes

The subsequent [editorial imagery pass](editorial-visuals-2026-11-05.md) adds four photographic still lifes under `brand/editorial/`: strategy, studio, connections and research, each exported at320/640px. These appear in the main task introductions; the empty capabilities and upload surfaces now use the relevant photographic scene in place of the earlier mascot guide. The guide files remain available for other setup/empty states. Generation prompts, original file paths, responsive placement and validation are recorded in that report.
