/**
 * manageCustomers - 客户主档案、别名与收货档案管理。
 *
 * 第一阶段只维护人工确认的数据，不扫描或自动合并历史订单。
 */

const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');
const { clean, normalizeName, normalizePhone, normalizeAddress } = require('./normalizers');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const CUSTOMER_COLLECTION = 'customers';
const ALIAS_COLLECTION = 'customer_aliases';
const RECIPIENT_COLLECTION = 'customer_recipient_profiles';
const ORDER_COLLECTION = 'orders';
const CONFIG_COLLECTION = 'system_config';
const CONFIG_ID = 'permission_system';
const ROLE_COLLECTION = 'roles';
const USER_ROLE_COLLECTION = 'user_roles';

const READ_PERMISSIONS = ['customers:read', 'customers:write', 'orders:read', 'orders:create', 'orders:update'];
const WRITE_PERMISSIONS = ['customers:write'];
const ORDER_LINK_PERMISSIONS = ['customers:write', 'orders:create', 'orders:update'];

function now() {
  return new Date().toISOString();
}

function getPayload(event) {
  const first = event && event.data !== undefined ? event.data : event || {};
  return first && first.data && first.action === undefined ? first.data : first;
}

function notFound(err) {
  const message = String(err && err.message || '');
  return err && (err.errCode === -1 || err.errCode === -502005 || message.includes('not exist') || message.includes('does not exist'));
}

function hasAnyPermission(role, permissions) {
  const actions = Array.isArray(role && role.actionPermissions) ? role.actionPermissions : [];
  return actions.includes('*') || permissions.some(permission => actions.includes(permission));
}

async function ensureCollection(name) {
  try {
    await db.collection(name).limit(1).get();
  } catch (err) {
    if (!notFound(err)) throw err;
    if (typeof db.createCollection !== 'function') throw new Error(`数据库集合不存在且无法自动创建: ${name}`);
    try {
      await db.createCollection(name);
    } catch (createErr) {
      const message = String(createErr && createErr.message || '');
      if (!message.includes('already exists') && !message.includes('exists')) throw createErr;
    }
  }
}

async function ensureCollections() {
  await Promise.all([
    ensureCollection(CUSTOMER_COLLECTION),
    ensureCollection(ALIAS_COLLECTION),
    ensureCollection(RECIPIENT_COLLECTION),
  ]);
}

async function getDocById(collectionName, id) {
  if (!id) return null;
  try {
    const result = await db.collection(collectionName).where({ _id: id }).limit(1).get();
    return result.data && result.data[0] || null;
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

async function fetchAll(collectionName, where = {}) {
  try {
    const query = Object.keys(where).length ? db.collection(collectionName).where(where) : db.collection(collectionName);
    const result = [];
    for (let skip = 0; ; skip += 100) {
      const page = await query.skip(skip).limit(100).get();
      const rows = page.data || [];
      result.push(...rows);
      if (rows.length < 100) break;
    }
    return result;
  } catch (err) {
    if (notFound(err)) return [];
    throw err;
  }
}

async function requirePermission(permissions) {
  const currentUser = await getCurrentUser();
  if (!currentUser) return { allowed: false, code: 'LOGIN_REQUIRED', errMsg: '请先登录' };
  const config = await getDocById(CONFIG_COLLECTION, CONFIG_ID);
  if (!config || !config.initialized) return { allowed: false, code: 'PERMISSION_UNINITIALIZED', errMsg: '权限系统未初始化' };
  const userRoles = await fetchAll(USER_ROLE_COLLECTION, { userId: currentUser.id });
  if (!userRoles[0]) return { allowed: false, code: 'ROLE_UNASSIGNED', errMsg: '当前用户未分配角色' };
  const role = await getDocById(ROLE_COLLECTION, userRoles[0].roleId);
  if (!role) return { allowed: false, code: 'ROLE_NOT_FOUND', errMsg: '用户关联的角色不存在' };
  if (!hasAnyPermission(role, permissions)) return { allowed: false, code: 'ACCESS_DENIED', errMsg: '无权访问客户主档案' };
  return { allowed: true, currentUser, role };
}

function auditCreate(currentUser) {
  const timestamp = now();
  return { createdAt: timestamp, createdBy: currentUser.id, updatedAt: timestamp, updatedBy: currentUser.id };
}

function auditUpdate(currentUser) {
  return { updatedAt: now(), updatedBy: currentUser.id };
}

async function requireCustomer(customerId) {
  const customer = await getDocById(CUSTOMER_COLLECTION, customerId);
  if (!customer) throw new Error('客户主档案不存在');
  return customer;
}

async function findDuplicateAlias(customerId, normalizedName, salesChannel, excludeId = '') {
  const aliases = await fetchAll(ALIAS_COLLECTION, { customerId });
  return aliases.find(alias => alias._id !== excludeId
    && alias.enabled !== false
    && alias.normalizedName === normalizedName
    && clean(alias.salesChannel) === salesChannel) || null;
}

async function listCustomers(payload) {
  await ensureCollections();
  const keyword = clean(payload.keyword).normalize('NFKC').toLocaleLowerCase('zh-CN');
  const normalizedKeyword = normalizeName(keyword);
  const includeDisabled = payload.includeDisabled === true;
  const page = Math.max(1, Number(payload.page) || 1);
  const pageSize = Math.min(5000, Math.max(1, Number(payload.pageSize) || 100));
  const [customers, aliases, recipients] = await Promise.all([
    fetchAll(CUSTOMER_COLLECTION),
    fetchAll(ALIAS_COLLECTION),
    fetchAll(RECIPIENT_COLLECTION),
  ]);
  const aliasesByCustomer = new Map();
  const recipientsByCustomer = new Map();
  aliases.filter(item => item.enabled !== false).forEach(item => {
    const values = aliasesByCustomer.get(item.customerId) || [];
    values.push(item);
    aliasesByCustomer.set(item.customerId, values);
  });
  recipients.filter(item => item.enabled !== false).forEach(item => {
    const values = recipientsByCustomer.get(item.customerId) || [];
    values.push(item);
    recipientsByCustomer.set(item.customerId, values);
  });

  const filtered = customers.filter(customer => {
    if (!includeDisabled && customer.status === 'disabled') return false;
    if (!keyword) return true;
    if (String(customer.displayName || '').toLocaleLowerCase('zh-CN').includes(keyword)) return true;
    if (String(customer.normalizedDisplayName || '').includes(normalizedKeyword)) return true;
    if ((aliasesByCustomer.get(customer._id) || []).some(alias => String(alias.name || '').toLocaleLowerCase('zh-CN').includes(keyword))) return true;
    return (recipientsByCustomer.get(customer._id) || []).some(recipient => (
      String(recipient.consignee || '').toLocaleLowerCase('zh-CN').includes(keyword)
      || String(recipient.phone || '').includes(keyword)
      || String(recipient.address || '').toLocaleLowerCase('zh-CN').includes(keyword)
    ));
  }).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  const data = filtered.slice((page - 1) * pageSize, page * pageSize).map(customer => ({
    ...customer,
    aliasCount: (aliasesByCustomer.get(customer._id) || []).length,
    recipientCount: (recipientsByCustomer.get(customer._id) || []).length,
  }));
  return { success: true, data, total: filtered.length, page, pageSize };
}

async function getCustomer(payload) {
  await ensureCollections();
  const customerId = clean(payload.customerId || payload._id);
  const customer = await requireCustomer(customerId);
  const [aliases, recipients, orderCountResult, recentOrdersResult] = await Promise.all([
    fetchAll(ALIAS_COLLECTION, { customerId }),
    fetchAll(RECIPIENT_COLLECTION, { customerId }),
    db.collection(ORDER_COLLECTION).where({ customerId }).count().catch(() => ({ total: 0 })),
    db.collection(ORDER_COLLECTION).where({ customerId }).orderBy('date', 'desc').limit(20).get().catch(() => ({ data: [] })),
  ]);
  return {
    success: true,
    data: {
      ...customer,
      aliases: aliases.sort((a, b) => Number(b.enabled !== false) - Number(a.enabled !== false) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))),
      recipients: recipients.sort((a, b) => Number(b.enabled !== false) - Number(a.enabled !== false) || String(b.lastUsedAt || b.updatedAt || '').localeCompare(String(a.lastUsedAt || a.updatedAt || ''))),
      linkedOrderCount: Number(orderCountResult.total) || 0,
      recentOrders: recentOrdersResult.data || [],
    },
  };
}

async function createCustomer(payload, currentUser) {
  await ensureCollections();
  const displayName = clean(payload.displayName);
  if (!displayName) return { success: false, errMsg: '客户主名称不能为空' };
  const customerResult = await db.collection(CUSTOMER_COLLECTION).add({ data: {
    displayName,
    normalizedDisplayName: normalizeName(displayName),
    status: 'active',
    remark: clean(payload.remark),
    ...auditCreate(currentUser),
  } });
  const customerId = customerResult._id;
  const aliasResult = await db.collection(ALIAS_COLLECTION).add({ data: {
    customerId,
    name: displayName,
    normalizedName: normalizeName(displayName),
    sourceType: 'manual',
    salesChannel: '',
    remark: '创建主档案时生成',
    enabled: true,
    ...auditCreate(currentUser),
  } });
  return { success: true, data: { _id: customerId, primaryAliasId: aliasResult._id } };
}

async function updateCustomer(payload, currentUser) {
  const customerId = clean(payload.customerId || payload._id);
  const existing = await requireCustomer(customerId);
  const displayName = clean(payload.displayName === undefined ? existing.displayName : payload.displayName);
  if (!displayName) return { success: false, errMsg: '客户主名称不能为空' };
  await db.collection(CUSTOMER_COLLECTION).doc(customerId).update({ data: {
    displayName,
    normalizedDisplayName: normalizeName(displayName),
    remark: clean(payload.remark === undefined ? existing.remark : payload.remark),
    ...auditUpdate(currentUser),
  } });
  return { success: true };
}

async function setCustomerStatus(payload, currentUser, status) {
  const customerId = clean(payload.customerId || payload._id);
  await requireCustomer(customerId);
  await db.collection(CUSTOMER_COLLECTION).doc(customerId).update({ data: { status, ...auditUpdate(currentUser) } });
  return { success: true };
}

function aliasData(payload) {
  const name = clean(payload.name);
  return {
    name,
    normalizedName: normalizeName(name),
    sourceType: ['manual', 'order', 'assist_import'].includes(payload.sourceType) ? payload.sourceType : 'manual',
    salesChannel: clean(payload.salesChannel),
    remark: clean(payload.remark),
    enabled: payload.enabled !== false,
  };
}

async function createAlias(payload, currentUser) {
  const customerId = clean(payload.customerId);
  await requireCustomer(customerId);
  const data = aliasData(payload);
  if (!data.name) return { success: false, errMsg: '别名不能为空' };
  if (await findDuplicateAlias(customerId, data.normalizedName, data.salesChannel)) return { success: false, errMsg: '该客户在相同渠道下已存在此别名' };
  const result = await db.collection(ALIAS_COLLECTION).add({ data: { customerId, ...data, ...auditCreate(currentUser) } });
  return { success: true, data: { _id: result._id } };
}

async function updateAlias(payload, currentUser) {
  const aliasId = clean(payload.aliasId || payload._id);
  const existing = await getDocById(ALIAS_COLLECTION, aliasId);
  if (!existing) return { success: false, errMsg: '客户别名不存在' };
  const data = aliasData({ ...existing, ...payload });
  if (!data.name) return { success: false, errMsg: '别名不能为空' };
  if (await findDuplicateAlias(existing.customerId, data.normalizedName, data.salesChannel, aliasId)) return { success: false, errMsg: '该客户在相同渠道下已存在此别名' };
  await db.collection(ALIAS_COLLECTION).doc(aliasId).update({ data: { ...data, ...auditUpdate(currentUser) } });
  return { success: true };
}

async function disableAlias(payload, currentUser) {
  const aliasId = clean(payload.aliasId || payload._id);
  const existing = await getDocById(ALIAS_COLLECTION, aliasId);
  if (!existing) return { success: false, errMsg: '客户别名不存在' };
  await db.collection(ALIAS_COLLECTION).doc(aliasId).update({ data: { enabled: false, ...auditUpdate(currentUser) } });
  return { success: true };
}

function recipientData(payload) {
  const consignee = clean(payload.consignee);
  const phone = clean(payload.phone);
  const address = clean(payload.address);
  return {
    label: clean(payload.label) || consignee || '默认收货档案',
    consignee,
    normalizedConsignee: normalizeName(consignee),
    phone,
    normalizedPhone: normalizePhone(phone),
    address,
    normalizedAddress: normalizeAddress(address),
    sourceType: ['manual', 'order', 'assist_import'].includes(payload.sourceType) ? payload.sourceType : 'manual',
    enabled: payload.enabled !== false,
  };
}

async function createRecipient(payload, currentUser) {
  const customerId = clean(payload.customerId);
  await requireCustomer(customerId);
  const data = recipientData(payload);
  if (!data.consignee || !data.phone || !data.address) return { success: false, errMsg: '收货人、电话和地址不能为空' };
  const result = await db.collection(RECIPIENT_COLLECTION).add({ data: {
    customerId, ...data, useCount: 0, lastUsedAt: '', ...auditCreate(currentUser),
  } });
  return { success: true, data: { _id: result._id } };
}

async function updateRecipient(payload, currentUser) {
  const recipientId = clean(payload.recipientId || payload._id);
  const existing = await getDocById(RECIPIENT_COLLECTION, recipientId);
  if (!existing) return { success: false, errMsg: '收货档案不存在' };
  const data = recipientData({ ...existing, ...payload });
  if (!data.consignee || !data.phone || !data.address) return { success: false, errMsg: '收货人、电话和地址不能为空' };
  await db.collection(RECIPIENT_COLLECTION).doc(recipientId).update({ data: { ...data, ...auditUpdate(currentUser) } });
  return { success: true };
}

async function disableRecipient(payload, currentUser) {
  const recipientId = clean(payload.recipientId || payload._id);
  const existing = await getDocById(RECIPIENT_COLLECTION, recipientId);
  if (!existing) return { success: false, errMsg: '收货档案不存在' };
  await db.collection(RECIPIENT_COLLECTION).doc(recipientId).update({ data: { enabled: false, ...auditUpdate(currentUser) } });
  return { success: true };
}

async function touchRecipient(payload, currentUser) {
  const recipientId = clean(payload.recipientId || payload._id);
  const existing = await getDocById(RECIPIENT_COLLECTION, recipientId);
  if (!existing) return { success: false, errMsg: '收货档案不存在' };
  await db.collection(RECIPIENT_COLLECTION).doc(recipientId).update({ data: {
    useCount: (Number(existing.useCount) || 0) + 1,
    lastUsedAt: now(),
    ...auditUpdate(currentUser),
  } });
  return { success: true };
}

exports.main = async event => {
  const payload = getPayload(event);
  const action = clean(payload.action) || 'list';
  try {
    const readActions = new Set(['list', 'search', 'get']);
    const permissions = readActions.has(action)
      ? READ_PERMISSIONS
      : action === 'touchRecipient' ? ORDER_LINK_PERMISSIONS : WRITE_PERMISSIONS;
    const auth = await requirePermission(permissions);
    if (!auth.allowed) return { success: false, code: auth.code, errMsg: auth.errMsg };

    if (action === 'list' || action === 'search') return listCustomers(payload);
    if (action === 'get') return getCustomer(payload);
    if (action === 'create') return createCustomer(payload, auth.currentUser);
    if (action === 'update') return updateCustomer(payload, auth.currentUser);
    if (action === 'disable') return setCustomerStatus(payload, auth.currentUser, 'disabled');
    if (action === 'enable') return setCustomerStatus(payload, auth.currentUser, 'active');
    if (action === 'createAlias') return createAlias(payload, auth.currentUser);
    if (action === 'updateAlias') return updateAlias(payload, auth.currentUser);
    if (action === 'disableAlias') return disableAlias(payload, auth.currentUser);
    if (action === 'createRecipient') return createRecipient(payload, auth.currentUser);
    if (action === 'updateRecipient') return updateRecipient(payload, auth.currentUser);
    if (action === 'disableRecipient') return disableRecipient(payload, auth.currentUser);
    if (action === 'touchRecipient') return touchRecipient(payload, auth.currentUser);
    return { success: false, errMsg: '不支持的操作类型' };
  } catch (error) {
    console.error('客户主档案管理失败:', error);
    return { success: false, code: 'CUSTOMER_MANAGE_FAILED', errMsg: error.message || '客户主档案管理失败' };
  }
};

exports.__test = { normalizeName, normalizePhone, normalizeAddress, recipientData, aliasData, getPayload };
