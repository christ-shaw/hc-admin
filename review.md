# Code Review — `feature/order-outbound`

- **Date**: 2026-07-02
- **Scope**: `git diff main...feature/order-outbound` (7 commits, ~1,500 lines) plus the preceding merge already on `main` ("Merge branch 'bugfix'")
- **Method**: 16 finder passes across 8 angles (line-by-line, removed-behavior, cross-file tracing, reuse, simplification, efficiency, altitude, CLAUDE.md conventions) → ~40 candidates → deduped to 24 → each independently verified against the current feature-branch code. Verdicts: **CONFIRMED** (demonstrable from code) / **PLAUSIBLE** (realistic, state-dependent).

---

## Findings (ranked by severity)

### 1. `LOGIN_REQUIRED` never triggers re-login — CONFIRMED
**File**: `src/lib/cloudbase.ts:127`

`isAuthError()` checks only `['AUTH_EXPIRED', 'TOKEN_EXPIRED', 'UNAUTHENTICATED']`, but the new record cloud functions (`queryRecords`, `updateRecord`, `deleteInboundRecord`, `deleteOutboundRecord`) return `code: 'LOGIN_REQUIRED'` when server-side identity is missing. `callFunction` therefore never calls `emitAuthExpired()`; the hooks just throw `errMsg` and the user is stuck with a generic error instead of being routed to re-login.

**Fix**: add `'LOGIN_REQUIRED'` to the code list in `isAuthError()` (or map it in the record functions to a code the frontend already handles).

### 2. New cloud functions missing from `cloudbaserc.json` — CONFIRMED
**File**: `cloudbaserc.json` (functions array)

`completeOutbound` and `generateOutboundFromOrders` exist under `cloud_functions/sendWechatNotification/functions/` but are not registered in the `functions` array (38 entries, neither present). CLAUDE.md states cloudbaserc.json lists all deployed functions; any config-driven deploy will skip them and the 生成出库单 button will fail with FUNCTION_NOT_FOUND.

**Fix**: add both function entries to `cloudbaserc.json`.

### 3. `count()` chained after `skip()/limit()` — PLAUSIBLE
**File**: `cloud_functions/sendWechatNotification/functions/queryRecords/index.js:330`

```js
result = await query.limit(pageSize).skip(skipValue).get();
const countResult = await query.count();
```

`query.count()` runs on the same query object that already has `limit`/`skip` chained. If the SDK applies those modifiers to the count request, `totalCount`/`hasMore` are computed from the truncated set — page 2+ becomes unreachable. (Marked PLAUSIBLE because CloudBase SDK count semantics with chained cursors were not conclusively proven either way.)

**Fix**: call `.count()` on a fresh `collection.where(condition)` query built before pagination modifiers are applied.

### 4. Shipped-status validation removed from Orders wizards — CONFIRMED
**File**: `src/pages/Orders.tsx:767` (add wizard) and `:1183` (edit wizard)

On `main`, step 4 blocked `status === 'shipped'` without `shippingFee`/`trackingNumber`. The feature branch deleted both checks, leaving dead `const { status } = getEffectiveShipmentFields(...)` extractions behind. A user can now save a shipped order with no shipping details.

**Fix**: restore the validation (or delete the dead destructures if the removal was intentional and enforce server-side instead).

### 5. Web edits write empty audit identity — CONFIRMED
**File**: `cloud_functions/sendWechatNotification/functions/updateRecord/index.js:187`

History rows store `modifiedByOpenid: auth.openid || ''`. The web path (`requireWebPermission`/`permissionAuth`) returns `{ allowed, role, actionPermissions }` with no `openid`, and the resolved `currentUser` (`uid`/`customUserId`) is never written. Every edit from the web UI produces `record_history` entries that cannot be attributed to a user.

**Fix**: have the web auth path return the resolved identity and store it (e.g. `modifiedByUserId`).

### 6. Deleting a legacy outbound record leaves the order stuck `shipped` — CONFIRMED
**File**: `cloud_functions/sendWechatNotification/functions/deleteOutboundRecord/index.js:126`

Orders are reverted to `unshipped` only when `outbound.outboundStatus === 'completed'`. Outbound records created before this feature have no `outboundStatus` field, so `wasCompleted` is `false`: the order's `outboundRecordId` is cleared but its status stays `shipped`, with no backing record and no way to regenerate from the pending filter.

**Fix**: treat a missing `outboundStatus` on a record whose linked order is `shipped` as completed for reversion purposes (or backfill the field).

### 7. Missing `outboundStatus` treated as `completed` in filters — CONFIRMED
**File**: `cloud_functions/sendWechatNotification/functions/queryRecords/index.js:299`

The filter only excludes `isPending === true` from the completed view, so legacy records with `outboundStatus === undefined` disappear from 待出库 (pending) and silently appear under completed — even if never processed via `completeOutbound`.

**Fix**: decide the legacy semantics explicitly (backfill the field, or treat `undefined` as pending) and encode it in the filter.

### 8. Transient auth failure indistinguishable from logged-out — CONFIRMED
**File**: `cloud_functions/sendWechatNotification/functions/queryRecords/permissionAuth.js:21` (copied into `updateRecord`, `deleteInboundRecord`, `deleteOutboundRecord`)

`getCurrentUser()` catches and swallows `auth.getUserInfo()` exceptions, returning `null` for both "no identity" and "lookup failed". Both map to a non-retryable `LOGIN_REQUIRED` (请先登录) — a transient CloudBase auth hiccup logs a signed-in user out of the flow. Compounds with finding 1.

**Fix**: rethrow (or return a distinct `AUTH_LOOKUP_FAILED`) from the catch so transient faults surface as retryable errors. Update all four copies.

### 9. Fetch-all + in-memory filtering in `queryRecords` — CONFIRMED (efficiency)
**File**: `cloud_functions/sendWechatNotification/functions/queryRecords/index.js:293`

Whenever a date or `outboundStatus` filter is active, the function loads up to `maxRecords = 10000` docs through a sequential pagination loop, then filters in memory to return ~20 rows. Read cost and latency scale with collection size, not result size.

**Fix**: push date ranges (`_.gte/_.lte`) and `outboundStatus` into the `where()` clause; keep the in-memory path only for conditions the DB genuinely cannot express.

### 10. `needsOutbound=false` hides but does not clear consignee fields — CONFIRMED
**File**: `src/pages/Orders.tsx:161` (`applyNeedsOutbound`)

Toggling 不需出库 clears `shippingFee`/`trackingNumber` but leaves `consignee`/`consigneePhone`/`consigneeAddress` in form state; they are persisted on save while hidden from the form. A `noShip` order can carry stale consignee data that downstream consumers may read as ship intent. (Possibly intentional to preserve input when toggling back — if so, document it.)

---

## Verified and refuted (no action needed)

| Suspicion | Why refuted |
|---|---|
| `completeOutbound` writes `shippingMethod` into `order.shippingFee` — domain mismatch | Both hold `SHIPPING_FEE_MAP` keys (`prepaid`/`cod`/`pickup`); labels resolve correctly |
| `generateOutboundFromOrders` forgets `outboundStatus` on new records | Insert payload sets `outboundStatus: 'pending'` explicitly |
| Regex injection via `db.RegExp` in `importOrderFromAssist` | File contains zero `db.RegExp` usages; all queries are exact-match |
| `todayInBeijing()` timezone bug | Correct pattern: +8h at timestamp level, then UTC getters via `toISOString()` |
| `updateRecord` wipes omitted fields (salesperson/consignee) | CloudBase `doc().update()` merges; omitted fields preserved |
| Removed `usePhoneModels` exports still referenced | All consumers (RecordEdit, PhoneModels, Orders) use only surviving exports |
| Generate-outbound button shows when it would fail `ALREADY_GENERATED` | `!row.outboundRecordId` in the AND chain makes it impossible |
| `deleteOrder` leaves dangling id crashes `completeOutbound` | No unlink exists, but `completeOutbound` skips missing orders gracefully |

## Below the cut (real but lower priority)

- **N+1 sequential loops** — `generateOutboundFromOrders`, `completeOutbound`, `deleteOutboundRecord` each `await doc.get()`/`doc.update()` per linked order inside the transaction; batch with `Promise.all` where the transaction API allows.
- **`columns` useMemo defeated** — `Orders.tsx:1394`: `DictionaryContext.getMap()` returns a fresh object each call, so the memo recomputes every render; memoize map objects in the context.
- **Idempotency key collision (PLAUSIBLE)** — `importOrderFromAssist:328` keys dedup solely on `sourceOrderItemNo`; if the same item number can recur across different source orders, the second import is silently skipped.
- **Legacy whitelist migration duplicates (PLAUSIBLE)** — `manageUserRoles:642` matches existing users by `userId` only; a user stored with a different `userId` but same `openid` gets a duplicate `permission_users` row.
- **Known drift** — `SALES_CHANNEL_MAP` duplicated between `src/data/dict.ts` and `importOrderFromAssist` (already tracked in the team's drift inventory).

---
🤖 Generated with [Claude Code](https://claude.com/claude-code)
