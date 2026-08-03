const MINIAPP_ACCESS_PERMISSION = 'miniapp:access';
const USER_COLLECTION = 'permission_users';
const USER_ROLE_COLLECTION = 'user_roles';
const ROLE_COLLECTION = 'roles';

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean).map(String)));
}

function hasPermission(actions, permission) {
  const list = unique(actions);
  return list.includes('*') || list.includes(permission);
}

async function findOne(db, collectionName, condition) {
  const result = await db.collection(collectionName).where(condition).limit(1).get();
  return result.data && result.data[0] || null;
}

async function findPermissionUser(db, openid) {
  return await findOne(db, USER_COLLECTION, { userId: openid })
    || await findOne(db, USER_COLLECTION, { openid });
}

async function findRole(db, roleId) {
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

function deny(code, errMsg, openid) {
  return { allowed: false, code, errMsg, openid };
}

async function requireMiniappPermission(cloud, db, permissions = []) {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) return deny('LOGIN_REQUIRED', '无法获取当前微信用户身份', '');

  const user = await findPermissionUser(db, openid);
  if (!user) return deny('MINIAPP_ACCESS_DENIED', '当前用户暂无小程序访问权限，请联系管理员', openid);

  const userRole = await findOne(db, USER_ROLE_COLLECTION, { userId: user.userId || openid });
  if (!userRole) return deny('ROLE_UNASSIGNED', '当前用户未分配角色，请联系管理员', openid);

  const role = await findRole(db, userRole.roleId);
  if (!role) return deny('ROLE_NOT_FOUND', '用户关联的角色不存在，请联系管理员', openid);

  const actionPermissions = unique(role.actionPermissions);
  if (!hasPermission(actionPermissions, MINIAPP_ACCESS_PERMISSION)) {
    return deny('MINIAPP_ACCESS_DENIED', '当前用户暂无小程序访问权限，请联系管理员', openid);
  }

  const required = unique(Array.isArray(permissions) ? permissions : [permissions]);
  const missing = required.filter(permission => !hasPermission(actionPermissions, permission));
  if (missing.length > 0) {
    return deny('PERMISSION_DENIED', '当前用户无权执行该操作', openid);
  }

  return { allowed: true, wxContext, openid, user, role, actionPermissions };
}

function deniedResult(auth) {
  return {
    success: false,
    code: auth.code || 'PERMISSION_DENIED',
    errMsg: auth.errMsg || '当前用户无权执行该操作',
    openid: auth.openid || '',
  };
}

module.exports = {
  requireMiniappPermission,
  deniedResult,
  hasPermission,
};
