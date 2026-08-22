const LEARNING_FEEDBACK_TYPES = new Set(['accepted', 'corrected', 'manual']);
const LOG_ONLY_FEEDBACK_TYPES = new Set(['cancelled', 'invalid_source']);
const ALL_FEEDBACK_TYPES = new Set([...LEARNING_FEEDBACK_TYPES, ...LOG_ONLY_FEEDBACK_TYPES]);
const DISABLE_CORRECTION_THRESHOLD = 2;
const VERIFY_CONFIRMATION_THRESHOLD = 3;

function normalizeFeedbackType(value) {
  const type = String(value || '').trim();
  return ALL_FEEDBACK_TYPES.has(type) ? type : '';
}

function isLearningFeedback(type) {
  return LEARNING_FEEDBACK_TYPES.has(type);
}

function normalizeSelectedItems(items) {
  const quantities = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const skuId = String(item && item.skuId || '').trim();
    if (!skuId) continue;
    const quantity = Math.max(1, Number.parseInt(item && item.quantity, 10) || 1);
    quantities.set(skuId, (quantities.get(skuId) || 0) + quantity);
  }
  return [...quantities.entries()]
    .map(([skuId, quantity]) => ({ skuId, quantity }))
    .sort((a, b) => a.skuId.localeCompare(b.skuId));
}

function normalizeMappingItems(items) {
  const normalized = normalizeSelectedItems(items);
  // 阶段一只支持单 SKU 历史命中；映射保存单位数量 1，当前订单数量由匹配请求决定。
  if (normalized.length === 1) return [{ skuId: normalized[0].skuId, quantity: 1 }];
  return normalized;
}

function sameTargetItems(left, right) {
  const a = normalizeMappingItems(left);
  const b = normalizeMappingItems(right);
  return a.length === b.length && a.every((item, index) => (
    item.skuId === b[index].skuId && item.quantity === b[index].quantity
  ));
}

function buildNextMapping(existing, context) {
  const selectedItems = normalizeMappingItems(context.selectedItems);
  if (selectedItems.length === 0) throw new Error('学习反馈必须包含 selectedItems');

  const exists = !!existing;
  const targetChanged = exists && !sameTargetItems(existing.target_items, selectedItems);
  const previousOrderNos = Array.isArray(existing && existing.confirmed_order_nos)
    ? existing.confirmed_order_nos.map(value => String(value || '').trim()).filter(Boolean)
    : [];
  const confirmedOrderNos = targetChanged
    ? [context.sourceOrderNo]
    : Array.from(new Set([...previousOrderNos, context.sourceOrderNo]));
  const correctedCount = Number(existing && existing.corrected_count || 0) + (targetChanged ? 1 : 0);
  const confirmedCount = confirmedOrderNos.length;
  const promotable = context.promotable !== false;
  const ambiguityReason = promotable ? '' : String(context.ambiguityReason || '商品特征不足以形成全局可信映射');

  let status = promotable && confirmedCount >= VERIFY_CONFIRMATION_THRESHOLD ? 'verified' : 'candidate';
  if (correctedCount >= DISABLE_CORRECTION_THRESHOLD || existing && existing.status === 'disabled') {
    status = 'disabled';
  }

  return {
    source: context.source,
    mapping_version: 'v2',
    source_title: context.goodsTitle,
    normalized_title: context.normalizedTitle,
    title_fingerprint: context.titleFingerprint,
    target_items: selectedItems,
    confirmed_order_nos: confirmedOrderNos,
    confirmed_count: confirmedCount,
    corrected_count: correctedCount,
    status,
    promotable,
    ambiguity_reason: ambiguityReason,
    created_by: existing && existing.created_by || context.operator,
    last_confirmed_by: context.operator,
    created_at: existing && existing.created_at || context.now,
    updated_at: context.now,
    last_request_id: context.requestId,
  };
}

module.exports = {
  ALL_FEEDBACK_TYPES,
  buildNextMapping,
  isLearningFeedback,
  normalizeFeedbackType,
  normalizeMappingItems,
  normalizeSelectedItems,
  sameTargetItems,
};
