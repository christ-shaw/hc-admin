const test = require('node:test');
const assert = require('node:assert/strict');

const { mapProductModelDocs } = require('./productModelsCatalog');

test('mapProductModelDocs returns IDs, aliases and attributes while keeping names', () => {
  const result = mapProductModelDocs([{
    brandId: 'br_1',
    brand: 'Apple',
    aliases: [' 苹果 ', '苹果'],
    products: [{
      productId: 'prd_1',
      name: 'iPhone 15 Pro Max',
      aliases: ['15PM'],
      enabled: true,
      sort: 20,
      specs: [{
        skuId: 'sku_1',
        name: '256GB 原色',
        aliases: ['256G 原色'],
        attributes: { storage: '256GB', color: '原色', edition: '国行' },
        enabled: true,
        sort: 10,
      }],
    }],
  }]);

  assert.deepEqual(result, [{
    brandId: 'br_1',
    brand: 'Apple',
    aliases: ['苹果'],
    products: [{
      productId: 'prd_1',
      name: 'iPhone 15 Pro Max',
      aliases: ['15PM'],
      specs: [{
        skuId: 'sku_1',
        name: '256GB 原色',
        aliases: ['256G 原色'],
        enabled: true,
        attributes: { storage: '256GB', color: '原色', edition: '国行' },
      }],
    }],
  }]);
});

test('mapProductModelDocs excludes disabled and empty candidates and sorts enabled items', () => {
  const result = mapProductModelDocs([{
    brand: '测试品牌',
    products: [
      { name: '停用货品', enabled: false, specs: [{ name: '默认' }] },
      {
        name: '后排序', sort: 20, specs: [
          { name: '停用规格', enabled: false, sort: 5 },
          { name: '规格2', sort: 20 },
          { name: '规格1', sort: 10 },
        ],
      },
      { name: '前排序', sort: 10, specs: [{ name: '默认' }] },
    ],
  }]);

  assert.deepEqual(result[0].products.map(product => product.name), ['前排序', '后排序']);
  assert.deepEqual(result[0].products[1].specs.map(spec => spec.name), ['规格1', '规格2']);
});

test('mapProductModelDocs supports legacy models with a default spec', () => {
  const result = mapProductModelDocs([{ brand: '旧品牌', models: ['旧型号'] }]);
  assert.equal(result[0].products[0].name, '旧型号');
  assert.equal(result[0].products[0].specs[0].name, '默认');
});
