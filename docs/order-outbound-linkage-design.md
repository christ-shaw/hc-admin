# 订单-出库联动系统设计文档

> 版本：v1.1  
> 日期：2026-06-21

---

## 1. 需求概述

### 1.1 业务目标

打通订单系统与出库系统的数据流转，实现"订单创建 → 自动生成出库单 → 出库完成 → 自动回填物流信息"的全链路闭环。

### 1.2 核心需求

| # | 需求 | 说明 |
|---|------|------|
| 1 | 出库状态 | 出库记录新增 `待出库` / `已出库` 两个状态 |
| 2 | 自动生成出库单 | 订单录入且判定为需要实物出库后，自动在出库记录中创建一条"待出库"记录，含自动生成的出库编号 |
| 3 | 订单-出库关联 | 订单与出库单之间建立双向关联 |
| 4 | 出库完成回写 | 出库同事通过微信小程序完成出库后，自动将物流单号回填到订单，并将订单状态改为"已发货" |

### 1.3 角色与职责

| 角色 | 操作 | 系统 |
|------|------|------|
| 客服/销售 | 录入订单 | Web 管理端 |
| 出库同事 | 扫描出库、填写物流单号 | 微信小程序 |
| 系统 | 自动生成出库单、回写物流信息 | 云函数 |

---

## 2. 数据模型设计

### 2.1 出库记录扩展（OutboundRecord）

```typescript
interface OutboundRecord {
  _id: string;                      // 文档 ID（云数据库自动生成）
  outboundNumber: string;           // 【新增】出库编号，自动生成，如 "CK-20260621-00001"
  outboundStatus: 'pending' | 'completed';  // 【新增】出库状态：待出库 / 已出库（作废、异常不复用该字段）
  customerName: string;             // 客户名称
  consignee?: string;               // 【新增】收货人（从订单同步）
  consigneePhone?: string;          // 【新增】收货人电话（从订单同步）
  consigneeAddress?: string;        // 【新增】收货人地址（从订单同步）
  outboundDate: string;             // 计划/关联出库日期（创建时 = 订单日期，完成时不覆盖）
  completedDate?: string;           // 【新增】实际出库完成时间
  completedBy?: string;             // 【新增】出库操作人
  trackingNumber?: string;          // 物流单号（出库完成时由小程序回填）
  phoneModels: PhoneModelItem[];    // 手机型号+数量（从订单货品同步）
  linkedOrderId?: string;           // 【新增】关联的订单 _id（手工出库单可为空）
  linkedOrderSerialNumber?: number; // 【新增】关联的订单序号（冗余，方便展示）
  source: 'order' | 'manual';       // 【新增】来源：订单自动生成 / 手工录入
  linkedOrderStatus?: 'active' | 'deleted' | 'missing'; // 【新增】关联订单状态，不复用 source
  remark?: string;                  // 备注
  createTime?: { $date: string };
}
```

### 2.2 订单记录扩展（OrderRecord）

```typescript
interface OrderRecord {
  // ... 现有字段保持不变 ...
  
  linkedOutboundId?: string;        // 【新增】关联的出库单 _id
  linkedOutboundNumber?: string;    // 【新增】关联的出库编号（冗余，方便展示）
  outboundSyncStatus?: 'none' | 'pending' | 'completed';  // 【新增】出库同步状态：无出库 / 待出库 / 已出库
}
```

### 2.3 出库编号规则

| 规则 | 说明 |
|------|------|
| 格式 | `CK-YYYYMMDD-NNNNN` |
| 示例 | `CK-20260621-00001` |
| 日期部分 | 按订单日期 |
| 流水号 | 每天从 00001 开始，通过 `system_counters` 的 `db_counter_outbound_YYYYMMDD` 计数器自增 |
| 唯一性 | 计数器事务保证 |

### 2.4 状态流转图

```
订单创建/编辑（需要实物出库，且订单仍处于待发货状态）
    │
    ├─→ 出库单自动生成（outboundStatus = 'pending'）
    │       出库编号自动分配
    │       订单 ←→ 出库单 双向关联建立
    │
    │    ┌── 订单无需发货（虚拟产品/租后款项等）
    │    │       不生成出库单
    │    
    ▼
出库同事在小程序完成出库
    │
    ├─→ 扫描确认货品
    ├─→ 填写物流单号
    ├─→ 点击"确认出库"
    │
    ▼
云函数 completeOutbound
    │
    ├─→ 更新出库单：outboundStatus = 'completed'
    ├─→ 回写出库单：completedDate / completedBy / trackingNumber
    │
    ├─→ 更新订单：trackingNumber = 物流单号
    ├─→ 更新订单：status = 'shipped'
    ├─→ 更新订单：outboundSyncStatus = 'completed'
    │
    └─→ 记录操作日志
```

---

## 3. 架构设计

### 3.1 数据流

```
┌──────────────┐    saveOrders     ┌──────────────────┐
│  Web 管理端   │ ─────────────────→ │  saveOrders 云函数  │
│  (录入订单)   │                    │                    │
└──────────────┘                    │  1. 保存订单        │
                                    │  2. 检查是否需要实物出库│
                                    │  3. 自动创建出库单   │
                                    │  4. 建立双向关联    │
                                    └────────┬───────────┘
                                             │
                    ┌────────────────────────┘
                    ▼
          ┌─────────────────────┐
          │  CloudBase 数据库    │
          │  ├─ orders          │
          │  ├─ outbound_records│
          │  └─ system_counters │
          └──────────┬──────────┘
                     │
                     │ 查询待出库记录
                     ▼
┌──────────────┐    ┌──────────────────────┐
│ 微信小程序     │ ←─ │ queryRecords/queryOutbound │
│ (出库同事)    │    │ 返回待出库列表         │
└──────┬───────┘    └──────────────────────┘
       │
       │ 完成出库 + 物流单号
       ▼
┌──────────────────┐
│ completeOutbound  │
│ 云函数             │
│                    │
│ 1. 更新出库状态     │
│ 2. 回填物流单号到订单│
│ 3. 修改订单状态     │
└──────────────────┘
```

### 3.2 哪些订单需要自动生成出库单

> 注意：当前系统中 `shipped` 表示"已发货"，并且会要求填写物流单号。因此不能用 `status === 'shipped'` 作为创建待出库单的触发条件。出库单应在订单仍处于待发货状态时生成，出库完成后才将订单状态更新为 `shipped`。

| 条件 | 生成出库单？ |
|------|:-----------:|
| 订单状态为 `unknown` / `--`，且需要实物出库 | ✅ 是 |
| 订单状态为 `shipped`（已发货） | ❌ 否 |
| 订单状态为 `noShip`（不用发货，如虚拟产品、仅退款） | ❌ 否 |
| 订单已有 `linkedOutboundId`（避免重复生成） | ❌ 否 |
| 编辑订单时已有待出库单 | ❌ 不重复生成，仅同步收货人/货品等可变信息 |
| 编辑订单时已有已完成出库单 | ❌ 不自动修改，由人工处理 |

推荐封装统一判断函数：

```typescript
function shouldGenerateOutbound(order: OrderRecord) {
  return requiresPhysicalShipment(order)
    && isPendingShipmentStatus(order.status)
    && !order.linkedOutboundId;
}

function isPendingShipmentStatus(status?: string) {
  return status === 'unknown' || status === '--' || !status;
}
```

### 3.3 出库单生成时机

**新增订单：**
- `requiresPhysicalShipment(order) && isPendingShipmentStatus(status)` → 自动生成出库单
- `status === 'noShip'`、虚拟产品、仅退款、退租金等无实物出库场景 → 不生成
- `status === 'shipped'` 且已有物流单号 → 视为历史/已发货订单，不生成待出库单

**编辑订单：**
- 原本不需要出库，改为需要实物出库且仍处于待发货状态 → 自动生成出库单
- 原本已有关联待出库单 → 同步更新收货人、收货地址、货品明细等信息
- 已有关联出库单且 `outboundStatus === 'completed'` → 不自动修改，由人工创建补发/异常处理流程
- 订单从待发货改为 `noShip` → 不自动删除出库单，标记待人工确认

---

## 4. 接口设计

### 4.1 云函数：saveOrders（修改）

**新增逻辑：** 保存订单后，检查是否需要自动生成出库单。

```
保存订单成功
    │
    ├─ shouldGenerateOutbound(order)？
    │   ├─ 是 → 调用 generateOutboundRecord(order)
    │   └─ 否 → 跳过
    │
    └─ 返回 { ..., outbound: { ... } }
```

`saveOrders` 当前承担批量保存职责，联动出库时需要按单处理部分成功/失败：

```
for each order:
  开始事务
    ├─ 创建/更新订单
    ├─ 如需出库：生成出库编号
    ├─ 如需出库：创建 pending 出库单
    └─ 回写订单 linkedOutboundId / linkedOutboundNumber / outboundSyncStatus
  提交事务
```

返回结果建议包含每条订单的保存与出库创建状态，避免出现"订单已保存但出库单失败"时前端无法感知。

### 4.2 云函数：generateOutboundRecord（新增）

| 字段 | 值 |
|------|-----|
| `outboundNumber` | 自动生成 `CK-YYYYMMDD-NNNNN` |
| `outboundStatus` | `'pending'` |
| `customerName` | 从订单同步 |
| `consignee` | 从订单同步 |
| `consigneePhone` | 从订单同步 |
| `consigneeAddress` | 从订单同步 |
| `outboundDate` | 从订单日期，作为计划/关联出库日期 |
| `phoneModels` | 从订单货品转换（brand + productName → model，quantity） |
| `linkedOrderId` | 订单 _id |
| `linkedOrderSerialNumber` | 订单 serialNumber |
| `source` | `'order'` |

### 4.3 云函数：queryRecords / queryOutbound（修改）

**修改：** 当前 Web 端出库列表调用通用 `queryRecords`。本方案可选择改造 `queryRecords`，或新增小程序专用 `queryOutbound`；两者必须保持同一套筛选语义。小程序端查询 `pending` 状态的出库单。

```
输入: { type: 'outbound', outboundStatus: 'pending', customerName?, ... }
输出: { data: OutboundRecord[] }
```

### 4.4 云函数：completeOutbound（新增）

**用途：** 微信小程序调用，完成出库。

```
输入: {
  outboundId: string,       // 出库单 _id
  trackingNumber: string,   // 物流单号
  completedBy: string,      // 出库操作人
  phoneModels?: PhoneModelItem[],  // 实际出库型号（可修正）
}
```

**逻辑：**
1. 校验出库单存在且状态为 `pending`
2. 更新出库单：`outboundStatus = 'completed'`、`completedDate`、`completedBy`、`trackingNumber`
3. 查询关联订单
4. 更新订单：`trackingNumber`、`status = 'shipped'`、`outboundSyncStatus = 'completed'`
5. 记录操作日志

### 4.5 云函数：updateOutbound（新增/修改）

**场景：** 手工修改出库记录（Web 管理端），同步更新关联订单。

建议命名与现有系统对齐：
- 若沿用通用函数：改造 `updateRecord(type='outbound')`
- 若新增专用函数：新增 `updateOutbound`

同步规则：
- 仅允许自动同步 `pending` 出库单的收货信息、货品明细、备注
- 已 `completed` 的出库单不自动覆盖订单，物流号变更需走人工确认
- 若修改 `trackingNumber` 并确认同步订单，需要记录操作日志

---

## 5. 前端实现（Web 管理端）

### 5.1 出库管理页面改造

#### 5.1.1 新增字段展示

| 列 | 说明 |
|----|------|
| 出库编号 | `outboundNumber`，独立列 |
| 出库状态 | `outboundStatus`：待出库 🟡 / 已出库 🟢 |
| 关联订单 | `linkedOrderSerialNumber`，可点击跳转 |
| 来源 | `source`：订单同步 / 手工录入 |

#### 5.1.2 状态筛选

筛选栏新增"出库状态"下拉：全部 / 待出库 / 已出库

#### 5.1.3 出库详情弹窗

| 区块 | 字段 |
|------|------|
| 基本信息 | 出库编号、出库状态、出库日期、完成日期、来源、操作人 |
| 关联订单 | 订单序号（可点击）、客户名称、收货信息 |
| 货品明细 | 型号、数量表格 |
| 物流信息 | 物流单号 |
| 操作日志 | 出库/回写时间线 |

### 5.2 订单详情增加出库关联

订单详情弹窗中显示：
- 关联出库编号（可点击跳转）
- 出库状态徽章
- 出库同步状态

### 5.3 出库详情新增 Tab

出库详情中新增「关联订单」Tab，展示订单摘要信息：

```
┌─────────────────────────────────────┐
│ 出库单 CK-20260621-00001    [详情]  │
├─────────────────────────────────────┤
│ [基本信息] [货品明细] [关联订单]     │
│                                     │
│ 关联订单                            │
│ 序号: 12345                         │
│ 客户: 张三                          │
│ 货品: 品牌 / 产品名 / 规格          │
│ 订单状态: 已发货 🟢                  │
│ [查看完整订单 →]                    │
└─────────────────────────────────────┘
```

---

## 6. 微信小程序端（简要设计）

### 6.1 待出库列表页

```
┌─────────────────────────┐
│ 待出库任务               │
├─────────────────────────┤
│ CK-20260621-00001       │
│ 客户: 张三              │
│ 型号: iPhone 15 × 1    │
│ 收货: 北京朝阳区...     │
│ [确认出库 →]            │
├─────────────────────────┤
│ CK-20260621-00002       │
│ ...                     │
└─────────────────────────┘
```

### 6.2 出库确认页

```
┌─────────────────────────┐
│ 确认出库                 │
│                         │
│ 出库编号: CK-...00001   │
│ 客户: 张三              │
│                         │
│ 货品清单:               │
│ ☑️ iPhone 15 128G × 1  │
│ ☑️ AirPods × 1         │
│                         │
│ 物流单号: [___________] │
│   [扫码录入]            │
│                         │
│ [确认出库]              │
└─────────────────────────┘
```

### 6.3 API 调用

| 操作 | 云函数 | 说明 |
|------|--------|------|
| 获取待出库列表 | `queryRecords` 或 `queryOutbound` + `outboundStatus: 'pending'` | 分页查询 |
| 出库确认 | `completeOutbound` | 更新出库+回写订单 |

---

## 7. 数据一致性保障

### 7.1 事务保护

`completeOutbound` 云函数使用数据库事务：

```
开始事务
  ├─ 读取出库单，验证状态 = pending
  ├─ 更新出库单（status/date/tracking）
  ├─ 读取关联订单
  ├─ 更新订单（tracking/status）
  └─ 写入操作日志
提交事务
```

`saveOrders` / `updateOrder` 中的出库单生成也应使用事务，至少保证同一订单的以下操作要么全部成功，要么全部失败：
- 订单保存/更新
- 出库编号计数器自增
- 出库单创建
- 订单关联字段回写

### 7.2 异常处理

| 场景 | 处理 |
|------|------|
| 事务冲突 | 重试最多 3 次 |
| 订单已删除 | 仍完成出库，日志中记录异常 |
| 重复出库 | 校验状态 = pending，否则拒绝 |
| 网络超时 | 返回错误，由小程序重试 |
| 订单已是 `shipped` 且有物流单号 | 不创建待出库单，避免重复发货 |
| 订单从待发货改为 `noShip` | 保留待出库单并标记待人工确认 |

### 7.3 幂等性

- `generateOutboundRecord`：检查 `linkedOrderId` → `linkedOutboundId` 是否已有，防止重复生成
- `generateOutboundRecord`：建议额外用 `linkedOrderId` 建唯一约束/唯一索引语义，避免并发编辑重复创建
- `completeOutbound`：检查 `outboundStatus` 是否为 `pending`
- `completeOutbound`：若已完成且传入的 `trackingNumber` 与已记录一致，返回成功，便于小程序网络超时后安全重试；若物流号不同，返回冲突

### 7.4 权限与日志

| 操作 | 权限建议 | 日志 |
|------|----------|------|
| 自动生成出库单 | 系统权限 | 记录订单号、出库编号、触发来源 |
| 小程序完成出库 | 出库角色 | 记录操作人、物流号、完成时间 |
| 手工修改关联出库单 | 管理端出库编辑权限 | 记录修改字段和是否同步订单 |
| 删除/作废出库单 | 管理员或主管权限 | 记录原因，不建议硬删除 |

---

## 8. 实施计划

### 阶段 0：状态语义确认 + 历史数据盘点（0.5 天）

| 步骤 | 内容 |
|------|------|
| 0.1 | 确认订单状态中"待发货"使用 `unknown` / `--`，`shipped` 仅表示已发货 |
| 0.2 | 统一文档与代码中的不用发货状态为 `noShip` |
| 0.3 | 盘点历史订单和出库记录，确认迁移范围 |

### 阶段 1：数据模型 + 基础设施（0.5 天）

| 步骤 | 内容 |
|------|------|
| 1.1 | `system_counters` 创建出库编号计数器文档 `db_counter_outbound_YYYYMMDD` |
| 1.2 | 修改 `OutboundRecord` 类型，新增出库编号、状态、关联订单、完成信息等字段 |
| 1.3 | 修改 `OrderRecord` 类型，新增 3 个字段 |

### 阶段 2：云函数开发（1 天）

| 步骤 | 内容 |
|------|------|
| 2.1 | 实现 `getAndIncrementOutboundCounter` 出库编号生成函数 |
| 2.2 | 修改 `saveOrders` 云函数：订单保存后按 `shouldGenerateOutbound` 自动生成出库单 |
| 2.3 | 修改 `queryOrders` 云函数：返回关联出库信息 |
| 2.4 | 修改 `queryRecords` 或新增 `queryOutbound`：支持 `outboundStatus` 筛选 |
| 2.5 | 新增 `completeOutbound` 云函数：出库完成 + 订单回写 |
| 2.6 | 部署并测试 |

### 阶段 3：前端改造（1 天）

| 步骤 | 内容 |
|------|------|
| 3.1 | 出库列表页新增出库编号列、出库状态列、关联订单列、状态筛选 |
| 3.2 | 出库详情弹窗新增关联订单 Tab |
| 3.3 | 订单详情弹窗显示关联出库信息 |
| 3.4 | 订单列表页新增出库状态列 |

### 阶段 4：测试（0.5 天）

| 步骤 | 内容 |
|------|------|
| 4.1 | 新增待发货实物订单 → 验证出库单自动生成 |
| 4.2 | 编辑订单 → 验证出库单同步更新 |
| 4.3 | 模拟出库完成 → 验证订单物流号回填和状态变更 |
| 4.4 | 验证待出库/已出库筛选 |
| 4.5 | 验证已发货订单、`noShip` 订单、虚拟产品不会生成待出库单 |

### 阶段 5：历史数据迁移（0.5 天）

| 步骤 | 内容 |
|------|------|
| 5.1 | 给旧出库记录补 `outboundStatus`：有物流号默认为 `completed`，无物流号默认为 `pending` 或人工确认 |
| 5.2 | 给旧出库记录补 `outboundNumber`，可使用迁移专用前缀或按历史日期生成 |
| 5.3 | 尝试按物流号、客户名、日期关联旧订单；无法可靠匹配的保持未关联 |
| 5.4 | 迁移完成后抽样校验订单-出库双向关联 |

---

## 9. 边界情况

| 场景 | 处理策略 |
|------|----------|
| 订单删除 | 不自动删除出库单，设置 `linkedOrderStatus = 'deleted'`，保留 `source` 原值 |
| 出库单已被人为删除 | 下次编辑订单时重新生成 |
| 订单状态从待发货改为 noShip | 不自动删除出库单，人工确认后手动处理 |
| 同一订单多个货品 | 生成一条出库单，phoneModels 包含所有货品 |
| 出库数量与订单数量不一致 | 小程序端可修正数量，但需备注差异原因 |
| 无需要发货的货品（虚拟产品） | 不生成出库单 |
| 小程序重复提交完成出库 | 同一物流号返回成功，不同物流号返回冲突 |
| 已完成出库后订单收货信息被修改 | 不自动覆盖出库单，提示人工确认是否补发/改单 |
