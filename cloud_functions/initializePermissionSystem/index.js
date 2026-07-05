/**
 * initializePermissionSystem - 首次初始化权限系统
 *
 * 仅 CloudBase 内置 administrator 账号可调用。初始化后创建管理员角色并把当前用户设为管理员。
 */

const cloud = require('wx-server-sdk');
const { getCurrentUser, isSystemAdministrator } = require('./permissionAuth');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const CONFIG_COLLECTION = 'system_config';
const CONFIG_ID = 'permission_system';
const ROLE_COLLECTION = 'roles';
const USER_COLLECTION = 'permission_users';
const USER_ROLE_COLLECTION = 'user_roles';
const ADMIN_ROLE_ID = 'role_admin';
const SYSTEM_ADMIN_USERNAME = 'administrator';

const ALL_PAGE_PERMISSIONS = [
  '/',
  '/inbound',
  '/outbound',
  '/inventory',
  '/stats',
  '/logs',
  '/models',
  '/orders',
  '/invoices',
  '/companies',
  '/settings',
];

function notFound(err) {
  const message = String(err && err.message || '');
  return err && (err.errCode === -1 || err.errCode === -502005 || message.includes('not exist') || message.includes('does not exist'));
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean).map(String)));
}

function now() {
  return new Date().toISOString();
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
      if (!notFound(createErr)) {
        const message = String(createErr && createErr.message || '');
        if (!message.includes('already exists') && !message.includes('exists')) {
          throw createErr;
        }
      }
    }
  }
}

async function ensurePermissionCollections() {
  await Promise.all([
    ensureCollection(CONFIG_COLLECTION),
    ensureCollection(ROLE_COLLECTION),
    ensureCollection(USER_COLLECTION),
    ensureCollection(USER_ROLE_COLLECTION),
  ]);
}

async function getDoc(collectionName, id) {
  try {
    const result = await db.collection(collectionName)
      .where({ _id: id })
      .limit(1)
      .get();
    return (result.data && result.data[0]) || null;
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

async function setDoc(collectionName, id, data) {
  const exists = await getDoc(collectionName, id);
  if (exists) {
    await db.collection(collectionName).where({ _id: id }).update({ data });
    return id;
  }
  await db.collection(collectionName).add({ data: { _id: id, ...data } });
  return id;
}

async function findUserRole(userId) {
  const result = await db.collection(USER_ROLE_COLLECTION)
    .where({ userId })
    .limit(1)
    .get();
  return result.data && result.data[0] || null;
}

async function findLocalUser(userId) {
  const result = await db.collection(USER_COLLECTION)
    .where({ userId })
    .limit(1)
    .get();
  return result.data && result.data[0] || null;
}

async function upsertLocalUser(currentUser) {
  const existing = await findLocalUser(currentUser.id);
  const record = {
    userId: currentUser.id,
    username: currentUser.username || SYSTEM_ADMIN_USERNAME,
    nickName: currentUser.nickName || '',
    email: '',
    phone: '',
    source: 'cloudbase',
    lastSyncedAt: now(),
    updatedAt: now(),
    updatedBy: currentUser.id,
  };

  if (existing) {
    await db.collection(USER_COLLECTION).doc(existing._id).update({ data: record });
    return existing._id;
  }

  const result = await db.collection(USER_COLLECTION).add({
    data: {
      ...record,
      createdAt: now(),
      createdBy: currentUser.id,
    },
  });
  return result._id;
}

async function upsertUserRole(currentUser) {
  const existing = await findUserRole(currentUser.id);
  const record = {
    userId: currentUser.id,
    username: currentUser.username || '',
    nickName: currentUser.nickName || '',
    roleId: ADMIN_ROLE_ID,
    assignedBy: currentUser.id,
    updatedAt: now(),
  };

  if (existing) {
    await db.collection(USER_ROLE_COLLECTION).doc(existing._id).update({ data: record });
    return existing._id;
  }

  const result = await db.collection(USER_ROLE_COLLECTION).add({
    data: {
      ...record,
      createdAt: now(),
    },
  });
  return result._id;
}

exports.main = async (event, context) => {
  const payload = event && event.data || {};

  try {
    const currentUser = await getCurrentUser(event);
    if (!currentUser) {
      return {
        success: false,
        code: 'LOGIN_REQUIRED',
        errMsg: '请先登录',
      };
    }

    const config = await getDoc(CONFIG_COLLECTION, CONFIG_ID);
    if (config && config.initialized) {
      return {
        success: false,
        code: 'PERMISSION_ALREADY_INITIALIZED',
        errMsg: '权限系统已初始化',
      };
    }

    if (!await isSystemAdministrator(currentUser)) {
      return {
        success: false,
        code: 'ACCESS_DENIED',
        errMsg: '仅 CloudBase 内置 administrator 账号可以初始化权限系统',
      };
    }

    await ensurePermissionCollections();

    const timestamp = now();
    await setDoc(ROLE_COLLECTION, ADMIN_ROLE_ID, {
      name: payload.adminRoleName || '管理员',
      code: 'admin',
      description: '拥有全部页面和功能权限',
      pagePermissions: ALL_PAGE_PERMISSIONS,
      actionPermissions: ['*'],
      systemRole: true,
      updatedAt: timestamp,
      createdAt: timestamp,
    });

    await upsertLocalUser(currentUser);
    await upsertUserRole(currentUser);

    await setDoc(CONFIG_COLLECTION, CONFIG_ID, {
      initialized: true,
      bootstrapAdminUsername: SYSTEM_ADMIN_USERNAME,
      initializedBy: currentUser.id,
      initializedAt: timestamp,
      updatedAt: timestamp,
    });

    return {
      success: true,
      initialized: true,
      roleId: ADMIN_ROLE_ID,
      errMsg: '权限系统初始化成功',
    };
  } catch (error) {
    console.error('初始化权限系统失败:', error);
    const message = String(error && error.message || '');
    if (message.includes('not exist') || message.includes('collection')) {
      return {
        success: false,
        code: 'COLLECTION_NOT_EXIST',
        errMsg: '数据库集合不存在，请先在 CloudBase 控制台创建 roles、user_roles、system_config、permission_users 集合后再初始化',
      };
    }
    return {
      success: false,
      code: 'PERMISSION_INIT_FAILED',
      errMsg: error.message || '初始化权限系统失败',
    };
  }
};
