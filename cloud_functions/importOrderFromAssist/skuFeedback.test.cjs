const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildNextMapping,
  isLearningFeedback,
  normalizeFeedbackType,
  normalizeMappingItems,
  normalizeSelectedItems,
  sameTargetItems,
} = require('./skuFeedback');

function context(overrides = {}) {
  return {
    source: 'zanchenzu',
    goodsTitle: '苹果15PM 256G',
    normalizedTitle: 'apple 15 pro max 256gb',
    titleFingerprint: 'brand:apple|model:15promax|storage:256gb|variant:promax',
    promotable: true,
    ambiguityReason: '',
    selectedItems: [{ skuId: 'sku_1', quantity: 1 }],
    sourceOrderNo: 'ME001',
    operator: { uid: 'u1', username: '测试' },
    requestId: 'match_1',
    now: '2026-08-08T00:00:00.000Z',
    ...overrides,
  };
}

test('feedback type separates learning and log-only events', () => {
  assert.equal(normalizeFeedbackType('accepted'), 'accepted');
  assert.equal(normalizeFeedbackType('unknown'), '');
  assert.equal(isLearningFeedback('manual'), true);
  assert.equal(isLearningFeedback('cancelled'), false);
});

test('normalizeSelectedItems combines duplicate SKU quantities deterministically', () => {
  assert.deepEqual(normalizeSelectedItems([
    { skuId: 'sku_b', quantity: 1 },
    { skuId: 'sku_a', quantity: 2 },
    { skuId: 'sku_b', quantity: 3 },
  ]), [
    { skuId: 'sku_a', quantity: 2 },
    { skuId: 'sku_b', quantity: 4 },
  ]);
  assert.equal(sameTargetItems([{ skuId: 'sku_1', quantity: 1 }], [{ quantity: 1, skuId: 'sku_1' }]), true);
});

test('single-SKU mappings ignore historical order quantity', () => {
  assert.deepEqual(normalizeMappingItems([{ skuId: 'sku_1', quantity: 50 }]), [{ skuId: 'sku_1', quantity: 1 }]);
  assert.equal(sameTargetItems(
    [{ skuId: 'sku_1', quantity: 1 }],
    [{ skuId: 'sku_1', quantity: 50 }]
  ), true);
});

test('three distinct imported orders promote the same mapping to verified', () => {
  const first = buildNextMapping(null, context());
  assert.equal(first.status, 'candidate');
  assert.equal(first.mapping_version, 'v2');
  assert.equal(first.title_fingerprint, context().titleFingerprint);
  assert.equal('merchant' in first, false);
  assert.equal('normalized_merchant' in first, false);
  const second = buildNextMapping(first, context({ sourceOrderNo: 'ME002', requestId: 'match_2' }));
  assert.equal(second.status, 'candidate');
  const repeated = buildNextMapping(second, context({ sourceOrderNo: 'ME002', requestId: 'match_repeat' }));
  assert.equal(repeated.confirmed_count, 2);
  const third = buildNextMapping(repeated, context({ sourceOrderNo: 'ME003', requestId: 'match_3' }));
  assert.equal(third.status, 'verified');
  assert.equal(third.confirmed_count, 3);
});

test('an ambiguous fingerprint records feedback but never promotes to verified', () => {
  const ambiguous = context({
    goodsTitle: 'Y33S',
    normalizedTitle: 'y33s',
    titleFingerprint: 'model:y33s',
    promotable: false,
    ambiguityReason: '型号 Y33S 存在多个品牌',
  });
  const first = buildNextMapping(null, ambiguous);
  const second = buildNextMapping(first, { ...ambiguous, sourceOrderNo: 'ME002', requestId: 'match_2' });
  const third = buildNextMapping(second, { ...ambiguous, sourceOrderNo: 'ME003', requestId: 'match_3' });
  assert.equal(third.confirmed_count, 3);
  assert.equal(third.status, 'candidate');
  assert.equal(third.promotable, false);
  assert.match(third.ambiguity_reason, /多个品牌/);
});

test('changing a target resets confirmations and repeated corrections disable mapping', () => {
  const verified = {
    ...buildNextMapping(null, context()),
    target_items: [{ skuId: 'sku_old', quantity: 1 }],
    confirmed_order_nos: ['ME001', 'ME002', 'ME003'],
    confirmed_count: 3,
    status: 'verified',
  };
  const corrected = buildNextMapping(verified, context({ selectedItems: [{ skuId: 'sku_new', quantity: 1 }], sourceOrderNo: 'ME004' }));
  assert.equal(corrected.status, 'candidate');
  assert.equal(corrected.confirmed_count, 1);
  assert.equal(corrected.corrected_count, 1);

  const disabled = buildNextMapping(corrected, context({ selectedItems: [{ skuId: 'sku_newer', quantity: 1 }], sourceOrderNo: 'ME005' }));
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabled.corrected_count, 2);
});
