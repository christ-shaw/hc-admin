/**
 * manageAfterSaleOrders - 租赁2订单售后管理
 *
 * action=create: 从已发货租赁2原订单创建独立售后订单
 * action=listBySource: 查询原订单及其售后订单
 * action=getRelation: 查询售后订单关联的原订单
 */

const crypto = require('crypto');
const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const ORDERS = 'orders';
const ROLES = 'roles';
const USER_ROLES = 'user_roles';
const COUNTERS = 'system_counters';
const ORDER_COUNTER = 'orderSerialNumber';
const CREATE_PERMISSION = 'orders:create';
const READ_PERMISSION = 'orders:read';
const SHIPPING_METHODS = new Set(['prepaid', 'cod', 'pickup']);
const PHONE_PATTERN = /^\d{6,20}$/;
const MAX_RETRY = 3;

function trim(value) {
  return String(value || '').trim();
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean).map(String)));
}

function hasPermission(actions, permission) {
  const list = unique(actions);
  return list.includes('*') || list.includes(permission);
}

function getUserIds(currentUser) {
  if (!currentUser || typeof currentUser !== 'object') return [];
  return unique([
    currentUser.id,
    currentUser.uid,
    currentUser.userId,
    currentUser.customUserId,
    currentUser.openid,
    currentUser.openId,
  ]).map(value => value.trim()).filter(value => value && value !== 'anon');
}

async function findOne(collectionName, condition) {
  const result = await db.collection(collectionName).where(condition).limit(1).get();
  return (result.data || [])[0] || null;
}

async function findRole(roleId) {
  if (!roleId) return null;
  try {
    const result = await db.collection(ROLES).doc(roleId).get();
    return result.data || null;
  } catch (error) {
    return null;
  }
}

async function requirePermission(permission) {
  const currentUser = await getCurrentUser();
  const userIds = getUserIds(currentUser);
  if (userIds.length === 0) {
    return { allowed: false, code: 'LOGIN_REQUIRED', errMsg: '请先登录' };
  }

  let userRole = null;
  for (const userId of userIds) {
    userRole = await findOne(USER_ROLES, { userId });
    if (userRole) break;
  }
  if (!userRole) return { allowed: false, code: 'ROLE_UNASSIGNED', errMsg: '当前用户未分配角色' };

  const role = await findRole(userRole.roleId);
  if (!role) return { allowed: false, code: 'ROLE_NOT_FOUND', errMsg: '用户关联的角色不存在' };
  if (!hasPermission(role.actionPermissions, permission)) {
    return { allowed: false, code: 'PERMISSION_DENIED', errMsg: '当前用户无权执行该操作' };
  }
  return { allowed: true, currentUser };
}

function isNotFound(error) {
  const message = trim(error && error.message);
  return error && (error.errCode === -1 || message.includes('not exist') || message.includes('does not exist'));
}

async function getOrder(orderId) {
  try {
    const result = await db.collection(ORDERS).doc(orderId).get();
    return result.data || null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function isRental2(value) {
  return value === 'rental2' || value === '租赁2';
}

function isShipped(value) {
  return value === 'shipped' || value === '已发货';
}

function validateSourceOrder(order) {
  if (!order) throw new Error('原订单不存在或已删除');
  if (!isRental2(order.orderAttribute)) throw new Error('仅租赁2订单支持生成售后订单');
  if (!isShipped(order.status)) throw new Error('仅已发货订单支持生成售后订单');
  if (trim(order.afterSaleSourceOrderId) || order.importSource === 'manual-after-sale') {
    throw new Error('售后订单不能再次生成售后订单');
  }
}

function normalizeProducts(products) {
  if (!Array.isArray(products) || products.length === 0) throw new Error('请至少添加一条售后货品');
  return products.map((item, index) => {
    const brand = trim(item && item.brand);
    const productName = trim(item && item.productName);
    const specification = trim(item && item.specification);
    const quantity = Number(item && item.quantity);
    if (!brand || !productName || !specification) throw new Error(`货品 ${index + 1} 信息不完整`);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error(`货品 ${index + 1} 数量必须为正整数`);
    return { brand, productName, specification, quantity, unitPrice: 0, amount: 0 };
  });
}

function normalizeCreatePayload(payload) {
  const sourceOrderId = trim(payload.sourceOrderId);
  const requestId = trim(payload.requestId);
  if (!sourceOrderId) throw new Error('缺少原订单 ID');
  if (!requestId || requestId.length > 100) throw new Error('售后请求标识无效');

  const products = normalizeProducts(payload.products);
  const virtualOnly = products.length > 0 && products.every(item => item.brand === '虚拟产品');
  if (typeof payload.needsOutbound !== 'boolean') throw new Error('请选择是否需要出库');
  const needsOutbound = virtualOnly ? false : payload.needsOutbound;
  const consignee = needsOutbound ? trim(payload.consignee) : '';
  const consigneePhone = needsOutbound ? trim(payload.consigneePhone) : '';
  const consigneeAddress = needsOutbound ? trim(payload.consigneeAddress) : '';
  const shippingFee = needsOutbound ? trim(payload.shippingFee) : '';

  if (needsOutbound) {
    if (!consignee) throw new Error('请填写收货人名称');
    if (!PHONE_PATTERN.test(consigneePhone)) throw new Error('收货人电话只能填写 6–20 位数字');
    if (!consigneeAddress) throw new Error('请填写收货人地址');
    if (!SHIPPING_METHODS.has(shippingFee)) throw new Error('请选择有效的快递方式');
  }

  return {
    sourceOrderId,
    requestId,
    products,
    needsOutbound,
    consignee,
    consigneePhone,
    consigneeAddress,
    shippingFee,
    customerRemark: trim(payload.customerRemark),
  };
}

function todayInBeijing() {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function getRequestOrderId(requestId) {
  const digest = crypto.createHash('sha256').update(requestId).digest('hex').slice(0, 24);
  return `as_${digest}`;
}

function getTimestamp(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (value.$date) return new Date(value.$date).getTime();
  return new Date(value).getTime() || 0;
}

async function findExistingRequest(orderId, sourceOrderId, requestId) {
  const existing = await getOrder(orderId);
  if (!existing) return null;
  if (existing.afterSaleSourceOrderId !== sourceOrderId || existing.afterSaleRequestId !== requestId) {
    throw new Error('售后请求标识冲突，请关闭窗口后重试');
  }
  return existing;
}

async function createAfterSale(payload, currentUser) {
  const input = normalizeCreatePayload(payload);
  const orderId = getRequestOrderId(input.requestId);
  const existing = await findExistingRequest(orderId, input.sourceOrderId, input.requestId);
  if (existing) {
    return { success: true, duplicated: true, orderId, order: { _id: orderId, ...existing }, errMsg: '售后订单已存在' };
  }

  for (let attempt = 1; attempt <= MAX_RETRY; attempt += 1) {
    const transaction = await db.startTransaction();
    try {
      const sourceResult = await transaction.collection(ORDERS).doc(input.sourceOrderId).get();
      const source = sourceResult.data || null;
      validateSourceOrder(source);

      let counterValue = 0;
      let counterExists = true;
      try {
        const counterResult = await transaction.collection(COUNTERS).doc(ORDER_COUNTER).get();
        counterValue = Number(counterResult.data && counterResult.data.value) || 0;
      } catch (error) {
        if (!isNotFound(error)) throw error;
        counterExists = false;
      }
      const serialNumber = counterValue + 1;
      const now = db.serverDate();
      if (counterExists) {
        await transaction.collection(COUNTERS).doc(ORDER_COUNTER).update({
          data: { value: serialNumber, updatedAt: now },
        });
      } else {
        await transaction.collection(COUNTERS).add({
          data: { _id: ORDER_COUNTER, value: serialNumber, updatedAt: now },
        });
      }

      const order = {
        _id: orderId,
        serialNumber,
        date: todayInBeijing(),
        orderSource: 'service',
        orderAttribute: 'rental2',
        orderType: 'postRentalShip',
        salesChannel: trim(source.salesChannel),
        salesperson: trim(source.salesperson),
        channelCategory: trim(source.channelCategory),
        onlineOrderNumber: trim(source.onlineOrderNumber),
        customerName: trim(source.customerName),
        products: input.products,
        paymentAccount: '',
        paymentSplits: [],
        trackingNumber: '',
        consignee: input.consignee,
        consigneePhone: input.consigneePhone,
        consigneeAddress: input.consigneeAddress,
        shippingFee: input.shippingFee,
        status: input.needsOutbound ? 'unshipped' : 'noShip',
        customerRemark: input.customerRemark,
        transferBrand: '',
        transferProductName: '',
        transferSpecification: '',
        paidPeriod: 0,
        paidRent: 0,
        transferItems: '',
        attachments: [],
        returnStatus: 'notReturned',
        returnTrackingNumbers: '',
        needsOutbound: input.needsOutbound,
        outboundRecordId: '',
        importSource: 'manual-after-sale',
        afterSaleSourceOrderId: input.sourceOrderId,
        afterSaleSourceSerialNumber: Number(source.serialNumber) || 0,
        afterSaleRequestId: input.requestId,
        afterSaleCreatedBy: currentUser && currentUser.id || '',
        createTime: now,
      };

      await transaction.collection(ORDERS).add({ data: order });
      await transaction.commit();
      return { success: true, duplicated: false, orderId, order, errMsg: '售后订单创建成功' };
    } catch (error) {
      try { await transaction.rollback(); } catch (_) { /* ignore */ }

      const concurrentExisting = await findExistingRequest(orderId, input.sourceOrderId, input.requestId).catch(() => null);
      if (concurrentExisting) {
        return { success: true, duplicated: true, orderId, order: { _id: orderId, ...concurrentExisting }, errMsg: '售后订单已存在' };
      }
      const retryable = trim(error && error.message).toLowerCase().includes('transaction')
        || trim(error && error.message).toLowerCase().includes('conflict');
      if (retryable && attempt < MAX_RETRY) continue;
      throw error;
    }
  }
  throw new Error('售后订单创建失败，请稍后重试');
}

async function listBySource(sourceOrderId) {
  const id = trim(sourceOrderId);
  if (!id) throw new Error('缺少原订单 ID');
  const source = await getOrder(id);
  const orders = [];
  const pageSize = 100;
  let offset = 0;
  while (offset < 10000) {
    const result = await db.collection(ORDERS)
      .where({ afterSaleSourceOrderId: id })
      .skip(offset)
      .limit(pageSize)
      .get();
    const page = result.data || [];
    orders.push(...page);
    if (page.length < pageSize) break;
    offset += page.length;
  }
  orders.sort((a, b) => getTimestamp(b.createTime) - getTimestamp(a.createTime));
  return { success: true, source: source ? { _id: id, ...source } : null, orders, errMsg: '查询成功' };
}

async function getRelation(orderId) {
  const id = trim(orderId);
  if (!id) throw new Error('缺少售后订单 ID');
  const order = await getOrder(id);
  if (!order) throw new Error('售后订单不存在或已删除');
  const sourceOrderId = trim(order.afterSaleSourceOrderId);
  if (!sourceOrderId) throw new Error('该订单不是关联售后订单');
  const source = await getOrder(sourceOrderId);
  return {
    success: true,
    order: { _id: id, ...order },
    source: source ? { _id: sourceOrderId, ...source } : null,
    sourceSnapshot: { _id: sourceOrderId, serialNumber: Number(order.afterSaleSourceSerialNumber) || 0 },
    errMsg: '查询成功',
  };
}

exports.main = async (event) => {
  const data = event.data || {};
  const action = trim(data.action);
  const requiredPermission = action === 'create' ? CREATE_PERMISSION : READ_PERMISSION;

  try {
    if (!['create', 'listBySource', 'getRelation'].includes(action)) {
      return { success: false, code: 'INVALID_ACTION', errMsg: '不支持的售后订单操作' };
    }
    const auth = await requirePermission(requiredPermission);
    if (!auth.allowed) return { success: false, code: auth.code, errMsg: auth.errMsg };

    if (action === 'create') return await createAfterSale(data, auth.currentUser);
    if (action === 'listBySource') return await listBySource(data.sourceOrderId);
    return await getRelation(data.orderId);
  } catch (error) {
    console.error('[manageAfterSaleOrders]', action, error);
    return { success: false, code: 'OPERATION_FAILED', errMsg: error.message || '售后订单操作失败' };
  }
};
