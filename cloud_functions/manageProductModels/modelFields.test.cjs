const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeAliases, normalizeAttributes, shouldIncrementCatalogVersion } = require('./modelFields');

test('normalizeAliases trims, deduplicates and ignores invalid entries', () => {
  assert.deepEqual(normalizeAliases([' 苹果 ', 'Apple', '苹果', '', null, 123]), ['苹果', 'Apple']);
  assert.deepEqual(normalizeAliases(undefined), []);
});

test('normalizeAttributes preserves supported and future fields without sharing the input object', () => {
  const input = { storage: '256GB', color: '黑色', network: '5G', edition: '国行' };
  const result = normalizeAttributes(input);
  assert.deepEqual(result, input);
  assert.notEqual(result, input);
});

test('normalizeAttributes ignores invalid values', () => {
  assert.equal(normalizeAttributes(null), undefined);
  assert.equal(normalizeAttributes([]), undefined);
  assert.equal(normalizeAttributes('256GB'), undefined);
});

test('shouldIncrementCatalogVersion only publishes actual catalog changes', () => {
  assert.equal(shouldIncrementCatalogVersion('addBrand', {}, { success: true }), true);
  assert.equal(shouldIncrementCatalogVersion('addBrand', {}, { success: false }), false);
  assert.equal(shouldIncrementCatalogVersion('initializeDefault', {}, { success: true, data: { inserted: 0, merged: 0 } }), false);
  assert.equal(shouldIncrementCatalogVersion('initializeDefault', {}, { success: true, data: { inserted: 1, merged: 0 } }), true);
  assert.equal(shouldIncrementCatalogVersion('addModels', {}, { success: true, addedCount: 0 }), false);
  assert.equal(shouldIncrementCatalogVersion('addModels', {}, { success: true, addedCount: 2 }), true);
  assert.equal(shouldIncrementCatalogVersion('backfillSkuIds', { dryRun: true }, { success: true, data: { updatedDocuments: 18 } }), false);
  assert.equal(shouldIncrementCatalogVersion('backfillSkuIds', { dryRun: false }, { success: true, data: { updatedDocuments: 18 } }), true);
});
