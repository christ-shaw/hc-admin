/**
 * manageUserRoles - 用户角色分配
 *
 * action: list | assign | remove
 */

const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const CONFIG_COLLECTION = 'system_config';
const CONFIG_ID = 'permission_system';
const ROLE_COLLECTION = 'roles';
const USER_COLLECTION = 'permission_users';
const USER_ROLE_COLLECTION = 'user_roles';
const USER_ROLE_MANAGE_PERMISSION = 'settings:user_role_manage';
const ROLE_MANAGE_PERMISSION = 'settings:role_manage';

function notFound(err) {
  const message = String(err && err.message || '');
  return err && (err.errCode === -1 || err.errCode === -502005 || message.includes('not exist') || message.includes('does not exist'));
}

function now() {
  return new Date().toISOString();
}

function getPayload(event) {
  return event && event.data || event || {};
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean).map(String)));
}

function firstNonEmpty(values) {
  return values.find(value => value !== undefined && value !== null && String(value) !== '') || '';
}

function hasPermission(actions, permission) {
  const list = actions || [];
  return list.includes('*') || list.includes(permission);
}

function isAdminRole(role) {
  const actions = role && role.actionPermissions || [];
  return actions.includes('*')
    || (actions.includes(ROLE_MANAGE_PERMISSION) && actions.includes(USER_ROLE_MANAGE_PERMISSION));
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

async function fetchAll(collectionName, where = {}) {
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
}

async function loadCurrentPermission(currentUser) {
  const config = await getDoc(CONFIG_COLLECTION, CONFIG_ID);
  if (!config || !config.initialized) {
    return {
      allowed: false,
      code: 'PERMISSION_UNINITIALIZED',
      errMsg: '权限系统未初始化',
    };
  }

  const userRoles = await fetchAll(USER_ROLE_COLLECTION, { userId: currentUser.id });
  const userRole = userRoles[0];
  if (!userRole) {
    return {
      allowed: false,
      code: 'ROLE_UNASSIGNED',
      errMsg: '当前用户未分配角色',
    };
  }

  const role = await getDoc(ROLE_COLLECTION, userRole.roleId);
  if (!role) {
    return {
      allowed: false,
      code: 'ROLE_NOT_FOUND',
      errMsg: '用户关联的角色不存在',
    };
  }

  if (!hasPermission(role.actionPermissions, USER_ROLE_MANAGE_PERMISSION)) {
    return {
      allowed: false,
      code: 'ACCESS_DENIED',
      errMsg: '无权分配用户角色',
    };
  }

  return { allowed: true, role, userRole };
}

async function requireUserRoleManage(event, context) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return {
      allowed: false,
      code: 'LOGIN_REQUIRED',
      errMsg: '请先登录',
    };
  }

  const permission = await loadCurrentPermission(currentUser);
  return { currentUser, ...permission };
}

async function getRoleMap() {
  const roles = await fetchAll(ROLE_COLLECTION);
  return new Map(roles.map(role => [role._id, role]));
}

function normalizeCloudbaseUser(user) {
  const metadata = user.user_metadata || user.userMetadata || user.metadata || {};
  const id = firstNonEmpty([
    user.id,
    user.uid,
    user.userId,
    user.uuid,
    user._id,
    user.openid,
    user.OPENID,
  ]);

  if (!id) return null;

  return {
    userId: String(id),
    username: String(firstNonEmpty([
      user.username,
      user.userName,
      metadata.username,
      user.email,
      user.phone,
      user.phoneNumber,
    ])),
    nickName: String(firstNonEmpty([
      user.nickName,
      user.nickname,
      metadata.nickName,
      metadata.nickname,
      user.name,
    ])),
    email: user.email || '',
    phone: user.phone || user.phoneNumber || '',
    rawUser: user,
  };
}

function extractUserList(result) {
  const candidates = [
    result && result.users,
    result && result.userList,
    result && result.list,
    result && result.data,
    result && result.data && result.data.users,
    result && result.data && result.data.userList,
    result && result.data && result.data.list,
  ];
  return candidates.find(Array.isArray) || [];
}

function extractNextCursor(result, offset, limit, count) {
  const next = firstNonEmpty([
    result && result.nextCursor,
    result && result.cursor,
    result && result.data && result.data.nextCursor,
    result && result.data && result.data.cursor,
  ]);
  if (next) return String(next);

  const total = Number(firstNonEmpty([
    result && result.total,
    result && result.totalCount,
    result && result.data && result.data.total,
    result && result.data && result.data.totalCount,
  ]));
  if (Number.isFinite(total) && offset + count < total) return String(offset + limit);
  return count === limit ? String(offset + limit) : null;
}

async function tryListUsersCall(target, methodName, argsList) {
  if (!target || typeof target[methodName] !== 'function') return null;

  for (const args of argsList) {
    try {
      const result = await target[methodName](args);
      return result || {};
    } catch (error) {
      // 不同 CloudBase SDK 版本的用户列表参数形态不同，失败后继续尝试下一种参数。
    }
  }

  return null;
}

async function listRegisteredCloudbaseUsers() {
  return {
    success: false,
    code: 'CLOUDBASE_AUTH_USER_LIST_UNAVAILABLE',
    errMsg: '请通过「添加用户」按钮手工录入用户镜像',
  };
}

async function findLocalUser(userId) {
  const result = await db.collection(USER_COLLECTION)
    .where({ userId })
    .limit(1)
    .get();
  return result.data && result.data[0] || null;
}

async function upsertLocalUser(user, currentUser) {
  const existing = await findLocalUser(user.userId);
  const data = {
    userId: user.userId,
    username: user.username || '',
    nickName: user.nickName || '',
    email: user.email || '',
    phone: user.phone || '',
    source: 'cloudbase',
    lastSyncedAt: now(),
    updatedAt: now(),
    updatedBy: currentUser.id,
  };

  if (existing) {
    await db.collection(USER_COLLECTION).doc(existing._id).update({ data });
    return { type: 'updated', _id: existing._id };
  }

  const result = await db.collection(USER_COLLECTION).add({
    data: {
      ...data,
      createdAt: now(),
      createdBy: currentUser.id,
    },
  });
  return { type: 'created', _id: result._id };
}

async function syncCloudbaseUsers(payload, currentUser) {
  const cloudbaseUsersResult = await listRegisteredCloudbaseUsers(payload);
  if (!cloudbaseUsersResult.success) return cloudbaseUsersResult;

  let created = 0;
  let updated = 0;

  for (const user of cloudbaseUsersResult.data) {
    const result = await upsertLocalUser(user, currentUser);
    if (result.type === 'created') created += 1;
    if (result.type === 'updated') updated += 1;
  }

  return {
    success: true,
    total: cloudbaseUsersResult.data.length,
    created,
    updated,
    errMsg: '用户同步完成',
  };
}

async function findUserRole(userId) {
  const result = await db.collection(USER_ROLE_COLLECTION)
    .where({ userId })
    .limit(1)
    .get();
  return result.data && result.data[0] || null;
}

async function countAdminUsersAfterChange(targetUserId, replacementRoleId) {
  const [roleMap, userRoles] = await Promise.all([
    getRoleMap(),
    fetchAll(USER_ROLE_COLLECTION),
  ]);
  const seenTarget = userRoles.some(userRole => userRole.userId === targetUserId);
  let count = 0;

  userRoles.forEach(userRole => {
    const roleId = userRole.userId === targetUserId ? replacementRoleId : userRole.roleId;
    if (!roleId) return;
    if (isAdminRole(roleMap.get(roleId))) count += 1;
  });

  if (!seenTarget && replacementRoleId && isAdminRole(roleMap.get(replacementRoleId))) {
    count += 1;
  }

  return count;
}

async function listUserRoles() {
  const [roleMap, localUsers, userRoles] = await Promise.all([
    getRoleMap(),
    fetchAll(USER_COLLECTION),
    fetchAll(USER_ROLE_COLLECTION),
  ]);
  const userRoleMap = new Map(userRoles.map(record => [record.userId, record]));

  return localUsers
    .map(user => {
      const record = userRoleMap.get(user.userId);
      if (!record) {
        return {
          userId: user.userId,
          username: user.username,
          nickName: user.nickName,
          email: user.email,
          phone: user.phone,
          roleId: '',
          roleName: '',
          roleCode: '',
          assigned: false,
        };
      }
      const role = roleMap.get(record.roleId);
      return {
        ...record,
        username: record.username || user.username,
        nickName: record.nickName || user.nickName,
        email: user.email,
        phone: user.phone,
        roleName: role && role.name || '',
        roleCode: role && role.code || '',
        assigned: true,
      };
    })
    .sort((a, b) => String(a.username || a.nickName || a.userId).localeCompare(String(b.username || b.nickName || b.userId), 'zh-Hans-CN'));
}

async function assignUserRole(payload, currentUser) {
  const userId = String(payload.userId || '').trim();
  const roleId = String(payload.roleId || '').trim();
  if (!userId) return { success: false, errMsg: '缺少用户ID' };
  if (!roleId) return { success: false, errMsg: '缺少角色ID' };

  const role = await getDoc(ROLE_COLLECTION, roleId);
  if (!role) return { success: false, errMsg: '目标角色不存在' };

  const localUser = await findLocalUser(userId);
  if (!localUser) {
    return {
      success: false,
      code: 'LOCAL_USER_NOT_FOUND',
      errMsg: '目标用户不在本地用户列表中，请先从 CloudBase 同步用户',
    };
  }

  const adminCountAfterChange = await countAdminUsersAfterChange(userId, roleId);
  if (adminCountAfterChange < 1) {
    return { success: false, errMsg: '不能让系统失去最后一个管理员' };
  }

  const existing = await findUserRole(userId);
  const record = {
    userId,
    username: String(payload.username || localUser.username || '').trim(),
    nickName: String(payload.nickName || localUser.nickName || '').trim(),
    roleId,
    assignedBy: currentUser.id,
    updatedAt: now(),
  };

  if (existing) {
    await db.collection(USER_ROLE_COLLECTION).doc(existing._id).update({ data: record });
    return { success: true, data: { _id: existing._id, ...record } };
  }

  const result = await db.collection(USER_ROLE_COLLECTION).add({
    data: {
      ...record,
      createdAt: now(),
    },
  });
  return { success: true, data: { _id: result._id, ...record } };
}

async function removeUserRole(payload) {
  const userId = String(payload.userId || '').trim();
  if (!userId) return { success: false, errMsg: '缺少用户ID' };

  const localUser = await findLocalUser(userId);
  if (!localUser) {
    return {
      success: false,
      code: 'LOCAL_USER_NOT_FOUND',
      errMsg: '目标用户不在本地用户列表中，请先从 CloudBase 同步用户',
    };
  }

  const existing = await findUserRole(userId);
  if (!existing) return { success: true, removed: 0 };

  const adminCountAfterChange = await countAdminUsersAfterChange(userId, null);
  if (adminCountAfterChange < 1) {
    return { success: false, errMsg: '不能移除最后一个管理员的角色' };
  }

  const result = await db.collection(USER_ROLE_COLLECTION).doc(existing._id).remove();
  return { success: true, removed: result.stats && result.stats.removed || 0 };
}

async function createUserRecord(payload, currentUser) {
  const userId = String(payload.userId || '').trim();
  const username = String(payload.username || '').trim();
  if (!userId) return { success: false, errMsg: '请填写 CloudBase 用户 ID' };
  if (!username) return { success: false, errMsg: '请填写用户名' };

  const existing = await findLocalUser(userId);
  if (existing) {
    return { success: false, errMsg: '该用户 ID 已存在，请直接编辑' };
  }

  const data = {
    userId,
    username,
    nickName: String(payload.nickName || '').trim(),
    email: String(payload.email || '').trim(),
    phone: String(payload.phone || '').trim(),
    source: 'manual',
    lastSyncedAt: now(),
    createdAt: now(),
    createdBy: currentUser.id,
    updatedAt: now(),
    updatedBy: currentUser.id,
  };

  const result = await db.collection(USER_COLLECTION).add({ data });
  return { success: true, data: { _id: result._id, ...data } };
}

async function updateUserRecord(payload, currentUser) {
  const userId = String(payload.userId || '').trim();
  if (!userId) return { success: false, errMsg: '缺少用户 ID' };

  const existing = await findLocalUser(userId);
  if (!existing) {
    return { success: false, code: 'LOCAL_USER_NOT_FOUND', errMsg: '用户不存在' };
  }

  const data = {
    updatedAt: now(),
    updatedBy: currentUser.id,
  };
  if (payload.username !== undefined) data.username = String(payload.username || '').trim();
  if (payload.nickName !== undefined) data.nickName = String(payload.nickName || '').trim();
  if (payload.email !== undefined) data.email = String(payload.email || '').trim();
  if (payload.phone !== undefined) data.phone = String(payload.phone || '').trim();

  await db.collection(USER_COLLECTION).doc(existing._id).update({ data });
  return { success: true };
}

async function deleteUserRecord(payload) {
  const userId = String(payload.userId || '').trim();
  if (!userId) return { success: false, errMsg: '缺少用户 ID' };

  const existing = await findLocalUser(userId);
  if (!existing) return { success: true, removed: 0 };

  // 同时移除该用户的角色映射
  const userRole = await findUserRole(userId);
  if (userRole) {
    const adminCountAfterChange = await countAdminUsersAfterChange(userId, null);
    if (adminCountAfterChange < 1) {
      return { success: false, errMsg: '不能移除最后一个管理员' };
    }
    await db.collection(USER_ROLE_COLLECTION).doc(userRole._id).remove();
  }

  await db.collection(USER_COLLECTION).doc(existing._id).remove();
  return { success: true };
}

exports.main = async (event, context) => {
  const payload = getPayload(event);
  const action = payload.action || 'list';
  console.log('[manageUserRoles] 收到 action:', JSON.stringify(action), 'payload keys:', Object.keys(payload));

  try {
    const auth = await requireUserRoleManage(event, context);
    if (!auth.allowed) {
      return {
        success: false,
        code: auth.code,
        errMsg: auth.errMsg,
      };
    }

    if (action === 'list') {
      return { success: true, data: await listUserRoles() };
    }

    if (action === 'syncUsers') return syncCloudbaseUsers(payload, auth.currentUser);
    if (action === 'createUser') return createUserRecord(payload, auth.currentUser);
    if (action === 'updateUser') return updateUserRecord(payload, auth.currentUser);
    if (action === 'deleteUser') return deleteUserRecord(payload);
    if (action === 'assign') return assignUserRole(payload, auth.currentUser);
    if (action === 'remove') return removeUserRole(payload);

    return { success: false, errMsg: '不支持的操作类型' };
  } catch (error) {
    console.error('管理用户角色失败:', error);
    const message = String(error && error.message || '');
    if (message.includes('not exist') || message.includes('collection')) {
      return {
        success: false,
        code: 'COLLECTION_NOT_EXIST',
        errMsg: '数据库集合不存在，请先在 CloudBase 控制台创建 roles、user_roles、permission_users、system_config 集合',
      };
    }
    return {
      success: false,
      code: 'USER_ROLE_MANAGE_FAILED',
      errMsg: error.message || '管理用户角色失败',
    };
  }
};
