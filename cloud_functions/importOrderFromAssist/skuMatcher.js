const crypto = require('crypto');

const MERCHANT_SENTINEL = '-';
const MIN_CANDIDATE_CONFIDENCE = 0.65;

const BRAND_REPLACEMENTS = [
  [/苹果/g, ' apple '],
  [/华为/g, ' huawei '],
  [/荣耀/g, ' honor '],
  [/小米/g, ' xiaomi '],
  [/红米/g, ' redmi '],
  [/三星/g, ' samsung '],
  [/谷歌/g, ' google '],
  [/一加/g, ' oneplus '],
  [/魅族/g, ' meizu '],
  [/真我/g, ' realme '],
  [/大疆/g, ' dji '],
];

const MARKETING_WORDS = [
  '全新正品', '正品保障', '顺丰包邮', '全国包邮', '包邮', '爆款', '热卖', '特价',
  '旗舰店', '官方', '原装正品', '品质保证', '现货', '极速发货',
];

const KNOWN_COLORS = [
  '黑色', '白色', '红色', '蓝色', '绿色', '黄色', '紫色', '粉色', '金色', '银色',
  '灰色', '橙色', '青色', '原色', '钛金属', '午夜色', '星光色', '远峰蓝', '暗夜紫',
];

const NETWORK_TERMS = ['全网通', '5g', '4g', '国行', '港版', '美版', '日版', '有锁', '无锁', '解bl'];
const MODEL_SUFFIX_TERMS = new Set(['pro', 'max', 'promax', 'plus', 'ultra', 'mini', 'se', 's', 'p']);

function normalizeCapacityAndNetworkUnits(value) {
  return String(value || '')
    .replace(/(\d+)\s*(gb|g)\b/g, (_match, amount, unit) => (
      unit === 'g' && (amount === '4' || amount === '5') ? `${amount}g` : `${amount}gb`
    ))
    .replace(/(\d+)\s*(tb|t)\b/g, '$1tb');
}

function normalizeBase(value) {
  const normalizedUnits = normalizeCapacityAndNetworkUnits(String(value || '')
    .normalize('NFKC')
    .toLowerCase());
  return normalizedUnits
    .replace(/[【】\[\]（）()「」『』<>《》“”"'`~!！?？,，。；;：:|\\/_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTitle(value) {
  let text = normalizeBase(value);
  for (const [pattern, replacement] of BRAND_REPLACEMENTS) text = text.replace(pattern, replacement);
  text = text
    // iPhone X / XS / XR 不带数字，需在通用 iPhone 兜底前先转成可匹配的型号。
    .replace(/\biphone\s*x\s*s\s*max\b/g, ' apple xs max ')
    .replace(/\biphone\s*x\s*r\b/g, ' apple xr ')
    .replace(/\biphone\s*x\s*s\b/g, ' apple xs ')
    .replace(/\biphone\s*x\b/g, ' apple x ')
    .replace(/\biphone\s*(\d{1,2})\s*pro\s*max\b/g, ' apple $1 pro max ')
    .replace(/\biphone\s*(\d{1,2})\s*pro\b/g, ' apple $1 pro ')
    .replace(/\biphone\s*(\d{1,2})\s*plus\b/g, ' apple $1p ')
    .replace(/\biphone\s*(\d{1,2})\b/g, ' apple $1 ')
    .replace(/\biphone\s*se\s*(\d+)\b/g, ' apple se$1 ')
    .replace(/\biphone\s*se\b/g, ' apple se ')
    .replace(/\biphone(?=\s*\d|[a-z])/g, ' apple iphone')
    .replace(/\bipad(?=\s*\d|[a-z])/g, ' apple ipad')
    .replace(/pro\s*max/g, ' pro max ')
    .replace(/(\d{1,3})\s*pm\b/g, '$1 pro max')
    .replace(/\s+/g, ' ');
  text = normalizeCapacityAndNetworkUnits(text);
  for (const word of MARKETING_WORDS) text = text.split(word).join(' ');
  return text.replace(/\s+/g, ' ').trim();
}

// 仅供 rule-v1 存量映射双读和迁移脚本使用；rule-v2 匹配不得依赖商家。
function normalizeMerchant(value) {
  const normalized = normalizeBase(value).replace(/\s+/g, '');
  return normalized || MERCHANT_SENTINEL;
}

function compact(value) {
  return normalizeTitle(value).replace(/\s+/g, '');
}

function bigrams(value) {
  const text = compact(value);
  if (text.length < 2) return text ? [text] : [];
  const result = [];
  for (let index = 0; index < text.length - 1; index += 1) result.push(text.slice(index, index + 2));
  return result;
}

function diceSimilarity(left, right) {
  const a = compact(left);
  const b = compact(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (shorter.length >= 3 && longer.includes(shorter)) return 0.96;
  const aPairs = bigrams(a);
  const bCounts = new Map();
  for (const pair of bigrams(b)) bCounts.set(pair, (bCounts.get(pair) || 0) + 1);
  let overlap = 0;
  for (const pair of aPairs) {
    const count = bCounts.get(pair) || 0;
    if (count > 0) {
      overlap += 1;
      bCounts.set(pair, count - 1);
    }
  }
  return (2 * overlap) / Math.max(1, aPairs.length + bigrams(b).length);
}

function normalizeTerms(values) {
  return Array.from(new Set((values || []).map(normalizeTitle).filter(Boolean)));
}

function extractStorages(text) {
  return Array.from(new Set(
    [...normalizeTitle(text).matchAll(/\b(\d{1,4})(gb|tb)\b/g)].map(match => `${match[1]}${match[2]}`)
  ));
}

function extractKnownTerms(text, terms) {
  const normalized = normalizeTitle(text);
  return terms.filter(term => normalized.includes(normalizeTitle(term)));
}

function extractVariant(text) {
  const normalized = ` ${normalizeTitle(text)} `;
  if (/pro\s*max/.test(normalized)) return 'pro max';
  if (/\bultra\b/.test(normalized)) return 'ultra';
  if (/\bplus\b/.test(normalized)) return 'plus';
  if (/\b\d{1,2}p\b/.test(normalized)) return 'plus';
  if (/\bmini\b/.test(normalized)) return 'mini';
  if (/\bpro\b/.test(normalized)) return 'pro';
  return '';
}

function extractModelNumbers(text) {
  const normalized = normalizeTitle(text)
    .replace(/\b\d{1,4}(?:gb|tb)\b/g, ' ')
    .replace(/\b[45]g\b/g, ' ');
  return Array.from(new Set([...normalized.matchAll(/\d{1,3}/g)].map(match => match[0])));
}

function extractModelTokens(value) {
  const normalized = normalizeTitle(value)
    .replace(/\b\d{1,4}(?:gb|tb)\b/g, ' ')
    .replace(/\b[45]g\b/g, ' ');
  const chunks = normalized.match(/[a-z0-9]+/g) || [];
  const tokens = new Set();

  // X / XS / XR 是老款 iPhone 的完整型号，不能因为没有数字就丢弃。
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk === 'x' || chunk === 'xr') tokens.add(chunk);
    if (chunk === 'xs') tokens.add(chunks[index + 1] === 'max' ? 'xsmax' : 'xs');
    if (chunk === 'xsmax') tokens.add('xsmax');
  }

  for (const chunk of chunks) {
    if (/[a-z]/.test(chunk) && /\d/.test(chunk) && !/^\d{1,4}(?:gb|tb)$/.test(chunk)) {
      tokens.add(chunk);
    }
  }

  for (let index = 0; index < chunks.length - 1; index += 1) {
    const first = chunks[index];
    const second = chunks[index + 1];
    if (/^[a-z]+$/.test(first) && /^\d{1,4}[a-z]*$/.test(second)) {
      let combined = `${first}${second}`;
      for (let suffixIndex = index + 2; suffixIndex < Math.min(chunks.length, index + 4); suffixIndex += 1) {
        if (!MODEL_SUFFIX_TERMS.has(chunks[suffixIndex])) break;
        combined += chunks[suffixIndex];
      }
      tokens.add(combined);
    }
    if (/^\d{1,3}$/.test(first)
      && MODEL_SUFFIX_TERMS.has(second)
      && !(index > 0 && /^[a-z]+$/.test(chunks[index - 1]))) {
      let combined = `${first}${second}`;
      if (MODEL_SUFFIX_TERMS.has(chunks[index + 2])) combined += chunks[index + 2];
      tokens.add(combined);
    }
    if (/[a-z]/.test(first) && /\d/.test(first) && MODEL_SUFFIX_TERMS.has(second)) {
      let combined = `${first}${second}`;
      if (MODEL_SUFFIX_TERMS.has(chunks[index + 2])) combined += chunks[index + 2];
      tokens.add(combined);
    }
  }

  return [...tokens].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function stripBrandPrefix(productName, brandTerms) {
  const productKey = compact(productName);
  const prefixes = (brandTerms || [])
    .map(compact)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const prefix of prefixes) {
    if (productKey.startsWith(prefix)) return productKey.slice(prefix.length);
  }
  return productKey;
}

function removeKnownTerms(value, terms) {
  let normalized = normalizeTitle(value);
  const needles = normalizeTerms(terms).sort((left, right) => right.length - left.length);
  for (const needle of needles) normalized = normalized.split(needle).join(' ');
  return normalized.replace(/\s+/g, ' ').trim();
}

function isMultiProductTitle(title) {
  const normalized = normalizeBase(title);
  // 手机标题常用“6+128G / 8GB+256GB”表示运行内存+存储，这不是多商品。
  const withoutMemoryConfigurations = normalized.replace(
    /\b\d{1,2}\s*(?:gb)?\s*[+＋]\s*\d{2,4}\s*(?:gb|tb)?\b/g,
    ' '
  );
  return /套装|套餐|组合|加送|赠送|[+＋&＆]|(?:两|二|2)\s*(?:台|部|个)/.test(withoutMemoryConfigurations);
}

function flattenCatalog(brands) {
  const result = [];
  for (const brand of brands || []) {
    if (!brand || brand.enabled === false) continue;
    const brandTerms = normalizeTerms([brand.brand, ...(brand.aliases || [])]);
    for (const product of brand.products || []) {
      if (!product || product.enabled === false) continue;
      const productTerms = normalizeTerms([product.name, ...(product.aliases || [])]);
      const modelKeys = Array.from(new Set(
        productTerms.map(term => stripBrandPrefix(term, brandTerms)).filter(Boolean)
      ));
      const modelTokens = Array.from(new Set(modelKeys.flatMap(extractModelTokens)));
      for (const spec of product.specs || []) {
        if (!spec || spec.enabled === false || !spec.skuId) continue;
        const specTerms = normalizeTerms([spec.name, ...(spec.aliases || [])]);
        const attributes = spec.attributes && typeof spec.attributes === 'object' ? { ...spec.attributes } : {};
        const attributeTerms = normalizeTerms(Object.values(attributes));
        result.push({
          brandId: brand.brandId || '',
          brand: brand.brand || '',
          brandTerms,
          productId: product.productId || '',
          productName: product.name || '',
          productTerms,
          modelKey: modelKeys[0] || compact(product.name),
          modelTokens,
          skuId: spec.skuId,
          specification: spec.name || '',
          specTerms,
          attributes,
          searchText: [...brandTerms, ...productTerms, ...specTerms, ...attributeTerms].join(' '),
        });
      }
    }
  }
  return result;
}

function detectBrandIds(normalizedTitle, skus) {
  const titleCompact = compact(normalizedTitle);
  const matches = new Set();
  for (const sku of skus) {
    if (sku.brandTerms.some(term => {
      const needle = compact(term);
      return needle.length >= 2 && titleCompact.includes(needle);
    })) matches.add(String(sku.brandId || sku.brand));
  }
  return matches;
}

function hasIntersection(left, right) {
  const rightSet = new Set(right);
  return left.some(value => rightSet.has(value));
}

function getSkuFeatureValues(sku) {
  const specificationText = [sku.specification, ...Object.values(sku.attributes || {})].filter(Boolean).join(' ');
  return {
    storages: extractStorages(specificationText),
    colors: extractKnownTerms(specificationText, KNOWN_COLORS),
    networks: extractKnownTerms(specificationText, NETWORK_TERMS),
    variant: extractVariant(sku.productName),
  };
}

function hasNetworkConflict(sourceNetworks, candidateNetworks) {
  const groups = [
    ['4g', '5g'],
    ['有锁', '无锁'],
    ['国行', '港版', '美版', '日版'],
  ];
  return groups.some(group => {
    const sourceValue = group.find(item => sourceNetworks.includes(item));
    const candidateValue = group.find(item => candidateNetworks.includes(item));
    return !!sourceValue && !!candidateValue && sourceValue !== candidateValue;
  });
}

function hasHardConflict(source, sku) {
  const candidate = getSkuFeatureValues(sku);
  if (source.storages.length > 0 && candidate.storages.length > 0
    && !hasIntersection(source.storages, candidate.storages)) return true;
  if (source.variant && source.variant !== candidate.variant) return true;
  if (source.colors.length > 0 && candidate.colors.length > 0
    && !hasIntersection(source.colors, candidate.colors)) return true;
  if (hasNetworkConflict(source.networks, candidate.networks)) return true;
  return false;
}

function hasExactModelMatch(source, sku) {
  if (source.modelTokens.some(token => sku.modelTokens.includes(token))) return true;
  return !!sku.modelKey && source.modelTokens.includes(sku.modelKey);
}

function getModelUniqueness(candidates) {
  return {
    productCount: new Set(candidates.map(item => item.productId || `${item.brand}|${item.productName}`)).size,
    skuCount: new Set(candidates.map(item => item.skuId)).size,
  };
}

function createTitleFingerprint(source, explicitBrandKeys) {
  if (source.modelTokens.length === 0) return `title:${source.normalizedTitle}`;
  const parts = [];
  if (explicitBrandKeys.length === 1) parts.push(`brand:${explicitBrandKeys[0]}`);
  if (source.modelTokens.length > 0) parts.push(`model:${source.modelTokens[0]}`);
  if (source.storages.length > 0) parts.push(`storage:${[...source.storages].sort().join(',')}`);
  if (source.variant) parts.push(`variant:${source.variant.replace(/\s+/g, '')}`);
  if (source.colors.length > 0) parts.push(`color:${[...source.colors].sort().map(compact).join(',')}`);
  if (source.networks.length > 0) parts.push(`network:${[...source.networks].sort().map(compact).join(',')}`);
  return parts.length > 0 ? parts.join('|') : `title:${source.normalizedTitle}`;
}

function analyzeTitle(goodsTitle, brands) {
  const normalizedTitle = normalizeTitle(goodsTitle);
  const skus = flattenCatalog(brands);
  const explicitBrandIds = detectBrandIds(normalizedTitle, skus);
  const explicitBrandSkus = skus.filter(sku => explicitBrandIds.has(String(sku.brandId || sku.brand)));
  const explicitBrandTerms = Array.from(new Set(explicitBrandSkus.flatMap(sku => sku.brandTerms)));
  const modelSourceText = explicitBrandTerms.length > 0
    ? removeKnownTerms(normalizedTitle, explicitBrandTerms)
    : normalizedTitle;
  const source = {
    normalizedTitle,
    quantity: 1,
    storages: extractStorages(normalizedTitle),
    colors: extractKnownTerms(normalizedTitle, KNOWN_COLORS),
    networks: extractKnownTerms(normalizedTitle, NETWORK_TERMS),
    variant: extractVariant(normalizedTitle),
    modelNumbers: extractModelNumbers(normalizedTitle),
    modelTokens: extractModelTokens(modelSourceText),
  };
  const brandEligibleSkus = explicitBrandIds.size > 0
    ? skus.filter(sku => explicitBrandIds.has(String(sku.brandId || sku.brand)))
    : skus;
  const globalExactSkus = skus.filter(sku => hasExactModelMatch(source, sku));
  const exactSkus = brandEligibleSkus
    .filter(sku => hasExactModelMatch(source, sku))
    .filter(sku => !hasHardConflict(source, sku));
  const exactUniqueness = getModelUniqueness(exactSkus);
  const globalUniqueness = getModelUniqueness(globalExactSkus);
  const explicitBrandKeys = Array.from(new Set(
    explicitBrandSkus.map(sku => compact(sku.brand)).filter(Boolean)
  )).sort();
  const titleFingerprint = createTitleFingerprint(source, explicitBrandKeys);
  const hasStrongSpecification = source.storages.length > 0
    || source.colors.length > 0
    || source.networks.length > 0
    || !!source.variant;
  const promotable = source.modelTokens.length > 0 && (
    explicitBrandIds.size === 1
    || (globalUniqueness.productCount === 1 && globalUniqueness.skuCount > 0)
    || (hasStrongSpecification && exactUniqueness.skuCount === 1)
  );
  const modelLabel = source.modelTokens[0] || '';
  const ambiguityReason = promotable
    ? ''
    : modelLabel
      ? `型号 ${modelLabel.toUpperCase()} 在当前有效货品库中存在多个品牌、货品或规格`
      : '未从标题中提取到可靠型号';

  return {
    normalizedTitle,
    skus,
    source,
    explicitBrandIds,
    brandEligibleSkus,
    globalExactSkus,
    exactSkus,
    exactUniqueness,
    globalUniqueness,
    titleFingerprint,
    promotable,
    ambiguityReason,
  };
}

function buildTitleFingerprint(goodsTitle, brands) {
  return analyzeTitle(goodsTitle, brands).titleFingerprint;
}

function scoreSku(source, sku, explicitBrandIds, exactModel, uniqueness) {
  const matchedAttributes = [];
  const conflicts = [];
  const candidateBrandKey = String(sku.brandId || sku.brand);
  if (explicitBrandIds.size > 0 && !explicitBrandIds.has(candidateBrandKey)) return null;
  if (explicitBrandIds.size > 0) matchedAttributes.push('品牌');

  const candidate = getSkuFeatureValues(sku);
  if (source.storages.length > 0) {
    if (candidate.storages.length > 0 && hasIntersection(source.storages, candidate.storages)) matchedAttributes.push('容量');
    else if (candidate.storages.length > 0) conflicts.push(`容量不一致（来源 ${source.storages.join('/')}，候选 ${candidate.storages.join('/')}）`);
  }
  if (source.colors.length > 0) {
    if (candidate.colors.length > 0 && hasIntersection(source.colors, candidate.colors)) matchedAttributes.push('颜色');
    else if (candidate.colors.length > 0) conflicts.push('颜色不一致');
  }
  if (source.networks.length > 0) {
    if (candidate.networks.length > 0 && hasIntersection(source.networks, candidate.networks)) matchedAttributes.push('网络版本');
    else if (candidate.networks.length > 0 && hasNetworkConflict(source.networks, candidate.networks)) conflicts.push('网络版本不一致');
  }
  if (source.variant && source.variant !== candidate.variant) {
    conflicts.push(`型号版本不一致（来源 ${source.variant}，候选 ${candidate.variant || '基础版'}）`);
  }

  let confidence;
  if (exactModel) {
    matchedAttributes.unshift('型号');
    if (uniqueness.productCount === 1 && uniqueness.skuCount === 1) confidence = explicitBrandIds.size > 0 ? 0.99 : 0.96;
    else if (uniqueness.productCount === 1) confidence = explicitBrandIds.size > 0 ? 0.88 : 0.85;
    else confidence = explicitBrandIds.size > 0 ? 0.86 : 0.80;
  } else {
    const candidateModelNumbers = extractModelNumbers(sku.productName);
    if (source.modelNumbers.length > 0 && candidateModelNumbers.length > 0
      && !hasIntersection(source.modelNumbers, candidateModelNumbers)) return null;
    const modelScore = Math.max(0, ...sku.productTerms.map(term => diceSimilarity(source.normalizedTitle, term)));
    const textScore = diceSimilarity(source.normalizedTitle, sku.searchText);
    const brandScore = explicitBrandIds.size > 0 ? 1 : 0;
    confidence = (0.20 * brandScore) + (0.65 * modelScore) + (0.15 * textScore);
    if (modelScore >= 0.78) matchedAttributes.unshift('型号');
  }

  if (conflicts.some(item => item.startsWith('容量不一致'))) confidence = Math.min(confidence - 0.25, 0.64);
  if (conflicts.some(item => item.startsWith('型号版本不一致'))) confidence = Math.min(confidence - 0.20, 0.64);
  if (conflicts.includes('颜色不一致')) confidence = Math.min(confidence - 0.10, 0.84);
  if (conflicts.includes('网络版本不一致')) confidence = Math.min(confidence - 0.08, 0.84);
  confidence = Math.max(0, Math.min(1, confidence));

  const modelLabel = source.modelTokens[0] || sku.modelKey || '';
  let reason;
  if (conflicts.length > 0) reason = `存在${conflicts.join('、')}`;
  else if (exactModel && uniqueness.productCount === 1 && uniqueness.skuCount === 1) {
    reason = `型号 ${modelLabel.toUpperCase()} 在当前有效货品库中唯一`;
  } else if (exactModel && uniqueness.productCount === 1) {
    reason = `型号 ${modelLabel.toUpperCase()} 命中一个货品，但存在多个规格`;
  } else if (exactModel) {
    reason = `型号 ${modelLabel.toUpperCase()} 存在多个品牌或货品，需要人工确认`;
  } else reason = matchedAttributes.length > 0 ? `${matchedAttributes.join('、')}与来源标题一致` : '文本相似度召回';

  return {
    items: [{ skuId: sku.skuId, quantity: source.quantity }],
    confidence: Number(confidence.toFixed(4)),
    matchedAttributes: Array.from(new Set(matchedAttributes)),
    conflicts,
    reason,
  };
}

function buildRuleMatch({ goodsTitle, goodsQuantity, brands, analysis }) {
  const context = analysis || analyzeTitle(goodsTitle, brands);
  const quantity = Math.max(1, Number.parseInt(goodsQuantity, 10) || 1);
  if (isMultiProductTitle(goodsTitle)) {
    return {
      normalizedTitle: context.normalizedTitle,
      titleFingerprint: context.titleFingerprint,
      promotable: false,
      ambiguityReason: '套装或多商品标题不进入自动学习映射',
      matchType: 'none',
      candidates: [],
      missingAttributes: [],
      message: '识别到套装或多商品标题，阶段一不自动拆分，请人工选择。',
    };
  }

  const source = { ...context.source, quantity };
  const exactPool = context.exactSkus;
  const pool = exactPool.length > 0 ? exactPool : context.brandEligibleSkus;
  const uniqueness = exactPool.length > 0 ? context.exactUniqueness : getModelUniqueness([]);
  const candidates = pool
    .map(sku => scoreSku(source, sku, context.explicitBrandIds, exactPool.length > 0, uniqueness))
    .filter(Boolean)
    .filter(candidate => candidate.confidence >= MIN_CANDIDATE_CONFIDENCE)
    .sort((left, right) => right.confidence - left.confidence || left.items[0].skuId.localeCompare(right.items[0].skuId))
    .slice(0, 3);

  const missingAttributes = [];
  if (source.modelTokens.length === 0) missingAttributes.push('型号');
  if (context.explicitBrandIds.size === 0) missingAttributes.push('品牌');
  if (source.storages.length === 0) missingAttributes.push('容量');
  if (source.colors.length === 0) missingAttributes.push('颜色');
  if (source.networks.length === 0) missingAttributes.push('网络版本');

  return {
    normalizedTitle: context.normalizedTitle,
    titleFingerprint: context.titleFingerprint,
    promotable: context.promotable,
    ambiguityReason: context.ambiguityReason,
    matchType: candidates.length > 0 ? 'rule' : 'none',
    candidates,
    missingAttributes,
    ...(candidates.length === 0 ? { message: '未找到可靠的 SKU 候选，请人工选择。' } : {}),
  };
}

function buildHistoryCandidate(mapping, activeSkuIds, goodsQuantity) {
  if (!mapping || mapping.status !== 'verified' || mapping.promotable === false) return null;
  const items = Array.isArray(mapping.target_items)
    ? mapping.target_items
    : (Array.isArray(mapping.targetItems) ? mapping.targetItems : []);
  if (items.length !== 1) return null;
  const currentQuantity = Math.max(1, Number.parseInt(goodsQuantity, 10) || 1);
  const normalizedItems = items.map(item => ({
    skuId: String(item && item.skuId || '').trim(),
    quantity: currentQuantity,
  }));
  if (normalizedItems.some(item => !item.skuId || !activeSkuIds.has(item.skuId))) return null;
  return {
    items: normalizedItems,
    confidence: 1,
    matchedAttributes: ['历史确认'],
    conflicts: [],
    reason: mapping.__legacyV1
      ? '命中同来源、同标题且目标一致的旧版已验证历史映射'
      : '命中同来源、同商品特征的已验证历史映射',
  };
}

function selectConsistentLegacyMapping(mappings, activeSkuIds, goodsQuantity) {
  const usable = (mappings || [])
    .map(mapping => ({ mapping, candidate: buildHistoryCandidate(mapping, activeSkuIds, goodsQuantity) }))
    .filter(item => !!item.candidate);
  const skuIds = new Set(usable.map(item => item.candidate.items[0].skuId));
  if (skuIds.size !== 1 || usable.length === 0) return null;
  return { ...usable[0].mapping, __legacyV1: true };
}

function createMatchRequestId() {
  return `match_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
}

// rule-v1 ID 仅用于存量映射读取和迁移，禁止用于新反馈。
function createSourceMappingId(source, normalizedMerchant, normalizedTitle) {
  const key = [source || '', normalizedMerchant || MERCHANT_SENTINEL, normalizedTitle || ''].join('\n');
  return `sku_map_${crypto.createHash('sha256').update(key).digest('hex')}`;
}

function createSourceMappingIdV2(source, titleFingerprint) {
  const key = ['v2', source || '', titleFingerprint || ''].join('\n');
  return `sku_map_${crypto.createHash('sha256').update(key).digest('hex')}`;
}

module.exports = {
  MERCHANT_SENTINEL,
  analyzeTitle,
  buildHistoryCandidate,
  buildRuleMatch,
  buildTitleFingerprint,
  createMatchRequestId,
  createSourceMappingId,
  createSourceMappingIdV2,
  diceSimilarity,
  extractModelTokens,
  flattenCatalog,
  getModelUniqueness,
  hasExactModelMatch,
  isMultiProductTitle,
  normalizeMerchant,
  normalizeTitle,
  selectConsistentLegacyMapping,
  stripBrandPrefix,
};
