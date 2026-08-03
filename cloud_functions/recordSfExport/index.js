/**
 * recordSfExport - 以“导出批次 + 来源订单”写入幂等顺丰模板导出日志。
 */

const crypto = require('node:crypto');
const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const ORDERS = 'orders';
const EXPORT_LOGS = 'sf_export_logs';
const ROLES = 'roles';
const USER_ROLES = 'user_roles';
const MAX_ORDERS = 500;
const CHUNK_SIZE = 20;

function trim(value) {
  return String(value || '').trim();
}

function isNotFound(error) {
  const message = String(error && error.message || '');
  return !!error && (
    error.errCode === -1
    || error.errCode === -502005
    || message.includes('not exist')
    || message.includes('does not exist')
  );
}

function buildExportLogId(exportBatchId, sourceOrderId) {
  return crypto.createHash('sha256')
    .update(`${exportBatchId}:${sourceOrderId}`)
    .digest('hex');
}

async function getDoc(collection, id) {
  try {
    const result = await db.collection(collection).doc(id).get();
    return result.data || null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function requireOrderReadPermission() {
  const currentUser = await getCurrentUser();
  if (!currentUser) return { allowed: false, code: 'LOGIN_REQUIRED', errMsg: '请先登录' };

  let userRole = null;
  for (const userId of currentUser.ids || [currentUser.id]) {
    const result = await db.collection(USER_ROLES).where({ userId }).limit(1).get();
    userRole = result.data && result.data[0] || null;
    if (userRole) break;
  }
  if (!userRole) return { allowed: false, code: 'ROLE_UNASSIGNED', errMsg: '当前用户未分配角色' };

  const role = await getDoc(ROLES, userRole.roleId);
  if (!role) return { allowed: false, code: 'ROLE_NOT_FOUND', errMsg: '用户关联的角色不存在' };

  const actions = Array.isArray(role.actionPermissions) ? role.actionPermissions : [];
  const pages = Array.isArray(role.pagePermissions) ? role.pagePermissions : [];
  const allowed = actions.includes('*') || actions.includes('orders:read') || pages.includes('/orders');
  return allowed
    ? { allowed: true, operatorId: currentUser.id }
    : { allowed: false, code: 'ACCESS_DENIED', errMsg: '无权记录顺丰导出' };
}

async function ensureCollection(collectionName) {
  try {
    await db.collection(collectionName).limit(1).get();
  } catch (error) {
    if (!isNotFound(error)) throw error;
    if (typeof db.createCollection !== 'function') throw new Error(`数据库集合不存在: ${collectionName}`);
    await db.createCollection(collectionName);
  }
}

exports.main = async (event) => {
  const payload = event && event.data || {};
  const orderIds = Array.from(new Set(
    (Array.isArray(payload.orderIds) ? payload.orderIds : []).map(trim).filter(Boolean)
  ));
  const exportBatchId = trim(payload.exportBatchId);

  try {
    const auth = await requireOrderReadPermission();
    if (!auth.allowed) return { success: false, code: auth.code, errMsg: auth.errMsg };
    if (orderIds.length === 0) return { success: false, code: 'MISSING_ORDERS', errMsg: '缺少订单 ID' };
    if (orderIds.length > MAX_ORDERS) return { success: false, code: 'TOO_MANY_ORDERS', errMsg: `单次最多记录 ${MAX_ORDERS} 条订单` };
    if (!exportBatchId || exportBatchId.length > 100) return { success: false, code: 'INVALID_BATCH_ID', errMsg: '导出批次 ID 无效' };

    await ensureCollection(EXPORT_LOGS);
    let insertedCount = 0;
    let duplicatedCount = 0;
    const missingOrderIds = [];
    const exportedAt = new Date().toISOString();

    for (let index = 0; index < orderIds.length; index += CHUNK_SIZE) {
      const chunk = orderIds.slice(index, index + CHUNK_SIZE);
      const result = await db.collection(ORDERS)
        .where({ _id: _.in(chunk) })
        .field({ _id: true, serialNumber: true, onlineOrderNumber: true, date: true })
        .limit(chunk.length)
        .get();
      const orders = result.data || [];
      const foundIds = new Set(orders.map(order => order._id));
      missingOrderIds.push(...chunk.filter(id => !foundIds.has(id)));

      for (const order of orders) {
        const logId = buildExportLogId(exportBatchId, order._id);
        if (await getDoc(EXPORT_LOGS, logId)) {
          duplicatedCount += 1;
          continue;
        }
        try {
          await db.collection(EXPORT_LOGS).add({
            data: {
              _id: logId,
              exportBatchId,
              sourceOrderId: order._id,
              sourceSerialNumber: Number(order.serialNumber || 0),
              sourceOnlineOrderNumber: trim(order.onlineOrderNumber),
              sourceOrderDate: trim(order.date),
              operatorId: auth.operatorId,
              exportedAt,
              createdAt: db.serverDate(),
            },
          });
          insertedCount += 1;
        } catch (error) {
          const message = String(error && error.message || '').toLowerCase();
          if (message.includes('duplicate') || message.includes('already exists')) {
            duplicatedCount += 1;
          } else {
            throw error;
          }
        }
      }
    }

    return {
      success: missingOrderIds.length === 0,
      updatedCount: insertedCount,
      insertedCount,
      duplicatedCount,
      exportedAt,
      missingOrderIds: missingOrderIds.length > 0 ? missingOrderIds : undefined,
      errMsg: missingOrderIds.length > 0 ? '部分订单不存在，导出日志未全部记录' : '顺丰导出日志已记录',
    };
  } catch (error) {
    console.error('[recordSfExport] 记录导出日志失败:', error);
    return { success: false, code: 'RECORD_FAILED', errMsg: error.message || '记录顺丰导出日志失败' };
  }
};

exports.__test__ = { buildExportLogId };
