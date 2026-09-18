/**
 * manageCustomers - 客户主档案、别名与收货档案管理。
 *
 * 管理查询、身份匹配与事务化人工维护；订单接入及历史归档另阶段实施。
 */

const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');
const { clean, normalizeName, normalizePhone, normalizeAddress } = require('./normalizers');
const { permissionsFor, hasAnyPermission } = require('./permissions');

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

const { createRepository } = require('./repository');
const { conditionalMatch } = require('./versionedMatcher');
const { createWriter, WRITE_ACTIONS } = require('./writer');
const { CustomerError } = require('./errors');
const { aliasData, recipientData } = require('./records');
const repository = createRepository(db);
const { getDocById, fetchAll } = repository;
const write = createWriter(repository);
const scanUnlinkedOrders = require('./archiveScanner').createScanner(repository);
const resolveLinkCandidate = require('./archiveResolver').createResolver(repository);
const listLinkCandidates = require('./archiveQueries').createArchiveQueries(repository);
const suggestCustomers = require('./suggestions').createSuggestions(repository);
const archiveOrder = require('./orderArchive').createOrderArchive(db);

function getPayload(event) {
  const first = event && event.data !== undefined ? event.data : event || {};
  return first && first.data && first.action === undefined ? first.data : first;
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

async function requireCustomer(customerId) {
  const customer = await getDocById(CUSTOMER_COLLECTION, customerId);
  if (!customer) throw new Error('客户主档案不存在');
  return customer;
}

function pageNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 1;
}

function limitedPageSize(value, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(maximum, Math.max(1, Math.floor(number))) : 20;
}

async function listCustomers(payload, selectionOnly = false) {
  const keyword = clean(payload.keyword).normalize('NFKC').toLocaleLowerCase('zh-CN');
  if (selectionOnly && !keyword) return { success: false, code: 'KEYWORD_REQUIRED', errMsg: '请输入客户名称、别名、电话或地址' };
  if (keyword.length > 200) return { success: false, code: 'INVALID_KEYWORD', errMsg: '搜索内容过长' };
  const normalizedKeyword = normalizeName(keyword);
  const phoneKeyword = normalizePhone(keyword);
  const addressKeyword = normalizeAddress(keyword);
  const includeDisabled = payload.includeDisabled === true;
  const page = pageNumber(payload.page);
  const pageSize = limitedPageSize(payload.pageSize, selectionOnly ? 50 : 100);
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
    if (customer.status === 'merged') return false;
    if (selectionOnly ? customer.status !== 'active' : (!includeDisabled && customer.status === 'disabled')) return false;
    if (!keyword) return true;
    if (String(customer.displayName || '').toLocaleLowerCase('zh-CN').includes(keyword)) return true;
    // Derive from original fields until the optional v2 backfill has completed.
    if (normalizedKeyword && normalizeName(customer.displayName).includes(normalizedKeyword)) return true;
    if (normalizedKeyword && (aliasesByCustomer.get(customer._id) || []).some(alias => normalizeName(alias.name).includes(normalizedKeyword))) return true;
    return (recipientsByCustomer.get(customer._id) || []).some(recipient => (
      (normalizedKeyword && normalizeName(recipient.consignee).includes(normalizedKeyword))
      || (phoneKeyword && normalizePhone(recipient.phone).includes(phoneKeyword) && /^[+\d\s()\-]+$/.test(keyword))
      || (addressKeyword && normalizeAddress(recipient.address).includes(addressKeyword))
    ));
  }).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || String(a._id).localeCompare(String(b._id)));

  const data = filtered.slice((page - 1) * pageSize, page * pageSize).map(customer => selectionOnly ? ({
    _id: customer._id, displayName: customer.displayName,
  }) : ({
    ...customer,
    aliasCount: (aliasesByCustomer.get(customer._id) || []).length,
    recipientCount: (recipientsByCustomer.get(customer._id) || []).length,
  }));
  return { success: true, data, total: filtered.length, page, pageSize };
}

async function getOrderSelection(payload) {
  const customer = await requireCustomer(clean(payload.customerId || payload._id));
  if (customer.status !== 'active') return { success: false, code: 'CUSTOMER_UNAVAILABLE', errMsg: '该客户已停用或合并，请重新选择客户' };
  const pageSize = limitedPageSize(payload.pageSize, 50);
  const aliasPage = pageNumber(payload.aliasPage);
  const recipientPage = pageNumber(payload.recipientPage);
  const aliasQuery = db.collection(ALIAS_COLLECTION).where({ customerId: customer._id, enabled: db.command.neq(false) });
  const recipientQuery = db.collection(RECIPIENT_COLLECTION).where({ customerId: customer._id, enabled: db.command.neq(false) });
  const [aliasResult, recipientResult, aliasesCount, recipientsCount] = await Promise.all([
    aliasQuery.orderBy('_id', 'asc').skip((aliasPage - 1) * pageSize).limit(pageSize)
      .field({ _id: true, name: true, salesChannel: true }).get(),
    recipientQuery.orderBy('_id', 'asc').skip((recipientPage - 1) * pageSize).limit(pageSize)
      .field({ _id: true, label: true, consignee: true, phone: true, address: true }).get(),
    aliasQuery.count(), recipientQuery.count(),
  ]);
  return { success: true, data: {
    _id: customer._id,
    displayName: customer.displayName,
    // Explicit allowlists protect the response even if a projection changes later.
    aliases: (aliasResult.data || []).map(row => ({ _id: row._id, name: row.name, salesChannel: row.salesChannel || '' })),
    recipients: (recipientResult.data || []).map(row => ({
      _id: row._id, label: row.label || '', consignee: row.consignee, phone: row.phone, address: row.address,
    })),
    aliasPage, recipientPage, pageSize,
    aliasTotal: aliasesCount.total, recipientTotal: recipientsCount.total,
  } };
}

async function getCustomer(payload) {
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

exports.main = async event => {
  const payload = getPayload(event);
  const action = clean(payload.action) || 'list';
  try {
    const permissions = permissionsFor(action, payload.scope);
    if (!permissions) return { success: false, code: 'ACTION_NOT_ALLOWED', errMsg: '不支持此操作或查询模式' };
    const auth = await requirePermission(permissions);
    if (!auth.allowed) return { success: false, code: auth.code, errMsg: auth.errMsg };

    if (action === 'search' && payload.scope === 'orderSuggestions') return await suggestCustomers(payload);
    if (action === 'list' || action === 'search') return await listCustomers(payload, action === 'search');
    if (action === 'get') return await (payload.scope === 'orderSelection' ? getOrderSelection(payload) : getCustomer(payload));
    if (action === 'matchIdentity') return { success: true, data: await conditionalMatch(repository, payload) };
    if (action === 'createFromOrder') return { success: true, data: await archiveOrder(payload.orderId, auth.currentUser) };
    if (action === 'scanUnlinkedOrders') return await scanUnlinkedOrders({ ...payload, scanMode: 'all' }, auth.currentUser);
    if (action === 'scanNewOrders') return await scanUnlinkedOrders({ ...payload, scanMode: 'new', dryRun: false }, auth.currentUser);
    if (action === 'listLinkCandidates') return await listLinkCandidates(payload, auth.currentUser);
    if (action === 'resolveLinkCandidate') return await resolveLinkCandidate(payload, auth.currentUser);
    if (WRITE_ACTIONS.includes(action)) return await write(action, payload, auth.currentUser);
    return { success: false, code: 'ACTION_NOT_IMPLEMENTED', errMsg: '此操作尚未开放' };
  } catch (error) {
    console.error('客户主档案管理失败', { action, code: error.code || error.errCode || 'CUSTOMER_MANAGE_FAILED' });
    return { success: false, code: error instanceof CustomerError ? error.code : 'CUSTOMER_MANAGE_FAILED', errMsg: error instanceof CustomerError ? error.message : '客户操作失败，请使用原请求重试' };
  }
};

exports.__test = { normalizeName, normalizePhone, normalizeAddress, recipientData, aliasData, getPayload };
