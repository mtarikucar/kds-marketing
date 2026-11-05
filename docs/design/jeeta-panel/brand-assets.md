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
