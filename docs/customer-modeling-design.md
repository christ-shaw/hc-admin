# 租赁客户主档与关系建模设计方案

> 状态：方案评审稿
>
> 适用系统：`hc-admin`
>
> 适用业务：租赁 1、租赁 2 订单
> 首版范围：客户身份主档、别名、收件档案、客户关系、历史归档及订单总览

## 1. 背景

当前系统没有独立的客户主档。客户信息散落在每张 `orders` 订单中：

| 现有字段 | 当前含义 |
| --- | --- |
| `customerName` | 订单下单人或客户名称，自由文本 |
| `consignee` | 收件人姓名 |
| `consigneePhone` | 收件人电话 |
| `consigneeAddress` | 收件地址 |
| `orderAttribute` | `rental1` / `rental2`，即租赁 1 / 租赁 2 |

同一个真实客户可能使用不同平台账号、昵称或下单人名称，也可能长期使用多个收件人、电话和地址。反过来，同一个电话或地址也可能被家庭成员、同事或代下单客户共同使用。因此，不能将名称、电话或地址中的任意一个字段直接当作客户唯一标识。

生产数据只读统计结果如下：

| 指标 | 数量 |
| --- | ---: |
| 租赁订单总数 | 3,559 |
| 租赁 1 订单 | 2,455 |
| 租赁 2 订单 | 1,104 |
| 不同 `customerName` | 1,603 |
| 不同收件人组合 | 1,634 |
| 存在关键身份字段缺失的订单 | 1,227 |
| 一个客户名称对应多个收件档案 | 477 |
| 一个电话对应多个客户名称 | 113 |
| 相同电话和地址对应多个客户名称 | 92 |
| 同一客户名称横跨租赁 1、租赁 2 | 93 |

这些数据说明历史归档必须采用“系统生成候选、人工确认”的方式，不能直接按名称或电话批量自动合并。

## 2. 建设目标

1. 为租赁 1、租赁 2 建立统一客户主档，同一客户跨业务类型共用一个稳定 `customerId`。
2. 一个客户允许维护多个结构化别名，并记录别名来源渠道。
3. 一个客户允许维护多个收件档案，每个档案保存姓名、电话和地址组合。
4. 订单关联客户和收件档案，同时保留订单发生时的原始快照。
5. 支持家庭、同住、同事、代下单、担保等客户关系，但共享信息只生成候选，不能自动确认关系。
6. 允许管理员重新关联订单、合并客户以及撤销客户合并。
7. 不阻断现有手工下单、插件导入、续租、售后和转租赁 2 流程。
8. 在客户详情中提供租赁 1/2 订单总览和基础业务汇总。

## 3. 首版边界

首版不建设完整 CRM，不包含客户价值分层、自动风险评分、营销跟进、催收流程或复杂关系图谱。客户关系先使用列表和详情视图展示，不实现可视化网络图。

身份证、银行卡、人脸、征信等敏感资料不进入本次客户主档。首版个人信息仅覆盖系统已经存在的下单名称、收件人姓名、电话和地址。

## 4. 核心原则

### 4.1 客户身份与订单快照分离

- 客户主档表达“现在系统认为这个人是谁”。
- 订单字段表达“下单当时使用了什么名称和收件信息”。
- 修改客户主档不得批量覆盖历史订单的姓名、电话和地址。
- 客户合并不得抹掉历史订单原本关联的客户身份。

### 4.2 稳定 ID 优先

客户、别名、收件档案和关系均使用不可变 ID。名称、电话、地址只用于检索和匹配，不作为主键。

### 4.3 自动关联必须唯一且精确

只有同时满足以下条件时，新订单才可自动关联：

1. 客户主名称或某个启用别名完全匹配；
2. 收件人姓名、电话、地址三项完全匹配一个启用收件档案；
3. 经过客户合并映射解析后，只能得到一个有效客户。

电话一致、地址一致、名称相似或评分较高均不足以触发自动关联，只能生成候选。

### 4.4 候选与事实分开

- 共享电话、共享地址和相似名称属于匹配证据。
- 经管理员确认的客户归属和客户关系才是业务事实。
- 被拒绝的候选必须保存结果，避免重复提示。

## 5. 数据模型

### 5.1 `customers`：客户主档

```ts
interface Customer {
  _id: string;
  displayName: string;
  normalizedDisplayName: string;
  status: 'active' | 'disabled' | 'merged';
  mergedIntoCustomerId?: string;
  remark?: string;
  stats?: CustomerStats;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}
```

规则：

- `displayName` 是系统中的客户主显示名，不要求全局唯一。
- `mergedIntoCustomerId` 仅在 `status='merged'` 时存在。
- 已合并客户不可再接收新订单，但其历史订单、别名和收件档案继续保留。
- 禁止客户合并到自身、形成循环合并或以停用客户作为目标。

### 5.2 `customer_aliases`：客户别名

```ts
interface CustomerAlias {
  _id: string;
  customerId: string;
  name: string;
  normalizedName: string;
  sourceType: 'manual' | 'order' | 'assist_import';
  salesChannel?: string;
  remark?: string;
  enabled: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}
```

规则：

- 不同客户允许使用相同别名，避免同名客户产生冲突。
- 同一客户内，以 `normalizedName + salesChannel` 作为逻辑去重键。
- 别名可表达平台账号、昵称、历史名称或代下单名称。
- 订单的 `customerName` 保存下单时实际使用的名称，不自动替换为客户主显示名。

### 5.3 `customer_recipient_profiles`：收件档案

```ts
interface CustomerRecipientProfile {
  _id: string;
  customerId: string;
  label?: string;
  consignee: string;
  normalizedConsignee: string;
  phone: string;
  normalizedPhone: string;
  address: string;
  normalizedAddress: string;
  sourceType: 'manual' | 'order' | 'assist_import';
  enabled: boolean;
  useCount: number;
  lastUsedAt?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}
```

规则：

- `label` 可填写“本人”“公司”“家里”“父母家”等便于识别的名称。
- 不同客户允许拥有完全相同的收件档案，这本身不代表两个客户相同。
- 订单选择档案后复制完整快照；以后修改档案不影响历史订单。
- 在订单中临时修改收件信息时，默认只修改订单快照。只有明确选择“保存为新收件档案”才写回客户主档。

### 5.4 `customer_relations`：已确认客户关系

```ts
type CustomerRelationType =
  | 'family'
  | 'cohabitant'
  | 'colleague'
  | 'ordered_on_behalf'
  | 'guarantor'
  | 'other';

interface CustomerRelation {
  _id: string;
  fromCustomerId: string;
  toCustomerId: string;
  type: CustomerRelationType;
  direction: 'undirected' | 'directed';
  remark?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}
```

关系规则：

| 类型 | 方向 |
| --- | --- |
| 家庭 | 双向 |
| 同住 | 双向 |
| 同事 | 双向 |
| 代下单 | 有向：下单方 → 实际客户 |
| 担保 | 有向：担保方 → 被担保客户 |
| 其他 | 创建时选择方向并填写备注 |

双向关系使用排序后的两个客户 ID 生成确定性关系键，避免重复创建。

### 5.5 `customer_link_candidates`：订单归档候选

```ts
interface CustomerLinkCandidate {
  _id: string;
  identityFingerprint: string;
  orderIds: string[];
  orderCount: number;
  rentalTypes: string[];
  observedIdentity: {
    customerName: string;
    consignee: string;
    phone: string;
    address: string;
  };
  matches: Array<{
    customerId: string;
    score: number;
    reasons: string[];
  }>;
  status: 'pending' | 'accepted' | 'rejected' | 'ignored';
  resolvedCustomerId?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  createdAt: string;
  updatedAt: string;
}
```

候选以标准化后的“客户名称 + 收件人 + 电话 + 地址”生成确定性指纹。重复扫描时更新同一候选，不重复创建。

### 5.6 `customer_relation_candidates`：关系候选

关系候选保存两个客户 ID、共享电话/地址等证据、证据出现次数和处理状态。候选只能由管理员确认或拒绝，不能自动转成正式关系。

### 5.7 `customer_merge_events`：客户合并审计

记录源客户、目标客户、操作人、操作时间、撤销状态和操作备注。客户合并采用映射方式，不批量重写历史订单：

- 源客户标记为 `merged` 并写入 `mergedIntoCustomerId`。
- 查询目标客户时聚合整个客户簇的订单、别名和收件档案。
- 新订单只能写入最终有效客户 ID。
- 撤销时清除合并映射并重算双方统计。

### 5.8 `orders` 新增字段

```ts
interface OrderCustomerLink {
  customerId?: string;
  customerAliasId?: string;
  recipientProfileId?: string;
  customerLinkStatus?: 'linked' | 'pending' | 'ignored';
  customerLinkedAt?: string;
  customerLinkedBy?: string;
}
```

兼容原则：

- 所有新增字段均为可选，旧客户端和旧订单可以继续工作。
- `customerName`、`consignee`、`consigneePhone`、`consigneeAddress` 保持原义和原值。
- 客户合并、改名或修改收件档案不得重写这些快照字段。

## 6. 标准化与匹配规则

### 6.1 名称标准化

1. Unicode NFKC 全半角统一；
2. 去除首尾空白；
3. 连续空白折叠为一个；
4. 拉丁字符统一为小写；
5. 统一常见分隔符，但不进行拼音转换和模糊纠错。

### 6.2 电话标准化

- 只保留数字；
- 不完整号码仍可保留展示，但不能参与自动关联；
- 电话不能单独作为客户唯一标识。

### 6.3 地址标准化

- Unicode NFKC 全半角统一；
- 移除无意义空白和常见标点；
- 保留省市区、道路、门牌、楼栋、单元和房号中的文字与数字；
- 第一版不接入地图地址解析服务，不自动纠正行政区或别字。

### 6.4 匹配评分

评分用于候选排序和解释，不直接决定自动归并：

| 证据 | 建议分值 |
| --- | ---: |
| 主名称或别名完全一致 | 40 |
| 电话完全一致 | 30 |
| 地址完全一致 | 20 |
| 收件人姓名完全一致 | 10 |

自动关联仍必须满足“名称/别名完全一致 + 完整收件档案完全一致 + 唯一客户”三项硬条件。

## 7. 历史数据迁移

### 7.1 预扫描

迁移函数按 `_id` 或创建时间分页读取租赁 1/2 订单，每批最多 100 条：

1. 提取订单身份观察值；
2. 执行标准化；
3. 按身份指纹分组；
4. 查找已有客户、别名和收件档案；
5. 写入或更新候选记录；
6. 保存游标和扫描统计。

预扫描不得写入订单 `customerId`。

### 7.2 管理员确认操作

每个候选支持：

- 创建新客户并关联本组订单；
- 归入已有客户，并选择是否增加别名和收件档案；
- 从组内选择部分订单拆分处理；
- 忽略并填写原因；
- 拒绝某个系统推荐客户。

确认动作必须事务化或具备幂等请求 ID。重复提交不得重复创建客户、别名或收件档案。

### 7.3 批量处理

待归档页面允许批量选择候选，但批量确认仅适用于管理员明确选择的记录。系统可以预选低冲突候选，不能未经确认自动提交。

### 7.4 回滚与重跑

- 扫描任务可从游标断点继续。
- 候选指纹确定，重复扫描只刷新证据和订单列表。
- 已确认订单不会被后续扫描重新归档。
- 订单可在客户详情或订单页面重新关联。

## 8. 新订单关联流程

### 8.1 手工新增订单

1. 操作人通过主名称、别名、电话或地址搜索客户；
2. 选择已有客户或快捷创建客户；
3. 选择客户别名作为本次 `customerName`；
4. 选择已有收件档案或填写临时收件信息；
5. 保存订单快照和稳定 ID；
6. 未选择客户时仍允许保存，并将订单标记为 `pending`。

### 8.2 插件导入及衍生订单

插件导入、续租、售后和转租赁 2 均调用相同身份匹配服务：

- 唯一精确匹配：自动关联；
- 无匹配或多匹配：订单照常创建，生成待确认候选；
- 匹配服务异常：只记录日志，不影响订单主流程；
- 后台扫描会补偿未生成候选的订单。

### 8.3 编辑订单

- 修改订单客户归属必须显式选择目标客户；
- 修改快照不会自动修改客户主档；
- 可显式将当前名称保存为别名，或将当前收件信息保存为新档案；
- 重新关联后重算原客户与新客户统计。

## 9. 客户关系生成

系统可以基于以下证据生成关系候选：

- 两个客户使用过相同完整电话；
- 两个客户使用过相同标准化地址；
- 两个客户使用过相同电话和地址组合；
- 历史订单存在相同收件档案但下单名称不同。

以下情况不得自动创建关系：

- 仅名称相同或相似；
- 电话、地址为空或格式无效；
- 两个名称已经被确认是同一客户的别名；
- 候选此前已被拒绝且证据没有发生变化。

管理员确认时选择关系类型、方向和备注。确认同一真实客户时应使用“客户合并”，不应使用客户关系替代。

## 10. 客户统计

客户主档维护以下可重建汇总：

```ts
interface CustomerStats {
  totalOrderCount: number;
  rental1OrderCount: number;
  rental2OrderCount: number;
  totalAmount: number;
  firstOrderDate?: string;
  lastOrderDate?: string;
}
```

- 普通新单和改单采用增量更新。
- 订单重新关联、客户合并或撤销合并后，对受影响客户执行全量重算。
- 合并客户的统计按整个客户簇计算。
- 统计字段属于缓存，可以从 `orders` 重新生成，不能作为唯一业务事实来源。

## 11. 云函数接口

新增 `manageCustomers` 云函数，按 `action` 提供以下能力：

| 操作组 | Actions |
| --- | --- |
| 查询 | `list`、`get`、`search` |
| 主档 | `create`、`update`、`disable`、`enable` |
| 别名 | `createAlias`、`updateAlias`、`disableAlias` |
| 收件档案 | `createRecipient`、`updateRecipient`、`disableRecipient` |
| 订单归档 | `matchIdentity`、`ingestOrder`、`listLinkCandidates`、`resolveLinkCandidate` |
| 客户关系 | `listRelations`、`listRelationCandidates`、`confirmRelation`、`rejectRelation`、`removeRelation` |
| 合并修正 | `merge`、`unmerge`、`relinkOrder` |
| 运维 | `scanUnlinkedOrders`、`rebuildStats` |

需要更新的订单入口包括：

- `saveOrders`
- `updateOrder`
- `importOrderFromAssist`
- `manageAfterSaleOrders`
- 前端续租和转租赁 2 创建流程

所有入口使用同一套字段标准化和匹配规则。无法在同一事务完成的匹配操作采用“订单先成功、匹配后补偿”的最终一致方式。

## 12. 权限设计

新增页面权限：

- `/customers`：访问客户管理页面。

新增操作权限：

| 权限 | 能力 |
| --- | --- |
| `customers:read` | 查看客户、别名、收件档案、关系和订单总览 |
| `customers:write` | 建档、编辑、维护别名/收件档案、处理归档候选 |
| `customers:merge` | 合并客户、撤销合并 |

订单新增或编辑人员可在订单表单中搜索客户，但不能因此进入客户管理页或执行客户合并。现有管理员的 `*` 权限自动覆盖新增权限。

## 13. 索引建议

| 集合 | 索引 |
| --- | --- |
| `customers` | `status + normalizedDisplayName`、`mergedIntoCustomerId` |
| `customer_aliases` | `normalizedName + enabled`、`customerId + enabled` |
| `customer_recipient_profiles` | `normalizedPhone + enabled`、`normalizedAddress + enabled`、`customerId + enabled` |
| `customer_relations` | `fromCustomerId + type`、`toCustomerId + type` |
| `customer_link_candidates` | `status + updatedAt`、`identityFingerprint` |
| `customer_relation_candidates` | `status + updatedAt`、客户对确定性键 |
| `orders` | `customerId + date`、`customerLinkStatus + date` |

## 14. 页面设计

新增主导航“客户管理”，包含以下区域：

### 14.1 客户列表

- 支持主名称、别名、电话和地址检索；
- 展示租赁 1/2 订单数、累计金额、最近下单、收件档案数和关系数；
- 可进入详情、停用、合并；
- 已合并客户默认隐藏，可通过筛选查看。

### 14.2 客户详情

使用页签展示：

1. 基本信息与统计；
2. 别名；
3. 收件档案；
4. 关联客户；
5. 租赁 1/2 订单；
6. 操作记录。

### 14.3 待归档

- 展示订单数量、租赁类型、观察到的名称和收件信息；
- 显示推荐客户、评分和逐条匹配原因；
- 支持建为新客户、归入已有客户、拆分订单、拒绝或忽略；
- 对共享电话、共享地址和多候选情况给出醒目标识。

### 14.4 关系候选

- 展示两端客户、共享证据和出现次数；
- 管理员确认关系类型、方向和备注；
- 支持拒绝并避免重复提示。

## 15. 审计与安全

- 客户创建、修改、别名维护、收件档案维护、订单重新关联、关系确认、合并和撤销合并均记录操作人和时间。
- 日志不得输出完整电话、地址或认证信息；必要时只记录脱敏摘要和相关记录 ID。
- 客户搜索接口限制返回数量，按权限校验，不允许匿名调用。
- 删除采用停用或软合并，不物理删除仍被订单引用的客户数据。

## 16. 测试方案

### 16.1 单元测试

- 中文、英文、全半角和空格的名称标准化；
- 电话格式标准化及无效电话处理；
- 地址标准化不丢失门牌和房号；
- 唯一精确匹配成功；
- 同名、共用电话、共用地址和多个候选时禁止自动关联；
- 同一客户多个别名和多个收件档案；
- 双向与有向关系去重；
- 客户合并循环检测及撤销；
- 候选扫描和确认的幂等性。

### 16.2 集成测试

- 手工新增订单选择客户和临时收件信息；
- 未选择客户仍能保存并进入待归档；
- 插件导入唯一匹配、无匹配、多匹配和匹配服务失败；
- 续租、售后、转租赁 2 继承或重新匹配客户；
- 订单重新关联后双方统计正确；
- 合并后客户详情聚合源客户历史，撤销后恢复；
- 权限不足时无法查看或修改客户数据。

### 16.3 回归测试

- 订单查询、新增、编辑和删除；
- 出库单生成及订单关联；
- 顺丰申请、追加、取消和打印；
- 插件普通导入和续租导入；
- 历史订单无新增客户字段时仍能正常展示。

## 17. 上线步骤

1. 增加类型定义、客户核心逻辑和自动化测试；
2. 部署新集合、索引、权限项和 `manageCustomers`；
3. 更新订单写入入口，但保持客户关联字段可选；
4. 上线仅管理员可见的客户管理页面；
5. 对生产订单执行只读预扫描并核对统计；
6. 小批量确认候选，验证订单归属、统计、合并和撤销；
7. 批量处理历史候选；
8. 开启新订单唯一精确自动关联；
9. 观察候选积压、匹配失败率和误归档反馈后再扩大使用范围。

云函数先于前端发布，确保前端不会引用尚未部署的接口。Cloudflare 前端固定生产地址为 `https://hc-admin-4s3.pages.dev`。

## 18. 验收标准

1. 可以通过客户主名称、任一别名、电话或地址找到客户。
2. 同一客户的租赁 1、租赁 2 订单在一个详情页统一展示。
3. 同一客户可以维护多个别名和多个收件档案。
4. 新订单只有唯一精确匹配时自动关联，任何多候选情况都进入待确认。
5. 历史订单在管理员确认前不会被自动写入客户归属。
6. 客户主档修改不改变历史订单快照。
7. 客户合并后可查看完整历史，并可由管理员撤销。
8. 共享电话或地址不会自动将两个客户合并或建立正式关系。
9. 插件导入和现有订单流程在匹配服务不可用时仍可完成。
10. 客户统计可以从订单重新计算并与订单明细一致。
