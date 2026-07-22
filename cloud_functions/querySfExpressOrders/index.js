/**
 * querySfExpressOrders - 顺丰快递工作台订单查询
 *
 * view:
 * - pending: 待顺丰发货订单（资料不完整的订单仍返回，由前端提示补全）
 * - history: 已调用过顺丰接口的订单
 *
 * 数据库集合: orders / outbound_records
 */

const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const ORDERS_COLLECTION = 'orders';
const OUTBOUND_COLLECTION = 'outbound_records';
const ROLE_COLLECTION = 'roles';
const USER_ROLE_COLLECTION = 'user_roles';
const RAW_PAGE_SIZE = 100;
const MAX_SCAN = 10000;
const PENDING_STATUSES = new Set(['unknown', '--', 'unshipped']);

function trimString(value) {
  return String(value || '').trim();
}

async function requireOrderReadPermission() {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return { allowed: false, code: 'LOGIN_REQUIRED', errMsg: '请先登录' };
  }

  const userRoleResult = await db.collection(USER_ROLE_COLLECTION)
    .where({ userId: currentUser.id })
    .limit(1)
    .get();
  const userRole = userRoleResult.data && userRoleResult.data[0];
  if (!userRole) {
    return { allowed: false, code: 'ROLE_UNASSIGNED', errMsg: '当前用户未分配角色' };
  }

  let role = null;
  try {
    const roleResult = await db.collection(ROLE_COLLECTION).doc(userRole.roleId).get();
    role = roleResult.data || null;
  } catch (error) {
    role = null;
  }
  if (!role) {
    return { allowed: false, code: 'ROLE_NOT_FOUND', errMsg: '用户关联的角色不存在' };
  }

  const actions = Array.isArray(role.actionPermissions) ? role.actionPermissions : [];
  const pages = Array.isArray(role.pagePermissions) ? role.pagePermissions : [];
  const allowed = actions.includes('*') || actions.includes('orders:read') || pages.includes('/orders');
  return allowed
    ? { allowed: true }
    : { allowed: false, code: 'ACCESS_DENIED', errMsg: '无权访问顺丰订单' };
}

function escapeRegExp(value) {
  return trimString(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeShippingFee(value) {
  const normalized = trimString(value);
  if (['prepaid', '包邮', '寄付月结'].includes(normalized)) return 'prepaid';
  if (['cod', '到付', '收方付'].includes(normalized)) return 'cod';
  if (['pickup', '自提'].includes(normalized)) return 'pickup';
  return normalized;
}

function isPendingOrder(order) {
  const shippingFee = normalizeShippingFee(order.shippingFee);
  return PENDING_STATUSES.has(trimString(order.status))
    && order.needsOutbound !== false
    && !trimString(order.trackingNumber)
    && !trimString(order.sfWaybillNo)
    && shippingFee !== 'pickup';
}

function isSfHistoryOrder(order) {
  return trimString(order.expressProvider).toLowerCase() === 'sf'
    || !!trimString(order.expressApplyStatus)
    || !!trimString(order.sfOrderId)
    || !!trimString(order.sfWaybillNo)
    || !!trimString(order.sfRequestId)
    || !!trimString(order.sfCancelRequestId);
}

function matchesShippingFee(order, filter) {
  if (!filter) return true;
  return normalizeShippingFee(order.shippingFee) === normalizeShippingFee(filter);
}

async function getOutboundShippingMap(orders) {
  const ids = Array.from(new Set(
    orders
      .filter(order => !trimString(order.shippingFee) && trimString(order.outboundRecordId))
      .map(order => trimString(order.outboundRecordId))
  ));
  const result = new Map();

  for (let index = 0; index < ids.length; index += 20) {
    const chunk = ids.slice(index, index + 20);
    const records = await db.collection(OUTBOUND_COLLECTION)
      .where({ _id: _.in(chunk) })
      .limit(chunk.length)
      .get();
    for (const record of records.data || []) {
      const shippingMethod = trimString(record.shippingMethod);
      if (shippingMethod) result.set(trimString(record._id), shippingMethod);
    }
  }

  return result;
}

async function enrichShippingFees(orders) {
  const outboundShippingMap = await getOutboundShippingMap(orders);
  return orders.map(order => ({
    ...order,
    shippingFee: trimString(order.shippingFee)
      || outboundShippingMap.get(trimString(order.outboundRecordId))
      || '',
  }));
}

exports.main = async (event) => {
  const data = event.data || {};
  const {
    view = 'pending',
    limit = 20,
    cursor,
    serialNumber,
    onlineOrderNumber,
    consignee,
    salesperson,
    startDate,
    endDate,
    shippingFee,
    expressApplyStatus,
  } = data;

  if (!['pending', 'history'].includes(view)) {
    return { success: false, data: [], cursor: null, hasMore: false, errMsg: '不支持的顺丰订单视图' };
  }

  const pageLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  let rawOffset = Math.max(0, parseInt(cursor, 10) || 0);

  try {
    const auth = await requireOrderReadPermission();
    if (!auth.allowed) {
      return { success: false, code: auth.code, data: [], cursor: null, hasMore: false, errMsg: auth.errMsg };
    }

    const conditions = {};

    if (serialNumber !== undefined && serialNumber !== null && trimString(serialNumber) !== '') {
      const parsedSerialNumber = Number(trimString(serialNumber));
      if (!Number.isSafeInteger(parsedSerialNumber) || parsedSerialNumber < 0) {
        throw new Error('序号必须为非负整数');
      }
      conditions.serialNumber = parsedSerialNumber;
    }

    if (onlineOrderNumber) {
      conditions.onlineOrderNumber = db.RegExp({ regexp: escapeRegExp(onlineOrderNumber), options: 'i' });
    }
    if (consignee) {
      conditions.consignee = db.RegExp({ regexp: escapeRegExp(consignee), options: 'i' });
    }
    if (salesperson) conditions.salesperson = salesperson;
    if (expressApplyStatus && view === 'history') conditions.expressApplyStatus = expressApplyStatus;
    if (startDate || endDate) {
      conditions.date = _.and(
        startDate ? _.gte(startDate) : _.gt(''),
        endDate ? _.lte(endDate) : _.lt('9999-12-31')
      );
    }

    const query = db.collection(ORDERS_COLLECTION).where(conditions);
    const records = [];
    let nextCursor = null;
    let hasMore = false;
    let scanned = 0;
    let exhausted = false;

    while (!exhausted && records.length <= pageLimit && scanned < MAX_SCAN) {
      const page = await query
        .orderBy('date', 'desc')
        .orderBy('serialNumber', 'desc')
        .skip(rawOffset)
        .limit(RAW_PAGE_SIZE)
        .get();
      const rawRecords = page.data || [];
      if (rawRecords.length === 0) break;

      const enrichedRecords = await enrichShippingFees(rawRecords);
      for (const order of enrichedRecords) {
        rawOffset += 1;
        scanned += 1;
        const matchesView = view === 'pending' ? isPendingOrder(order) : isSfHistoryOrder(order);
        if (!matchesView || !matchesShippingFee(order, shippingFee)) continue;

        records.push(order);
        if (records.length === pageLimit) nextCursor = String(rawOffset);
        if (records.length > pageLimit) {
          hasMore = true;
          break;
        }
      }

      exhausted = rawRecords.length < RAW_PAGE_SIZE;
    }

    return {
      success: true,
      data: records.slice(0, pageLimit),
      cursor: hasMore ? nextCursor : null,
      hasMore,
      errMsg: '查询成功',
    };
  } catch (error) {
    console.error('查询顺丰快递订单失败:', error);
    return {
      success: false,
      data: [],
      cursor: null,
      hasMore: false,
      errMsg: error.message || '查询顺丰快递订单失败',
    };
  }
};
