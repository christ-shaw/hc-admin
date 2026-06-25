/**
 * manageProductModels - 产品型号三层字典管理
 *
 * collection: product_models
 * structure: brand -> products -> specs
 */

const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const COLLECTION = 'product_models';
const CONFIG_COLLECTION = 'system_config';
const CONFIG_ID = 'permission_system';
const ROLE_COLLECTION = 'roles';
const USER_ROLE_COLLECTION = 'user_roles';

const READ_PERMISSION = 'models:read';
const WRITE_PERMISSION = 'models:write';
const ORDER_READ_PERMISSION = 'orders:read';
const ORDER_CREATE_PERMISSION = 'orders:create';
const ORDER_UPDATE_PERMISSION = 'orders:update';

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
  const name = cleanName(typeof spec === 'string' ? spec : spec && spec.name);
  if (!name) return null;
  return {
    name,
    enabled: spec && typeof spec === 'object' && spec.enabled === false ? false : true,
    sort: Number(spec && spec.sort) || (index + 1) * 10,
    systemItem: spec && typeof spec === 'object' ? !!spec.systemItem : false,
  };
}

function normalizeProduct(product, index) {
  const name = cleanName(typeof product === 'string' ? product : product && product.name);
  if (!name) return null;
  const sourceSpecs = Array.isArray(product && product.specs) ? product.specs : ['默认'];
  const specs = sourceSpecs.map(normalizeSpec).filter(Boolean);
  return {
    name,
    enabled: product && typeof product === 'object' && product.enabled === false ? false : true,
    sort: Number(product && product.sort) || (index + 1) * 10,
    systemItem: product && typeof product === 'object' ? !!product.systemItem : false,
    specs: specs.length > 0 ? specs : [{ name: '默认', enabled: true, sort: 10, systemItem: false }],
  };
}

function normalizeBrand(brand, index) {
  const brandName = cleanName(brand && brand.brand);
  if (!brandName) return null;
  const sourceProducts = Array.isArray(brand.products)
    ? brand.products
    : (Array.isArray(brand.models) ? brand.models : []);
  const products = sourceProducts.map(normalizeProduct).filter(Boolean);
  const timestamp = now();
  return {
    brand: brandName,
    enabled: brand.enabled === false ? false : true,
    sort: Number(brand.sort) || (index + 1) * 10,
    systemBrand: !!brand.systemBrand,
    products,
    models: buildLegacyModels(products),
    createdAt: brand.createdAt || timestamp,
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
    specs: sortBySortAndName(product.specs || []),
  }));
  return {
    ...doc,
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
  const { _id, ...rest } = doc;
  const products = rest.products || [];
  const data = {
    ...rest,
    models: buildLegacyModels(products),
    updatedAt: now(),
  };
  await db.collection(COLLECTION).doc(_id).update({ data });
  return { _id, ...data };
}

async function addBrandDoc(doc) {
  const { _id, ...rest } = doc;
  const products = rest.products || [];
  await db.collection(COLLECTION).add({
    data: {
      ...rest,
      models: buildLegacyModels(products),
    },
  });
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

  if (brand !== nextBrand) {
    const duplicated = await getBrandDoc(nextBrand);
    if (duplicated) return { success: false, errMsg: '品牌已存在' };
    await saveBrandDoc({
      ...doc,
      brand: nextBrand,
      enabled: payload.enabled === false ? false : true,
    });
    return { success: true };
  }

  await saveBrandDoc({
    ...doc,
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

  const specs = uniqueNames(payload.specs).map((name, index) => ({ name, enabled: true, sort: (index + 1) * 10, systemItem: false }));
  products.push({
    name: productName,
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
  specs.push({ name: specName, enabled: true, sort: (specs.length + 1) * 10, systemItem: false });
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
  const action = payload.action || 'getBrands';
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
  ]);

  try {
    const permission = await requirePermission(
      writeActions.has(action)
        ? [WRITE_PERMISSION]
        : [READ_PERMISSION, WRITE_PERMISSION, ORDER_READ_PERMISSION, ORDER_CREATE_PERMISSION, ORDER_UPDATE_PERMISSION]
    );
    if (!permission.allowed) return { success: false, code: permission.code, errMsg: permission.errMsg };

    if (action === 'getBrands' || action === 'list') {
      return { success: true, data: await fetchBrands() };
    }

    if (action === 'getAllModels') {
      const brands = await fetchBrands();
      const models = Array.from(new Set(brands.flatMap(brand => brand.models || [])))
        .sort((a, b) => a.localeCompare(b, 'zh-CN'));
      return { success: true, data: models };
    }

    if (action === 'getModelsByBrand') {
      const doc = await getBrandDoc(payload.brand);
      return { success: true, data: doc ? buildLegacyModels(doc.products || []) : [] };
    }

    if (action === 'initializeDefault') return initializeDefault(payload.seed);
    if (action === 'addBrand') return addBrand(payload);
    if (action === 'updateBrand') return updateBrand(payload);
    if (action === 'deleteBrand') return deleteBrand(payload);
    if (action === 'addModels') return addModels(payload);
    if (action === 'addProduct') return addProduct(payload);
    if (action === 'updateProduct') return updateProduct(payload);
    if (action === 'deleteProduct') return deleteProduct(payload);
    if (action === 'addSpec') return addSpec(payload);
    if (action === 'updateSpec') return updateSpec(payload);
    if (action === 'deleteSpec') return deleteSpec(payload);

    return { success: false, errMsg: `未知操作: ${action}` };
  } catch (error) {
    console.error('manageProductModels 执行失败:', error);
    return { success: false, errMsg: error.message || '型号管理操作失败' };
  }
};
