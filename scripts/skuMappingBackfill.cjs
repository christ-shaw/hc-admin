const {
  analyzeTitle,
  createSourceMappingIdV2,
} = require('../cloud_functions/importOrderFromAssist/skuMatcher');

const SOURCE = 'zanchenzu';

function clean(value) {
  return String(value || '').trim();
}

function nameKey(value) {
  return clean(value).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

function tripleKey(brand, productName, specification) {
  return [brand, productName, specification].map(nameKey).join('\n');
}

function normalizeQuantity(value) {
  return Math.max(1, Number.parseInt(value, 10) || 1);
}

function normalizeTargetItems(items) {
  const quantities = new Map();
  for (const item of items || []) {
    const skuId = clean(item && item.skuId);
    if (!skuId) continue;
    quantities.set(skuId, (quantities.get(skuId) || 0) + normalizeQuantity(item.quantity));
  }
  return [...quantities.entries()]
    .map(([skuId, quantity]) => ({ skuId, quantity }))
    .sort((left, right) => left.skuId.localeCompare(right.skuId));
}

function sameTargets(left, right) {
  const a = normalizeTargetItems(left);
  const b = normalizeTargetItems(right);
  return a.length === b.length && a.every((item, index) => (
    item.skuId === b[index].skuId && item.quantity === b[index].quantity
  ));
}

function buildActiveSkuIndex(productModelDocs) {
  const index = new Map();
  for (const brand of productModelDocs || []) {
    if (!brand || brand.enabled === false) continue;
    for (const product of brand.products || []) {
      if (!product || product.enabled === false) continue;
      for (const spec of product.specs || []) {
        const skuId = clean(spec && spec.skuId);
        if (!spec || spec.enabled === false || !skuId) continue;
        const key = tripleKey(brand.brand, product.name, spec.name);
        if (!key.replace(/\n/g, '')) continue;
        const matches = index.get(key) || [];
        matches.push({
          skuId,
          brand: clean(brand.brand),
          productName: clean(product.name),
          specification: clean(spec.name),
        });
        index.set(key, matches);
      }
    }
  }
  return index;
}

function getOrderProducts(order) {
  if (Array.isArray(order && order.products) && order.products.length > 0) return order.products;
  if (order && (order.brand || order.productName || order.specification)) {
    return [{
      brand: order.brand,
      productName: order.productName,
      specification: order.specification,
      quantity: order.quantity,
      sourceOrderItemNo: order.sourceOrderItemNo,
    }];
  }
  return [];
}

function logContext(log, productModelDocs) {
  const raw = log && log.rawPayload && typeof log.rawPayload === 'object' ? log.rawPayload : {};
  const sourceTitle = clean(raw.goodsTitle || log.goodsTitle);
  const analysis = analyzeTitle(sourceTitle, productModelDocs);
  return {
    sourceTitle,
    normalizedTitle: analysis.normalizedTitle,
    titleFingerprint: analysis.titleFingerprint,
    promotable: analysis.promotable,
    ambiguityReason: analysis.ambiguityReason,
  };
}

function makeSkip(group, reason, detail) {
  return {
    sourceOrderNo: group.sourceOrderNo,
    normalizedTitle: group.normalizedTitle,
    reason,
    ...(detail ? { detail } : {}),
  };
}

function buildColdStartMappings({ logs, orders, productModelDocs, existingMappingIds = [], now }) {
  const timestamp = now || new Date().toISOString();
  const skuIndex = buildActiveSkuIndex(productModelDocs);
  const ordersById = new Map((orders || []).map(order => [clean(order && order._id), order]));
  const existingIds = new Set((existingMappingIds || []).map(clean).filter(Boolean));
  const groups = new Map();
  const skipped = [];

  for (const log of logs || []) {
    if (!log || log.source !== SOURCE || log.status !== 'success') continue;
    const sourceOrderNo = clean(log.sourceOrderNo);
    const sourceOrderItemNo = clean(log.sourceOrderItemNo);
    const createdOrderId = clean(log.createdOrderId);
    const context = logContext(log, productModelDocs);
    if (!sourceOrderNo || !sourceOrderItemNo || !createdOrderId || !context.normalizedTitle) {
      skipped.push({ sourceOrderNo, normalizedTitle: context.normalizedTitle, reason: 'incomplete_log' });
      continue;
    }
    const key = [sourceOrderNo, context.titleFingerprint].join('\n');
    const group = groups.get(key) || {
      sourceOrderNo,
      sourceTitle: context.sourceTitle,
      normalizedTitle: context.normalizedTitle,
      titleFingerprint: context.titleFingerprint,
      promotable: context.promotable,
      ambiguityReason: context.ambiguityReason,
      logs: [],
    };
    group.logs.push({ log, sourceOrderItemNo, createdOrderId });
    groups.set(key, group);
  }

  const resolvedGroups = [];
  for (const group of groups.values()) {
    const targets = [];
    let usedFallback = false;
    let failure = null;

    for (const entry of group.logs) {
      const order = ordersById.get(entry.createdOrderId);
      if (!order
        || clean(order.onlineOrderNumber) !== group.sourceOrderNo
        || clean(order.importSource) !== 'hc-order-assist') {
        failure = makeSkip(group, 'order_not_found_or_mismatch', entry.createdOrderId);
        break;
      }

      const products = getOrderProducts(order);
      const exact = products.filter(product => clean(product && product.sourceOrderItemNo) === entry.sourceOrderItemNo);
      let product = null;
      if (exact.length === 1) {
        product = exact[0];
      } else if (exact.length === 0 && group.logs.length === 1 && products.length === 1) {
        product = products[0];
        usedFallback = true;
      } else {
        failure = makeSkip(group, 'product_link_ambiguous', entry.sourceOrderItemNo);
        break;
      }

      const matches = skuIndex.get(tripleKey(product.brand, product.productName, product.specification)) || [];
      if (matches.length === 0) {
        failure = makeSkip(group, 'active_sku_not_found', [product.brand, product.productName, product.specification].map(clean).join(' / '));
        break;
      }
      if (matches.length !== 1) {
        failure = makeSkip(group, 'active_sku_ambiguous', matches.map(item => item.skuId).join(','));
        break;
      }
      targets.push({ skuId: matches[0].skuId, quantity: normalizeQuantity(product.quantity) });
    }

    if (failure) {
      skipped.push(failure);
      continue;
    }
    const targetItems = normalizeTargetItems(targets);
    if (targetItems.length === 0) {
      skipped.push(makeSkip(group, 'empty_target_items'));
      continue;
    }
    const promotable = group.promotable && targetItems.length === 1;
    const ambiguityReason = targetItems.length > 1
      ? '阶段一不将多 SKU 标题升级为全局可信映射'
      : group.ambiguityReason;
    resolvedGroups.push({
      ...group,
      targetItems,
      promotable,
      ambiguityReason,
      status: !usedFallback && promotable ? 'verified' : 'candidate',
    });
  }

  const accumulators = new Map();
  const conflicts = new Set();
  for (const group of resolvedGroups) {
    const mappingId = createSourceMappingIdV2(SOURCE, group.titleFingerprint);
    const current = accumulators.get(mappingId);
    if (current && !sameTargets(current.target_items, group.targetItems)) {
      conflicts.add(mappingId);
      skipped.push(makeSkip(group, 'mapping_target_conflict', {
        mappingId,
        existingTargetItems: current.target_items,
        conflictingTargetItems: group.targetItems,
      }));
      continue;
    }
    const orderNos = Array.from(new Set([...(current && current.confirmed_order_nos || []), group.sourceOrderNo]));
    const verified = group.status === 'verified' || current && current.status === 'verified';
    accumulators.set(mappingId, {
      _id: mappingId,
      source: SOURCE,
      mapping_version: 'v2',
      source_title: current && current.source_title || group.sourceTitle,
      normalized_title: group.normalizedTitle,
      title_fingerprint: group.titleFingerprint,
      target_items: group.targetItems,
      confirmed_order_nos: orderNos,
      confirmed_count: orderNos.length,
      corrected_count: 0,
      status: verified ? 'verified' : 'candidate',
      promotable: group.promotable,
      ambiguity_reason: group.promotable ? '' : group.ambiguityReason,
      created_by: { uid: 'system', username: 'cold-start-backfill', loginType: 'system' },
      last_confirmed_by: { uid: 'system', username: 'cold-start-backfill', loginType: 'system' },
      created_at: timestamp,
      updated_at: timestamp,
      cold_start: true,
    });
  }

  for (const mappingId of conflicts) accumulators.delete(mappingId);
  const mappings = [...accumulators.values()].sort((left, right) => left._id.localeCompare(right._id));
  const pendingMappings = mappings.filter(mapping => !existingIds.has(mapping._id));
  const existing = mappings.length - pendingMappings.length;
  return {
    mappings: pendingMappings,
    skipped,
    stats: {
      inputLogs: (logs || []).length,
      groupedTitles: groups.size,
      verified: pendingMappings.filter(item => item.status === 'verified').length,
      candidate: pendingMappings.filter(item => item.status === 'candidate').length,
      existing,
      skipped: skipped.length,
    },
  };
}

module.exports = {
  SOURCE,
  buildActiveSkuIndex,
  buildColdStartMappings,
  getOrderProducts,
  logContext,
  normalizeTargetItems,
  sameTargets,
  tripleKey,
};
