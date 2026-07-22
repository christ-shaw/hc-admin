/**
 * recordSfExport - 在顺丰 Excel 成功生成后记录每个原订单的导出次数。
 *
 * 同一个 exportBatchId 重试时不会重复计数；合并导出仍按每个原订单分别 +1。
 */

const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const ORDERS = 'orders';
const ROLES = 'roles';
const USER_ROLES = 'user_roles';
const MAX_ORDERS = 500;
const CHUNK_SIZE = 20;

function trim(value) {
  return String(value || '').trim();
}

async function requireOrderReadPermission() {
  const currentUser = await getCurrentUser();
  if (!currentUser) return { allowed: false, code: 'LOGIN_REQUIRED', errMsg: '请先登录' };

  const userRoleResult = await db.collection(USER_ROLES).where({ userId: currentUser.id }).limit(1).get();
  const userRole = (userRoleResult.data || [])[0];
  if (!userRole) return { allowed: false, code: 'ROLE_UNASSIGNED', errMsg: '当前用户未分配角色' };

  let role = null;
  try {
    const roleResult = await db.collection(ROLES).doc(userRole.roleId).get();
    role = roleResult.data || null;
  } catch (_) {
    role = null;
  }
  if (!role) return { allowed: false, code: 'ROLE_NOT_FOUND', errMsg: '用户关联的角色不存在' };

  const actions = Array.isArray(role.actionPermissions) ? role.actionPermissions : [];
  const pages = Array.isArray(role.pagePermissions) ? role.pagePermissions : [];
  const allowed = actions.includes('*') || actions.includes('orders:read') || pages.includes('/orders');
  return allowed
    ? { allowed: true }
    : { allowed: false, code: 'ACCESS_DENIED', errMsg: '无权记录顺丰导出' };
}

exports.main = async (event) => {
  const data = event.data || {};
  const orderIds = Array.from(new Set(
    (Array.isArray(data.orderIds) ? data.orderIds : []).map(trim).filter(Boolean)
  ));
  const exportBatchId = trim(data.exportBatchId);

  try {
    const auth = await requireOrderReadPermission();
    if (!auth.allowed) return { success: false, code: auth.code, errMsg: auth.errMsg };
    if (orderIds.length === 0) return { success: false, code: 'MISSING_ORDERS', errMsg: '缺少订单 ID' };
    if (orderIds.length > MAX_ORDERS) return { success: false, code: 'TOO_MANY_ORDERS', errMsg: `单次最多记录 ${MAX_ORDERS} 条订单` };
    if (!exportBatchId || exportBatchId.length > 100) return { success: false, code: 'INVALID_BATCH_ID', errMsg: '导出批次 ID 无效' };

    let updatedCount = 0;
    let duplicatedCount = 0;
    const missingOrderIds = [];

    for (let index = 0; index < orderIds.length; index += CHUNK_SIZE) {
      const chunk = orderIds.slice(index, index + CHUNK_SIZE);
      const result = await db.collection(ORDERS)
        .where({ _id: _.in(chunk) })
        .field({ _id: true, sfExportLastBatchId: true })
        .limit(chunk.length)
        .get();
      const records = result.data || [];
      const foundIds = new Set(records.map(record => record._id));
      missingOrderIds.push(...chunk.filter(id => !foundIds.has(id)));

      const pendingIds = records
        .filter(record => record.sfExportLastBatchId !== exportBatchId)
        .map(record => record._id);
      duplicatedCount += records.length - pendingIds.length;
      if (pendingIds.length === 0) continue;

      const updateResult = await db.collection(ORDERS).where({ _id: _.in(pendingIds) }).update({
        data: {
          sfExportCount: _.inc(1),
          sfLastExportTime: db.serverDate(),
          sfExportLastBatchId: exportBatchId,
        },
      });
      updatedCount += Number(updateResult.stats && updateResult.stats.updated) || pendingIds.length;
    }

    return {
      success: missingOrderIds.length === 0,
      updatedCount,
      duplicatedCount,
      missingOrderIds: missingOrderIds.length > 0 ? missingOrderIds : undefined,
      errMsg: missingOrderIds.length > 0 ? '部分订单不存在，导出计数未全部记录' : '顺丰导出计数已记录',
    };
  } catch (error) {
    console.error('[recordSfExport] 记录导出次数失败:', error);
    return { success: false, code: 'RECORD_FAILED', errMsg: error.message || '记录顺丰导出次数失败' };
  }
};
