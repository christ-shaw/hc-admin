# Design QA — 采购管理页面

## Comparison Target

- Source visual truth:
  - `/Users/zhibinxiao/.codex/visualizations/2026/07/14/019f61b5-342f-7c30-a0a9-ca55b798af67/purchase-page-build/source-purchase-list.jpg`
  - `/Users/zhibinxiao/.codex/visualizations/2026/07/14/019f61b5-342f-7c30-a0a9-ca55b798af67/purchase-page-build/source-purchase-create.jpg`
  - `/Users/zhibinxiao/.codex/visualizations/2026/07/14/019f61b5-342f-7c30-a0a9-ca55b798af67/purchase-page-build/source-purchase-detail.jpg`
- Rendered implementation:
  - `/Users/zhibinxiao/.codex/visualizations/2026/07/14/019f61b5-342f-7c30-a0a9-ca55b798af67/purchase-page-build/implementation-purchase-list-1280.jpg`
  - `/Users/zhibinxiao/.codex/visualizations/2026/07/14/019f61b5-342f-7c30-a0a9-ca55b798af67/purchase-page-build/implementation-purchase-create-1280.jpg`
  - `/Users/zhibinxiao/.codex/visualizations/2026/07/14/019f61b5-342f-7c30-a0a9-ca55b798af67/purchase-page-build/implementation-purchase-detail-1280.jpg`
- Combined comparison evidence:
  - `/Users/zhibinxiao/.codex/visualizations/2026/07/14/019f61b5-342f-7c30-a0a9-ca55b798af67/purchase-page-build/compare-list.jpg`
  - `/Users/zhibinxiao/.codex/visualizations/2026/07/14/019f61b5-342f-7c30-a0a9-ca55b798af67/purchase-page-build/compare-create.jpg`
  - `/Users/zhibinxiao/.codex/visualizations/2026/07/14/019f61b5-342f-7c30-a0a9-ca55b798af67/purchase-page-build/compare-detail.jpg`
- Viewport: 1280 × 720.
- State: authenticated administrator; purchase list, create modal, and detail drawer.

## Findings

No actionable P0, P1, or P2 visual mismatch remains.

- The list hierarchy, filter card, table density, radii, borders, row dividers, hover affordances, amount emphasis, and pagination match the design reference.
- The create modal matches the source width, grid, labels, muted hints, field heights, footer, overlay, and primary action treatment.
- The detail drawer matches the source width, price summary card, information sections, row spacing, footer actions, and overlay treatment.
- The existing hc-admin top bar and expanded navigation are intentionally preserved rather than replacing the product shell with the design reference's prototype tabs.
- Demo content uses the real hc-admin product catalog and logged-in operator, so brand/model values differ intentionally from the static reference rows.

## Full-view Comparison Evidence

The source and implementation states were placed together in the same comparison images at the same viewport. The page-region proportions, content hierarchy, filters, table/card surfaces, modal placement, and drawer proportions align with the source. The current application shell is a known product constraint and does not change the purchase workflow.

## Focused Region Comparison Evidence

Focused comparison was required and completed for:

- Filter card: input widths, date spacing, blue filter affordance, 16px card radius, and white surface match.
- Table: header surface, 12px header copy, 13px row copy, row height, dividers, amount weight, and bounded horizontal overflow match.
- Create modal: 640px width, two-column form, 8px controls, muted helper copy, and footer actions match.
- Detail drawer: 460px width, blue price summary, section cards, row rhythm, and fixed footer match.

## Required Fidelity Surfaces

- Fonts and typography: hc-admin system/PingFang fallback is preserved; source sizes and weights are reproduced for titles, labels, table text, and amounts. Truncation is limited to long model and supplier cells.
- Spacing and layout rhythm: 14–16px card padding, 16px radii, 8px controls, table tracks, modal grid, drawer sections, and vertical rhythm align with the source.
- Colors and visual tokens: `#0052D9`, `#1F2733`, `#374151`, `#8A94A6`, `#B5BBC5`, `#EEF0F2`, `#F5F6F8`, and overlay values are mapped directly from the design handoff.
- Image quality and asset fidelity: the target contains no raster imagery, logos, or illustrations requiring generated assets. Existing product shell assets are preserved; Lucide icons are used for interactive controls.
- Copy and content: purchase labels, filter copy, field hints, empty state, detail sections, actions, and computed-price wording match the source. Catalog values intentionally use live hc-admin model data.
- Responsiveness and overflow: at the verified desktop viewport, the document width equals the viewport width; the 1140px table overflows only inside its bounded card.
- Accessibility: page heading, labeled filters, modal/drawer dialog semantics, close-button labels, current pagination state, disabled states, and focusable actions are exposed.

## Comparison History

### Iteration 1 — blocked

- Finding: the local implementation redirected to the login screen, preventing authenticated screenshots and interaction testing.
- Resolution: user signed in to the local app and reopened `/purchases`.

### Iteration 2 — passed

- Captured list, create, and detail states at 1280 × 720.
- Compared each source/implementation pair together.
- No production visual fix was required after comparison.
- Search, expanded brand filtering, clear filters, pagination, brand → model → specification cascade, computed total, create/save, detail, confirmation, and delete were tested successfully.
- The create/delete round trip restored the demo list to 21 rows.

## Browser And Build Verification

- Primary interactions tested: search, expanded filters, brand filter, clear filters, pagination, create modal, catalog cascade, quantity/unit price, computed total, save, detail drawer, delete confirmation, and delete.
- Console: no application errors. Only the existing React Router v7 future-flag warnings remain.
- Build: `npm run build` passed.
- Diff validation: `git diff --check` passed.

## Follow-up Polish

- [P3] Replace the in-memory purchase records with a CloudBase collection and audited CRUD functions when persistence is required.
- [P3] Add supplier dictionary management so the form no longer relies on the page-local supplier seed.

Previous full-page result: passed

## Latest Scoped Change — 2026-07-16 Filter Alignment

- Source visual truth: `/var/folders/f4/wvpm3j0j3js_dq9wly9z27xc0000gn/T/codex-clipboard-58119a4b-1193-41db-a6c7-ea533a500a64.png`
- Implementation screenshot: unavailable; the local authenticated page cannot currently be captured through the permitted in-app browser surface.
- Viewport: desktop; exact CSS viewport unavailable from the supplied high-density crop.
- State: purchase list with the primary filter row visible.
- Full-view comparison evidence: blocked because no post-change browser-rendered screenshot is available.
- Focused region comparison evidence: blocked for the same reason.

### Findings

- The source evidence shows the date inputs incorrectly occupying full rows because the shared `w-full` utility wins over their width utilities.
- The implementation now supplies explicit `flex-basis` values of 220px for search and 142px for each date input, with shrinking disabled. This should keep all primary filters on one desktop row while preserving wrapping when the container is genuinely too narrow.
- `npm run build` passed and the production CSS contains the expected 142px and 220px flex-basis rules.
- No typography, color, image, icon, or copy changes were introduced. Image quality is not applicable because the scoped filter region has no raster assets.

### Comparison History

- Iteration 3 — blocked: code fix and build verification completed; post-change browser capture and side-by-side visual comparison remain unavailable.

final result: blocked
