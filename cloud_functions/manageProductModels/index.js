/**
 * manageProductModels - 产品型号三层字典管理
 *
 * collection: product_models
 * structure: brand -> products -> specs
 */

const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');
const { requireMiniappPermission } = require('./miniappAuth');
const {
  ID_PREFIXES,
  ensureStableId,
  countMissingStableIds,
  findDuplicateStableIds,
  hasDuplicateStableIds,
} = require('./stableIds');
const {
  normalizeAliases,
  normalizeAttributes,
  shouldIncrementCatalogVersion,
} = require('./modelFields');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const COLLECTION = 'product_models';
const COUNTER_COLLECTION = 'system_counters';
const CATALOG_VERSION_COUNTER = 'skuCatalogVersion';
const CONFIG_COLLECTION = 'system_config';
const CONFIG_ID = 'permission_system';
const ROLE_COLLECTION = 'roles';
const USER_ROLE_COLLECTION = 'user_roles';

const READ_PERMISSION = 'models:read';
const WRITE_PERMISSION = 'models:write';
const ORDER_READ_PERMISSION = 'orders:read';
const ORDER_CREATE_PERMISSION = 'orders:create';
const ORDER_UPDATE_PERMISSION = 'orders:update';
// 出入库记录编辑器（RecordEdit）需要读取型号下拉，放行库存权限
const INVENTORY_READ_PERMISSIONS = ['inbound:read', 'inbound:create', 'inbound:update', 'outbound:read', 'outbound:create', 'outbound:update'];

function now() {
  return new Date().toISOString();
}

function getPayload(event) {
  return event && event.data || event || {};
}

function notFound(err) {
  const message = String(err && err.message || '');
  return err && (err.errCode === -1 || err.errCode === -502005 || message.includes('not exist') || message.includes('does not exist'));
}

function hasPermission(actions, permission) {
  const list = actions || [];
  return list.includes('*') || list.includes(permission);
}

function hasAnyPermission(actions, permissions) {
  return permissions.some(permission => hasPermission(actions, permission));
}

function cleanName(value) {
  return String(value || '').trim();
}

function uniqueNames(values) {
  return Array.from(new Set((values || []).map(cleanName).filter(Boolean)));
}

function sortBySortAndName(items, nameKey = 'name') {
  return [...(items || [])].sort((a, b) => {
    const sortDiff = (Number(a.sort) || 0) - (Number(b.sort) || 0);
    if (sortDiff !== 0) return sortDiff;
    return String(a[nameKey] || '').localeCompare(String(b[nameKey] || ''), 'zh-CN');
  });
}

function normalizeSpec(spec, index) {
  const source = spec && typeof spec === 'object' ? spec : { name: spec };
  const { attributes: rawAttributes, ...sourceWithoutAttributes } = source;
  const name = cleanName(source.name);
  if (!name) return null;
  const attributes = normalizeAttributes(rawAttributes);
  return {
    ...sourceWithoutAttributes,
    skuId: ensureStableId(source.skuId, ID_PREFIXES.sku),
    name,
    aliases: normalizeAliases(source.aliases),
    enabled: source.enabled === false ? false : true,
    sort: Number(source.sort) || (index + 1) * 10,
    systemItem: !!source.systemItem,
    ...(attributes ? { attributes } : {}),
  };
}

function normalizeProduct(product, index) {
  const source = product && typeof product === 'object' ? product : { name: product };
  const name = cleanName(source.name);
  if (!name) return null;
  const sourceSpecs = Array.isArray(source.specs) ? source.specs : ['默认'];
  const specs = sourceSpecs.map(normalizeSpec).filter(Boolean);
  return {
    ...source,
    productId: ensureStableId(source.productId, ID_PREFIXES.product),
    name,
    aliases: normalizeAliases(source.aliases),
    enabled: source.enabled === false ? false : true,
    sort: Number(source.sort) || (index + 1) * 10,
    systemItem: !!source.systemItem,
    specs: specs.length > 0 ? specs : [normalizeSpec({ name: '默认', enabled: true, sort: 10, systemItem: false }, 0)],
  };
}

function normalizeBrand(brand, index) {
  const source = brand && typeof brand === 'object' ? brand : { brand };
  const { _id, ...persistedSource } = source;
  const brandName = cleanName(source.brand);
  if (!brandName) return null;
  const sourceProducts = Array.isArray(source.products) && source.products.length > 0
    ? source.products
    : (Array.isArray(source.models) ? source.models : []);
  const products = sourceProducts.map(normalizeProduct).filter(Boolean);
  const timestamp = now();
  return {
    ...persistedSource,
    brandId: ensureStableId(source.brandId, ID_PREFIXES.brand),
    brand: brandName,
    aliases: normalizeAliases(source.aliases),
    enabled: source.enabled === false ? false : true,
    sort: Number(source.sort) || (index + 1) * 10,
    systemBrand: !!source.systemBrand,
    products,
    models: buildLegacyModels(products),
    createdAt: source.createdAt || timestamp,
    updatedAt: timestamp,
  };
}

function normalizeBrands(brands) {
  return (brands || []).map(normalizeBrand).filter(Boolean);
}

function buildLegacyModels(products) {
  return sortBySortAndName(products)
    .filter(product => product.enabled !== false)
    .map(product => product.name);
}

function toClientBrand(doc) {
  const sourceProducts = Array.isArray(doc.products) && doc.products.length > 0
    ? doc.products
    : (Array.isArray(doc.models) ? doc.models : []).map((model, index) => ({
      name: model,
      enabled: true,
      sort: (index + 1) * 10,
      systemItem: false,
      specs: [{ name: '默认', enabled: true, sort: 10, systemItem: false }],
    }));
  const products = sortBySortAndName(sourceProducts).map(product => ({
    ...product,
    aliases: normalizeAliases(product.aliases),
    specs: sortBySortAndName(product.specs || []).map(spec => {
      const attributes = normalizeAttributes(spec.attributes);
      return {
        ...spec,
        aliases: normalizeAliases(spec.aliases),
        ...(attributes ? { attributes } : {}),
      };
    }),
  }));
  return {
    ...doc,
    aliases: normalizeAliases(doc.aliases),
    products,
    models: buildLegacyModels(products),
  };
}

async function ensureCollection() {
  try {
    await db.collection(COLLECTION).limit(1).get();
  } catch (err) {
    if (!notFound(err)) throw err;
    if (typeof db.createCollection !== 'function') {
      throw new Error(`数据库集合不存在且当前 SDK 不支持自动创建: ${COLLECTION}`);
    }
    try {
      await db.createCollection(COLLECTION);
    } catch (createErr) {
      const message = String(createErr && createErr.message || '');
      if (!message.includes('already exists') && !message.includes('exists')) throw createErr;
    }
  }
}

async function getDocById(collectionName, id) {
  try {
    const result = await db.collection(collectionName)
      .where({ _id: id })
      .limit(1)
      .get();
    return result.data && result.data[0] || null;
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

async function fetchAll(collectionName, where = {}) {
  try {
    const collection = Object.keys(where).length > 0
      ? db.collection(collectionName).where(where)
      : db.collection(collectionName);
    const result = [];
    const pageSize = 100;
    let skip = 0;

    while (true) {
      const page = await collection.skip(skip).limit(pageSize).get();
      const data = page.data || [];
      result.push(...data);
      if (data.length < pageSize) break;
      skip += pageSize;
    }

    return result;
  } catch (err) {
    if (notFound(err)) return [];
    throw err;
  }
}

async function loadCurrentPermission(currentUser) {
  const config = await getDocById(CONFIG_COLLECTION, CONFIG_ID);
  if (!config || !config.initialized) {
    return { allowed: false, code: 'PERMISSION_UNINITIALIZED', errMsg: '权限系统未初始化' };
  }

  const userRoles = await fetchAll(USER_ROLE_COLLECTION, { userId: currentUser.id });
  const userRole = userRoles[0];
  if (!userRole) {
    return { allowed: false, code: 'ROLE_UNASSIGNED', errMsg: '当前用户未分配角色' };
  }

  const role = await getDocById(ROLE_COLLECTION, userRole.roleId);
  if (!role) {
    return { allowed: false, code: 'ROLE_NOT_FOUND', errMsg: '用户关联的角色不存在' };
  }

  return { allowed: true, role };
}

async function requirePermission(permissions) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return { allowed: false, code: 'LOGIN_REQUIRED', errMsg: '请先登录' };
  }

  const permissionResult = await loadCurrentPermission(currentUser);
  if (!permissionResult.allowed) return permissionResult;

  const actions = permissionResult.role.actionPermissions || [];
  if (!hasAnyPermission(actions, permissions)) {
    return { allowed: false, code: 'PERMISSION_DENIED', errMsg: '无权操作型号管理' };
  }

  return { allowed: true, currentUser, role: permissionResult.role };
}

async function fetchBrands() {
  await ensureCollection();
  const list = await fetchAll(COLLECTION);
  return sortBySortAndName(list.map(toClientBrand), 'brand');
}

async function getCatalogVersion() {
  try {
    const result = await db.collection(COUNTER_COLLECTION).doc(CATALOG_VERSION_COUNTER).get();
    return Math.max(0, Number(result.data && result.data.value) || 0);
  } catch (err) {
    if (notFound(err)) return 0;
    throw err;
  }
}

async function incrementCatalogVersion() {
  const collection = db.collection(COUNTER_COLLECTION);
  try {
    await collection.doc(CATALOG_VERSION_COUNTER).update({
      data: {
        value: db.command.inc(1),
        updatedAt: db.serverDate(),
      },
    });
  } catch (err) {
    if (!notFound(err)) throw err;
    try {
      await collection.add({
        data: {
          _id: CATALOG_VERSION_COUNTER,
          value: 1,
          updatedAt: db.serverDate(),
        },
      });
    } catch (createErr) {
      const message = String(createErr && createErr.message || '').toLowerCase();
      const duplicate = createErr && createErr.errCode === -502001
        || message.includes('duplicate')
        || message.includes('already exists');
      if (!duplicate) throw createErr;
      await collection.doc(CATALOG_VERSION_COUNTER).update({
        data: {
          value: db.command.inc(1),
          updatedAt: db.serverDate(),
        },
      });
    }
  }
  return getCatalogVersion();
}

async function getBrandDoc(brand) {
  const brandName = cleanName(brand);
  if (!brandName) return null;
  try {
    const result = await db.collection(COLLECTION)
      .where({ brand: brandName })
      .limit(1)
      .get();
    const doc = result.data && result.data[0] || null;
    return doc ? toClientBrand(doc) : null;
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

async function saveBrandDoc(doc) {
  const { _id } = doc;
  if (!_id) throw new Error('缺少品牌文档 _id');
  const normalized = normalizeBrand(doc, 0);
  if (!normalized) throw new Error('品牌数据无效');
  const products = normalized.products || [];
  const data = {
    ...normalized,
    models: buildLegacyModels(products),
    updatedAt: now(),
  };
  await db.collection(COLLECTION).doc(_id).update({ data });
  return { _id, ...data };
}

async function addBrandDoc(doc) {
  const normalized = normalizeBrand(doc, 0);
  if (!normalized) throw new Error('品牌数据无效');
  const products = normalized.products || [];
  const result = await db.collection(COLLECTION).add({
    data: {
      ...normalized,
      models: buildLegacyModels(products),
    },
  });
  return { _id: result._id, ...normalized };
}

async function backfillSkuIds(payload) {
  await ensureCollection();
  const dryRun = payload.dryRun !== false;
  const docs = await fetchAll(COLLECTION);
  const before = countMissingStableIds(docs);
  const duplicatesBefore = findDuplicateStableIds(docs);

  if (hasDuplicateStableIds(duplicatesBefore)) {
    return {
      success: false,
      errMsg: '检测到重复稳定 ID，请先修复后再执行回填',
      data: { dryRun, documentCount: docs.length, missing: before, duplicates: duplicatesBefore },
    };
  }

  if (dryRun) {
    return {
      success: true,
      data: { dryRun: true, documentCount: docs.length, missing: before, duplicates: duplicatesBefore },
    };
  }

  let updatedDocuments = 0;
  for (const doc of docs) {
    const missing = countMissingStableIds([doc]);
    if (missing.brands || missing.products || missing.specs) {
      await saveBrandDoc(doc);
      updatedDocuments += 1;
    }
  }

  const afterDocs = await fetchAll(COLLECTION);
  const after = countMissingStableIds(afterDocs);
  const duplicatesAfter = findDuplicateStableIds(afterDocs);
  if (after.brands || after.products || after.specs || hasDuplicateStableIds(duplicatesAfter)) {
    throw new Error('稳定 ID 回填后校验失败');
  }

  return {
    success: true,
    data: {
      dryRun: false,
      documentCount: afterDocs.length,
      updatedDocuments,
      before,
      after,
      duplicates: duplicatesAfter,
    },
  };
}

function mergeProducts(existingProducts, seedProducts) {
  const products = [...(existingProducts || [])];
  let changed = false;

  seedProducts.forEach(seedProduct => {
    const product = products.find(item => item.name === seedProduct.name);
    if (!product) {
      products.push(seedProduct);
      changed = true;
      return;
    }

    const specs = [...(product.specs || [])];
    seedProduct.specs.forEach(seedSpec => {
      if (!specs.some(item => item.name === seedSpec.name)) {
        specs.push(seedSpec);
        changed = true;
      }
    });
    product.specs = specs;
  });

  return { products, changed };
}

async function initializeDefault(seed) {
  const normalizedSeed = normalizeBrands(seed);
  if (normalizedSeed.length === 0) {
    return { success: false, errMsg: '种子数据为空' };
  }

  await ensureCollection();
  const existing = await fetchAll(COLLECTION);
  const existingMap = new Map(existing.map(doc => [doc.brand, doc]));
  let inserted = 0;
  let merged = 0;

  for (const seedBrand of normalizedSeed) {
    const current = existingMap.get(seedBrand.brand);
    if (!current) {
      await addBrandDoc(seedBrand);
      inserted += 1;
      continue;
    }

    const { products, changed } = mergeProducts(current.products || [], seedBrand.products || []);
    if (changed) {
      await saveBrandDoc({
        ...current,
        products,
        systemBrand: current.systemBrand || seedBrand.systemBrand,
      });
      merged += 1;
    }
  }

  return { success: true, data: { inserted, merged } };
}

async function addBrand(payload) {
  const brand = cleanName(payload.brand);
  if (!brand) return { success: false, errMsg: '品牌名称不能为空' };
  await ensureCollection();
  const existing = await getBrandDoc(brand);
  if (existing) return { success: false, errMsg: '品牌已存在' };

  const total = (await fetchAll(COLLECTION)).length;
  await addBrandDoc({
    brand,
    aliases: normalizeAliases(payload.aliases),
    enabled: true,
    sort: (total + 1) * 10,
    systemBrand: false,
    products: [],
    createdAt: now(),
    updatedAt: now(),
  });
  return { success: true };
}

async function updateBrand(payload) {
  const brand = cleanName(payload.brand);
  const nextBrand = cleanName(payload.nextBrand);
  if (!brand || !nextBrand) return { success: false, errMsg: '品牌名称不能为空' };

  const doc = await getBrandDoc(brand);
  if (!doc) return { success: false, errMsg: '品牌不存在' };

  const aliases = Object.prototype.hasOwnProperty.call(payload, 'aliases')
    ? normalizeAliases(payload.aliases)
    : doc.aliases;

  if (brand !== nextBrand) {
    const duplicated = await getBrandDoc(nextBrand);
    if (duplicated) return { success: false, errMsg: '品牌已存在' };
    await saveBrandDoc({
      ...doc,
      brand: nextBrand,
      aliases,
      enabled: payload.enabled === false ? false : true,
    });
    return { success: true };
  }

  await saveBrandDoc({
    ...doc,
    aliases,
    enabled: payload.enabled === false ? false : true,
  });
  return { success: true };
}

async function deleteBrand(payload) {
  const brand = cleanName(payload.brand);
  const doc = await getBrandDoc(brand);
  if (!doc) return { success: false, errMsg: '品牌不存在' };

  if (doc.systemBrand) {
    await saveBrandDoc({ ...doc, enabled: false });
  } else {
    await db.collection(COLLECTION).doc(doc._id).remove();
  }
  return { success: true };
}

async function addProduct(payload) {
  const brand = cleanName(payload.brand);
  const productName = cleanName(payload.productName);
  if (!brand || !productName) return { success: false, errMsg: '品牌和货品名称不能为空' };

  const doc = await getBrandDoc(brand);
  if (!doc) return { success: false, errMsg: '品牌不存在' };
  const products = [...(doc.products || [])];
  if (products.some(product => product.name === productName)) return { success: false, errMsg: '货品已存在' };

  const specs = [];
  for (const [index, input] of (Array.isArray(payload.specs) ? payload.specs : []).entries()) {
    const source = input && typeof input === 'object' ? input : { name: input };
    const name = cleanName(source.name);
    if (!name || specs.some(spec => spec.name === name)) continue;
    specs.push({
      ...source,
      name,
      aliases: normalizeAliases(source.aliases),
      enabled: source.enabled === false ? false : true,
      sort: Number(source.sort) || (index + 1) * 10,
      systemItem: !!source.systemItem,
    });
  }
  products.push({
    name: productName,
    aliases: normalizeAliases(payload.aliases),
    enabled: true,
    sort: (products.length + 1) * 10,
    systemItem: false,
    specs: specs.length > 0 ? specs : [{ name: '默认', enabled: true, sort: 10, systemItem: false }],
  });
  await saveBrandDoc({ ...doc, products });
  return { success: true };
}

async function addModels(payload) {
  const models = uniqueNames(payload.models);
  let addedCount = 0;
  for (const model of models) {
    const result = await addProduct({ brand: payload.brand, productName: model, specs: ['默认'] });
    if (result.success) addedCount += 1;
  }
  return { success: true, addedCount };
}

async function updateProduct(payload) {
  const brand = cleanName(payload.brand);
  const productName = cleanName(payload.productName);
  const nextProductName = cleanName(payload.nextProductName);
  if (!brand || !productName || !nextProductName) return { success: false, errMsg: '货品名称不能为空' };

  const doc = await getBrandDoc(brand);
  if (!doc) return { success: false, errMsg: '品牌不存在' };

  const products = [...(doc.products || [])];
  const product = products.find(item => item.name === productName);
  if (!product) return { success: false, errMsg: '货品不存在' };
  if (productName !== nextProductName && products.some(item => item.name === nextProductName)) {
    return { success: false, errMsg: '货品已存在' };
  }

  product.name = nextProductName;
  product.enabled = payload.enabled === false ? false : true;
  if (Object.prototype.hasOwnProperty.call(payload, 'aliases')) {
    product.aliases = normalizeAliases(payload.aliases);
  }
  await saveBrandDoc({ ...doc, products });
  return { success: true };
}

async function deleteProduct(payload) {
  const brand = cleanName(payload.brand);
  const productName = cleanName(payload.productName);
  const doc = await getBrandDoc(brand);
  if (!doc) return { success: false, errMsg: '品牌不存在' };

  const products = [...(doc.products || [])];
  const product = products.find(item => item.name === productName);
  if (!product) return { success: false, errMsg: '货品不存在' };

  const nextProducts = product.systemItem
    ? products.map(item => item.name === productName ? { ...item, enabled: false } : item)
    : products.filter(item => item.name !== productName);
  await saveBrandDoc({ ...doc, products: nextProducts });
  return { success: true };
}

async function addSpec(payload) {
  const brand = cleanName(payload.brand);
  const productName = cleanName(payload.productName);
  const specName = cleanName(payload.specName);
  if (!brand || !productName || !specName) return { success: false, errMsg: '规格名称不能为空' };

  const doc = await getBrandDoc(brand);
  if (!doc) return { success: false, errMsg: '品牌不存在' };

  const products = [...(doc.products || [])];
  const product = products.find(item => item.name === productName);
  if (!product) return { success: false, errMsg: '货品不存在' };

  const specs = [...(product.specs || [])];
  if (specs.some(spec => spec.name === specName)) return { success: false, errMsg: '规格已存在' };
  const attributes = normalizeAttributes(payload.attributes);
  specs.push({
    name: specName,
    aliases: normalizeAliases(payload.aliases),
    enabled: true,
    sort: (specs.length + 1) * 10,
    systemItem: false,
    ...(attributes ? { attributes } : {}),
  });
  product.specs = specs;
  await saveBrandDoc({ ...doc, products });
  return { success: true };
}

async function updateSpec(payload) {
  const brand = cleanName(payload.brand);
  const productName = cleanName(payload.productName);
  const specName = cleanName(payload.specName);
  const nextSpecName = cleanName(payload.nextSpecName);
  if (!brand || !productName || !specName || !nextSpecName) return { success: false, errMsg: '规格名称不能为空' };

  const doc = await getBrandDoc(brand);
  if (!doc) return { success: false, errMsg: '品牌不存在' };

  const products = [...(doc.products || [])];
  const product = products.find(item => item.name === productName);
  if (!product) return { success: false, errMsg: '货品不存在' };

  const specs = [...(product.specs || [])];
  const spec = specs.find(item => item.name === specName);
  if (!spec) return { success: false, errMsg: '规格不存在' };
  if (specName !== nextSpecName && specs.some(item => item.name === nextSpecName)) {
    return { success: false, errMsg: '规格已存在' };
  }

  spec.name = nextSpecName;
  spec.enabled = payload.enabled === false ? false : true;
  if (Object.prototype.hasOwnProperty.call(payload, 'aliases')) {
    spec.aliases = normalizeAliases(payload.aliases);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'attributes')) {
    const attributes = normalizeAttributes(payload.attributes);
    if (attributes) spec.attributes = attributes;
    else delete spec.attributes;
  }
  product.specs = specs;
  await saveBrandDoc({ ...doc, products });
  return { success: true };
}

async function deleteSpec(payload) {
  const brand = cleanName(payload.brand);
  const productName = cleanName(payload.productName);
  const specName = cleanName(payload.specName);
  const doc = await getBrandDoc(brand);
  if (!doc) return { success: false, errMsg: '品牌不存在' };

  const products = [...(doc.products || [])];
  const product = products.find(item => item.name === productName);
  if (!product) return { success: false, errMsg: '货品不存在' };

  const specs = [...(product.specs || [])];
  const spec = specs.find(item => item.name === specName);
  if (!spec) return { success: false, errMsg: '规格不存在' };

  product.specs = spec.systemItem
    ? specs.map(item => item.name === specName ? { ...item, enabled: false } : item)
    : specs.filter(item => item.name !== specName);
  await saveBrandDoc({ ...doc, products });
  return { success: true };
}

exports.main = async (event) => {
  const payload = getPayload(event);
  const action = payload.action || 'getProductTree';
  const writeActions = new Set([
    'initializeDefault',
    'addBrand',
    'updateBrand',
    'deleteBrand',
    'addModels',
    'addProduct',
    'updateProduct',
    'deleteProduct',
    'addSpec',
    'updateSpec',
    'deleteSpec',
    'backfillSkuIds',
  ]);

  try {
    const isWrite = writeActions.has(action);
    // 双鉴权：小程序调用带 WX 上下文 OPENID，走 miniappAuth（miniapp:access）；
    // hc-admin 网页端无 OPENID，走原 RBAC。
    const wxContext = (typeof cloud.getWXContext === 'function' && cloud.getWXContext()) || {};
    let permission;
    if (wxContext.OPENID) {
      const auth = await requireMiniappPermission(cloud, db, isWrite ? [WRITE_PERMISSION] : []);
      permission = auth.allowed
        ? { allowed: true, role: auth.role }
        : { allowed: false, code: auth.code, errMsg: auth.errMsg };
    } else {
      permission = await requirePermission(
        isWrite
          ? [WRITE_PERMISSION]
          : [READ_PERMISSION, WRITE_PERMISSION, ORDER_READ_PERMISSION, ORDER_CREATE_PERMISSION, ORDER_UPDATE_PERMISSION, ...INVENTORY_READ_PERMISSIONS]
      );
    }
    if (!permission.allowed) return { success: false, code: permission.code, errMsg: permission.errMsg };

    // 统一入口：返回完整品牌树（品牌→货品→规格），hc-admin 与小程序共用
    if (action === 'getProductTree') {
      const [brands, catalogVersion] = await Promise.all([fetchBrands(), getCatalogVersion()]);
      return { success: true, data: brands, catalogVersion };
    }

    if (action === 'getAllModels') {
      const [brands, catalogVersion] = await Promise.all([fetchBrands(), getCatalogVersion()]);
      const models = Array.from(new Set(brands.flatMap(brand => brand.models || [])))
        .sort((a, b) => a.localeCompare(b, 'zh-CN'));
      return { success: true, data: models, catalogVersion };
    }

    if (action === 'getModelsByBrand') {
      const [doc, catalogVersion] = await Promise.all([getBrandDoc(payload.brand), getCatalogVersion()]);
      return { success: true, data: doc ? buildLegacyModels(doc.products || []) : [], catalogVersion };
    }

    if (action === 'getCatalogVersion') {
      return { success: true, data: { catalogVersion: await getCatalogVersion() } };
    }

    let result = null;
    if (action === 'initializeDefault') result = await initializeDefault(payload.seed);
    else if (action === 'addBrand') result = await addBrand(payload);
    else if (action === 'updateBrand') result = await updateBrand(payload);
    else if (action === 'deleteBrand') result = await deleteBrand(payload);
    else if (action === 'addModels') result = await addModels(payload);
    else if (action === 'addProduct') result = await addProduct(payload);
    else if (action === 'updateProduct') result = await updateProduct(payload);
    else if (action === 'deleteProduct') result = await deleteProduct(payload);
    else if (action === 'addSpec') result = await addSpec(payload);
    else if (action === 'updateSpec') result = await updateSpec(payload);
    else if (action === 'deleteSpec') result = await deleteSpec(payload);
    else if (action === 'backfillSkuIds') result = await backfillSkuIds(payload);

    if (result) {
      const catalogVersion = shouldIncrementCatalogVersion(action, payload, result)
        ? await incrementCatalogVersion()
        : await getCatalogVersion();
      return { ...result, catalogVersion };
    }

    return { success: false, errMsg: `未知操作: ${action}` };
  } catch (error) {
    console.error('manageProductModels 执行失败:', error);
    return { success: false, errMsg: error.message || '型号管理操作失败' };
  }
};
