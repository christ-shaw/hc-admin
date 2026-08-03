/**
 * manageSuppliers - 采购供应商配置管理
 *
 * action:
 * - list
 * - create
 * - update
 * - delete
 */

const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const COLLECTION = 'purchase_suppliers';
const CONFIG_COLLECTION = 'system_config';
const CONFIG_ID = 'permission_system';
const ROLE_COLLECTION = 'roles';
const USER_ROLE_COLLECTION = 'user_roles';

const READ_PERMISSIONS = [
  'settings:read',
  'settings:update',
  'settings:supplier_manage',
  'purchases:read',
  'purchases:create',
  'purchases:delete',
  'orders:read',
  'orders:create',
];
const WRITE_PERMISSIONS = ['settings:update', 'settings:supplier_manage'];

function now() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value || '').trim();
}

function getPayload(event) {
  return event && event.data || event || {};
}

function notFound(err) {
  const message = String(err && err.message || '');
  return err && (
    err.errCode === -1
    || err.errCode === -502005
    || message.includes('not exist')
    || message.includes('does not exist')
  );
}

function hasPermission(actions, permission) {
  const list = actions || [];
  return list.includes('*') || list.includes(permission);
}

function hasAnyPermission(actions, permissions) {
  return permissions.some(permission => hasPermission(actions, permission));
}

async function ensureCollection(collectionName) {
  try {
    await db.collection(collectionName).limit(1).get();
  } catch (err) {
    if (!notFound(err)) throw err;
    if (typeof db.createCollection !== 'function') {
      throw new Error(`数据库集合不存在且当前 SDK 不支持自动创建: ${collectionName}`);
    }
    try {
      await db.createCollection(collectionName);
    } catch (createErr) {
      const message = String(createErr && createErr.message || '');
      if (!message.includes('already exists') && !message.includes('exists')) throw createErr;
    }
  }
}

async function getDocById(collectionName, id) {
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
  if (!userRole) return { allowed: false, code: 'ROLE_UNASSIGNED', errMsg: '当前用户未分配角色' };

  const role = await getDocById(ROLE_COLLECTION, userRole.roleId);
  if (!role) return { allowed: false, code: 'ROLE_NOT_FOUND', errMsg: '用户关联的角色不存在' };

  return { allowed: true, role };
}

async function requirePermission(permissions) {
  const currentUser = await getCurrentUser();
  if (!currentUser) return { allowed: false, code: 'LOGIN_REQUIRED', errMsg: '请先登录' };

  const permission = await loadCurrentPermission(currentUser);
  if (!permission.allowed) return permission;
  if (!hasAnyPermission(permission.role.actionPermissions, permissions)) {
    return { allowed: false, code: 'ACCESS_DENIED', errMsg: '无权访问供应商配置' };
  }

  return { allowed: true, currentUser, role: permission.role };
}

async function findByName(name, excludeId = '') {
  const result = await db.collection(COLLECTION).where({ name }).limit(1).get();
  const record = result.data && result.data[0] || null;
  return record && record._id !== excludeId ? record : null;
}

function supplierData(payload) {
  return {
    name: clean(payload.name),
    contactName: clean(payload.contactName),
    phone: clean(payload.phone),
    address: clean(payload.address),
    remark: clean(payload.remark),
    enabled: payload.enabled !== false,
    sort: Number(payload.sort || 0),
  };
}

async function listSuppliers(payload) {
  await ensureCollection(COLLECTION);
  const list = await fetchAll(COLLECTION);
  const data = list
    .filter(item => !payload.enabledOnly || item.enabled !== false)
    .sort((a, b) => (
      (Number(a.sort || 0) - Number(b.sort || 0))
      || String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN')
    ));
  return { success: true, data };
}

async function createSupplier(payload, currentUser) {
  await ensureCollection(COLLECTION);
  const data = supplierData(payload);
  if (!data.name) return { success: false, errMsg: '供应商名称不能为空' };
  if (await findByName(data.name)) return { success: false, errMsg: '供应商名称已存在' };

  const timestamp = now();
  const result = await db.collection(COLLECTION).add({
    data: {
      ...data,
      createdAt: timestamp,
      createdBy: currentUser.id,
      updatedAt: timestamp,
      updatedBy: currentUser.id,
    },
  });
  return { success: true, data: { _id: result._id } };
}

async function updateSupplier(payload, currentUser) {
  const supplierId = clean(payload.supplierId || payload._id);
  if (!supplierId) return { success: false, errMsg: '缺少供应商ID' };

  const existing = await getDocById(COLLECTION, supplierId);
  if (!existing) return { success: false, errMsg: '供应商不存在' };

  const data = supplierData({ ...existing, ...payload });
  if (!data.name) return { success: false, errMsg: '供应商名称不能为空' };
  if (await findByName(data.name, supplierId)) return { success: false, errMsg: '供应商名称已存在' };

  await db.collection(COLLECTION).doc(supplierId).update({
    data: {
      ...data,
      updatedAt: now(),
      updatedBy: currentUser.id,
    },
  });
  return { success: true };
}

async function deleteSupplier(payload) {
  const supplierId = clean(payload.supplierId || payload._id);
  if (!supplierId) return { success: false, errMsg: '缺少供应商ID' };

  const existing = await getDocById(COLLECTION, supplierId);
  if (!existing) return { success: true, removed: 0 };

  const result = await db.collection(COLLECTION).doc(supplierId).remove();
  return { success: true, removed: result.stats && result.stats.removed || 0 };
}

exports.main = async (event) => {
  const payload = getPayload(event);
  const action = payload.action || 'list';

  try {
    const auth = await requirePermission(action === 'list' ? READ_PERMISSIONS : WRITE_PERMISSIONS);
    if (!auth.allowed) return { success: false, code: auth.code, errMsg: auth.errMsg };

    if (action === 'list') return listSuppliers(payload);
    if (action === 'create') return createSupplier(payload, auth.currentUser);
    if (action === 'update') return updateSupplier(payload, auth.currentUser);
    if (action === 'delete') return deleteSupplier(payload);
    return { success: false, errMsg: '不支持的操作类型' };
  } catch (error) {
    console.error('管理供应商配置失败:', error);
    return {
      success: false,
      code: 'SUPPLIER_MANAGE_FAILED',
      errMsg: error.message || '管理供应商配置失败',
    };
  }
};
