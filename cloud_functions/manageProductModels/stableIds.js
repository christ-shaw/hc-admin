const crypto = require('crypto');

const ID_PREFIXES = Object.freeze({
  brand: 'br',
  product: 'prd',
  sku: 'sku',
});

function createStableId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function ensureStableId(value, prefix) {
  if (typeof value === 'string' && value.trim()) return value;
  return createStableId(prefix);
}

function countMissingStableIds(brands) {
  const missing = { brands: 0, products: 0, specs: 0 };
  for (const brand of brands || []) {
    if (!String(brand && brand.brandId || '').trim()) missing.brands += 1;
    const products = Array.isArray(brand && brand.products) && brand.products.length > 0
      ? brand.products
      : (brand && Array.isArray(brand.models) ? brand.models.map(name => ({ name })) : []);
    for (const product of products) {
      if (!String(product && product.productId || '').trim()) missing.products += 1;
      const specs = Array.isArray(product && product.specs) && product.specs.length > 0
        ? product.specs
        : [{}];
      for (const spec of specs) {
        if (!String(spec && spec.skuId || '').trim()) missing.specs += 1;
      }
    }
  }
  return missing;
}

function findDuplicateStableIds(brands) {
  const seen = {
    brandId: new Set(),
    productId: new Set(),
    skuId: new Set(),
  };
  const duplicates = {
    brandIds: [],
    productIds: [],
    skuIds: [],
  };

  function record(type, value, outputKey) {
    const id = String(value || '').trim();
    if (!id) return;
    if (seen[type].has(id)) {
      if (!duplicates[outputKey].includes(id)) duplicates[outputKey].push(id);
      return;
    }
    seen[type].add(id);
  }

  for (const brand of brands || []) {
    record('brandId', brand && brand.brandId, 'brandIds');
    for (const product of brand && brand.products || []) {
      record('productId', product && product.productId, 'productIds');
      for (const spec of product && product.specs || []) {
        record('skuId', spec && spec.skuId, 'skuIds');
      }
    }
  }

  return duplicates;
}

function hasDuplicateStableIds(duplicates) {
  return Object.values(duplicates || {}).some(items => Array.isArray(items) && items.length > 0);
}

module.exports = {
  ID_PREFIXES,
  createStableId,
  ensureStableId,
  countMissingStableIds,
  findDuplicateStableIds,
  hasDuplicateStableIds,
};
