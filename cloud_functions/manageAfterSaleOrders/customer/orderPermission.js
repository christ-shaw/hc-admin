const { createRepository } = require('./repository');
const { fail } = require('./errors');
async function requireOrderPermission(db, getCurrentUser, permission) {
  const actor = await getCurrentUser();
  if (!actor || !actor.id) fail('LOGIN_REQUIRED', '请先登录');
  const repository = createRepository(db);
  const config = await repository.getDocById('system_config', 'permission_system');
  if (!config || !config.initialized) fail('PERMISSION_UNINITIALIZED', '权限系统未初始化');
  const assignments = await repository.fetchAll('user_roles', { userId: actor.id });
  const role = assignments[0] && await repository.getDocById('roles', assignments[0].roleId);
  const permissions = Array.isArray(role && role.actionPermissions) ? role.actionPermissions : [];
  if (!permissions.includes('*') && !permissions.includes(permission)) fail('ACCESS_DENIED', '无权执行此订单操作');
  return actor;
}
module.exports = { requireOrderPermission };
