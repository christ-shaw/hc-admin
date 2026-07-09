/**
 * manageRoles - 角色管理
 *
 * action: list | create | update | delete
 */

const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const CONFIG_COLLECTION = 'system_config';
const CONFIG_ID = 'permission_system';
const ROLE_COLLECTION = 'roles';
const USER_ROLE_COLLECTION = 'user_roles';
const ROLE_MANAGE_PERMISSION = 'settings:role_manage';
const USER_ROLE_MANAGE_PERMISSION = 'settings:user_role_manage';

function notFound(err) {
  const message = String(err && err.message || '');
  return err && (err.errCode === -1 || err.errCode === -502005 || message.includes('not exist') || message.includes('does not exist'));
}

function now() {
  return new Date().toISOString();
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean).map(String)));
}

function getPayload(event) {
  return event && event.data || event || {};
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

  if (!hasPermission(role.actionPermissions, ROLE_MANAGE_PERMISSION)) {
    return {
      allowed: false,
      code: 'ACCESS_DENIED',
      errMsg: '无权管理角色',
    };
  }

  return { allowed: true, role, userRole };
}

async function requireRoleManage(event, context) {
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

async function countRoleUsers(roleId) {
  const result = await db.collection(USER_ROLE_COLLECTION).where({ roleId }).count();
  return result.total || 0;
}

async function countRolesWithPermission(permission, excludeRoleId) {
  const roles = await fetchAll(ROLE_COLLECTION);
  return roles.filter(role => {
    if (excludeRoleId && role._id === excludeRoleId) return false;
    return hasPermission(role.actionPermissions, permission);
  }).length;
}

async function countAdminUsersAfterRoleChange(changedRoleId, nextActionPermissions) {
  const [roles, userRoles] = await Promise.all([
    fetchAll(ROLE_COLLECTION),
    fetchAll(USER_ROLE_COLLECTION),
  ]);
  const roleMap = new Map();
  roles.forEach(role => {
    const nextRole = role._id === changedRoleId
      ? { ...role, actionPermissions: nextActionPermissions }
      : role;
    roleMap.set(role._id, nextRole);
  });

  return userRoles.filter(userRole => isAdminRole(roleMap.get(userRole.roleId))).length;
}

async function assertRoleUpdateSafe(roleId, nextActionPermissions) {
  const role = await getDoc(ROLE_COLLECTION, roleId);
  if (!role) {
    return { ok: false, errMsg: '角色不存在' };
  }

  if (role.systemRole && role._id === 'role_admin' && !isAdminRole({ actionPermissions: nextActionPermissions })) {
    return { ok: false, errMsg: '不能移除系统管理员角色的核心权限' };
  }

  if (hasPermission(role.actionPermissions, ROLE_MANAGE_PERMISSION)
      && !hasPermission(nextActionPermissions, ROLE_MANAGE_PERMISSION)
      && await countRolesWithPermission(ROLE_MANAGE_PERMISSION, roleId) === 0) {
    return { ok: false, errMsg: '不能移除最后一个角色管理权限' };
  }

  if (hasPermission(role.actionPermissions, USER_ROLE_MANAGE_PERMISSION)
      && !hasPermission(nextActionPermissions, USER_ROLE_MANAGE_PERMISSION)
      && await countRolesWithPermission(USER_ROLE_MANAGE_PERMISSION, roleId) === 0) {
    return { ok: false, errMsg: '不能移除最后一个用户角色管理权限' };
  }

  const roleUsers = await countRoleUsers(roleId);
  if (roleUsers > 0 && isAdminRole(role) && !isAdminRole({ actionPermissions: nextActionPermissions })) {
    const adminUsersAfterChange = await countAdminUsersAfterRoleChange(roleId, nextActionPermissions);
    if (adminUsersAfterChange < 1) {
      return { ok: false, errMsg: '不能让系统失去最后一个管理员' };
    }
  }

  return { ok: true };
}

async function listRoles() {
  const roles = await fetchAll(ROLE_COLLECTION);
  return roles.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN'));
}

async function createRole(payload) {
  const name = String(payload.name || '').trim();
  if (!name) {
    return { success: false, errMsg: '角色名称不能为空' };
  }

  const existing = await db.collection(ROLE_COLLECTION)
    .where({ name })
    .limit(1)
    .get();
  if (existing.data && existing.data.length > 0) {
    return { success: false, errMsg: '角色名称已存在' };
  }

  const record = {
    name,
    code: payload.code ? String(payload.code).trim() : '',
    description: payload.description ? String(payload.description).trim() : '',
    pagePermissions: unique(payload.pagePermissions),
    actionPermissions: unique(payload.actionPermissions),
    systemRole: false,
    createdAt: now(),
    updatedAt: now(),
  };

  const result = await db.collection(ROLE_COLLECTION).add({ data: record });
  return {
    success: true,
    data: { _id: result._id, ...record },
  };
}

async function updateRole(payload) {
  const roleId = String(payload.roleId || '').trim();
  if (!roleId) {
    return { success: false, errMsg: '缺少角色ID' };
  }

  const existing = await getDoc(ROLE_COLLECTION, roleId);
  if (!existing) {
    return { success: false, errMsg: '角色不存在' };
  }

  const nextActionPermissions = payload.actionPermissions
    ? unique(payload.actionPermissions)
    : unique(existing.actionPermissions);
  const safe = await assertRoleUpdateSafe(roleId, nextActionPermissions);
  if (!safe.ok) {
    return { success: false, errMsg: safe.errMsg };
  }

  const updateData = {
    updatedAt: now(),
  };

  if (payload.name !== undefined) {
    const name = String(payload.name || '').trim();
    if (!name) return { success: false, errMsg: '角色名称不能为空' };
    updateData.name = name;
  }
  if (payload.code !== undefined) updateData.code = String(payload.code || '').trim();
  if (payload.description !== undefined) updateData.description = String(payload.description || '').trim();
  if (payload.pagePermissions !== undefined) updateData.pagePermissions = unique(payload.pagePermissions);
  if (payload.actionPermissions !== undefined) updateData.actionPermissions = nextActionPermissions;

  delete updateData.systemRole;

  await db.collection(ROLE_COLLECTION).doc(roleId).update({ data: updateData });
  return { success: true };
}

async function deleteRole(payload) {
  const roleId = String(payload.roleId || '').trim();
  if (!roleId) {
    return { success: false, errMsg: '缺少角色ID' };
  }

  const role = await getDoc(ROLE_COLLECTION, roleId);
  if (!role) {
    return { success: false, errMsg: '角色不存在' };
  }

  if (role.systemRole) {
    return { success: false, errMsg: '系统内置角色不可删除' };
  }

  const userCount = await countRoleUsers(roleId);
  if (userCount > 0) {
    return { success: false, errMsg: `该角色仍有 ${userCount} 个用户使用，请先调整用户角色` };
  }

  if (hasPermission(role.actionPermissions, ROLE_MANAGE_PERMISSION)
      && await countRolesWithPermission(ROLE_MANAGE_PERMISSION, roleId) === 0) {
    return { success: false, errMsg: '不能删除最后一个拥有角色管理权限的角色' };
  }

  if (hasPermission(role.actionPermissions, USER_ROLE_MANAGE_PERMISSION)
      && await countRolesWithPermission(USER_ROLE_MANAGE_PERMISSION, roleId) === 0) {
    return { success: false, errMsg: '不能删除最后一个拥有用户角色管理权限的角色' };
  }

  await db.collection(ROLE_COLLECTION).doc(roleId).remove();
  return { success: true };
}

exports.main = async (event, context) => {
  const payload = getPayload(event);
  const action = payload.action || 'list';

  try {
    const auth = await requireRoleManage(event, context);
    if (!auth.allowed) {
      return {
        success: false,
        code: auth.code,
        errMsg: auth.errMsg,
      };
    }

    if (action === 'list') {
      return { success: true, data: await listRoles() };
    }

    if (action === 'create') return createRole(payload);
    if (action === 'update') return updateRole(payload);
    if (action === 'delete') return deleteRole(payload);

    return { success: false, errMsg: '不支持的操作类型' };
  } catch (error) {
    console.error('管理角色失败:', error);
    const message = String(error && error.message || '');
    if (message.includes('not exist') || message.includes('collection')) {
      return {
        success: false,
        code: 'COLLECTION_NOT_EXIST',
        errMsg: '数据库集合不存在，请先在 CloudBase 控制台创建 roles、user_roles、system_config 集合',
      };
    }
    return {
      success: false,
      code: 'ROLE_MANAGE_FAILED',
      errMsg: error.message || '管理角色失败',
    };
  }
};
