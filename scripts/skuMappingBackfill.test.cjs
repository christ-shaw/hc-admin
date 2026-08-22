const test = require('node:test');
const assert = require('node:assert/strict');

const { buildColdStartMappings } = require('./skuMappingBackfill.cjs');

function catalog(extraSpecs = []) {
  return [{
    brand: 'Apple', enabled: true, products: [{
      name: 'iPhone 15 Pro Max', enabled: true, specs: [
        { name: '256GB 原色', skuId: 'sku_256', enabled: true },
        { name: '128GB 黑色', skuId: 'sku_128', enabled: true },
        { name: '512GB 蓝色', skuId: 'sku_disabled', enabled: false },
        ...extraSpecs,
      ],
    }],
  }];
}

function history({ itemNo = 'ME1#1', orderId = 'order_1', title = '苹果15PM 256G 原色', merchant = '云途租机坊' } = {}) {
  return {
    log: {
      _id: `zanchenzu_${itemNo}`,
      source: 'zanchenzu', status: 'success', sourceOrderNo: 'ME1', sourceOrderItemNo: itemNo,
      createdOrderId: orderId, rawPayload: { goodsTitle: title, merchant },
    },
    order: {
      _id: orderId, importSource: 'hc-order-assist', onlineOrderNumber: 'ME1',
      products: [{
        sourceOrderItemNo: itemNo, brand: 'Apple', productName: 'iPhone 15 Pro Max',
        specification: '256GB 原色', quantity: 1,
      }],
    },
  };
}

test('exact sourceOrderItemNo link and unique active SKU create a verified mapping', () => {
  const { log, order } = history();
  const result = buildColdStartMappings({
    logs: [log], orders: [order], productModelDocs: catalog(), now: '2026-08-08T00:00:00.000Z',
  });
  assert.deepEqual(result.stats, { inputLogs: 1, groupedTitles: 1, verified: 1, candidate: 0, existing: 0, skipped: 0 });
  assert.equal(result.mappings[0].status, 'verified');
  assert.equal(result.mappings[0].mapping_version, 'v2');
  assert.match(result.mappings[0].title_fingerprint, /^brand:apple\|model:/);
  assert.equal('merchant' in result.mappings[0], false);
  assert.equal('normalized_merchant' in result.mappings[0], false);
  assert.deepEqual(result.mappings[0].target_items, [{ skuId: 'sku_256', quantity: 1 }]);
  assert.deepEqual(result.mappings[0].confirmed_order_nos, ['ME1']);
});

test('single-product legacy fallback is candidate instead of verified', () => {
  const { log, order } = history();
  order.products[0].sourceOrderItemNo = '';
  const result = buildColdStartMappings({ logs: [log], orders: [order], productModelDocs: catalog() });
  assert.equal(result.mappings[0].status, 'candidate');
  assert.equal(result.stats.candidate, 1);
});

test('multiple logs for one title aggregate all target items by source item number', () => {
  const first = history();
  const second = history({ itemNo: 'ME1#2' });
  first.order.products.push({
    sourceOrderItemNo: 'ME1#2', brand: 'Apple', productName: 'iPhone 15 Pro Max',
    specification: '128GB 黑色', quantity: 2,
  });
  second.order = first.order;
  const result = buildColdStartMappings({ logs: [first.log, second.log], orders: [first.order], productModelDocs: catalog() });
  assert.equal(result.mappings[0].status, 'candidate');
  assert.equal(result.mappings[0].promotable, false);
  assert.match(result.mappings[0].ambiguity_reason, /多 SKU/);
  assert.deepEqual(result.mappings[0].target_items, [
    { skuId: 'sku_128', quantity: 2 },
    { skuId: 'sku_256', quantity: 1 },
  ]);
});

test('missing, disabled or ambiguous SKU is skipped without a partial mapping', () => {
  const missing = history();
  missing.order.products[0].specification = '512GB 蓝色';
  const noActive = buildColdStartMappings({ logs: [missing.log], orders: [missing.order], productModelDocs: catalog() });
  assert.equal(noActive.mappings.length, 0);
  assert.equal(noActive.skipped[0].reason, 'active_sku_not_found');

  const exact = history();
  const ambiguous = buildColdStartMappings({
    logs: [exact.log], orders: [exact.order],
    productModelDocs: catalog([{ name: '256GB 原色', skuId: 'sku_duplicate', enabled: true }]),
  });
  assert.equal(ambiguous.mappings.length, 0);
  assert.equal(ambiguous.skipped[0].reason, 'active_sku_ambiguous');
});

test('existing mappings and conflicting targets are never overwritten', () => {
  const first = history();
  const preview = buildColdStartMappings({ logs: [first.log], orders: [first.order], productModelDocs: catalog() });
  const existing = buildColdStartMappings({
    logs: [first.log], orders: [first.order], productModelDocs: catalog(),
    existingMappingIds: [preview.mappings[0]._id],
  });
  assert.equal(existing.mappings.length, 0);
  assert.equal(existing.stats.existing, 1);

  const second = history({ itemNo: 'ME2#1', orderId: 'order_2', merchant: '汇租机' });
  second.log.sourceOrderNo = 'ME2';
  second.order.onlineOrderNumber = 'ME2';
  second.order.products[0].sourceOrderItemNo = 'ME2#1';
  second.order.products[0].specification = '128GB 黑色';
  const conflict = buildColdStartMappings({
    logs: [first.log, second.log], orders: [first.order, second.order], productModelDocs: catalog(),
  });
  assert.equal(conflict.mappings.length, 0);
  assert.equal(conflict.skipped.some(item => item.reason === 'mapping_target_conflict'), true);
});
