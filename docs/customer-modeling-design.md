#  租赁客户主档与关系建模设计方案

> 状态：方案评审稿
>
> 适用系统：`hc-admin`
>
> 适用业务：租赁 1、租赁 2 订单
> 首版范围：客户身份主档、别名、收件档案、客户关系、历史归档及订单总览

> 2026-09-05 修订：补充权限矩阵、订单表单受限查询、运维调用边界及权限验收；分步执行见[实现计划](./customer-modeling-implementation-plan.md)，已实现的标准化与接口契约见[阶段 1 说明](./customer-modeling-phase1.md)。

> 2026-09-06 修订：阶段 2 已实现只读身份匹配、合并链解析与引用校验、事务写入及幂等审计；接口与发布要求见[阶段 2 说明](./customer-modeling-phase2.md)。订单入口接入仍在阶段 4。

> 2026-09-07 修订：阶段 3 已实现历史扫描、独立订单成员、人工归档与续跑；候选组不再存储无限订单数组，详见[阶段 3 说明](./customer-modeling-phase3.md)。

> 2026-09-07 修订：阶段 4 已接入订单保存、编辑、插件导入/续租/追加和售后入口；自动匹配默认关闭，匹配失败保留可重扫状态。详见[阶段 4 说明](./customer-modeling-phase4.md)。
>
> 2026-09-11 修订：新建与编辑订单共用客户名称 Top 3 推荐；选择客户、选择地址分别明确操作，编辑关联与订单快照同事务保存。实现与发布说明见[客户名称推荐](./customer-name-suggestions.md)。

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
6. 允许具备对应操作权限的人员重新关联订单、合并客户以及撤销客户合并，具体边界见第 12 节。
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
- 历史归档和客户关系只有经具备对应操作权限的人员确认后才成为业务事实；新订单唯一精确自动关联按第 4.3 节执行。
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
  _id: string; // 标准化身份指纹；完全空身份使用订单独立指纹
  identityFingerprint: string;
  normalizationVersion: string;
  evidenceVersion: string;
  observedIdentity: { customerName: string; consignee: string; phone: string; address: string };
  matches: Array<{ customerId: string; score: number; reasons: string[] }>;
  matchCount: number;
  matchStatus: string;
  orderCount: number;
  pendingCount: number;
  rental1Count: number;
  rental2Count: number;
  status: 'pending' | 'processed';
  createdAt: string;
  updatedAt: string;
}
// 订单独立存储并分页查询，避免候选文档过大。
interface CustomerLinkCandidateMember {
  _id: string; // 由订单 ID 确定
  candidateId: string;
  orderId: string;
  orderVersion: string;
  evidenceVersion: string;
  revision: number;
  status: 'pending' | 'accepted' | 'ignored' | 'stale';
  rejectedCustomerIds: string[]; // 当前证据版本下被拒绝的推荐
  resolvedCustomerId?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  reason?: string;
}
```

候选以标准化后的“客户名称 + 收件人 + 电话 + 地址”生成确定性指纹。重复扫描时更新同一候选，不重复创建。

### 5.6 `customer_relation_candidates`：关系候选

关系候选保存两个客户 ID、共享电话/地址等证据、证据出现次数和处理状态。候选只能由具备 `customers:write` 的人员确认或拒绝，不能自动转成正式关系。

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

迁移函数按 `_id` 分页检查历史订单并筛选租赁 1/2 订单。页面每次点击最多检查 500 条，内部连续执行最多 25 次、每次 20 条的请求；遇到任务完成或失败时提前停止。服务端单次请求上限仍为 100 条：

1. 提取订单身份观察值；
2. 执行标准化；
3. 按身份指纹分组；
4. 查找已有客户、别名和收件档案；
5. 写入或更新候选记录；
6. 保存游标和扫描统计。

预扫描不得写入订单 `customerId`。

### 7.2 授权人员确认操作

以下操作均要求 `customers:write`，不以角色名称是否为“管理员”判断权限。

每个候选支持：

- 创建新客户并关联本组订单；
- 归入已有客户，并选择是否增加别名和收件档案；
- 从组内选择部分订单拆分处理；
- 忽略并填写原因；
- 拒绝某个系统推荐客户。

确认动作必须事务化或具备幂等请求 ID。重复提交不得重复创建客户、别名或收件档案。

### 7.3 批量处理

待归档页面支持组内选择和跨组集中核对，仅具备 `customers:write` 的人员可提交：

- 单组可跨页明确勾选最多 100 条订单；快速入口的单条订单按第 7.4 节展示确认。
- 列表新增组复选框、“选择本页待归档组”和“批量建档归档”，可跨页勾选最多 100 组。勾选组明确表示纳入该组全部待处理订单，打开核对窗口时重新分页读取并展示数量、序号和收货资料；单组超过 100 条时阻止该组提交，提示从单组入口分批选择，不静默截断。
- 集中核对窗口允许逐组修改主名称、别名/档案保存选项及收货资料，默认分别新建客户；也可取消纳入某组。有重复提示时可选择已有客户，或明确核对后仍然新建独立客户。修改主名称、收货人、电话或地址后需重新核对本组；仅切换别名/档案保存选项不使身份匹配结果失效。
- 弹窗直接复用列表中的匹配结果与客户名称，仅重新加载待处理订单范围，不逐组再次匹配或查询客户详情。匹配缓存同时绑定主名称、原下单名称、收货人、电话、地址以及规则版本。
- 点击一次最终确认，按组串行处理已核对的组。每组写入前重新读取订单范围；拟新建客户时，通过 `matchIdentity` 携带缓存版本做条件检查。全局客户资料版本和匹配规则未变化时仅读取版本号并返回 `unchanged`，复用结果；版本变化、身份输入变化、旧候选无版本或候选截断时才完整匹配。新结果直接携带客户名称，避免逐个读取收货档案详情。
- 本批前面刚创建的客户也会更新全局版本，参与后续组检查；新出现或变化的重复候选要求重新确认，不自动合并或新建。查询失败、成员范围/版本变化时该组停留待核对，其他组继续处理。扫描读取客户集合前后校验版本，遇到并发修改重新读取，不能把旧资料标注为新版本。
- 每组独立幂等请求，首次写入前锁定资料及请求 ID；失败后重试原请求，已完成组不重复提交。每次服务端调用最多处理 10 个单订单事务，保存进度并支持续跑；整批不作为一个事务，冲突订单单独展示。
- 可在当前组完成后暂停，再继续剩余组。关闭或刷新页面停止后续组；已提交的未完成请求从现有处理记录继续，未提交的组需重新勾选。浏览器不持久化客户名称、电话、地址等批量草稿。

跨组批量复用 `matchIdentity`、受限 `get`、`listLinkCandidates` 和 `resolveLinkCandidate`，无需新增云函数、集合或权限。条件匹配需要更新 `manageCustomers`：新增可选版本请求字段和响应字段，旧客户端仍收到完整匹配结果；新前端遇到旧云函数返回完整结果时正常使用。订单原始名称和收货快照保持不变。

### 7.4 逐组快速建档

待归档列表提供独立的“新建客户并归档”入口，直接打开单窗口核对页：

- 默认带入订单客户名称，保留下单名称为别名；相同主名称及空渠道复用初始别名。
- 完整收货资料默认勾选保存，不完整时可补充或仅建客户。
- 明确点击快速入口后，服务端查询确认只有一条待处理订单时直接选中并展示；有多条时不默认选择，可手动勾选或显式选择本组全部待处理订单，最多 100 条。
- 订单数量、序号、客户及收货资料集中核对，底部固定最终确认按钮；不再叠加第二个确认弹窗。
- 打开时与提交前，使用当前主名称、原下单名称和收货资料查询已有客户。发现相关客户时展示名称与匹配原因，可改为归入该客户，也可明确勾选仍需新建。查询失败阻止新建，不将失败当作没有重复。
- 检查是辅助核对，不是全局唯一客户约束；不同浏览器并发新建的最终治理仍需要合并/纠错。后端继续校验订单和证据版本，沿用事务及请求幂等。
- 开始写入后锁定本次资料与选择，失败时重试原输入或继续原请求。成功后“处理下一组”仅打开下一组，不自动确认；当前组未选订单继续待处理。

此入口要求 `customers:write`，复用已有查询和归档接口，无需新增云函数、集合或权限。

### 7.5 回滚与重跑

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

- 明确手工选择：创建事务内验证客户、别名和收货档案归属，生成服务端操作人和时间；无效引用拒绝该条保存。
- 衍生订单：保存后重新读取来源订单，校验来源类型、客户名称、渠道和平台订单号，解析有效客户簇；不依赖草稿复制的 ID。来源存在冲突时进入待归档，不降级为自动推断。
- 唯一精确匹配：仅当 `system_config/customer_modeling.autoLinkNewOrders === true` 时自动关联；缺失或关闭均不启用。
- 无匹配或多匹配：订单照常创建，保持 `pending`，通过待归档扫描生成候选。
- 匹配服务异常：输出不含客户快照的错误码和订单 ID，不影响已提交的订单；随订单写入的接入版本及状态可用于补偿。
- 后台扫描补齐候选，人工确认归档；已忽略或已关联的订单不会被自动重新绑定。
- `ingestOrder` 是打包在各订单云函数内的服务模块，不开放客户端动作；手工入口校验真实用户订单权限，插件入口沿用服务端 token 校验并使用固定服务操作人。

### 8.3 编辑订单

- 普通编辑保留客户 ID、别名/收货档案引用、关联操作人和时间，忽略旧客户端全量表单携带的这些字段。2026-09-11 起，订单名称推荐允许显式改绑或取消关联：提交选择模式及原关联引用，后端校验权限、有效档案和并发变化，与订单快照及审计同事务保存；
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

具备 `customers:write` 的人员确认时选择关系类型、方向和备注。确认同一真实客户时应使用“客户合并”，并另行校验 `customers:merge`，不应使用客户关系替代。

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

### 12.1 页面权限与操作权限

- `/customers`：访问客户管理页面；页面还需具备下表中至少一项客户操作权限才能加载对应内容。
- 页面权限与操作权限独立校验；拥有页面权限不代表可以调用所有客户接口。
- 不允许使用 `/orders` 页面权限作为进入 `/customers` 的兼容回退。

新增操作权限：

| 权限 | 能力 |
| --- | --- |
| `customers:read` | 查看客户、别名、收件档案、关系、候选、客户关联订单总览和客户操作记录，不允许修改 |
| `customers:write` | 包含上述客户读取能力；建档、编辑、启停、维护别名/收件档案、处理归档候选、重新关联订单、确认/拒绝/移除客户关系 |
| `customers:merge` | 包含上述客户读取能力；合并客户、撤销合并；不因此获得主档编辑、归档确认或关系维护能力 |

文中的人工确认均指持有对应操作权限的人员，不额外要求角色名称为“管理员”。首轮上线仅给管理员开放页面和相关权限；后续可按职责授予其他角色。现有页面及操作权限中的 `*` 分别覆盖相应权限域。

### 12.2 云函数 action 权限矩阵

下表中的“客户读取能力”指 `customers:read`、`customers:write`、`customers:merge` 任一项。所有接口均在服务端校验调用身份和权限，不能只依赖页面或按钮隐藏。

| Actions / 模式 | 必需权限 | 限制 |
| --- | --- | --- |
| `list`、`get` 管理详情 | 客户读取能力 | 分页读取；完整详情及操作记录不得通过订单表单权限获取 |
| `listLinkCandidates`、`listRelations`、`listRelationCandidates` | 客户读取能力 | 只允许查询，不隐式确认或修改候选 |
| `search`、`get` 的 `scope='orderSelection'` 模式 | 客户读取能力，或 `orders:create` / `orders:update` | 始终返回第 12.3 节定义的受限字段；仅有 `orders:read` 不满足条件 |
| `create`、`update`、`disable`、`enable` | `customers:write` | 订单表单快捷建档也使用此权限 |
| `createAlias`、`updateAlias`、`disableAlias`、`createRecipient`、`updateRecipient`、`disableRecipient` | `customers:write` | 显式从订单保存别名或新收件档案也使用此权限 |
| `resolveLinkCandidate` | `customers:write` | 覆盖建档归入、归入已有客户、拆分、忽略、拒绝推荐及批量确认 |
| `confirmRelation`、`rejectRelation`、`removeRelation` | `customers:write` | 校验关系两端、类型和方向；不允许以确认关系绕过合并权限 |
| `merge`、`unmerge` | `customers:merge` | 校验客户状态、循环及撤销依赖，记录合并事件 |
| `relinkOrder` | `customers:write`，或 `orders:update` 且有权编辑目标订单 | 订单编辑角色仅可操作其可编辑订单，不因此获得客户管理读取权限或批量历史归档权限 |
| `matchIdentity` | 客户读取能力；或可信订单服务内部调用 | 客户端不得用订单搜索权限读取完整匹配证据；内部调用沿用已校验的订单操作范围 |
| `ingestOrder` | 仅可信服务内部调用 | 在订单入口完成业务鉴权后调用，不能作为客户端绕过订单或客户权限的写入口 |
| `scanUnlinkedOrders`、`rebuildStats` | 人工调用要求操作权限 `*`；或可信后台任务 | 首版限定运维管理员；普通 `customers:write` / `customers:merge` 不得启动全量扫描或重建 |

可信服务调用必须由服务端可验证的调用来源或服务身份授权，不能相信客户端提交的 `internal` 标记、用户 ID 或角色。内部匹配、候选补偿和受影响客户的统计重算不要求订单操作人额外拥有运维权限，但必须限定到已授权业务操作或后台任务的范围。未列入白名单的 action 和查询模式一律拒绝。

### 12.3 订单表单受限查询

订单新增或编辑人员可在订单表单中搜索、选择客户，不因此获得客户管理页、完整客户详情、历史订单、关系证据或审计记录。

- `search` 仅返回最终有效且启用客户的 ID、主显示名及必要的匹配展示摘要；摘要中的电话脱敏，不返回完整地址或整组别名、收件档案。
- 选择客户后，通过 `get` 的 `scope='orderSelection'` 模式读取该客户可用的启用别名和收件档案。返回 ID、名称/渠道、档案标签及订单填写所必需的收件人、完整电话和地址，不返回客户备注、统计、关系、历史订单及审计字段。
- 受限详情无论调用人是否还有客户读取能力，均使用同一受限返回结构；省略 scope 的完整 `get` 必须按管理详情鉴权。
- 搜索要求非空关键词，支持主名称、别名、电话和地址；默认每页 20 条、最多 50 条，关联档案同样分页限量，禁止全量拉取后在前端过滤。
- 客户列表采用服务端分页，默认每页 20 条、最多 100 条；所有数量上限均由服务端强制执行。
- 有 `orders:create` / `orders:update` 但无 `customers:write` 时，允许选择已有客户和填写订单临时快照，不能快捷创建客户或把快照写回别名、收件档案。
- 提交订单时再次校验有效客户及别名/收件档案归属，避免直接构造 ID 绕过查询限制；时间和操作人由后端生成。

### 12.4 存量实现调整

- 移除 `PermissionContext.tsx` 中通过 `/orders` 自动开放 `/customers` 的回退。
- 拆分当前 `manageCustomers` 对 `list`、`search`、`get` 共用的宽泛读权限；`orders:read` 不再获得客户接口读取能力。
- 订单表单从客户管理 `list` / 完整 `get` 切换为受限查询，移除默认请求 5,000 条数据的实现。
- 角色配置补充 `customers:merge`，不因角色已有订单权限就自动授予客户管理权限。
- 现有 `touchRecipient` 不再作为客户端可任意调用的计数写入口；将实际使用记录放入授权订单流程，并按订单幂等维护。
- 所有新增权限须覆盖直接调用云函数、手工构造参数和内部接口伪造的测试，不只验证前端按钮状态。

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
| `customer_merge_events` | `sourceCustomerId + createdAt`、`targetCustomerId + createdAt` |
| `customer_write_requests` | 以操作人和请求 ID 生成确定性文档 ID；`actorId + createdAt`、`actorId + action + status + createdAt` |
| `customer_operation_audits` | `customerId + createdAt`、`actorId + createdAt` |
| `customer_scan_tasks` | `status + updatedAt` |
| `customer_link_candidate_members` | `candidateId + status`、`candidateId + status + serialNumber`、`orderId` |

集合及索引的可执行清单为 `scripts/customerSchema.cjs`；初始化默认只读，显式应用后须核验。所有客户资料维护在事务内递增 `customers.writeRevision`，并同时写请求记录和操作审计；后续各入口遵循相同并发约定。

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
- 具备 `customers:write` 的人员确认关系类型、方向和备注；
- 支持拒绝并避免重复提示。

## 15. 审计与安全

- 客户创建、修改、别名维护、收件档案维护、归档确认/拒绝/忽略、订单重新关联、关系确认/拒绝/移除、合并和撤销合并均记录操作人和时间；批量扫描及重建另记任务发起人、范围和结果。
- 日志不得输出完整电话、地址或认证信息；必要时只记录脱敏摘要和相关记录 ID。
- 客户搜索接口限制返回数量，按权限校验，不允许匿名调用。
- 接口按第 12 节执行 action 及返回字段校验；关联时间、审计操作人和内部调用身份不得由客户端参数直接决定。
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
- 权限不足时无法查看或修改客户数据；仅有 `/orders` 或 `orders:read` 不得进入客户管理或读取客户接口。
- 订单新增/编辑角色可执行受限搜索、选择客户和保存临时快照，但不能获取管理详情、快捷建档或维护客户关系。
- `customers:read` 不能写入，`customers:write` 不能合并，`customers:merge` 不能归档确认；扫描和重建仅允许运维管理员或可信后台任务。
- `orders:update` 只能重新关联其有权编辑的订单；跨订单范围、伪造内部调用或超限查询请求均被拒绝或按上限处理。
- 后台补偿和统计重算不要求普通订单操作人拥有运维权限，且不能借此扩大订单操作范围。

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
5. 历史订单在具备 `customers:write` 的人员确认前不会被自动写入客户归属。
6. 客户主档修改不改变历史订单快照。
7. 客户合并后可查看完整历史，并可由具备 `customers:merge` 的人员撤销。
8. 共享电话或地址不会自动将两个客户合并或建立正式关系。
9. 插件导入和现有订单流程在匹配服务不可用时仍可完成。
10. 客户统计可以从订单重新计算并与订单明细一致。
11. 页面权限与操作权限独立生效；订单新增/编辑人员仅能获取选择所需客户资料，不能通过表单接口读取管理详情或执行未授权操作。
12. 归档、关系维护、合并撤销和运维操作均按第 12 节矩阵鉴权，直接调用接口及伪造内部调用无法绕过权限。
