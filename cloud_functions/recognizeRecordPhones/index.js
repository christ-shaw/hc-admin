const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');
const { requireMiniappPermission } = require('./miniappAuth');
const { createService } = require('./service');
const { configuration, createDetector } = require('./provider');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

async function authorize(permission) {
  if (cloud.getWXContext().OPENID) return requireMiniappPermission(cloud, db, [permission]);
  const user = await getCurrentUser();
  const ids = [...new Set([user?.id, user?.uid, user?.customUserId, user?.openId].filter(Boolean))];
  if (!ids.length) return { allowed: false, code: 'LOGIN_REQUIRED', errMsg: '请先登录' };
  for (const userId of ids) {
    const { data } = await db.collection('user_roles').where({ userId }).limit(1).get();
    if (!data.length) continue;
    const { data: role } = await db.collection('roles').doc(data[0].roleId).get();
    if (role?.actionPermissions?.some(p => p === '*' || p === permission)) return { allowed: true };
    break;
  }
  return { allowed: false, code: 'PERMISSION_DENIED', errMsg: '当前用户无权执行该操作' };
}

exports.main = createService({ db, authorize, detector: () => createDetector(cloud, configuration()) });
