# SKU 规则 V2 集合与索引约束

## `source_sku_mapping`

### V2 文档

- 文档 `_id`：`sku_map_` + `sha256("v2\n" + source + "\n" + title_fingerprint)`。
- 确定性 `_id` 保证同一来源、同一商品特征只有一条 V2 映射。
- `merchant / normalized_merchant` 不再参与匹配、映射 ID、反馈一致性或可信状态判断。
- 新反馈只写 V2 文档；旧 V1 文档在过渡期保留，不原地改 ID。
- `target_items` 当前只允许单 SKU 历史自动命中；多 SKU 反馈可记录为 `candidate`，不得自动命中。
- `status`：`candidate / verified / disabled`。
- `promotable=false` 的映射即使确认次数达到阈值，也不得升级为 `verified`。

建议字段：

```json
{
  "mapping_version": "v2",
  "source": "zanchenzu",
  "source_title": "（云途） A72",
  "normalized_title": "云途 a72",
  "title_fingerprint": "model:a72",
  "target_items": [{ "skuId": "sku_xxx", "quantity": 1 }],
  "promotable": true,
  "ambiguity_reason": "",
  "confirmed_order_nos": ["ME001"],
  "confirmed_count": 1,
  "corrected_count": 0,
  "status": "candidate"
}
```

### V1 双读

V2 `_id` 未命中时，服务端按以下字段查询旧映射：

```text
source + normalized_title + status=verified
```

只有所有仍有效的旧映射都指向同一个 SKU 时才允许临时历史命中；不同商家旧映射目标不一致时返回规则候选或人工选择。

## `sku_match_log`

- 文档 `_id` 等于匹配接口返回的 `requestId`，反馈重试依靠 `feedback_processed` 保证幂等。
- `algorithm_version` 固定记录实际执行版本，V2 为 `rule-v2`。
- 增加 `title_fingerprint / mapping_promotable / ambiguity_reason`。
- 原始 `merchant` 可用于普通审计，但必须同时明确 `merchant_ignored_for_matching=true`。
- 不保存收件人、手机号、地址等与 SKU 匹配无关的信息。

## 上线前必须创建的索引

在 CloudBase 控制台为 `source_sku_mapping` 建立普通复合索引：

```text
source ASC + normalized_title ASC + status ASC
source ASC + title_fingerprint ASC + status ASC
```

第一条是 V1 双读查询的运行前置条件；未创建时不得部署包含双读逻辑的云函数。V2 正式读取使用确定性 `_id`，第二条主要用于审计、迁移和管理查询。

集合权限保持为仅服务端可读写，前端和浏览器扩展不直连。

## V2 backfill

脚本 `scripts/backfill-source-sku-mappings.cjs` 已按 V2 指纹生成新映射，默认只输出 dry-run 报告：

```bash
npm run sku-mapping:backfill
```

报告确认后才允许显式写入：

```bash
npm run sku-mapping:backfill -- --apply --confirm <目标环境ID>
```

脚本不会覆盖已存在的 V2 `_id`，目标冲突、无效 SKU、多 SKU 和不可提升指纹会降级或进入跳过报告。
