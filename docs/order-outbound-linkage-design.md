# 订单 ↔ 出库单 关联与发货回填 设计文档

> 状态：草案（头脑风暴阶段，含待决策项）
> 范围：hc-admin（React 前端 + 云函数）+ stockhelper（微信小程序 + 云函数），同一 CloudBase 环境 `cloud1-8gvbotkt966e5e19`

## 1. 背景与目标

当前订单（`orders`）与出库单（`outbound_records`）**没有持久关联**，只在 hc-admin「发货」对话框里靠 `订单.consignee` 模糊匹配 `出库单.customerName`，手动挑一条把快递单号抄到订单。存在匹配脆弱、无追溯、无货品核对、可重复关联、无库存核对等问题。

本设计要把两者打通成一条可追溯链路，实现：

1. 新建/编辑订单时选择「是否需要出库」；需要出库的订单在操作栏出现「生成出库单」按钮。
2. 点击生成 → 系统创建一条**待出库**的出库单。
3. 允许把**同一客户的多张订单合并**生成同一张出库单。
4. 出库单记录快递方式（包邮/到付/自提）与备注。
5. 小程序首页用卡片展示需要出库的出库单。
6. 小程序录入发货信息（照片、快递单号）并完成发货后，系统**自动把物流单号回填到关联订单**。

## 2. 现状检查（截至草案时）

| 项 | 现状 |
| --- | --- |
| 订单「是否需要出库」字段 | ❌ 不存在 |
| 订单「生成出库单」按钮 | ❌ 不存在（仅有手动匹配已有出库单的「发货」对话框，`Orders.tsx:878` `handleShipOpen`） |
| 出库单状态字段 | ⚠️ 查询侧已支持 `outboundStatus='pending'`（`queryRecords`），**但无任何地方创建 pending 出库单** |
| 小程序待出库计数 | ⚠️ 首页已有 `pendingOutboundTotal`（`index.js:loadPendingOutboundOrders`，仅计数，非列表） |
| 小程序出库状态徽标 | ⚠️ query 页已渲染 `outboundStatus`（`query.wxml`） |
| 小程序出库创建 | `saveOutbound` 存 customerName/outboundDate/trackingNumber/phoneModels/phonePhotos，**无状态、无 orderId、不回填订单** |
| 订单↔出库回填 | ❌ 无（hc-admin 发货对话框是单向抄单号，出库单不回写 orderId） |

**结论**：查询/展示侧有部分脚手架可复用，创建侧（生成待出库单）与回填侧（完成发货写回订单）需新建。

## 3. 数据模型变更

### 3.1 `orders`（新增字段）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `needsOutbound` | boolean | 是否需要出库。手工建单由用户勾选；赞晨导入订单默认 `true`（本就是待发货） |
| `outboundRecordId` | string | 关联的出库单 `_id`。生成后回填，用于防重复生成 + 完成发货时反查 |

> 复用已有字段：`shippingFee`（`prepaid` 包邮 / `cod` 到付 / `pickup` 自提）、`trackingNumber`、`status`（`unknown`=待发货 `--` → `shipped`）、`consignee/consigneePhone/consigneeAddress`、`customerName`。

### 3.2 `outbound_records`（新增/规范字段）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `outboundStatus` | 'pending' \| 'completed' | 待出库 / 已出库。**无此字段的历史记录一律视为 completed**（兼容旧数据） |
| `orderIds` | string[] | 关联的订单 `_id` 列表（支持合并多订单，需求3） |
| `shippingMethod` | string | 快递方式：`prepaid`/`cod`/`pickup`（取自订单 `shippingFee`，需求4） |
| `remark` | string | 备注（需求4；字段已存在） |
| `source` | 'order' \| 'manual' | **来源标记（必填，列表/详情展示）**：`order`=由订单生成；`manual`=手工创建（hc-admin 或小程序直接建，无来源订单）。历史无此字段的记录按 `manual` 兜底 |
| `consignee` / `consigneePhone` / `consigneeAddress` | string | 收货信息（从订单复制，便于小程序发货贴单） |

> 复用已有字段：`customerName`、`outboundDate`、`trackingNumber`、`phoneModels[]`、`phonePhotos[]`、`hasIssue`。
> `phoneModels[]` 由关联订单的货品聚合而来：每个订单货品 `品牌/货品/规格` 拼成 `model`，`quantity` 取订单数量；合并订单时相同 `model` 数量累加。

## 4. 流程设计（对应需求 1–6）

### 4.1 需求1：订单选择是否需要出库 + 生成按钮

- 订单**新建/编辑表单**增加「需要出库」开关 → 写 `needsOutbound`。
  - 手工建单：**默认值仅由「订单类型」自动判定，销售渠道不参与**（决策②=C），用户仍可手动改。

    | 订单类型 | 是否寄出实物 | `needsOutbound` 默认 |
    | --- | --- | --- |
    | `newBusiness` 新增业务 | 是 | **true** |
    | `postRentalShip` 租后发货 | 是 | **true** |
    | `postRentalReturn` 租后退货 | 否（退回=入库方向） | false |
    | `postRentalPayment` 租后款项 | 否（纯款项） | false |
    | `deposit` 押金 | 否（纯款项） | false |

    - **覆盖**：`isVirtualProductOrder`（虚拟货品单，本就 `noShip`）→ 一律 `false`，忽略上表。
  - 赞晨导入：`importOrderFromAssist` 默认 `needsOutbound=true`。
- 订单列表**操作栏**的「生成出库单」按钮，仅当满足：`needsOutbound===true` 且 `status` 为待发货 且 `outboundRecordId` 为空 时显示。

### 4.2 需求2：生成待出库单

- 点击「生成出库单」→ 调用新云函数 `generateOutboundFromOrders(orderIds=[单个])`：
  1. 校验订单存在、需要出库、未生成过。
  2. 创建 `outbound_records`：`outboundStatus='pending'`、`orderIds`、`phoneModels`（聚合）、`shippingMethod`=订单 `shippingFee`、`consignee` 信息、`source='order'`。
  3. 回写每个订单 `outboundRecordId = 新出库单._id`。
  4. 幂等：事务内校验 `outboundRecordId` 为空，防并发重复生成。

### 4.3 需求3：合并多订单生成一个出库单

- 订单列表支持**多选**（勾选框），点「合并生成出库单」。
- 校验：所选订单**同一客户**（`customerName` 或 `consignee` 一致）、均 `needsOutbound`、均未生成过。
- **快递方式在生成时统一选择一个**（决策①），写入出库单 `shippingMethod`，不逐单沿用订单各自的 `shippingFee`。
- 生成**一张** `outbound_records`，`orderIds=[全部]`，`phoneModels` 合并聚合（同 model 累加），并回写每个订单的 `outboundRecordId`。
- 单张订单生成也走同一入口：生成时弹出「统一选择快递方式」（默认带入订单 `shippingFee`，可改）。

### 4.4 需求4：出库单含快递方式与备注

- `shippingMethod`（包邮/到付/自提）**生成时统一选择**（决策①）；`remark` 可在生成时或小程序端编辑。

> **库存（决策③）**：生成出库单与完成发货**均不校验、不占用、不扣减库存**——库存模型尚未上线。后续库存上线时再作为独立增强接入。

### 4.5 需求5：小程序待出库卡片

- 复用 `queryRecords`（`type='outbound'`, `pendingOnly=true`，已支持）。
- 小程序首页把现有 `pendingOutboundTotal` 计数扩展为**卡片列表**：展示客户、型号汇总、快递方式、备注；点击进入发货录入。
- 建议新增独立「待出库」页承载列表 + 进入完成发货表单。

### 4.6 需求6：完成发货 + 自动回填订单

- 小程序打开某待出库单，录入 `trackingNumber` + `phonePhotos`，点「完成发货」。
- 调用新云函数 `completeOutbound(outboundId, trackingNumber, phonePhotos, remark?)`：
  1. 置 `outboundStatus='completed'`，保存单号与照片。
  2. **自动回填（不覆盖，决策⑤）**：对 `orderIds` 中每个订单：
     - 若订单**已是 `shipped` 或已有 `trackingNumber`** → **跳过回填**（不覆盖已有单号），仅记录/提示。
     - 否则更新 `trackingNumber`=出库单单号、`status='shipped'`、`shippingFee`=`shippingMethod`。
  3. 事务/批量，保证出库单与订单状态一致；跳过的订单在返回结果中列出，便于人工核对。
- 该流程**自动化并取代** hc-admin 现有手动匹配发货对话框（对「由订单生成」的出库单而言）。

### 4.7 手工创建出库单 + 旧手动匹配（保留，决策④）

- **手工创建**：允许在 hc-admin / 小程序直接新建出库单（不来自订单），`source='manual'`、`orderIds=[]`。用于特殊情况（无对应订单、临时补录等）。
- **旧「发货对话框」保留**：对**没有 `outboundRecordId`** 的订单，仍可用旧流程按 `consignee`↔`customerName` 模糊匹配、手动挑一条 `manual`/历史出库单，把单号抄到订单。
  - 建议增强：手动匹配成功时，也把该订单 `_id` 追加进出库单 `orderIds`、并回写订单 `outboundRecordId`，让「手工路径」也留下双向可追溯链路。
- 两条路径共存：**由订单生成**的走「生成→完成→自动回填」；**先有出库单**的走「手动匹配」。`source` 字段用于区分与统计。

## 5. 云函数

| 函数 | 归属 | 职责 | 鉴权 |
| --- | --- | --- | --- |
| `generateOutboundFromOrders` | hc-admin（新增） | 单/多订单 → 生成待出库单 + 回写 `outboundRecordId` | 双鉴权（网页 `getCurrentUser`，参见记录类函数） |
| `completeOutbound` | 共享（新增/扩展 saveOutbound） | 完成发货 → 置 completed + 回填订单 | 小程序 `OPENID` + 网页 `getCurrentUser` 双鉴权 |
| `queryRecords` | hc-admin（已有） | `pendingOnly` 待出库查询（已支持，复用） | 已双鉴权 |

> 注意跨仓库同名函数去重原则：`completeOutbound` 只保留**一份源码**（建议 hc-admin 为 owner），避免两个仓库分叉部署互相覆盖（见近期 `queryRecords` 等去重教训）。

## 6. 兼容与迁移

- 旧 `outbound_records` 无 `outboundStatus` → 视为 `completed`，不出现在待出库列表。
- 旧订单无 `needsOutbound` → 视为 `false`（不显示生成按钮），或按需批量回填。
- hc-admin 现有手动「发货匹配」对话框：**保留**（决策④），与新流程长期并存；对已生成出库单的订单走自动回填，历史/手工出库（`source='manual'`）仍可手动匹配。

## 7. 决策记录 / 待决策

### 已定
- ✅ **① 合并快递方式**：生成时**统一选择一个** `shippingMethod`（不逐单沿用）。
- ✅ **② 需要出库默认值**：**仅按订单类型**自动判定（渠道不参与，=C），映射表见 §4.1；`newBusiness`/`postRentalShip` 默认 `true`，其余 `false`，虚拟货品单强制 `false`。用户可手动改。
- ✅ **③ 库存**：**不校验、不占用、不扣减**（库存模型未上线）。
- ✅ **⑤ 回填不覆盖**：订单已 `shipped` 或已有 `trackingNumber` 时**跳过**，不覆盖已有单号。
- ✅ **④ 手动匹配流程保留**：旧「发货对话框」**保留**；特殊情况允许**手工创建出库单**（`source='manual'`）。出库单**必须标明来源** `source`（`order` 订单生成 / `manual` 手工创建），列表/详情均展示。

### 待决策
1. **一订单多货品聚合**：确认 `phoneModels[]` 的 `model` 拼写规则（`品牌 / 货品 / 规格`，与小程序一致），跨品牌保留多条、同 model 累加数量。
2. **撤销/删除解链**：待出库单被删或订单被删时如何解链（清 `outboundRecordId`、从 `orderIds` 移除）。
3. **权限**：生成出库单 / 完成发货 分别需要哪些 `actionPermissions`（如 `outbound:create` / `orders:update`）。

## 8. 实施方案（可落地细化）

### 8.1 字段落库清单

**`orders`（写入点：`saveOrders` / `updateOrder`）**

| 字段 | 类型 | 默认 | 写入时机 |
| --- | --- | --- | --- |
| `needsOutbound` | boolean | 按 §4.1 订单类型矩阵计算 | 建单/编辑保存 |
| `outboundRecordId` | string | `''` | 生成出库单时回写；解链时清空 |

**`outbound_records`（写入点：`generateOutboundFromOrders` / `completeOutbound` / 手工创建）**

| 字段 | 类型 | 生成时 | 完成时 |
| --- | --- | --- | --- |
| `outboundStatus` | 'pending'\|'completed' | `pending` | `completed` |
| `orderIds` | string[] | 关联订单 | 不变 |
| `source` | 'order'\|'manual' | `order` | 不变 |
| `shippingMethod` | string | 统一选择 | 不变 |
| `remark` | string | 可填 | 可补填 |
| `customerName` | string | 取订单 | 不变 |
| `consignee`/`consigneePhone`/`consigneeAddress` | string | 取订单 | 不变 |
| `phoneModels` | PhoneModelItem[] | 聚合(见 8.2) | 不变 |
| `outboundDate` | string | `''` | 完成当天 |
| `trackingNumber` | string | `''` | 录入 |
| `phonePhotos` | string[] | `[]` | 录入 |

### 8.2 phoneModels 聚合规则（定 §7.1）

- 每个订单货品 → `model` 字符串，规则**与小程序一致**：
  `规格 !== '默认' ? '品牌 / 货品 / 规格' : '品牌 / 货品'`，`quantity` 取订单 `quantity`。
- 合并多订单：相同 `model` **累加 quantity**；不同 `model`（含跨品牌）**各保留一条**。

### 8.3 云函数接口

**`generateOutboundFromOrders`（hc-admin 新增，权限 `outbound:create`，双鉴权）**
- 入参：`{ orderIds: string[], shippingMethod: string, remark?: string }`
- 事务逻辑：
  1. 载入订单，校验：存在、`needsOutbound===true`、`status` 为待发货(`unknown`)、`outboundRecordId` 为空、**同一 `customerName`**、非虚拟货品单。
  2. 聚合 `phoneModels`（8.2）。
  3. 建 `outbound_records`（`outboundStatus='pending'`, `source='order'`, `orderIds`, `shippingMethod`, `remark`, 客户/收货信息, `phoneModels`）。
  4. 回写每个订单 `outboundRecordId = 新出库单._id`。
- 出参：`{ success, outboundId }`；异常：`MIXED_CUSTOMER` / `ALREADY_GENERATED` / `INVALID_STATUS` 等。

**`completeOutbound`（共享，hc-admin 为唯一 owner，权限 `outbound:update` + `orders:update`，双鉴权）**
- 入参：`{ outboundId: string, trackingNumber: string, phonePhotos?: string[], remark?: string }`
- 逻辑：
  1. 载入出库单，须 `outboundStatus==='pending'`。
  2. 置 `completed`、写 `trackingNumber`/`phonePhotos`/`outboundDate=今天`/`remark`。
  3. 逐个 `orderIds` 回填（**不覆盖，决策⑤**）：订单已 `shipped` 或已有 `trackingNumber` → 跳过；否则写 `trackingNumber`、`status='shipped'`、`shippingFee=shippingMethod`。
- 出参：`{ success, backfilled: string[], skipped: string[] }`（跳过项供人工核对）。

### 8.4 hc-admin UI

- **建单/编辑表单**：新增「需要出库」开关，默认按订单类型矩阵（§4.1）计算，切换订单类型时联动默认值，用户可改。
- **订单列表操作栏**：`needsOutbound && 待发货 && !outboundRecordId` 时显示「生成出库单」→ 弹窗选 `shippingMethod`（默认带入订单 `shippingFee`）+ 备注 → 调 `generateOutboundFromOrders([orderId])`。
- **合并生成**：列表加多选框 + 批量「合并生成出库单」；前端校验同客户，弹一个统一 `shippingMethod` 选择。
- **详情/列表**：展示 `source`、`outboundRecordId`（可跳出库单）。
- **旧发货对话框保留**（决策④），供 `manual`/历史出库单手动匹配；匹配成功增强回写 `orderIds`+`outboundRecordId`。

### 8.5 小程序 UI

- **首页**：把现有 `pendingOutboundTotal` 计数扩成**待出库卡片列表**（`queryRecords` `type='outbound'` `pendingOnly=true`）。卡片显示客户、型号汇总、快递方式、备注，点击进「完成发货」。
- **完成发货表单**：预填出库单信息，录入 `trackingNumber`（+ 拍照 `phonePhotos`）→ 调 `completeOutbound`。
- **手工创建出库单**（`source='manual'`）：阶段2，复用现有出库录入表单，`orderIds=[]`。

> **现状（已存在脚手架）**：小程序首页已有「待处理出库单」入口卡（计数徽标）→ 跳 `query` 页按 `pendingOnly` 列出待出库记录（状态徽标 未出库/已出库）；`query` 详情弹窗已有「完成发货」区块（单号输入 + 按钮），调用 `completeOutbound`。**阶段1 只需部署 `completeOutbound` 云函数即闭环**，无需新增小程序代码。
> **阶段2 增强**：完成发货时的**拍照上传**（现有完成流程为纯单号，未含照片）。

### 8.6 权限（定 §7.3）

| 动作 | 权限点 |
| --- | --- |
| 保存 `needsOutbound` | 沿用 `orders:create` / `orders:update` |
| 生成出库单 | `outbound:create` |
| 完成发货（含回填订单） | 仅 `outbound:update`（订单回填为系统副作用，不再单独要 `orders:update`，避免只有库存权限的仓管被拦） |
| 手工创建出库单 | `outbound:create` |

### 8.7 删除 / 解链（定 §7.2）

- **删待出库单**（pending）：清空其 `orderIds` 对应订单的 `outboundRecordId`；`completed` 出库单删除需二次确认。
- **删订单**：从其所属出库单 `orderIds` 移除该 id；若 `orderIds` 变空 → 提示/标记该出库单。
- 实现落在 `deleteOrder` / `deleteOutboundRecord`。

### 8.8 分阶段落地

- **阶段1（MVP）**：`needsOutbound` 字段+默认矩阵；**单订单**生成出库单；小程序待出库列表 + 完成发货 + 回填（不覆盖）。跑通「订单→生成→完成→回填」主链路。
- **阶段2**：合并多订单生成；手工创建出库单（`source='manual'`）+ 来源展示；旧手动匹配增强回写 `orderIds`。
- **阶段3**：删除解链；权限点接入；旧数据兼容兜底（`outboundStatus`/`source` 缺省处理）。

## 9. 关联文档

- 订单导入：`docs/order-assist-import-design.md`
- 订单建单规则：`.codebuddy/rules/order-create-rules.md`
