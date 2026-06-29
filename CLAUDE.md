# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start local dev server (Vite, port 5173)
npm run build      # Type-check + production build → dist/
npm run preview    # Preview production build locally
npm run test:sf-token  # Run SF access token test
```

## Deployment

**Never auto-deploy.** Only deploy when the user explicitly asks (e.g., "部署", "deploy", "上线"). After `npm run build`, just report success — do not trigger any CloudBase upload or deploy tools.

To deploy frontend: upload `dist/` to CloudBase static hosting via the CloudBase MCP tool or `cloudbase` CLI.
To deploy a cloud function: update its source in `cloud_functions/sendWechatNotification/functions/<name>/index.js` and deploy via CloudBase MCP or CLI.

CloudBase env ID: `cloud1-8gvbotkt966e5e19` (Shanghai region). Environment variables in `.env`:
- `VITE_CLOUDBASE_ENV` — env ID
- `VITE_CLOUDBASE_ACCESS_KEY` — publishable key for frontend SDK init

## Architecture

This is a React 18 + TypeScript + Vite SPA backed entirely by **Tencent CloudBase (TCB)**. There is no traditional server — all data operations go through CloudBase cloud functions.

### Frontend

| Layer | Path | Role |
|-------|------|------|
| SDK init | `src/lib/cloudbase.ts` | Single entry point for CloudBase SDK, all `callFunction()` calls, AI model config, auth helpers |
| Routing | `src/App.tsx` | HashRouter with lazy-loaded pages; all routes under `AuthGuard → PermissionGuard` |
| Contexts | `src/contexts/` | `PermissionContext` (RBAC state) and `DictionaryContext` (dynamic dict data from cloud) |
| Hooks | `src/hooks/` | One hook per domain — wraps `callFunction` calls and manages local state |
| Pages | `src/pages/` | Full-page components; one per route |
| Components | `src/components/` | Shared UI (AuthGuard, Layout, PermissionGuard, RecordEdit, RecordDetail, Settings tabs) |
| Data | `src/data/dict.ts` | **Single source of truth** for all enum dictionaries and the brand→product→spec 3-level cascade |
| Types | `src/types/index.ts` | Re-exports from `dict.ts` + all TypeScript interfaces |
| Utils | `src/utils/constants.ts`, `format.ts`, `orderExcel.ts` | Shared constants, formatters, Excel export |

### Cloud Functions

All cloud functions live in `cloud_functions/sendWechatNotification/functions/<name>/index.js`. The `cloudbaserc.json` at the repo root lists all deployed functions.

Key function groups:
- **Records**: `queryRecords`, `updateRecord`, `deleteInboundRecord`, `deleteOutboundRecord`
- **Orders**: `queryOrders`, `saveOrders`, `updateOrder`, `deleteOrder`, `importOrderFromAssist`
- **Invoices**: `queryInvoices`, `saveInvoice`, `updateInvoice`, `deleteInvoice`
- **Companies**: `queryCompanies`, `saveCompany`, `updateCompany`, `deleteCompany`
- **Permissions (RBAC)**: `getUserRole`, `initializePermissionSystem`, `manageRoles`, `manageUserRoles`
- **Counters**: `getAndIncrementCounter` (atomic order serial number), `manageCounter`
- **SF Express**: `getSfAccessToken`, `applySfExpress`, `querySfOrderResult`, `cancelSfExpress`
- **Dictionaries**: `getDictionaries`, `manageDictionaries`, `manageProductModels`
- **Misc**: `sendWechatNotification`, `getCloudFileUrls`, `countPendingInvoices`, `generateDailyShipmentStats`

### Database Collections

`inbound_records`, `outbound_records`, `operation_logs`, `phone_models`, `shops`, `user_whitelist`, `record_history`, `orders`, `system_counters`, `roles`, `permission_users`, `user_roles`, `system_config`, `invoices`, `companies`, `dictionaries`

### Permission System (RBAC)

Two-layer: frontend hides menus/buttons; cloud functions enforce server-side.

- `PermissionContext` calls `getUserRole` on load and on auth state change
- `pagePermissions` controls which routes are accessible (path strings like `/orders`)
- `actionPermissions` controls button visibility; `can('some:action')` checks it
- Only the built-in CloudBase `administrator` account can initialize the system for the first time
- Default-deny: any permission load failure blocks access

### Data Dictionaries

`src/data/dict.ts` contains all static enum maps (order status, order type, sales channel, etc.). Dynamic dictionaries (shop names, operators, etc.) are loaded from the `dictionaries` collection via `DictionaryContext` → `getDictionaries` cloud function. Use `getLabel(groupCode, value)` from the context for display labels.

### Orders — Key Domain Rules

Defined in `.codebuddy/rules/order-create-rules.md`. Essential constraints:

- One order = multiple `ProductItem` rows sharing common fields (customer, consignee, logistics)
- Serial number is auto-generated atomically via `getAndIncrementCounter` — never editable on create
- `amount` is read-only, auto-computed as `quantity × unitPrice`
- `channelCategory` is read-only, auto-derived from `salesChannel` (platform vs offline)
- `orderType` options filter based on `orderSource` (new → newBusiness; service → 4 post-rental types)
- When `paymentAccount` is `未收款` or `returnStatus` is `inTransit`/`notReturned`, the row renders red in the list
- AI consignee parsing calls `parseConsigneeInfo()` in `src/lib/cloudbase.ts` which uses the CloudBase AI model

### UI Stack

- **TDesign React** (`tdesign-react`) — primary component library
- **Tailwind CSS** — utility styling; config in `tailwind.config.js`
- **Recharts** — charts in Stats page
- **lucide-react** — icons
- **xlsx** — Excel import/export
- **Vite** custom plugin patches TDesign CSS warnings at build time (`vite.config.ts`)
