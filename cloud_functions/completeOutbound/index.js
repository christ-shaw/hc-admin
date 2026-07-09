/**
 * completeOutbound - 完成发货
 *
 * 出库单录入快递单号/照片后置 outboundStatus='completed'，并把物流单号
 * 回填到关联订单（不覆盖已发货/已有单号的订单）。主要由小程序完成发货调用。
 * 设计见 docs/order-outbound-linkage-design.md §8.3
 *
 * 权限：仅要求 outbound:update（订单回填为该动作的系统副作用，不再单独要 orders:update，
 *       避免只有库存权限的仓管用户被拦）。
 */

const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');
const { requireMiniappPermission } = require('./miniappAuth');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const ORDERS = 'orders';
const OUTBOUND = 'outbound_records';
const ROLE_COLLECTION = 'roles';
const USER_ROLE_COLLECTION = 'user_roles';

const UPDATE_PERMISSION = 'outbound:update';

// ============ 鉴权（OPENID 走小程序，否则服务端登录态） ============

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean).map(String)));
}

function hasPermission(actions, permission) {
  const list = unique(actions);
  return list.includes('*') || list.includes(permission);
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
    currentUser.id, currentUser.uid, currentUser.userId,
    currentUser.customUserId, currentUser.openid, currentUser.openId,
  ]).map(value => String(value).trim()).filter(value => value && value !== 'anon');
}

async function requireWebPermission(currentUser, permission) {
  const userIds = getWebUserIds(currentUser);
  if (userIds.length === 0) return { allowed: false, code: 'LOGIN_REQUIRED', errMsg: '请先登录' };
  let userRole = null;
  for (const userId of userIds) {
    userRole = await findOne(USER_ROLE_COLLECTION, { userId });
    if (userRole) break;
  }
  if (!userRole) return { allowed: false, code: 'ROLE_UNASSIGNED', errMsg: '当前用户未分配角色，请联系管理员' };
  const role = await findRole(userRole.roleId);
  if (!role) return { allowed: false, code: 'ROLE_NOT_FOUND', errMsg: '用户关联的角色不存在，请联系管理员' };
  if (!hasPermission(role.actionPermissions, permission)) {
    return { allowed: false, code: 'PERMISSION_DENIED', errMsg: '当前用户无权执行该操作' };
  }
  return { allowed: true };
}

async function requirePermission(permission) {
  const wxContext = (typeof cloud.getWXContext === 'function' && cloud.getWXContext()) || {};
  if (wxContext.OPENID) {
    const auth = await requireMiniappPermission(cloud, db, [permission]);
    return auth.allowed ? { allowed: true } : { allowed: false, code: auth.code, errMsg: auth.errMsg };
  }
  const currentUser = await getCurrentUser();
  return requireWebPermission(currentUser, permission);
}

// ============ 业务 ============

function todayInBeijing() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

exports.main = async (event) => {
  const payload = (event && event.data) || event || {};

  const perm = await requirePermission(UPDATE_PERMISSION);
  if (!perm.allowed) return { success: false, code: perm.code, errMsg: perm.errMsg };

  const outboundId = String(payload.outboundId || '').trim();
  const trackingNumber = String(payload.trackingNumber || '').trim();
  const hasPhotos = Array.isArray(payload.phonePhotos); // 未传则不改动出库单原照片
  const phonePhotos = hasPhotos ? payload.phonePhotos : [];
  const hasRemark = payload.remark !== undefined && payload.remark !== null;
  const remark = hasRemark ? String(payload.remark) : '';
  const completedBy = payload.completedBy != null ? String(payload.completedBy) : '';

  if (!outboundId) return { success: false, code: 'MISSING_FIELDS', errMsg: '缺少 outboundId' };
  if (!trackingNumber) return { success: false, code: 'MISSING_FIELDS', errMsg: '缺少快递单号 trackingNumber' };

  const transaction = await db.startTransaction();
  try {
    // 1. 载入出库单，校验待出库
    let outRes = null;
    try { outRes = await transaction.collection(OUTBOUND).doc(outboundId).get(); } catch (_) { outRes = null; }
    if (!outRes || !outRes.data) {
      await transaction.rollback();
      return { success: false, code: 'OUTBOUND_NOT_FOUND', errMsg: '出库单不存在' };
    }
    const outbound = outRes.data;
    if (outbound.outboundStatus === 'completed') {
      await transaction.rollback();
      return { success: false, code: 'ALREADY_COMPLETED', errMsg: '该出库单已完成发货' };
    }

    // 2. 置已出库
    const outboundUpdate = {
      outboundStatus: 'completed',
      trackingNumber,
      outboundDate: todayInBeijing(),
    };
    if (hasPhotos) outboundUpdate.phonePhotos = phonePhotos; // 未传照片则保留原值
    if (hasRemark) outboundUpdate.remark = remark;
    if (completedBy) outboundUpdate.completedBy = completedBy;
    await transaction.collection(OUTBOUND).doc(outboundId).update({ data: outboundUpdate });

    // 3. 回填订单（不覆盖已发货/已有单号）
    const orderIds = Array.isArray(outbound.orderIds) ? outbound.orderIds : [];
    const shippingMethod = String(outbound.shippingMethod || '').trim();
    const backfilled = [];
    const skipped = [];
    for (const oid of orderIds) {
      let oRes = null;
      try { oRes = await transaction.collection(ORDERS).doc(oid).get(); } catch (_) { oRes = null; }
      if (!oRes || !oRes.data) { skipped.push(oid); continue; }
      const o = oRes.data;
      if (o.status === 'shipped' || String(o.trackingNumber || '').trim()) { skipped.push(oid); continue; }
      const orderUpdate = { trackingNumber, status: 'shipped' };
      if (shippingMethod) orderUpdate.shippingFee = shippingMethod;
      await transaction.collection(ORDERS).doc(oid).update({ data: orderUpdate });
      backfilled.push(oid);
    }

    await transaction.commit();
    return { success: true, outboundId, backfilled, skipped };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    console.error('[completeOutbound] 失败:', err);
    return { success: false, code: 'INTERNAL_ERROR', errMsg: err.message || '完成发货失败' };
  }
};
