# Editorial imagery — 5 November 2026

The owner requested richer, related imagery beyond the mascot, while retaining the earlier preference for compact pages. This pass adds four original photographic still lifes to the working panel, without extra informational sections or illustrative business metrics.

## Direction

- **Product:** a workspace for small-business customer acquisition, conversations, strategy and content production.
- **Character:** practical, tactile, attentive.
- **World:** the physical planning and production desk: paper, optics, index cards and connected equipment.
- **Moments:** one small photographic composition beside each relevant introduction; the material-upload introduction carries the photograph instead of its header.
- **Signature:** a navy working object and orange functional detail, such as a photo corner, divider or cable.

The audit found predominantly text-only introductions in the main workspaces. Existing grouping, typography and quiet controls were retained. The change is concentrated in the introductions; working records remain dominant. The studio header was reduced to 112px on desktop after visual review to avoid unnecessary space beneath the description.

## Placement

| Surface | Image and behavior |
| --- | --- |
| Strategy | Notebook, paper planning cards and orange connecting thread |
| Growth studio and posts | Camera and photographic prints; a metaphor for content production, not a user's uploaded material |
| Material upload | Same camera scene replaces the empty-upload mascot; the outer page header omits its photograph on the Materials tab |
| Capabilities | Physical cable hub next to the populated page introduction; only the empty-state illustration is shown for a truly empty inventory |
| Prospect pool and research tasks | Navy index-card archive with a magnifying glass and orange divider |

`WorkspaceHeader` retains one h1 and existing explanatory copy/actions. Images have no embedded interface text, no fabricated performance data and no interactive affordance. They are decorative with empty alt text because the adjacent text carries the meaning. On phones, the header photo is 80×80 and the description/actions span the full width. At desktop sizes it is 224×112 without actions or 224×144 with actions. A picture source serves the smaller mobile asset. No animation or external image request is added.

## Generated assets

All four originals are 1536×1024 PNGs produced with the available image-generation tool. No external stock photograph or existing customer's photo was used. Original files remain in the workspace; optimized exports are committed in `rust/panel/public/brand/editorial/`.

| Scene | Original generation |
| --- | --- |
| strategy | `/workspace/generated_images/exec-4bc3561e-4e54-4ca9-af68-10269937c876.png` |
| studio | `/workspace/generated_images/exec-11de004b-4c73-45bc-888b-2a9488606335.png` |
| connections | `/workspace/generated_images/exec-820f7eab-a5ce-4477-b2b4-7ab8d0ab65d6.png` |
| research | `/workspace/generated_images/exec-29adb8ab-32ce-497c-9e89-bd31e4881b9e.png` |

Export: ImageMagick to 640px wide WebP at quality 82 and 320px wide at quality 80. Desktop files range from 14–42 KB; mobile files 5–13 KB. One relevant scene is requested per introduction.

Shared prompt direction: premium editorial still-life photography for a practical business growth workspace; real physical materials, directional window light, soft contact shadows, pale cool-grey tabletop, navy details and one orange accent; restrained tactile composition; horizontal 3:2, three-quarter overhead viewpoint, legible at 224–240px. Exclude mascot, voxel/cartoon treatment, humans, branding, text, watermark, fabricated dashboards, holography and floating objects.

Subjects specified in the prompts:

- An open navy cloth-bound notebook with blank cream pages, three paper index cards joined by an orange thread, and a graphite pencil.
- A compact unbranded black mirrorless camera with overlapping prints of handmade blue ceramic cups and an orange photo corner.
- A navy ethernet hub with orange/off-white connected cables, real brushed metal, braided cable and physical plugs.
- A navy metal index-card tray, cream cards, orange divider and optical magnifying glass.

Some generated scenes include additional desk props; these were inspected and retained because the main subject remains clear at the actual display size.

## Verification and delivery

- Existing relevant suites: **67 tests across 6 files passed** (StrategyPage, StudioPage, CapabilitiesWorkbench, ProspectsPage, ResearchTasksPage, MaterialsUpload).
- TypeScript and Vite production build passed. The existing non-blocking main-chunk size warning remains.
- Browser: 16 desktop/mobile captures across 8 views at 1440/390 px, plus 8 narrow/tablet cases at 320/768 px, including 4 dark-theme checks. No recorded document overflow or runtime exceptions. API responses are fixtures; no live business writes were performed.
- Physically inspected desktop studio/research and mobile strategy/capabilities plus narrow dark studio. Photo loading and responsive sources were checked in the browser.
- Before/after gallery: `/workspace/jeeta-editorial-review/index.html`, 8 views × 2 widths × 2 versions = 32 images. It identifies local development and synthetic data.
- No staging or production deployment in this pass.

Design guidance: **Unslop by Damir Sokolovsky**, https://github.com/heydamir/unslop, CC BY 4.0, adapted to the owner's explicit request for more imagery. See the existing [attribution](unslop.md).
