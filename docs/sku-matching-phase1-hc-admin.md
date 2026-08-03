# SKU 智能匹配·阶段一 hc-admin 侧改造清单（评审稿）

- 文档状态：评审稿
- 上游方案：`hc-order-assist/docs/SKU_MATCHING_DESIGN.md`（赞晨租商品与 hc-admin SKU 智能匹配方案）
- 本文范围：阶段一（数据基础与规则推荐，**不接 LLM**）中 hc-admin 侧的全部改造项
- 编写日期：2026-07-12

## 评审意见（待团队确认）

- 评审日期：2026-07-12
- 当前结论：R1~R6 全部采纳，结论已于 2026-07-12 回写至对应设计章节（A2 / A3 / C / D / G1），正文以修订后内容为准。
- 状态说明：结论栏保留评审决策依据，供追溯。

| 编号 | 优先级 | 评审意见 | 影响 | 团队结论 |
| --- | --- | --- | --- | --- |
| R1 | P1 | **匹配缓存键缺少 `merchant`**。A3 使用 `source + normalized_title + sku_catalog_version`，但现状确认和历史映射均允许同一标题按商户映射到不同 SKU。建议改为 `source + normalized_merchant + normalized_title + sku_catalog_version`，无商户时使用固定哨兵值。 | 不同商户的同名标题可能命中彼此缓存，直接推荐错误 SKU。 | 建议采纳：缓存键与历史映射键统一为 `source + normalized_merchant + normalized_title (+ sku_catalog_version)`，无商户用哨兵值 `-`。商户名同样归一化（去空格/全角），避免同店不同写法分裂映射。 |
| R2 | P1 | **多 SKU 推荐无法由当前候选契约表达**。本文确认套装对应多个独立 SKU，但 C 节沿用的 `candidates[]` 每项只有一个 `skuId`，而历史映射使用 `target_items` 列表。建议统一为“候选方案组”，每个方案包含 `items[]`；若阶段一暂不支持，则正文需明确多 SKU 只提示人工处理。 | 历史命中、规则推荐和前端应用推荐无法使用统一数据结构，套装场景不能落地。 | 建议采纳"契约先行、实现收缩"：`candidates[]` 每项定义为方案组 `{ items: [{skuId, quantity}], confidence, matchedAttributes, conflicts, reason }`，历史映射 `target_items` 天然对齐；**阶段一实现只返回单 item 方案**，识别到套装/多商品时返回 `matchType: 'none'` + 提示人工拆分。契约一次定型，阶段二不再破坏性变更。 |
| R3 | P1 | **反馈计数缺少幂等和防污染约束**。当前接口复用扩展内置的共享静态 token，`operator` 不是可信身份；同一请求重试也可能重复增加 `confirmed_count`。建议以 `requestId` 保证反馈幂等，只按不同且已真实导入的 `sourceOrderNo` 计数，并在提升 `verified` 前校验匹配日志和订单结果。 | 重复提交或伪造反馈可快速把错误映射提升为 `verified`，污染后续推荐。 | 建议采纳三重约束：① 反馈以 `requestId` 幂等（`sku_match_log` 以 `_id = requestId` 覆盖写，重试不重复计数）；② `confirmed_count` 只按**不同 `sourceOrderNo`** 累计，且服务端在 `order_import_logs` 校验该单确已导入成功（存在 `createdOrderId`）；③ 升级 `verified` 前复核目标 SKU 仍有效。共享 token 下 `operator` 仅作记录，不作为信任依据。 |
| R4 | P2 | **G1 冷启动数据不能无条件直接标记 `verified`**。多货品导入时多个日志可能共享同一 `goodsTitle`，最终订单又包含多条 `products[]`；旧订单还可能无法唯一解析到回填后的 `skuId`。建议按 `sourceOrderNo + normalized_title` 聚合，通过 `sourceOrderItemNo` 关联全部目标货品；无法唯一解析、SKU 已停用或数据不完整的记录跳过或仅标记为 `candidate`。 | 可能生成残缺、重复或错误的历史强映射，上线首日即产生错误推荐。 | 建议采纳：按 `sourceOrderNo` 聚合日志、经 `sourceOrderItemNo` 关联到订单 `products[]` 的对应货品；名称三元组能**唯一**反查到 backfill 后仍有效的 `skuId` 才写 `verified`；反查不唯一（改过名）、SKU 停用、数据残缺 → 降为 `candidate` 或跳过并输出清单供人工核对。脚本先跑 dryRun 出统计再落库。 |
| R5 | P2 | **`sku_catalog_version` 更新缺少原子性约束**。建议使用事务或原子计数器，覆盖新增、改名、排序、停用、删除、初始化和 backfill；backfill 整批成功后只发布一次新版本。 | 并发修改可能丢失版本递增，使货品已经变化但缓存键未变化。 | 建议采纳：复用现有 `system_counters` 集合，新增文档 `skuCatalogVersion`，用 `_.inc(1)` 原子自增（CloudBase 单文档原子操作，无需事务）；`manageProductModels` 所有写路径（增/改/删/停用/初始化）写库成功后递增；`backfillSkuIds` 整批完成后只递增一次。版本丢增的兜底：读取时若计数文档缺失按 0 处理，宁可缓存失效不可错用旧缓存。 |
| R6 | P2 | **A2 的改造面不完整**。除 PhoneModels 页面透传外，还需明确修改 `src/types/index.ts` 的 `PhoneBrand / PhoneProduct / PhoneModelSpec`，并为 `normalizeBrand / normalizeProduct / normalizeSpec`、`addBrand / addProduct / addSpec`、种子合并路径定义 ID、aliases、attributes 的默认值和保留规则。 | 初始化、添加或后续编辑可能静默丢失稳定 ID、别名或结构化属性。 | 建议采纳，A2 改造面扩充为：① `src/types/index.ts` 的 `PhoneBrand / PhoneModelItem / PhoneModelSpec` 增加 `brandId?/productId?/skuId?/aliases?/attributes?`；② `normalizeBrand/Product/Spec` 统一规则"无 ID 则生成、有 ID 必保留；aliases 缺省 `[]`；attributes 原样透传"；③ `initializeDefault` 种子合并按名称对齐既有条目并保留其 ID；④ 前端 `usePhoneModels` 各写操作以服务端返回为准回填，禁止用本地对象整体覆盖。 |

### 需要团队优先决定

1. 阶段一是否正式支持一个来源标题推荐多个 SKU；若支持，采用“候选方案组 `items[]`”契约。
   - **建议**：契约按方案组 `items[]` 定型（与历史映射 `target_items` 对齐），**实现阶段一只出单 item 方案**。多商品/套装标题不自动拆，返回 `none` 走人工。理由：契约变更成本远高于实现收缩，一次定型可避免阶段二破坏兼容；而套装自动拆分的正确率没有数据支撑前不值得冒错误导入的风险。
2. `verified` 的可信门槛：仅按三个不同订单，还是还要求管理员/可信操作员审核。
   - **建议**：3 个不同 `sourceOrderNo` 且每单经服务端校验真实导入成功 → **自动升级**，不强制人工审核；同时保留管理员一键 `disabled` 与 `corrected_count` 自动降级作为纠错通道。理由：共享 token 场景下"真实导入校验"已挡住纯伪造；操作员全是内部人员，强制审核的摩擦大于风险；映射错了影响的只是**预填**（仍需人工确认导入），可容错。若上线后发现污染案例再收紧为审核制。
3. 冷启动映射的默认状态：全部 `candidate`，还是只有可通过 `sourceOrderItemNo` 唯一关联且 SKU 有效的数据可直接 `verified`。
   - **建议**：取后者（R4 口径）——`sourceOrderItemNo` 唯一关联 + 名称唯一反查有效 `skuId` 的直接 `verified`，其余 `candidate` 或跳过。理由：这批数据本来就是人工确认过的真实导入，满足唯一性校验后可信度不低于三次线上确认；全部压成 `candidate` 会让历史映射上线首月几乎无命中，损失冷启动的主要价值。
4. `sku_catalog_version` 的存储位置、原子递增方式和 backfill 发布策略。
   - **建议**：`system_counters` 集合新增 `skuCatalogVersion` 文档，`_.inc(1)` 原子自增（复用现有序号计数器的基础设施与运维习惯）；每次写库成功后递增；backfill 整批成功后只递增一次。计数文档缺失时按 0 处理，宁可多失效缓存不可错用旧缓存。

## 0. 现状确认（以代码与线上数据为准）

| 事项 | 现状 |
| --- | --- |
| 货品库集合 | `product_models`，共 18 个品牌文档 |
| 文档结构 | `brand → products[].name → specs[].name`，纯名称标识 |
| 稳定 ID | **无**（brandId/productId/skuId 均不存在） |
| 别名 / 结构化属性 | **无**（specs 仅有 name/enabled/sort/systemItem） |
| 云函数目录 | 已迁移为 `cloud_functions/<name>/` 平铺结构 |
| 插件取数入口 | `importOrderFromAssist` 的 `getProductModels` action（`fetchProductModels()`） |
| 鉴权模式 | HTTP 访问服务 + Bearer 静态 token（`HC_ORDER_ASSIST_TOKEN`） |
| 历史导入数据 | `order_import_logs` 存有每次导入的 `rawPayload`（含 goodsTitle）与建单结果，可用于冷启动 |
| 订单货品结构 | 订单已支持 `products[]` 多货品，多 SKU 推荐可直接落为同单多条货品 |

对上游方案 §19 待确认事项的就地回答：

1. hc-admin 当前**没有**稳定唯一 ID → 本清单 A1 新建；
2. 历史标题+正确 SKU 可从 `order_import_logs` 反向提取（见 G1）；
3. **没有**容量/颜色/版本结构化字段 → 本清单 A2 新建；
4. 同一标题不同商户对应不同 SKU：待业务确认，数据模型已按 `merchant` 维度预留；
5. 套装在 hc-admin 中是**多个独立 SKU**（订单 `products[]` 多货品），无套装 SKU 概念。

## A. SKU 主数据改造（核心依赖项）

### A1. 三级稳定 ID

改造点：`cloud_functions/manageProductModels/index.js`

- 品牌文档新增 `brandId`；`products[]` 每项新增 `productId`；`specs[]` 每项新增 `skuId`
- 生成规则：**写入时生成一次，改名/排序/停用永不重新生成、永不复用**
- `normalizeBrand / normalizeProduct / normalizeSpec` 及全部 add/update 路径遵循"无 ID 则补、有 ID 必留"
- 新增一次性 action `backfillSkuIds`（支持 `dryRun`）：为存量 18 个品牌文档补齐 ID

### A2. 别名与结构化属性（含 R6 修订）

- brand / product / spec 三级各新增 `aliases: string[]`（默认 `[]`）
- spec 新增可选 `attributes: { storage?, color?, network? }`
- 类型定义：`src/types/index.ts` 的 `PhoneBrand / PhoneModelItem / PhoneModelSpec` 同步增加 `brandId? / productId? / skuId? / aliases? / attributes?`
- 服务端统一保留规则：`normalizeBrand / normalizeProduct / normalizeSpec` 及全部 add/update 路径遵循——**无 ID 则生成、有 ID 必保留；`aliases` 缺省补 `[]`；`attributes` 原样透传**
- `initializeDefault` 种子合并按名称对齐既有条目并保留其已有 ID，禁止重建
- 前端底线：PhoneModels 管理页（`usePhoneModels` + `PhoneModels.tsx`）各写操作**以服务端返回为准回填**，禁止用本地对象整体覆盖导致新字段丢失；别名维护 UI 可放阶段 1.5

### A3. 货品库版本号（含 R1 / R5 修订）

- 存储：`system_counters` 集合新增文档 `skuCatalogVersion`，用 `_.inc(1)` 原子自增（单文档原子操作，无需事务，与现有序号计数器基础设施一致）
- 递增时机：`manageProductModels` 所有写路径（新增/改名/排序/停用/删除/初始化）写库成功后递增；`backfillSkuIds` 整批成功后只递增一次
- 容错：计数文档缺失时按 0 处理——宁可缓存失效，不可错用旧缓存
- 匹配结果缓存键 = `source + normalized_merchant + normalized_title + sku_catalog_version`，无商户用哨兵值 `-`；商户名同样归一化（去空格/全角转半角），避免同店不同写法分裂

## B. `getProductModels` 接口扩展

改造点：`cloud_functions/importOrderFromAssist/index.js` 的 `fetchProductModels()`

- 返回结构追加：`brandId / productId / skuId / aliases / attributes` + `catalogVersion`
- **保留现有 name 字段**，旧版插件无感兼容

## C. 新接口 `matchProductModels`（阶段一：纯规则）

建议作为 `importOrderFromAssist` 新 action（复用 HTTP 绑定与 token 鉴权）。

1. **标题归一化**（原始标题全程保留）：
   - 小写化、全角转半角、去装饰符号
   - 单位归一：`256g / 256 gb → 256gb`
   - 品牌别名：`苹果 → apple`；型号缩写：`pm → pro max`（限明确上下文）
   - 清除营销词（`全新正品/顺丰包邮/爆款` 等），保留可能影响 SKU 的套餐/配件词
2. **历史映射查询**：`source + normalized_merchant + normalized_title` 精确命中且目标全部 SKU 有效 → `matchType: 'history'`（无商户哨兵值 `-`，与缓存键一致）
3. **规则召回 Top 3**：SKU 扁平化为 `品牌+别名+货品+别名+规格+别名+属性` 检索文本；打分权重（初始值）：品牌 20% / 型号 35% / 容量 20% / 颜色 10% / 网络版本 5% / 文本相似度 10%；18 品牌量级用分词+编辑距离即可，不需要向量
4. **硬冲突**：
   - 来源容量明确且不一致 → 强降权
   - 品牌明确且不一致 → 排除
   - SKU 已停用 → 排除
   - 来源未提及某属性 ≠ 不一致（不扣分）
5. **响应契约（含 R2 修订，方案组结构一次定型）**：

   ```json
   {
     "requestId": "match_req_001",
     "matchType": "history | rule | none",
     "normalizedTitle": "...",
     "candidates": [
       {
         "items": [{ "skuId": "sku_123", "quantity": 1 }],
         "confidence": 0.92,
         "matchedAttributes": ["型号", "容量"],
         "conflicts": [],
         "reason": "..."
       }
     ],
     "needsConfirmation": true
   }
   ```

   - `candidates[]` 每项为**方案组**，`items[]` 与历史映射 `target_items` 结构对齐，阶段二接 LLM 时契约不变
   - **阶段一实现只返回单 item 方案**；识别到多商品/套装标题时返回 `matchType: 'none'` + 提示人工拆分，不自动组合
   - 方案组内 `items[].quantity` 合计不得超过来源商品数量

## D. 新接口 `submitProductMatchFeedback`（含 R3 修订）

- 全量写 `sku_match_log`（请求、候选与分数、最终选择、feedbackType、耗时）；**以 `_id = requestId` 覆盖写实现幂等**，重试/重复提交不重复计数
- 反馈可信度约束（共享静态 token 场景，`operator` 仅记录、不作为信任依据）：
  - `confirmed_count` 只按**不同 `sourceOrderNo`** 累计
  - 计数前服务端在 `order_import_logs` 校验该 `sourceOrderNo` 确已导入成功（存在 `createdOrderId`）
  - 升级 `verified` 前复核目标 SKU 全部仍有效
- `accepted / corrected / manual` 进入可学习反馈，upsert `source_sku_mapping`：
  - 首次写入 `status: 'candidate'`
  - `confirmed_count` 达 3 个不同订单且通过上述校验 → **自动升级** `verified`（不强制人工审核）
  - `corrected_count` 超阈值 → 自动 `disabled`；管理员保留一键 `disabled` 纠错通道
- `cancelled / invalid_source` 只记日志，不入映射

## E. 新集合

| 集合 | 用途 | 说明 |
| --- | --- | --- |
| `source_sku_mapping` | 已确认的标题→SKU 映射 | 建 `source + normalized_merchant + normalized_title` 唯一索引（与缓存键/查询键一致）；字段按上游方案 §9.1，`target_items` 为 `[{skuId, quantity}]` |
| `sku_match_log` | 匹配请求全量日志 | `_id = requestId`（反馈幂等依赖此约束）；字段按上游方案 §9.2；不写收件人/手机号/地址 |

权限：仅云函数读写，前端与插件不直连。

## F. 部署配置

- C/D 并入 `importOrderFromAssist` 则 `cloudbaserc.json` 无需变更；做成独立函数则需注册
- 无新增环境变量（阶段一不接 LLM）

## G. 验证与冷启动

### G1. 存量数据冷启动（含 R4 修订）

- 一次性脚本：从 `order_import_logs` 反向提取 `goodsTitle → 建单最终货品`，按 `sourceOrderNo` 聚合、经 `sourceOrderItemNo` 关联到订单 `products[]` 的对应货品
- 状态判定：
  - 名称三元组能**唯一**反查到 backfill 后仍有效的 `skuId` → 直接 `verified`（本就是人工确认过的真实导入）
  - 反查不唯一（货品改过名）、SKU 已停用、数据残缺 → 降为 `candidate` 或跳过，输出清单供人工核对
- 执行方式：先 dryRun 输出统计（可 verified / 降级 / 跳过 各多少条）再落库
- 效果：历史映射上线第一天即有命中率，同款商品重复导入直接秒填

### G2. 规则可测性

- 归一化与打分实现为纯函数，node 脚本断言（参照 `npm run test:sf-token` 的脚本模式）
- 验证集覆盖：型号缩写、容量/颜色差异、营销词、信息缺失、相似型号、无对应 SKU

## 实施顺序与工作量估算

```
A1 → A2/A3 → B → (E + C) → D → G1
```

| 项 | 估算 |
| --- | --- |
| A（含 backfill 迁移） | ~1 天 |
| B | ~0.5 天 |
| C（归一化规则最花时间） | 1~2 天 |
| D + E | ~0.5 天 |
| G1 冷启动脚本 | ~0.5 天 |

A1 是唯一带迁移性质的动作，先做且做对；其后全部为增量改动，随时可发布。

## 风险提示

| 风险 | 应对 |
| --- | --- |
| PhoneModels 页编辑丢新字段 | A2 底线要求透传未知字段，上线前专项回归 |
| backfill 与日常编辑并发 | backfill 选择低峰执行，支持 dryRun 预览 |
| 归一化规则误伤（如 `pm` 误展开） | 缩写展开限定品牌上下文；G2 验证集覆盖 |
| 旧版插件兼容 | B 项只增不改，name 字段语义不变 |

---
🤖 Generated with [Claude Code](https://claude.com/claude-code)
