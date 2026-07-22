/**
 * manageSfConfig - 管理顺丰下单环境
 *
 * action:
 * - get: 读取当前生效环境
 * - set: 保存环境到 system_config/sf_express.env
 */

const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const CONFIG_COLLECTION = 'system_config';
const CONFIG_ID = 'sf_express';
const PERMISSION_CONFIG_ID = 'permission_system';
const ROLE_COLLECTION = 'roles';
const USER_ROLE_COLLECTION = 'user_roles';

const READ_PERMISSION = 'settings:read';
const UPDATE_PERMISSION = 'settings:update';
const ORDER_READ_PERMISSION = 'orders:read';

function trimString(value) {
  return String(value || '').trim();
}

function now() {
  return new Date().toISOString();
}

function getPayload(event) {
  return event && event.data || event || {};
}

function notFound(err) {
  const message = String(err && err.message || '');
  return err && (
    err.errCode === -1 ||
    err.errCode === -502005 ||
    message.includes('not exist') ||
    message.includes('does not exist')
  );
}

function normalizeSfEnv(value = process.env.SF_ENV || 'sandbox') {
  const normalized = trimString(value).toLowerCase();
  if (!normalized || normalized === 'sandbox' || normalized === 'sbox') return 'sandbox';
  if (normalized === 'prod' || normalized === 'production') return 'production';
  throw new Error(`顺丰环境仅支持 sandbox 或 production，当前值: ${value}`);
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
  const config = await getDocById(CONFIG_COLLECTION, PERMISSION_CONFIG_ID);
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

  const permission = await loadCurrentPermission(currentUser);
  if (!permission.allowed) return permission;

  const hasOrderPageFallback = permissions.includes(ORDER_READ_PERMISSION)
    && (permission.role.pagePermissions || []).includes('/orders');
  if (!hasAnyPermission(permission.role.actionPermissions, permissions) && !hasOrderPageFallback) {
    return { allowed: false, code: 'ACCESS_DENIED', errMsg: '无权访问顺丰环境配置' };
  }

  return { allowed: true, currentUser, role: permission.role };
}

async function readSfConfig() {
  const config = await getDocById(CONFIG_COLLECTION, CONFIG_ID);
  const rawEnv = trimString(config && config.env);
  const env = rawEnv ? normalizeSfEnv(rawEnv) : normalizeSfEnv();

  return {
    success: true,
    env,
    source: rawEnv ? 'database' : 'env',
    updatedAt: config && config.updatedAt || '',
    updatedBy: config && config.updatedBy || '',
  };
}

async function saveSfConfig(payload, currentUser) {
  const env = normalizeSfEnv(payload.env);
  await ensureCollection(CONFIG_COLLECTION);

  const existing = await getDocById(CONFIG_COLLECTION, CONFIG_ID);
  const data = {
    env,
    updatedAt: now(),
    updatedBy: currentUser.id,
  };

  if (existing) {
    await db.collection(CONFIG_COLLECTION).doc(CONFIG_ID).update({ data });
  } else {
    await db.collection(CONFIG_COLLECTION).add({
      data: {
        _id: CONFIG_ID,
        ...data,
        createdAt: now(),
        createdBy: currentUser.id,
      },
    });
  }

  return {
    success: true,
    env,
    source: 'database',
    updatedAt: data.updatedAt,
    updatedBy: data.updatedBy,
  };
}

exports.main = async (event) => {
  const payload = getPayload(event);
  const action = payload.action || 'get';

  try {
    const permissions = action === 'get'
      ? [READ_PERMISSION, UPDATE_PERMISSION, ORDER_READ_PERMISSION]
      : [UPDATE_PERMISSION];
    const auth = await requirePermission(permissions);
    if (!auth.allowed) {
      return { success: false, code: auth.code, errMsg: auth.errMsg };
    }

    if (action === 'get') return readSfConfig();
    if (action === 'set') return saveSfConfig(payload, auth.currentUser);

    return { success: false, errMsg: '不支持的操作类型' };
  } catch (error) {
    console.error('管理顺丰配置失败:', error);
    return {
      success: false,
      code: 'SF_CONFIG_MANAGE_FAILED',
      errMsg: error.message || '管理顺丰配置失败',
    };
  }
};
