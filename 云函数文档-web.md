# 云函数文档

本文档以当前仓库的 `cloudbaserc.json` 和 `cloud_functions/sendWechatNotification/functions/*/index.js` 为准，描述 HC-Admin Web 管理端可部署的 CloudBase 云函数。

当前函数根目录：

```text
cloud_functions/sendWechatNotification/functions
```

当前运行时：

```text
Nodejs18.15
```

## 调用约定

前端统一通过 `src/lib/cloudbase.ts` 的 `callFunction(name, data)` 调用 CloudBase：

```ts
await callFunction('queryOrders', {
  data: {
    limit: 20,
    cursor: null,
  },
});
```

多数云函数从 `event.data` 读取业务参数；部分基础 CRUD 函数兼容 `event.data || event`。文档中的“请求参数”默认指业务参数对象。

通用返回字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| success | boolean | 是否成功 |
| errMsg | string | 错误或提示信息，失败时通常存在 |
| data | any | 业务数据，查询函数常返回数组或对象 |
| cursor | string \| null | 分页游标，使用 skip 偏移量字符串 |
| hasMore | boolean | 是否还有下一页 |
| total | number | 总数，部分分页查询返回 |

## 当前可部署函数索引

| 分类 | 云函数 | 说明 |
|------|--------|------|
| 订单 | `queryOrders` | 查询订单记录，支持分页和多条件筛选 |
| 订单 | `saveOrders` | 批量保存订单记录 |
| 订单 | `updateOrder` | 更新订单记录 |
| 订单 | `deleteOrder` | 删除订单记录 |
| 出库联动 | `generateOutboundRecord` | 根据待发货订单生成待出库单 |
| 出库联动 | `completeOutbound` | 完成出库并回写订单物流信息 |
| 出库联动 | `cancelOutbound` | 取消订单关联的未完成出库单 |
| 顺丰 | `getSfAccessToken` | 获取并缓存顺丰 OAuth2 accessToken |
| 顺丰 | `applySfExpress` | 调用顺丰下快递单并回写订单 |
| 顺丰 | `querySfOrderResult` | 查询顺丰下单结果并回写订单 |
| 顺丰 | `cancelSfExpress` | 取消顺丰发货并回写订单 |
| 发票 | `queryInvoices` | 查询发票记录 |
| 发票 | `saveInvoice` | 新增发票记录 |
| 发票 | `updateInvoice` | 更新发票记录 |
| 发票 | `deleteInvoice` | 删除发票记录 |
| 发票 | `countPendingInvoices` | 统计待开票数量 |
| 公司模板 | `queryCompanies` | 查询公司模板 |
| 公司模板 | `saveCompany` | 新增公司模板 |
| 公司模板 | `updateCompany` | 更新公司模板 |
| 公司模板 | `deleteCompany` | 删除公司模板 |
| 权限 | `getUserRole` | 获取当前登录用户角色与权限 |
| 权限 | `initializePermissionSystem` | 初始化权限系统 |
| 权限 | `manageRoles` | 管理角色 |
| 权限 | `manageUserRoles` | 管理用户与用户角色 |
| 权限 | `manageLoginLogs` | 记录或查询登录日志 |
| 统计 | `generateDailyShipmentStats` | 生成最近 7 日发货日切统计 |
| 统计 | `queryDailyShipmentStats` | 查询日切发货统计 |
| 工具 | `getAndIncrementCounter` | 获取计数器自增后的新值 |
| 工具 | `manageCounter` | 获取或设置计数器 |
| 工具 | `getCloudFileUrls` | 批量获取云存储临时访问链接 |
| 通知 | `sendWechatNotification` | 发送企业微信群机器人消息 |

## 订单函数

### queryOrders

查询 `orders` 集合，按 `date desc`、`serialNumber desc` 排序。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| limit | number | 否 | 每页数量，默认 20，最大 100 |
| cursor | string | 否 | 分页偏移量，首次查询传空 |
| customerName | string | 否 | 客户姓名，模糊匹配 |
| salesperson | string | 否 | 业务员，精确匹配 |
| salesChannel | string | 否 | 销售渠道，精确匹配 |
| orderType | string | 否 | 订单类型，精确匹配 |
| orderSource | string | 否 | 订单来源，精确匹配 |
| orderAttribute | string | 否 | 订单属性，精确匹配 |
| status | string | 否 | 订单状态，如 `unknown`、`shipped`、`noShip` |
| onlineOrderNumber | string | 否 | 网店订单号，模糊匹配 |
| startDate | string | 否 | 订单日期开始值，`YYYY-MM-DD` |
| endDate | string | 否 | 订单日期结束值，`YYYY-MM-DD` |

返回结果：

```js
{
  success: true,
  data: [],
  cursor: '20',
  hasMore: true,
  total: 120,
  errMsg: '查询成功'
}
```

### saveOrders

批量写入 `orders` 集合，并为每条记录添加 `createTime`。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| orders | Array | 是 | 订单数组，函数会移除每条记录上的 `_id` |

返回结果：

```js
{
  success: true,
  savedCount: 10,
  failedCount: 0,
  errors: undefined,
  errMsg: '成功保存 10 条订单'
}
```

### updateOrder

根据 `_id` 更新 `orders` 集合，并自动写入 `updateTime`。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| _id | string | 是 | 订单 `_id` |
| updateData | object | 是 | 更新字段；函数会忽略 `_id`、`createTime` |

### deleteOrder

根据 `_id` 删除 `orders` 集合中的订单记录。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| _id | string | 是 | 订单 `_id` |

## 订单出库联动

### generateOutboundRecord

根据订单生成一条 `pending` 待出库单，写入 `outbound_records`，并回写订单出库关联字段。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| orderId | string | 是 | 订单 `_id` |

生成条件：

| 条件 | 说明 |
|------|------|
| 订单存在 | 从 `orders` 集合读取 |
| 未关联出库单 | `linkedOutboundId` 和 `linkedOutboundNumber` 为空 |
| 待发货状态 | `status` 为空、`unknown` 或 `--` |
| 需要实物出库 | 排除 `noShip`、品牌为“虚拟产品”、部分虚拟订单类型 |

落库行为：

| 集合 | 行为 |
|------|------|
| `system_counters` | 使用 `db_counter_outbound_YYYYMMDD` 生成日流水 |
| `outbound_records` | 新增 `outboundStatus: 'pending'`、`source: 'order'` 的出库单 |
| `orders` | 回写 `linkedOutboundId`、`linkedOutboundNumber`、`outboundSyncStatus: 'pending'` |

返回结果：

```js
{
  success: true,
  data: {
    outboundId: 'outbound_id',
    outboundNumber: 'CK-20260621-00001',
    outboundStatus: 'pending'
  },
  errMsg: '出库单生成成功'
}
```

注意事项：

1. 函数使用数据库事务，最多重试 3 次。
2. 订单已有关联出库单时幂等返回成功，不重复生成。
3. 该函数不修改订单发货状态，实际发货由 `completeOutbound` 完成。

### completeOutbound

完成出库单，将物流单号回写到关联订单，并写入操作日志。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| outboundId | string | 是 | 出库单 `_id`；也兼容 `_id` |
| trackingNumber | string | 是 | 物流单号 |
| completedBy | string | 否 | 出库操作人 |
| operator | string | 否 | 操作人，`completedBy` 为空时使用 |
| phoneModels | Array | 否 | 实际出库货品明细，格式 `{ model, quantity }[]` |

落库行为：

| 集合 | 行为 |
|------|------|
| `outbound_records` | 更新 `outboundStatus: 'completed'`、物流单号、完成时间和操作人 |
| `orders` | 回写 `trackingNumber`、`status: 'shipped'`、`outboundSyncStatus: 'completed'` |
| `operation_logs` | 写入出库更新日志 |

幂等与异常：

| 场景 | 处理 |
|------|------|
| 已完成且物流号相同 | 返回成功，`idempotent: true` |
| 已完成但物流号不同 | 返回失败，避免覆盖 |
| 当前状态不是 `pending` | 返回失败 |
| 关联订单不存在 | 仍完成出库，返回 `orderMissing: true` |
| 关联订单已发货且物流号不同 | 返回失败 |

### cancelOutbound

取消订单关联的未完成出库单，并清空订单上的出库关联字段。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| orderId | string | 是 | 订单 `_id`；也兼容 `_id` |
| reason | string | 否 | 取消原因，默认“手动取消出库” |
| operator | string | 否 | 操作人 |

落库行为：

| 集合 | 行为 |
|------|------|
| `outbound_records` | 未完成时更新 `outboundStatus: 'cancelled'`、取消时间和原因 |
| `orders` | 清空 `linkedOutboundId`、`linkedOutboundNumber`，设置 `outboundSyncStatus: 'none'` |
| `operation_logs` | 写入出库取消日志 |

注意事项：

1. 已完成出库单不能取消。
2. 订单没有关联出库单时幂等返回成功。
3. 关联出库单不存在时，会清空订单关联，避免订单卡在已生成状态。

## 顺丰函数

顺丰相关函数都使用 `SF_ENV` 区分沙箱和生产，并通过 `getSfAccessToken` 获取 token。业务结果会回写到 `orders` 集合。

常用环境变量：

| 变量 | 说明 |
|------|------|
| SF_ENV | `sandbox` 或 `production`，默认 `sandbox` |
| SF_CLIENT_CODE | 默认顺丰客户编码 |
| SF_SANDBOX_CLIENT_CODE | 沙箱客户编码，优先于 `SF_CLIENT_CODE` |
| SF_PROD_CLIENT_CODE | 生产客户编码，优先于 `SF_CLIENT_CODE` |
| SF_SANDBOX_CHECK_WORD | 沙箱校验码，token 函数必需 |
| SF_PROD_CHECK_WORD | 生产校验码，token 函数必需 |
| SF_SANDBOX_SERVICE_URL | 沙箱业务接口地址，可选 |
| SF_PROD_SERVICE_URL | 生产业务接口地址，可选 |
| SF_PAY_METHOD | 付款方式，默认 `1` |
| SF_MONTHLY_CARD | 月结卡号，可选 |
| SF_EXPRESS_TYPE_ID | 快件产品类别，默认 `1` |
| SF_PARCEL_QTY | 包裹数，默认 `1` |
| SF_SENDER_MAP | 按订单业务员切换寄件人的 JSON 对象 |
| SF_SENDER_CONTACT | 默认寄件人 |
| SF_SENDER_TEL | 默认寄件电话 |
| SF_SENDER_COMPANY | 默认寄件公司，可选 |
| SF_SENDER_PROVINCE | 默认寄件省，可选 |
| SF_SENDER_CITY | 默认寄件市，可选 |
| SF_SENDER_COUNTY | 默认寄件区县，可选 |
| SF_SENDER_ADDRESS | 默认寄件详细地址 |

### getSfAccessToken

获取顺丰 OAuth2 token，并缓存到 `sf_tokens` 集合。返回结果不会暴露明文 token，只返回脱敏值和缓存状态。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| forceRefresh | boolean | 否 | 是否强制刷新 token |
| sfEnv | string | 否 | 调用方期望环境，用于防止环境配置不一致 |

返回结果：

```js
{
  success: true,
  env: 'sandbox',
  cached: true,
  accessTokenMasked: 'abcdef***uvwxyz',
  hasAccessToken: true,
  expiresIn: 7200,
  expiresAt: 1780000000000
}
```

### applySfExpress

根据订单调用顺丰下单接口。下单前要求订单状态为 `unknown` 或 `--`，并校验收件人、手机号、地址和寄件人配置。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| orderId | string | 是 | 订单 `_id` |

主要回写字段：

| 字段 | 说明 |
|------|------|
| status | 成功后写为 `shipped` |
| trackingNumber | 顺丰运单号 |
| expressProvider | `sf` |
| sfEnv | 当前顺丰环境 |
| expressApplyStatus | `applying`、`applied` 或 `failed` |
| sfRequestId | 顺丰请求 ID |
| sfOrderId | 顺丰客户订单号 |
| sfWaybillNo | 顺丰运单号 |
| sfRawResponse | 顺丰原始响应 |

### querySfOrderResult

查询顺丰下单结果，成功后回写订单发货状态和运单号。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| orderId | string | 是 | 订单 `_id` |
| searchType | string | 否 | `1` 正向单，`2` 退货单，默认 `1` |

### cancelSfExpress

取消顺丰发货，成功后将订单状态恢复为 `unknown`，清空物流单号和顺丰运单号。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| orderId | string | 是 | 订单 `_id` |

返回结果：

```js
{
  success: true,
  env: 'sandbox',
  orderId: 'order_id',
  sfOrderId: 'HC_order_id',
  waybillNo: 'SF123456789',
  resStatus: 2
}
```

## 发票函数

### queryInvoices

查询 `invoices` 集合，按 `applyDate desc`、`createTime desc` 排序。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| limit | number | 否 | 每页数量，默认 10 |
| cursor | string | 否 | 分页偏移量 |
| companyName | string | 否 | 单位名称，模糊匹配 |
| applicant | string | 否 | 申请人，模糊匹配 |
| status | string | 否 | 支持 `unpaid`、`paid`、`未开票`、`已开票` 兼容查询 |
| startDate | string | 否 | 申请日期开始值 |
| endDate | string | 否 | 申请日期结束值 |

### saveInvoice

新增发票记录。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| invoice | object | 是 | 发票数据，必须包含 `companyName` |

### updateInvoice

更新发票记录，并自动写入 `updateTime`。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| _id | string | 是 | 发票 `_id` |
| updateData | object | 是 | 更新字段 |

### deleteInvoice

删除发票记录。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| _id | string | 是 | 发票 `_id` |

### countPendingInvoices

统计待开票数量，兼容 `status` 为 `未开票` 和 `unpaid` 的旧新数据。

返回结果：

```js
{
  success: true,
  total: 5
}
```

## 公司模板函数

### queryCompanies

查询 `companies` 集合，按 `createTime desc` 排序。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| limit | number | 否 | 每页数量，默认 50 |
| cursor | string | 否 | 分页偏移量 |
| companyName | string | 否 | 单位名称，模糊匹配 |

### saveCompany

新增公司模板，要求公司名称唯一。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| company | object | 是 | 公司模板数据，必须包含 `companyName` |

### updateCompany

更新公司模板，并自动写入 `updateTime`。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| _id | string | 是 | 公司模板 `_id` |
| updateData | object | 是 | 更新字段 |

### deleteCompany

删除公司模板。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| _id | string | 是 | 公司模板 `_id` |

## 权限函数

权限系统使用以下集合：

| 集合 | 说明 |
|------|------|
| `system_config` | 权限系统初始化状态，配置 ID 为 `permission_system` |
| `roles` | 角色定义 |
| `user_roles` | 用户到角色的映射 |
| `permission_users` | 本地用户列表 |
| `login_logs` | 登录日志 |

### getUserRole

读取当前登录用户，返回权限系统状态、角色和权限点。

可能返回的 `status`：

| status | 说明 |
|--------|------|
| ready | 权限已就绪，`data` 内包含当前角色和权限 |
| uninitialized | 权限系统未初始化，且当前用户可以初始化 |
| forbidden | 未登录或无权初始化 |
| unassigned | 当前用户未分配角色 |
| error | 权限配置异常 |

成功且就绪时返回：

```js
{
  success: true,
  initialized: true,
  status: 'ready',
  data: {
    roleId: 'role_admin',
    roleName: '管理员',
    roleCode: 'admin',
    pagePermissions: [],
    actionPermissions: ['*']
  }
}
```

### initializePermissionSystem

初始化权限系统。仅 CloudBase 内置 `administrator` 账号可执行，且只能在系统未初始化时执行。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| adminRoleName | string | 否 | 管理员角色名称，默认“管理员” |

执行内容：

1. 确认当前登录用户为 CloudBase 内置 `administrator`。
2. 确保权限相关集合可访问。
3. 写入内置管理员角色 `role_admin`，`actionPermissions` 为 `['*']`。
4. 写入当前用户到 `permission_users` 和 `user_roles`。
5. 标记 `system_config/permission_system.initialized = true`。

### manageRoles

管理角色。调用者必须拥有 `settings:role_manage` 权限。

动作枚举：

| action | 说明 | 主要参数 |
|--------|------|----------|
| list | 查询角色列表 | 无 |
| create | 新建角色 | `name`、`code`、`description`、`pagePermissions`、`actionPermissions` |
| update | 更新角色 | `roleId` 以及待更新字段 |
| delete | 删除角色 | `roleId` |

保护规则：

1. 系统内置角色不可删除。
2. 仍有用户使用的角色不可删除。
3. 不允许删除或修改最后一个具备角色管理或用户角色管理能力的角色。

### manageUserRoles

管理本地用户和用户角色。调用者必须拥有 `settings:user_role_manage` 权限。

动作枚举：

| action | 说明 | 主要参数 |
|--------|------|----------|
| list | 查询本地用户、角色和映射后的列表 | 无 |
| syncUsers | 从 CloudBase Auth 同步用户到 `permission_users` | 可选分页相关参数 |
| createUser | 手动创建本地用户 | `userId`、`username`、`nickName`、`email`、`phone` |
| updateUser | 更新本地用户 | `userId` 以及待更新字段 |
| deleteUser | 删除本地用户，并移除角色映射 | `userId` |
| assign | 分配或改派角色 | `userId`、`roleId` |
| remove | 移除用户角色 | `userId` |

保护规则：

1. 分配角色前要求目标用户已存在于 `permission_users`。
2. 不允许系统失去最后一个管理员。
3. 删除用户时会同步移除该用户的角色映射。

### manageLoginLogs

登录日志管理。

动作枚举：

| action | 说明 | 权限要求 |
|--------|------|----------|
| record | 记录登录日志 | 不校验设置权限；成功登录日志要求有效登录态 |
| list | 查询登录日志 | 需要登录态和 `settings:read` 权限 |

`record` 请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| success | boolean | 否 | 是否登录成功，默认成功 |
| failReason | string | 否 | 失败原因 |
| username | string | 否 | 用户名，未登录失败日志可传 |
| nickName | string | 否 | 昵称 |
| userAgent | string | 否 | 浏览器 UA，服务端请求头优先 |

`list` 请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| limit | number | 否 | 每页数量，默认 20，最大 100 |
| cursor | string | 否 | 分页偏移量 |
| username | string | 否 | 用户名精确筛选 |
| success | boolean \| string | 否 | 是否成功 |
| startDate | string | 否 | 登录时间开始日期 |
| endDate | string | 否 | 登录时间结束日期 |

## 统计函数

### generateDailyShipmentStats

生成最近 7 日发货日切统计。统计口径为“不含今天，昨日往前 7 天”，写入或更新 `daily_shipment_stats`。

定时触发器：

```text
dailyShipmentStatsTimer: 0 0 0 * * * *
```

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| now | string | 否 | 调试用时间，默认当前时间 |

统计字段：

| 字段 | 说明 |
|------|------|
| statDate | 生成统计的日期 |
| startDate / endDate | 统计区间 |
| shipmentTrend | 每日发货数量和发货台数 |
| topShippedModels | 发货台数 Top 5 型号 |
| totalInbound / totalPhones | 区间入库记录数和入库台数 |
| totalOutbound / totalOutboundPhones | 区间出库记录数和出库台数 |

### queryDailyShipmentStats

查询 `daily_shipment_stats` 最新一条日切统计，或按 `statDate` 查询指定记录。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| statDate | string | 否 | 统计日期 |

## 工具函数

### getAndIncrementCounter

在事务内读取并自增 `system_counters` 计数器，返回自增后的新值。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| counterName | string | 否 | 计数器名，默认 `orderSerialNumber` |

返回结果：

```js
{
  success: true,
  value: 101
}
```

### manageCounter

获取或设置 `system_counters` 计数器。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| action | string | 否 | `get` 或 `set`，默认 `get` |
| counterName | string | 否 | 计数器名，默认 `orderSerialNumber` |
| value | number | set 时是 | 非负整数 |

### getCloudFileUrls

批量获取云存储文件临时访问链接。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| fileIDs | string[] | 是 | 云存储文件 ID 列表 |

返回结果：

```js
{
  success: true,
  fileList: [
    {
      fileID: 'cloud://xxx',
      tempFileURL: 'https://...',
      status: 0,
      maxAge: 7200
    }
  ]
}
```

### sendWechatNotification

通过企业微信群机器人 webhook 发送文本或 markdown 消息。该函数直接从事件根对象读取参数，不使用 `event.data` 包装。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| webhookUrl | string | 是 | 企业微信群机器人 webhook |
| msgtype | string | 是 | `text` 或 `markdown` |
| content | string | 是 | 消息内容 |

示例：

```ts
await callFunction('sendWechatNotification', {
  webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx',
  msgtype: 'text',
  content: '出库记录已更新',
});
```

## 数据集合摘要

| 集合 | 主要用途 |
|------|----------|
| `orders` | 订单明细、顺丰物流状态、订单出库关联 |
| `outbound_records` | 出库单生命周期：`pending`、`completed`、`cancelled` |
| `invoices` | 发票记录 |
| `companies` | 公司开票模板 |
| `system_counters` | 订单序号、出库编号等计数器 |
| `sf_tokens` | 顺丰 accessToken 缓存 |
| `operation_logs` | 出入库等业务操作日志 |
| `daily_shipment_stats` | 日切发货统计 |
| `roles` | 角色定义 |
| `user_roles` | 用户角色映射 |
| `permission_users` | 本地权限用户列表 |
| `system_config` | 权限系统配置 |
| `login_logs` | 登录日志 |
| `inbound_records` | 入库记录，当前统计函数会读取 |

订单出库关联字段：

| 字段 | 所在集合 | 说明 |
|------|----------|------|
| linkedOutboundId | `orders` | 关联出库单 `_id` |
| linkedOutboundNumber | `orders` | 关联出库编号 |
| outboundSyncStatus | `orders` | `none`、`pending`、`completed` |
| outboundNumber | `outbound_records` | 出库编号，如 `CK-20260621-00001` |
| outboundStatus | `outbound_records` | `pending`、`completed`、`cancelled` |
| linkedOrderId | `outbound_records` | 关联订单 `_id` |
| linkedOrderStatus | `outbound_records` | `active`、`missing` |
| source | `outbound_records` | `order` 或 `manual` |

## 前端仍调用但本地未包含的函数

以下函数仍可在 `src` 中看到调用，但当前不在 `cloudbaserc.json` 的 `functions` 清单中，也不在本地 `cloud_functions/sendWechatNotification/functions` 目录中。部署前需要确认它们是否已在云端保留，或补齐本地函数并加入部署清单。

| 函数 | 当前前端用途 |
|------|--------------|
| `queryRecords` | 入库、出库列表和统计页查询 |
| `updateRecord` | 入库、出库记录更新 |
| `deleteInboundRecord` | 删除入库记录 |
| `deleteOutboundRecord` | 删除出库记录 |
| `getOperationLogs` | 操作日志列表 |
| `getRecordHistory` | 记录修改历史 |
| `saveOperationLog` | 保存操作日志 |
| `phoneModels` | 手机品牌和型号管理 |
| `getShops` | 渠道或店铺列表 |
| `getRealImageUrl` | 旧图片真实地址获取；新逻辑优先使用 `getCloudFileUrls` |
| `getInboundStats` | 旧入库统计 |
| `getOutboundStats` | 旧出库统计 |

## 部署提醒

1. `cloudbaserc.json` 当前已声明 31 个可部署函数。
2. `generateDailyShipmentStats` 带有定时触发器，部署时需要确认 CloudBase 触发器配置生效。
3. 顺丰函数上线生产前必须确认 `SF_ENV`、客户编码、校验码、寄件人和月结配置在同一环境下成套配置。
4. 权限函数依赖 `roles`、`user_roles`、`permission_users`、`system_config` 集合；首次使用前需要执行 `initializePermissionSystem`。
