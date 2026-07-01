/**
 * generateOutboundFromOrders - 由订单生成待出库单
 *
 * 单/多订单 → 一张 outbound_records(outboundStatus='pending', source='order')，
 * 并回写每个订单的 outboundRecordId。用于订单页「生成出库单 / 合并生成」。
 * 设计见 docs/order-outbound-linkage-design.md §8.3
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

const CREATE_PERMISSION = 'outbound:create';

// ============ 鉴权（与记录类函数一致：OPENID 走小程序，否则服务端登录态） ============

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

function isPendingShipment(status) {
  const s = String(status || '').trim();
  return s === 'unknown' || s === '--' || s === '' || s === 'unshipped';
}

// 订单货品 → model 字符串（与小程序拼法一致：规格非"默认"时带规格）
function buildModel(order) {
  const brand = String(order.brand || '').trim();
  const product = String(order.productName || '').trim();
  const spec = String(order.specification || '').trim();
  const base = [brand, product].filter(Boolean).join(' / ');
  if (!base) return '';
  return spec && spec !== '默认' ? `${base} / ${spec}` : base;
}

// 聚合多订单货品：相同 model 累加数量，不同 model 各保留一条
function aggregatePhoneModels(orders) {
  const map = new Map();
  const order = [];
  for (const o of orders) {
    const model = buildModel(o);
    if (!model) continue;
    const qty = Number(o.quantity) || 0;
    if (map.has(model)) {
      map.set(model, map.get(model) + qty);
    } else {
      map.set(model, qty);
      order.push(model);
    }
  }
  return order.map(model => ({ model, quantity: map.get(model) }));
}

exports.main = async (event) => {
  const payload = (event && event.data) || event || {};

  const perm = await requirePermission(CREATE_PERMISSION);
  if (!perm.allowed) return { success: false, code: perm.code, errMsg: perm.errMsg };

  const orderIds = Array.isArray(payload.orderIds) ? unique(payload.orderIds) : [];
  const shippingMethod = String(payload.shippingMethod || '').trim();
  const remark = String(payload.remark || '');

  if (orderIds.length === 0) return { success: false, code: 'MISSING_FIELDS', errMsg: '缺少 orderIds' };
  if (!shippingMethod) return { success: false, code: 'MISSING_FIELDS', errMsg: '缺少快递方式 shippingMethod' };

  const transaction = await db.startTransaction();
  try {
    // 1. 载入并校验订单
    const orders = [];
    for (const id of orderIds) {
      let res = null;
      try { res = await transaction.collection(ORDERS).doc(id).get(); } catch (_) { res = null; }
      if (!res || !res.data) {
        await transaction.rollback();
        return { success: false, code: 'ORDER_NOT_FOUND', errMsg: `订单不存在: ${id}` };
      }
      orders.push({ _id: id, ...res.data });
    }

    for (const o of orders) {
      if (o.outboundRecordId) {
        await transaction.rollback();
        return { success: false, code: 'ALREADY_GENERATED', errMsg: `订单已生成过出库单: ${o._id}` };
      }
      if (o.needsOutbound === false) {
        await transaction.rollback();
        return { success: false, code: 'NOT_NEED_OUTBOUND', errMsg: `订单标记为无需出库: ${o._id}` };
      }
      if (!isPendingShipment(o.status)) {
        await transaction.rollback();
        return { success: false, code: 'INVALID_STATUS', errMsg: `仅待发货订单可生成出库单: ${o._id}` };
      }
    }

    // 2. 同一客户校验
    const customerName = String(orders[0].customerName || '').trim();
    if (!orders.every(o => String(o.customerName || '').trim() === customerName)) {
      await transaction.rollback();
      return { success: false, code: 'MIXED_CUSTOMER', errMsg: '合并的订单必须属于同一客户' };
    }

    // 3. 聚合货品并建出库单
    const phoneModels = aggregatePhoneModels(orders);
    const first = orders[0];
    const now = db.serverDate();
    const addRes = await transaction.collection(OUTBOUND).add({
      data: {
        customerName,
        outboundStatus: 'pending',
        source: 'order',
        orderIds,
        shippingMethod,
        remark,
        salesperson: first.salesperson || '',
        consignee: first.consignee || '',
        consigneePhone: first.consigneePhone || '',
        consigneeAddress: first.consigneeAddress || '',
        phoneModels,
        outboundDate: todayInBeijing(),
        trackingNumber: '',
        phonePhotos: [],
        createTime: now,
      },
    });
    const outboundId = addRes._id;

    // 4. 回写订单 outboundRecordId
    for (const id of orderIds) {
      await transaction.collection(ORDERS).doc(id).update({ data: { outboundRecordId: outboundId } });
    }

    await transaction.commit();
    return { success: true, outboundId, orderIds };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    console.error('[generateOutboundFromOrders] 失败:', err);
    return { success: false, code: 'INTERNAL_ERROR', errMsg: err.message || '生成出库单失败' };
  }
};
