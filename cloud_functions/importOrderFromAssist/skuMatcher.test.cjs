const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeTitle,
  buildHistoryCandidate,
  buildRuleMatch,
  createSourceMappingId,
  createSourceMappingIdV2,
  extractModelTokens,
  isMultiProductTitle,
  normalizeMerchant,
  normalizeTitle,
  selectConsistentLegacyMapping,
} = require('./skuMatcher');

function catalog() {
  return [
    {
      brandId: 'br_apple', brand: 'Apple', aliases: ['苹果'], products: [
        {
          productId: 'prd_15pm', name: 'iPhone 15 Pro Max', aliases: ['苹果15PM'], specs: [
            { skuId: 'sku_256', name: '256GB 原色', aliases: ['256G 原色'], enabled: true, attributes: { storage: '256GB', color: '原色', network: '全网通' } },
            { skuId: 'sku_128', name: '128GB 黑色', aliases: [], enabled: true, attributes: { storage: '128GB', color: '黑色', network: '全网通' } },
            { skuId: 'sku_disabled', name: '512GB 蓝色', enabled: false, attributes: { storage: '512GB', color: '蓝色' } },
          ],
        },
        { productId: 'prd_15pro', name: 'iPhone 15 Pro', aliases: [], specs: [{ skuId: 'sku_pro', name: '256GB 原色', enabled: true, attributes: { storage: '256GB', color: '原色' } }] },
      ],
    },
    { brandId: 'br_huawei', brand: '华为', aliases: ['Huawei'], products: [{ productId: 'prd_mate', name: 'Mate 60 Pro', aliases: [], specs: [{ skuId: 'sku_huawei', name: '256GB 黑色', enabled: true, attributes: { storage: '256GB', color: '黑色' } }] }] },
  ];
}

function ruleV2Catalog() {
  return [
    {
      brandId: 'br_oppo', brand: 'OPPO', aliases: [], products: [
        { productId: 'prd_oppo_a72', name: 'OPPOA72', aliases: [], specs: [{ skuId: 'sku_oppo_a72', name: '默认', enabled: true }] },
        { productId: 'prd_oppo_y33s', name: 'OPPOY33S', aliases: [], specs: [{ skuId: 'sku_oppo_y33s', name: '默认', enabled: true }] },
        {
          productId: 'prd_oppo_reno8', name: 'OPPOReno8', aliases: [], specs: [
            { skuId: 'sku_reno8_128', name: '128GB 4G 黑色', enabled: true, attributes: { storage: '128GB', network: '4G', color: '黑色' } },
            { skuId: 'sku_reno8_256', name: '256GB 5G 蓝色', enabled: true, attributes: { storage: '256GB', network: '5G', color: '蓝色' } },
          ],
        },
      ],
    },
    {
      brandId: 'br_vivo', brand: 'vivo', aliases: [], products: [
        { productId: 'prd_vivo_y33s', name: 'vivoY33S', aliases: [], specs: [{ skuId: 'sku_vivo_y33s', name: '默认', enabled: true }] },
      ],
    },
  ];
}

test('normalizeTitle handles full width, marketing words, brand aliases and units', () => {
  assert.equal(
    normalizeTitle('【全新正品】苹果１５PM 256 G 原色 顺丰包邮'),
    'apple 15 pro max 256gb 原色'
  );
  assert.equal(normalizeMerchant(' 云 途 租机坊 '), '云途租机坊');
  assert.equal(normalizeMerchant(''), '-');
  assert.equal(normalizeTitle('汇租机iPhone7PLUS'), '汇租机 apple 7p');
});

test('iPhone titles infer Apple and never recall OnePlus by numeric text similarity', () => {
  const brands = [
    {
      brandId: 'br_apple', brand: 'Apple', aliases: ['苹果'], products: [
        {
          productId: 'prd_7plus', name: 'iPhone 7 Plus', aliases: [],
          specs: [{ skuId: 'sku_iphone7plus', name: '默认', enabled: true }],
        },
        {
          productId: 'prd_7', name: 'iPhone 7', aliases: [],
          specs: [{ skuId: 'sku_iphone7', name: '默认', enabled: true }],
        },
      ],
    },
    {
      brandId: 'br_oneplus', brand: '一加', aliases: ['OnePlus'], products: [{
        productId: 'prd_oneplus8', name: '一加8', aliases: [],
        specs: [{ skuId: 'sku_oneplus8', name: '默认', enabled: true }],
      }],
    },
  ];
  const result = buildRuleMatch({ goodsTitle: '汇租机iPhone7PLUS', goodsQuantity: 1, brands });
  assert.equal(result.matchType, 'rule');
  assert.equal(result.candidates[0].items[0].skuId, 'sku_iphone7plus');
  assert.equal(result.candidates.some(candidate => candidate.items[0].skuId === 'sku_oneplus8'), false);
  assert.equal(result.candidates.some(candidate => candidate.items[0].skuId === 'sku_iphone7'), false);
});

test('low-confidence text-only recalls are suppressed', () => {
  const result = buildRuleMatch({ goodsTitle: '完全不相关的商品标题', goodsQuantity: 1, brands: catalog() });
  assert.equal(result.matchType, 'none');
  assert.deepEqual(result.candidates, []);
  assert.equal(result.promotable, false);
  assert.match(result.titleFingerprint, /^title:/);
});

test('rule-v2 extracts exact model tokens and matches a noisy A72 title globally', () => {
  assert.deepEqual(extractModelTokens('（云途） A72'), ['a72']);
  assert.deepEqual(extractModelTokens('Mate 60 Pro'), ['mate60pro']);
  const noisy = buildRuleMatch({ goodsTitle: '（云途） A72', goodsQuantity: 1, brands: ruleV2Catalog() });
  const clean = buildRuleMatch({ goodsTitle: 'A72', goodsQuantity: 1, brands: ruleV2Catalog() });
  assert.equal(noisy.matchType, 'rule');
  assert.equal(noisy.candidates[0].items[0].skuId, 'sku_oppo_a72');
  assert.ok(noisy.candidates[0].confidence >= 0.9);
  assert.deepEqual(noisy.candidates[0].conflicts, []);
  assert.equal(noisy.titleFingerprint, 'model:a72');
  assert.equal(clean.titleFingerprint, noisy.titleFingerprint);
  assert.equal(clean.candidates[0].items[0].skuId, noisy.candidates[0].items[0].skuId);
});

test('rule-v2 canonicalizes compact iPhone SE generation titles', () => {
  const expected = '云途 apple se2 二手机 可刷机 抹机 nfc im';
  assert.equal(normalizeTitle('[云途]iPhoneSE2 二手机 可刷机 抹机 NFC IM'), expected);
  assert.equal(normalizeTitle('[云途]iPhone SE 2 二手机 可刷机 抹机 NFC IM'), expected);
  assert.deepEqual(extractModelTokens('iPhoneSE2'), ['se2']);
  assert.deepEqual(extractModelTokens('苹果SE2'), ['se2']);
});

test('rule-v2 recognizes compact iPhone X family titles without numeric model tokens', () => {
  assert.equal(normalizeTitle('租机乐iPhoneX 苹果项目 可抹机'), '租机乐 apple x apple 项目 可抹机');
  assert.equal(normalizeTitle('iPhoneXSMax'), 'apple xs max');
  assert.equal(normalizeTitle('iPhoneXR'), 'apple xr');
  assert.deepEqual(extractModelTokens('iPhoneX'), ['x']);
  assert.deepEqual(extractModelTokens('苹果XS MAX'), ['xsmax']);

  const brands = [{
    brandId: 'br_apple', brand: '苹果', aliases: ['Apple'], products: [{
      productId: 'prd_iphone_x', name: '苹果X', aliases: [], specs: [
        { skuId: 'sku_iphone_x_64', name: '64G', enabled: true, attributes: { storage: '64GB' } },
        { skuId: 'sku_iphone_x_128', name: '128G', enabled: true, attributes: { storage: '128GB' } },
      ],
    }],
  }];
  const result = buildRuleMatch({
    goodsTitle: '租机乐iPhoneX 苹果项目 可抹机 抖音 小红书 视频号 TK',
    goodsQuantity: 1,
    brands,
  });
  assert.equal(result.matchType, 'rule');
  assert.ok(result.candidates.length > 0);
  assert.ok(result.candidates.every(candidate => candidate.matchedAttributes.includes('型号')));
  assert.equal(result.titleFingerprint, 'brand:apple|model:x');
});

test('rule-v2 keeps an unbranded duplicate model below auto-fill threshold', () => {
  const result = buildRuleMatch({ goodsTitle: 'Y33S', goodsQuantity: 1, brands: ruleV2Catalog() });
  assert.equal(result.matchType, 'rule');
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.every(candidate => candidate.confidence < 0.9));
  assert.equal(result.promotable, false);
  assert.match(result.ambiguityReason, /多个品牌/);
});

test('rule-v2 uses an explicit brand and specification attributes to disambiguate', () => {
  const branded = buildRuleMatch({ goodsTitle: 'vivo Y33S', goodsQuantity: 1, brands: ruleV2Catalog() });
  assert.equal(branded.candidates[0].items[0].skuId, 'sku_vivo_y33s');
  assert.ok(branded.candidates[0].confidence >= 0.9);
  assert.equal(branded.promotable, true);

  const specified = buildRuleMatch({ goodsTitle: 'OPPO Reno8 256G 5G 蓝色', goodsQuantity: 1, brands: ruleV2Catalog() });
  assert.equal(specified.candidates.length, 1);
  assert.equal(specified.candidates[0].items[0].skuId, 'sku_reno8_256');
  assert.ok(specified.candidates[0].confidence >= 0.9);
  assert.equal(specified.candidates[0].conflicts.length, 0);
});

test('rule-v2 distinguishes 5G network generation from GB storage capacity', () => {
  assert.equal(normalizeTitle('全网通5G 4G 4GB 256G'), '全网通5g 4g 4gb 256gb');

  const analysis = analyzeTitle('OPPO Reno8 5G 蓝色', ruleV2Catalog());
  assert.deepEqual(analysis.source.storages, []);
  assert.deepEqual(analysis.source.networks, ['5g']);
  assert.match(analysis.titleFingerprint, /network:5g/);
  assert.doesNotMatch(analysis.titleFingerprint, /storage:5gb/);
});

test('buildRuleMatch recommends the matching SKU and penalizes capacity conflicts', () => {
  const result = buildRuleMatch({ goodsTitle: '苹果15PM 256G 原色 全网通', goodsQuantity: 2, brands: catalog() });
  assert.equal(result.matchType, 'rule');
  assert.equal(result.candidates[0].items[0].skuId, 'sku_256');
  assert.equal(result.candidates[0].items[0].quantity, 2);
  assert.ok(result.candidates[0].confidence >= 0.9);
  const wrongCapacity = result.candidates.find(candidate => candidate.items[0].skuId === 'sku_128');
  assert.ok(!wrongCapacity || wrongCapacity.conflicts.some(conflict => conflict.startsWith('容量不一致')));
});

test('buildRuleMatch excludes a different explicit brand and disabled SKUs', () => {
  const result = buildRuleMatch({ goodsTitle: '华为 Mate 60 Pro 256G 黑色', goodsQuantity: 1, brands: catalog() });
  assert.equal(result.candidates[0].items[0].skuId, 'sku_huawei');
  assert.equal(result.candidates.some(candidate => candidate.items[0].skuId.startsWith('sku_2')), false);

  const apple = buildRuleMatch({ goodsTitle: '苹果15PM 512G 蓝色', goodsQuantity: 1, brands: catalog() });
  assert.equal(apple.candidates.some(candidate => candidate.items[0].skuId === 'sku_disabled'), false);
});

test('multi-product titles are routed to manual selection', () => {
  assert.equal(isMultiProductTitle('苹果15PM + AirPods 套装'), true);
  const result = buildRuleMatch({ goodsTitle: '苹果15PM 256G 套餐', goodsQuantity: 1, brands: catalog() });
  assert.equal(result.matchType, 'none');
  assert.deepEqual(result.candidates, []);
  assert.match(result.message, /人工选择/);
});

test('memory and storage configurations are not treated as multi-product titles', () => {
  const title = '红米note9 5G版 6+128G 小红书 抖音 应用多开手机 工作室手机';
  assert.equal(isMultiProductTitle(title), false);
  assert.equal(isMultiProductTitle('Redmi Note 9 8GB+256GB'), false);
  assert.equal(isMultiProductTitle('iPhone 15 + AirPods'), true);

  const brands = [{
    brandId: 'br_redmi', brand: '红米', aliases: ['Redmi'], products: [{
      productId: 'prd_note9', name: '红米Note9', aliases: [], specs: [{
        skuId: 'sku_note9_128',
        name: '128G',
        enabled: true,
        attributes: { storage: '128GB', network: '5G' },
      }],
    }],
  }];
  const result = buildRuleMatch({ goodsTitle: title, goodsQuantity: 40, brands });
  assert.equal(result.matchType, 'rule');
  assert.equal(result.candidates[0].items[0].skuId, 'sku_note9_128');
  assert.equal(result.candidates[0].items[0].quantity, 40);
});

test('history candidate requires one active SKU and always uses the current order quantity', () => {
  const active = new Set(['sku_256']);
  const valid = buildHistoryCandidate({ status: 'verified', target_items: [{ skuId: 'sku_256', quantity: 1 }] }, active, 50);
  assert.equal(valid.items[0].skuId, 'sku_256');
  assert.equal(valid.items[0].quantity, 50);
  assert.equal(valid.confidence, 1);
  assert.equal(buildHistoryCandidate({ status: 'verified', target_items: [{ skuId: 'missing', quantity: 1 }] }, active, 1), null);
  assert.equal(buildHistoryCandidate({ status: 'candidate', target_items: [{ skuId: 'sku_256', quantity: 1 }] }, active, 1), null);
  assert.equal(buildHistoryCandidate({ status: 'verified', target_items: [{ skuId: 'sku_256', quantity: 2 }] }, active, 1).items[0].quantity, 1);
});

test('source mapping ID is deterministic across retries and separates merchants', () => {
  const first = createSourceMappingId('zanchenzu', '云途', 'apple 15 pro max');
  assert.equal(first, createSourceMappingId('zanchenzu', '云途', 'apple 15 pro max'));
  assert.notEqual(first, createSourceMappingId('zanchenzu', '汇租机', 'apple 15 pro max'));
  assert.match(first, /^sku_map_[0-9a-f]{64}$/);
});

test('rule-v2 source mapping ID depends only on source and title fingerprint', () => {
  const first = createSourceMappingIdV2('zanchenzu', 'model:a72');
  assert.equal(first, createSourceMappingIdV2('zanchenzu', 'model:a72'));
  assert.notEqual(first, createSourceMappingIdV2('zanchenzu', 'brand:oppo|model:a72'));
  assert.match(first, /^sku_map_[0-9a-f]{64}$/);
});

test('legacy double-read only accepts verified mappings with one consistent active SKU', () => {
  const active = new Set(['sku_oppo_a72', 'sku_other']);
  const consistent = selectConsistentLegacyMapping([
    { status: 'verified', target_items: [{ skuId: 'sku_oppo_a72', quantity: 1 }], normalized_merchant: '云途' },
    { status: 'verified', target_items: [{ skuId: 'sku_oppo_a72', quantity: 1 }], normalized_merchant: '汇租机' },
  ], active, 1);
  assert.equal(consistent.target_items[0].skuId, 'sku_oppo_a72');
  assert.equal(consistent.__legacyV1, true);

  const conflict = selectConsistentLegacyMapping([
    { status: 'verified', target_items: [{ skuId: 'sku_oppo_a72', quantity: 1 }] },
    { status: 'verified', target_items: [{ skuId: 'sku_other', quantity: 1 }] },
  ], active, 1);
  assert.equal(conflict, null);
});
