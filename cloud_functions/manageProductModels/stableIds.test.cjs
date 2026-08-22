const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ID_PREFIXES,
  createStableId,
  ensureStableId,
  countMissingStableIds,
  findDuplicateStableIds,
  hasDuplicateStableIds,
} = require('./stableIds');

test('ensureStableId preserves an existing ID', () => {
  assert.equal(ensureStableId('sku_existing', ID_PREFIXES.sku), 'sku_existing');
  assert.equal(ensureStableId(' sku_existing ', ID_PREFIXES.sku), ' sku_existing ');
});

test('createStableId creates prefixed unique IDs', () => {
  const ids = new Set(Array.from({ length: 1000 }, () => createStableId(ID_PREFIXES.sku)));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert.match(id, /^sku_[0-9a-f]{24}$/);
});

test('countMissingStableIds counts all three levels', () => {
  const result = countMissingStableIds([
    {
      brand: '苹果',
      products: [
        { name: 'iPhone 13', specs: [{ name: '默认' }, { skuId: 'sku_1', name: '256G' }] },
        { productId: 'prd_2', name: 'iPhone 14', specs: [{ name: '默认' }] },
      ],
    },
  ]);
  assert.deepEqual(result, { brands: 1, products: 1, specs: 2 });
});

test('countMissingStableIds includes legacy models and their default specs', () => {
  const result = countMissingStableIds([
    { brandId: 'br_1', brand: '苹果', models: ['iPhone 13', 'iPhone 14'] },
  ]);
  assert.deepEqual(result, { brands: 0, products: 2, specs: 2 });
});

test('findDuplicateStableIds reports duplicates by level', () => {
  const duplicates = findDuplicateStableIds([
    {
      brandId: 'br_1',
      products: [{ productId: 'prd_1', specs: [{ skuId: 'sku_1' }] }],
    },
    {
      brandId: 'br_1',
      products: [{ productId: 'prd_1', specs: [{ skuId: 'sku_1' }] }],
    },
  ]);
  assert.deepEqual(duplicates, {
    brandIds: ['br_1'],
    productIds: ['prd_1'],
    skuIds: ['sku_1'],
  });
  assert.equal(hasDuplicateStableIds(duplicates), true);
});

test('findDuplicateStableIds ignores missing IDs', () => {
  const duplicates = findDuplicateStableIds([{ products: [{ specs: [{}] }] }]);
  assert.deepEqual(duplicates, { brandIds: [], productIds: [], skuIds: [] });
  assert.equal(hasDuplicateStableIds(duplicates), false);
});
