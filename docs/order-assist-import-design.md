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

`orders` 集合是**扁平结构**（已核对 `OrderRecord` 类型与数据库真实记录）：货品字段 `brand/productName/specification/quantity/unitPrice/amount/paymentAccount` 都在顶层，**不是 `products[]` 数组**。`status` 真实枚举见 `ORDER_STATUS_MAP`，顶层同时有 `amount`（金额）与 `paidRent`（已交租金）两个字段。

| 插件字段 | orders 字段（顶层） | 说明 |
| --- | --- | --- |
| `sourceOrderNo` | `onlineOrderNumber` | 原始赞晨租订单号；同一订单拆多个货品时该字段保持相同 |
| `sourceOrderItemNo` | `sourceOrderItemNo` | 货品项唯一编号（形如 `<sourceOrderNo>#<n>`），幂等键来源（见 §7） |
| `recipient` | `consignee` + `customerName` | 收货人=客户名，发货流程靠 `consignee` 匹配出库 |
| `recipientPhone` | `consigneePhone` | 完整手机号 |
| `recipientAddress` | `consigneeAddress` | |
| `brand` | `brand` | 插件从 `manageProductModels` 三级选择（见 §5.1） |
| `productName` | `productName` | 选中的货品名（**不再用** `goodsTitle`） |
| `specification` | `specification` | 选中的规格 |
| `salesChannel` | `salesChannel` | 插件按**商户名称**自动判定（见 §5.1），传 `SALES_CHANNEL_MAP` 的 key（校验合法性） |
| `goodsTitle` | → `customerRemark` | 页面原始商品名仅作参考写入备注 |
| `goodsQuantity` | `quantity` | 默认 1 |
| `paidRent` | —（暂忽略） | 暂不映射，`paidRent` 写默认 0 |
| `responsiblePerson` | `salesperson` | |
| （计数器生成） | `serialNumber` | 由 `system_counters` 的 `orderSerialNumber` 事务自增，与前端建单一致 |
| （固定值）| `date = 当天`（北京时间 YYYY-MM-DD） | 订单日期固定为导入当天，非 `orderedAt` |
| （固定值）| `orderSource = 'new'`（新增） | |
| （固定值）| `orderAttribute = 'rental1'`（租赁1） | |
| （固定值）| `orderType = 'newBusiness'`（新增业务） | |
| （固定值）| `channelCategory = 'platform'`（平台） | |
| （固定值）| `status = 'unknown'` | 见下方说明 |
| （固定值）| `customerRemark = '【赞晨租导入】原商品：<goodsTitle>'` + `importSource = 'hc-order-assist'` | 来源标记 |
| 其余字段 | `channelCategory/unitPrice/amount/shippingFee/transferItems/returnStatus/attachments ...` | 按 `EMPTY_ORDER` 默认值补空，保证列表显示与编辑向导可用 |
| `raw` | 仅写入导入日志，不污染订单 | |

> 状态映射说明：hc-admin 的 `status` 枚举（`shipped/noShip/returnReceived/returnShipped/unknown`）没有「待发货」。`unknown` 显示为 `--`，且 `isPendingShipmentStatus` 只认 `unknown`/`--`，是唯一会显示「发货」「申请快递」按钮的状态。因此导入订单一律置 `status = 'unknown'`，才能进入正常发货流程。

> 来源字段说明：`orderSource` 现固定写 `new`（新增）。来源信息另由 `onlineOrderNumber`（来源单号）、`customerRemark` 标注与 `importSource` 字段保留，并由 §8 导入日志完整记录。

### 5.1 货品三级与销售渠道选择

货品（品牌→货品名称→规格）与销售渠道**不从赞晨租页面解析**，改由用户在插件导入弹窗中选择，确保与 hc-admin 受控目录一致：

- 导入接口新增 **`getProductModels`** 动作（同一路径、同一静态 token 鉴权）：
  - 请求体 `{"action":"getProductModels"}`。
  - 返回 `data.brands`（`[{brand, products:[{name, specs:[名称...]}]}]`，仅含 enabled，按 sort 排序，读自 `product_models` 集合）与 `data.salesChannels`（`[{value,label}]`，对应 `SALES_CHANNEL_MAP`）。
- 插件 content-script 拉取后，在导入弹窗渲染：销售渠道下拉 + 品牌→货品→规格级联下拉；四项选完才允许确认。
- **销售渠道按商户名称自动判定**：插件从订单 `.table-top` 行解析「商户名称」，按关键字映射预选渠道（仍可人工改）：云途→`yuntu`、汇租机→`huizuji`、云界→`yunjie`、租机乐→`zujile`、倬石→`zhuoshi`、鸿城→`fRrz`。
- 提交时随订单带上 `salesChannel / brand / productName / specification`。
- 服务端校验：四项为必填；`salesChannel` 必须是 `SALES_CHANNEL_MAP` 合法 key，否则 422 `INVALID_FIELD`。

> 路线说明：本动作走 **token 鉴权**（方案三 B 路线），content-script 无 CloudBase 登录态也能取目录。代价是读取目录只认 token、绕过角色权限——与 `manageProductModels`（需 CloudBase 登录 + `models:read`）不同。升级到方案 A 后可改为直接调 `manageProductModels`。

### 5.2 回查快递单号（getTracking）

待发货阶段，插件可在订单行点「查快递单」反向从 hc-admin 取快递单号：

- 导入接口新增 **`getTracking`** 动作（同路径、同 token 鉴权）：请求体 `{"action":"getTracking","sourceOrderNo":"ME..."}`。
- 服务端按 `onlineOrderNumber === sourceOrderNo` 查 `orders`，优先返回已有 `trackingNumber` 的那条，响应 `data`：`{found, trackingNumber, sfWaybillNo, expressProvider, status, serialNumber}`。
- 插件行为：未找到 → 提示未导入；找到但 `trackingNumber` 空 → 提示「尚未发货/无快递单号」；有单号 → 弹窗显示并复制到剪贴板（`trackingNumber` 为空时回退 `sfWaybillNo`）。

## 6. 字段必填性

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `sourceOrderNo` | 是 | 原始赞晨租订单号 |
| `sourceOrderItemNo` | 是 | 货品项唯一编号（`<sourceOrderNo>#<n>`），每条 hc-admin 订单一一对应 |
| `sourceStatusCode` | 是 | 状态枚举，服务端据此校验是否待发货 |
| `recipient` | 是 | 收货人 → consignee/customerName |
| `recipientPhone` | 是 | 完整手机号（已解密） |
| `recipientAddress` | 是 | 收货地址 |
| `salesChannel` | 是 | 销售渠道 key，须为 `SALES_CHANNEL_MAP` 合法值（见 §5.1） |
| `brand` | 是 | 货品品牌（弹窗选择） |
| `productName` | 是 | 货品名称（弹窗选择） |
| `specification` | 是 | 规格（弹窗选择） |
| `goodsTitle` | 否 | 仅作参考写入 `customerRemark` |
| `goodsQuantity` | 否 | 默认 1 |
| `orderedAt` / `paidRent` / `responsiblePerson` | 否 | 缺失不阻断创建（`orderedAt` 不再使用，日期固定当天） |
| `operator.*` | 方案 A 由服务端从登录态取，忽略前端值；方案 B 仅供参考 | |

缺失必填字段返回 `MISSING_FIELDS`；`salesChannel` 非法返回 `INVALID_FIELD`，均在响应中指明。

## 7. 幂等设计

CloudBase NoSQL 没有原生复合唯一约束，`unique(source, source_order_no)` 不能直接声明。采用 **`_id` 幂等锁**（推荐）：

- 在 `order_import_logs` 集合中 `_id = 'zanchenzu_' + sourceOrderItemNo`，`_id` 天然唯一。
- `sourceOrderItemNo` 自带 `sourceOrderNo` 前缀（`<sourceOrderNo>#<n>`），全局唯一；同一 `sourceOrderNo` 的多个货品项各自建一条订单，互不冲突。
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
| `_id` | 幂等键 `zanchenzu_<sourceOrderItemNo>` |
| `source` | 固定 `zanchenzu` |
| `sourceOrderNo` | 来源订单号 |
| `sourceOrderItemNo` | 来源订单货品项编号 |
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

## 13. 当前实现状态（方案三 / B — 静态 Token）

已采用 **方案三：静态 API Token + HTTP 访问服务**（DESIGN §10.1）作为 MVP，对应上表的 B 路线。

已完成（本仓库）：

- 云函数 `cloud_functions/sendWechatNotification/functions/importOrderFromAssist/`（`index.js` + `package.json`）。
  - 鉴权：校验 `Authorization: Bearer <token>`，期望值取自环境变量 `HC_ORDER_ASSIST_TOKEN`。
  - 状态校验：`sourceStatusCode === 'PENDING_SHIPMENT'`，兜底 `sourceStatus.includes('待发货')`。
  - 字段校验：`sourceOrderNo / sourceOrderItemNo / recipient / recipientPhone / recipientAddress / salesChannel / brand / productName / specification`；`salesChannel` 校验枚举合法性。
  - `getProductModels` 动作：token 鉴权返回货品三级树 + 销售渠道选项（见 §5.1）。
  - 幂等：`order_import_logs` 以 `_id = zanchenzu_<sourceOrderItemNo>` 抢占锁；`sourceOrderItemNo` 全局唯一，同一赞晨租订单的每个货品项各建一条 hc-admin 订单，重复返回 `DUPLICATED`。
  - 序号经 `system_counters`/`orderSerialNumber` 事务自增生成 `serialNumber`。
  - 按扁平结构映射写入 `orders`：固定 `date=当天 / orderSource='new' / orderAttribute='rental1' / orderType='newBusiness' / status='unknown'`，`salesChannel`、`brand/productName/specification` 取自插件选择，原 `goodsTitle` 入 `customerRemark`，`paidRent` 暂忽略；并回写导入日志。
  - 返回 CloudBase「HTTP 访问服务」集成响应（带真实状态码 + `{success,code,message,data}`）。
- 已在 `cloudbaserc.json` 注册该函数。
- 插件侧（hc-order-assist）已配套：`background.js` 透传新字段 + `getHcAdminProductModels` 消息处理（带 15s 超时）；`content-script.js` 导入弹窗支持销售渠道下拉 + 品牌→货品→规格级联选择。

部署与配置步骤（已用 CloudBase CLI `tcb` 3.3.3 实测，envId `cloud1-8gvbotkt966e5e19`）：

1. 部署函数并一并创建 HTTP 访问路径：
   ```bash
   tcb fn deploy importOrderFromAssist --force \
     --path /api/integrations/hc-order-assist/orders/import \
     -e cloud1-8gvbotkt966e5e19
   ```
   成功后返回访问链接：`https://<envId>.service.tcloudbase.com/api/integrations/hc-order-assist/orders/import`。
2. 配置环境变量 `HC_ORDER_ASSIST_TOKEN`（自定义强随机串）。CLI 方式：在 `cloudbaserc.json` 的该函数下临时加 `envVariables.HC_ORDER_ASSIST_TOKEN`，执行 `tcb config update fn importOrderFromAssist`（提示时选「覆盖更新」），**推送后把 token 从文件删掉，不要提交进仓库**。也可在控制台 → 云函数 → 该函数 → 环境变量 中直接配置。
3. 开启 **HTTP 访问服务总开关**（首次必做）：`tcb service switch`（选「开启」）。注意首次开启后网关有**几分钟传播延迟**，期间接口会返回 403 `HTTPSERVICE_NONACTIVATED`，属正常现象，稍等重试即可。
4. **手动创建 `order_import_logs` 集合**：CloudBase NoSQL **不会**在首次 `add` 时自动建集合，未建会返回 500 `DATABASE_COLLECTION_NOT_EXIST`。用控制台或 MCP `createCollection` 预先创建。（`orders`、`system_counters` 已存在。）

> ⚠️ **重新部署会清空环境变量**：`tcb fn deploy` / `tcb config update fn` 会用 `cloudbaserc.json` 中该函数的配置覆盖云端。由于仓库里**不保存** token（见第 2 步），每次重新部署后都需要**重新推送一次 `HC_ORDER_ASSIST_TOKEN`**，否则云函数会因取不到 token 而对所有请求返回 500。

插件侧（hc-order-assist 仓库）配套：

- `config.js` 填 `hcAdmin.apiBase`（HTTP 访问服务域名）、`hcAdmin.importPath`（绑定的路径）、`hcAdmin.apiToken`（与 `HC_ORDER_ASSIST_TOKEN` 相同）。
- 若访问域名非 `localhost`，在 `manifest.json` 的 `host_permissions` 加入该域名。
- background.js / content-script 现有逻辑已满足；`sourceStatusCode` 为可选（云函数有中文兜底）。

后续升级到方案 A（CloudBase 身份贯通）时，仅需把鉴权从静态 token 换成 `getCurrentUser(event)`，其余校验/幂等/映射逻辑可复用。
