# Design QA — hc-admin P0 Layout Fixes

## Comparison Target

- Source visual truth:
  - `/Users/zhibinxiao/.codex/visualizations/2026/07/14/019f61b5-342f-7c30-a0a9-ca55b798af67/hc-admin-ui-audit/09-orders-1280.jpg`
  - `/Users/zhibinxiao/.codex/visualizations/2026/07/14/019f61b5-342f-7c30-a0a9-ca55b798af67/hc-admin-ui-audit/03-orders.jpg`
  - `/Users/zhibinxiao/.codex/visualizations/2026/07/14/019f61b5-342f-7c30-a0a9-ca55b798af67/hc-admin-ui-audit/08-orders-collapsed.jpg`
- Rendered implementation:
  - `/Users/zhibinxiao/.codex/visualizations/2026/07/14/019f61b5-342f-7c30-a0a9-ca55b798af67/hc-admin-ui-audit/12-orders-after-1280-final.jpg`
  - `/Users/zhibinxiao/.codex/visualizations/2026/07/14/019f61b5-342f-7c30-a0a9-ca55b798af67/hc-admin-ui-audit/17-orders-after-default-final.jpg`
  - `/Users/zhibinxiao/.codex/visualizations/2026/07/14/019f61b5-342f-7c30-a0a9-ca55b798af67/hc-admin-ui-audit/13-inbound-after-1280.jpg`
  - `/Users/zhibinxiao/.codex/visualizations/2026/07/14/019f61b5-342f-7c30-a0a9-ca55b798af67/hc-admin-ui-audit/14-inventory-after-1280.jpg`
  - `/Users/zhibinxiao/.codex/visualizations/2026/07/14/019f61b5-342f-7c30-a0a9-ca55b798af67/hc-admin-ui-audit/15-invoices-after-1280.jpg`
  - `/Users/zhibinxiao/.codex/visualizations/2026/07/14/019f61b5-342f-7c30-a0a9-ca55b798af67/hc-admin-ui-audit/16-sidebar-after-1280.jpg`
- Viewports: 953 × 720 and 1280 × 720.
- State: authenticated administrator, live data, expanded and collapsed sidebar states.

## Full-view Comparison Evidence

The source and implementation screenshots were inspected together at matching routes and viewports. The implementation preserves the existing navigation, typography, colors, card surfaces, data density, copy, icons, and table content while changing the overflow boundary and responsive filter layout.

- At 953px, document width changed from a horizontally overflowing layout to `pageScrollWidth = viewportWidth = 953`.
- At 1280px, document width changed from 1751px to `pageScrollWidth = viewportWidth = 1280`.
- The order, inbound, inventory, and invoice tables remain available inside their own bounded regions.
- Persistent top-bar controls and primary actions remain visible.
- The order action column remains visible while the table content can overflow internally.

## Focused Region Comparison Evidence

Focused comparison was required for the order filter bar, table action column, and collapsed sidebar.

- Order filter: the first implementation pass removed page overflow but clipped the end-date control. The final implementation uses a responsive grid; both date fields and all three filter actions are visible at 953px and 1280px.
- Table action column: the source pushed the operation area outside the viewport. The final implementation keeps the operation column visible at both test widths.
- Collapsed sidebar: the source exposed 10 unnamed navigation buttons. The final implementation exposes 10 of 10 labels and zero unnamed buttons.

## Required Fidelity Surfaces

- Fonts and typography: unchanged from the source. Existing PingFang/system fallback, weights, sizes, and hierarchy are preserved. Existing narrow table-cell wrapping remains a follow-up polish item rather than a regression introduced here.
- Spacing and layout rhythm: page padding, sidebar widths, card radii, section gaps, and header heights match the source. Filter fields reflow only when required to prevent clipping.
- Colors and visual tokens: unchanged. Primary, danger, success, muted, border, and surface tokens continue to use the existing Tailwind/TDesign system.
- Image quality and assets: no raster assets or logos were added, removed, regenerated, or replaced. Existing Lucide icons remain unchanged.
- Copy and content: unchanged. Live business labels, filter names, status text, and action labels are preserved.
- Responsiveness: verified at 953px and 1280px. No page-level horizontal overflow remains on the tested routes.
- Accessibility: collapsed navigation buttons now have accessible names and hover titles. The sidebar toggle remains labeled in both states.

## Comparison History

### Iteration 1 — blocked

- Earlier findings:
  - [P0] Page-level horizontal overflow hid persistent controls and operation columns.
  - [P0] All 10 collapsed sidebar navigation buttons lacked accessible names.
- Fixes made:
  - Added `min-w-0` boundaries to the nested layout and content wrappers.
  - Moved horizontal overflow into bounded table containers on four pages.
  - Added accessible labels and collapsed-state titles to sidebar navigation buttons.
- Post-fix evidence:
  - `10-orders-after-default.jpg`
  - `11-orders-after-1280.jpg`
  - `16-sidebar-after-1280.jpg`
- Remaining finding:
  - [P1] The end-date filter could be clipped after page overflow was hidden.

### Iteration 2 — passed

- Fix made:
  - Rebuilt the primary order filter row as a responsive grid with shrinkable date fields and breakpoint-aware action placement.
- Post-fix evidence:
  - `12-orders-after-1280-final.jpg`
  - `17-orders-after-default-final.jpg`
  - `13-inbound-after-1280.jpg`
  - `14-inventory-after-1280.jpg`
  - `15-invoices-after-1280.jpg`
- Result:
  - No actionable P0/P1/P2 mismatch remains within the approved P0 scope.

## Browser And Build Verification

- Primary interactions tested: route navigation, sidebar collapse, sidebar expand, responsive filter reflow.
- Console: no application errors; only existing React Router v7 future-flag warnings.
- Build: `npm run build` passed after the final changes.

## Follow-up Polish

- [P3] Keep dates and serial numbers on one line where table density allows.
- [P3] Raise empty-state and disabled-state contrast after measuring token contrast.
- [P3] Consider moving low-frequency row actions into a consistent overflow menu.

final result: passed
