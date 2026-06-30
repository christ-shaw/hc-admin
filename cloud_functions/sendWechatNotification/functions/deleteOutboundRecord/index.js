const cloud = require("wx-server-sdk");
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const { requireMiniappPermission, deniedResult } = require('./miniappAuth');
const { getCurrentUser } = require('./permissionAuth');

const ROLE_COLLECTION = 'roles';
const USER_ROLE_COLLECTION = 'user_roles';
const PAGE_PERMISSION_FALLBACKS = {
  'outbound:delete': ['/outbound'],
};

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean).map(String)));
}

function hasPermission(actions, permission) {
  const list = unique(actions);
  return list.includes('*') || list.includes(permission);
}

function hasPagePermission(pages, permission) {
  const list = unique(pages);
  const allowedPages = PAGE_PERMISSION_FALLBACKS[permission] || [];
  return list.includes('*') || allowedPages.some(page => list.includes(page));
}

async function findOne(collectionName, condition) {
  const result = await db.collection(collectionName).where(condition).limit(1).get();
  return result.data && result.data[0] || null;
}

async function findRole(roleId) {
  if (!roleId) return null;
  try {
    const result = await db.collection(ROLE_COLLECTION).doc(roleId).get();
    return result.data || null;
  } catch (err) {
    const message = String(err && err.message || '');
    if (message.includes('not exist') || message.includes('does not exist')) return null;
    throw err;
  }
}

function getWebUserIds(currentUser) {
  if (!currentUser || typeof currentUser !== 'object') return [];
  return unique([
    currentUser.id,
    currentUser.uid,
    currentUser.userId,
    currentUser.customUserId,
    currentUser.openid,
    currentUser.openId,
  ]).map(value => String(value).trim()).filter(value => value && value !== 'anon');
}

async function findUserRoleByIds(userIds) {
  for (const userId of userIds) {
    const userRole = await findOne(USER_ROLE_COLLECTION, { userId });
    if (userRole) return userRole;
  }
  return null;
}

async function requireWebPermission(currentUser, permissions = []) {
  const userIds = getWebUserIds(currentUser);
  if (userIds.length === 0) {
    return { allowed: false, code: 'LOGIN_REQUIRED', errMsg: '请先登录' };
  }

  const userRole = await findUserRoleByIds(userIds);
  if (!userRole) {
    return { allowed: false, code: 'ROLE_UNASSIGNED', errMsg: '当前用户未分配角色，请联系管理员' };
  }

  const role = await findRole(userRole.roleId);
  if (!role) {
    return { allowed: false, code: 'ROLE_NOT_FOUND', errMsg: '用户关联的角色不存在，请联系管理员' };
  }

  const actionPermissions = unique(role.actionPermissions);
  const pagePermissions = unique(role.pagePermissions);
  const required = unique(Array.isArray(permissions) ? permissions : [permissions]);
  const missing = required.filter(permission => !hasPermission(actionPermissions, permission) && !hasPagePermission(pagePermissions, permission));
  if (missing.length > 0) {
    return { allowed: false, code: 'PERMISSION_DENIED', errMsg: '当前用户无权执行该操作' };
  }

  return { allowed: true, role, actionPermissions };
}

async function requireRecordPermission(payload, requiredPermission) {
  // 小程序调用带平台注入的可信 OPENID，走小程序鉴权
  const wxContext = (typeof cloud.getWXContext === 'function' && cloud.getWXContext()) || {};
  if (wxContext.OPENID) {
    return await requireMiniappPermission(cloud, db, [requiredPermission]);
  }
  // 网页端：身份从服务端登录态解析，绝不信任 payload.currentUser（否则可伪造身份越权）
  const currentUser = await getCurrentUser();
  return await requireWebPermission(currentUser, [requiredPermission]);
}

exports.main = async (event, context) => {
  try {
    const payload = event.data || {};
    const auth = await requireRecordPermission(payload, 'outbound:delete');
    if (!auth.allowed) return deniedResult(auth);

    const { _id } = payload;

    // 删除出库记录
    await db.collection('outbound_records').doc(_id).remove();

    return {
      success: true,
      errMsg: '删除出库记录成功'
    };
  } catch (e) {
    console.error('删除出库记录失败:', e);
    return {
      success: false,
      errMsg: e.message || '删除出库记录失败'
    };
  }
};
