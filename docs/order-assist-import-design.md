# hc-admin 接入 HC Order Assist 订单导入设计

## 1. 背景

HC Order Assist 是一个 Chrome/Edge 浏览器扩展，运行在赞晨租后台页面，用于把「待发货」订单一条条导入 hc-admin。插件只做采集、确认和转发，**真正的鉴权、幂等、字段校验和订单创建都在 hc-admin 完成**。

插件侧设计见 hc-order-assist 仓库的 `docs/DESIGN.md`，本文档只描述 hc-admin 需要做的改动。

## 2. 架构现状与关键差异

hc-admin 是 CloudBase 应用：React 前端 + 云函数（`wx-server-sdk`）+ NoSQL。订单数据在 `orders` 集合，由云函数 `saveOrders` 写入。

> 重要：插件 `DESIGN.md` 里写的 `POST /api/integrations/...` REST 接口在 CloudBase 里没有天然对应物。所谓「实现导入接口」= **新增一个云函数 + 决定它如何被插件调到**。

## 3. 对接方式选择

| | A. CloudBase callFunction（推荐） | B. HTTP 访问服务 + 静态 Token |
| --- | --- | --- |
| 云函数入口 | `event` 直接是业务参数 | 需解析 `event.httpMethod/headers/body`，自行校验 Bearer |
| 鉴权 | `getCurrentUser(event)` 拿真实 CloudBase 用户，复用现有 `permissionAuth` | 自己比对静态 token |
| operator 可信度 | ✅ 真实可信，消除「operator 可伪造」问题 | ❌ 仍为前端自报 |
| 额外配置 | 仅在 `cloudbaserc.json` 注册函数 | 还需配 HTTP 访问服务路径 + 插件 `manifest.json` host_permissions |
| 插件改动 | background.js 由 `fetch` 改为 SDK `callFunction` | 插件基本不改 |

**推荐方案 A**：与现有云函数体系一致，鉴权直接复用 `permissionAuth.js`，并顺带解决插件侧 operator 不可信的问题。下文以 A 为主，B 的差异在 §9 单列。

## 4. 新增云函数 `importOrderFromAssist`

位置：`cloud_functions/sendWechatNotification/functions/importOrderFromAssist/index.js`

职责（对应插件 DESIGN §5.4）：

1. **鉴权**
   - 方案 A：`const user = await getCurrentUser(event)`，无用户返回 `LOGIN_REQUIRED`；再查 `user_roles` 判断是否有订单创建权限（参考 `getUserRole`）。
   - 方案 B：从 `event.headers.authorization` 取 Bearer，与环境变量中的 token 比对。
2. **状态校验**：`order.sourceStatusCode === 'PENDING_SHIPMENT'`（兜底 `sourceStatus.includes('待发货')`），否则返回 `INVALID_STATUS`。
3. **字段校验**：按 §6 必填表，缺失返回 `MISSING_FIELDS`。
4. **幂等**：见 §7。
5. **字段映射 + 写入 `orders`**：见 §5，复用 `saveOrders` 的 `db.collection('orders').add` 写法。
6. **写导入日志**：见 §8，返回统一结构 `{ success, code, message, data }`。

## 5. 字段映射（插件 normalized → orders 集合）

`orders` 集合实际字段（见 `订单字段关联关系说明.md`）：
`serialNumber, date, orderSource, customerName, consignee, consigneePhone, consigneeAddress, status, products[], onlineOrderNumber, salesperson ...`

| 插件字段 | orders 字段 | 说明 |
| --- | --- | --- |
| `sourceOrderNo` | `onlineOrderNumber` | 同时存独立幂等键（见 §7） |
| `recipient` | `consignee` + `customerName` | 收货人=客户名，发货流程靠 `consignee` 匹配出库 |
| `recipientPhone` | `consigneePhone` | 完整手机号 |
| `recipientAddress` | `consigneeAddress` | |
| `goodsTitle` | `products[0].productName` | orders 为 products 数组结构 |
| `goodsQuantity` | `products[0].quantity` | 默认 1 |
| `paidRent` | `products[0].amount` | |
| `responsiblePerson` | `salesperson` | |
| `orderedAt` | `date` | |
| （固定值） | `status = 'unknown'` | 见下方说明 |
| `source` | `orderSource = 'zanchenzu'` | |
| `raw` | 仅写入导入日志，不污染订单 | |

> 状态映射说明：hc-admin 的 `status` 枚举（`shipped/noShip/returnReceived/returnShipped/unknown`）没有「待发货」。最贴近的是 `unknown`（待处理/未明确），且只有 `unknown`/`--` 状态才会显示「发货」「申请快递」按钮。因此导入订单一律置 `status = 'unknown'`，才能进入正常发货流程。

## 6. 字段必填性

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `sourceOrderNo` | 是 | 幂等键之一 |
| `sourceStatusCode` | 是 | 状态枚举，服务端据此校验是否待发货 |
| `recipient` | 是 | 收货人 → consignee/customerName |
| `recipientPhone` | 是 | 完整手机号（已解密） |
| `recipientAddress` | 是 | 收货地址 |
| `goodsTitle` | 是 | 商品名称 |
| `goodsQuantity` | 否 | 默认 1 |
| `orderedAt` / `paidRent` / `responsiblePerson` | 否 | 缺失不阻断创建 |
| `operator.*` | 方案 A 由服务端从登录态取，忽略前端值；方案 B 仅供参考 | |

缺失必填字段返回 `MISSING_FIELDS`，并在响应中指明缺失字段。

## 7. 幂等设计

CloudBase NoSQL 没有原生复合唯一约束，`unique(source, source_order_no)` 不能直接声明。采用 **`_id` 幂等锁**（推荐）：

- 在 `order_import_logs` 集合中 `_id = 'zanchenzu_' + sourceOrderNo`，`_id` 天然唯一。
- 流程：
  1. 先 `add` 一条日志占位（成功 = 首次导入）。
  2. 创建 `orders` 订单。
  3. 回填日志的 `createdOrderId`、`status = 'success'`。
  4. 若占位 `add` 抛重复错（已存在）→ 读出已有 `createdOrderId`，返回 `DUPLICATED`。
- 该方式可抵抗并发重复点击。

备选：在 `orders` 加 `importKey` 字段并在控制台手动建唯一索引；或「查-再-插」（有竞态，仅低频内部场景可接受）。

重复导入按**成功**返回，不视为失败：

```json
{ "success": true, "code": "DUPLICATED", "message": "订单已存在", "data": { "orderId": "...", "duplicated": true } }
```

## 8. 新增 `order_import_logs` 集合

| 字段 | 说明 |
| --- | --- |
| `_id` | 幂等键 `zanchenzu_<sourceOrderNo>` |
| `source` | 固定 `zanchenzu` |
| `sourceOrderNo` | 来源订单号 |
| `operatorId` / `operatorName` | 方案 A 取自登录态；方案 B 取自前端 operator |
| `rawPayload` | 插件原始 `raw` |
| `normalizedPayload` | 映射后写入 orders 的数据 |
| `status` | `success` / `duplicated` / `failed` |
| `createdOrderId` | 创建出的 orders `_id` |
| `errorMessage` | 失败原因 |
| `createTime` | `db.serverDate()` |

失败也写一条，便于排查（谁导入、导入哪个赞晨租订单、是否重复、创建了哪个内部订单、失败原因）。

## 9. 响应结构与错误码

统一结构：`{ success, code, message, data }`。

| 场景 | success | code | HTTP（仅方案 B 体现） |
| --- | --- | --- | --- |
| 创建成功 | true | `CREATED` | 200 |
| 重复导入 | true | `DUPLICATED` | 200 |
| 未登录 / token 错误 | false | `LOGIN_REQUIRED` | 401 |
| 无权限 | false | `FORBIDDEN` | 403 |
| 非待发货状态 | false | `INVALID_STATUS` | 400 |
| 字段缺失 | false | `MISSING_FIELDS` | 422 |
| 系统异常 | false | `INTERNAL_ERROR` | 500 |

> 鉴权只认 `Authorization`（方案 B）或 CloudBase 登录态（方案 A），**不得信任 `X-HC-Order-Assist` 等可伪造请求头**。

## 10. 注册与配置

1. **`cloudbaserc.json`**：在 `functions` 数组新增
   ```json
   { "name": "importOrderFromAssist", "handler": "index.main", "runtime": "Nodejs18.15" }
   ```
2. **依赖**：函数目录放 `package.json`，声明 `wx-server-sdk`（与其它函数一致）。
3. **集合**：`orders` 已存在；新建 `order_import_logs`（首次 `add` 自动建，或控制台预建）。
4. **仅方案 B**：配置 HTTP 访问服务路径，token 存云函数环境变量（勿硬编码）；插件 `manifest.json` 的 `host_permissions` 加 `https://<envId>.service.tcloudbase.com/*` 或自定义域名。

## 11. 插件侧配套改动（供参考，不在本仓库）

- **方案 A**：background.js 改用 `app.callFunction({ name: 'importOrderFromAssist', data: payload })`，去掉 `apiBase/importPath/apiToken`；content-script 产出 `sourceStatusCode`。
- **方案 B**：插件基本不改，content-script 补 `sourceStatusCode`，config 填 `apiBase/apiToken`。

## 12. 落地顺序

1. 定方案（A / B）。
2. 新建 `order_import_logs` 集合。
3. 编写 `importOrderFromAssist` 云函数（鉴权 / 校验 / 幂等 / 映射 / 日志）。
4. 在 `cloudbaserc.json` 注册并部署。
5. 改插件对接。
6. 用一条真实待发货订单联调。
