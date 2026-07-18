/**
 * managePurchases - 采购订单及付款确认管理
 *
 * action: list | create | returnToSupplier | delete | confirmPayment
 */

const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const PURCHASE_COLLECTION = 'purchase_orders';
const COUNTER_COLLECTION = 'system_counters';
const CONFIG_COLLECTION = 'system_config';
const CONFIG_ID = 'permission_system';
const ROLE_COLLECTION = 'roles';
const USER_ROLE_COLLECTION = 'user_roles';
const MAX_RETRY = 3;

const PERMISSIONS = {
  list: ['purchases:read', 'purchases:create', 'purchases:update', 'purchases:delete', 'purchases:payment_confirm', 'orders:read', 'orders:create'],
  create: ['purchases:create', 'orders:create'],
  returnToSupplier: ['purchases:update'],
  delete: ['purchases:delete', 'orders:delete'],
  confirmPayment: ['purchases:payment_confirm'],
};

function now() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value || '').trim();
}

function getPayload(event) {
  return event && event.data || event || {};
}

function notFound(err) {
  const message = String(err && err.message || '');
  return err && (
    err.errCode === -1
    || err.errCode === -502005
    || message.includes('not exist')
    || message.includes('does not exist')
  );
}

function hasPermission(actions, permission) {
  const list = actions || [];
  return list.includes('*') || list.includes(permission);
}

function hasAnyPermission(actions, permissions) {
  return permissions.some(permission => hasPermission(actions, permission));
}

async function ensureCollection(collectionName) {
  try {
    await db.collection(collectionName).limit(1).get();
  } catch (err) {
    if (!notFound(err)) throw err;
    if (typeof db.createCollection !== 'function') throw new Error(`数据库集合不存在: ${collectionName}`);
    try {
      await db.createCollection(collectionName);
    } catch (createErr) {
      const message = String(createErr && createErr.message || '');
      if (!message.includes('already exists') && !message.includes('exists')) throw createErr;
    }
  }
}

async function getDocById(collectionName, id) {
  try {
    const result = await db.collection(collectionName).where({ _id: id }).limit(1).get();
    return result.data && result.data[0] || null;
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

async function fetchAll(collectionName, where = {}) {
  try {
    const collection = Object.keys(where).length > 0
      ? db.collection(collectionName).where(where)
      : db.collection(collectionName);
    const records = [];
    let skip = 0;
    const pageSize = 100;
    while (true) {
      const result = await collection.skip(skip).limit(pageSize).get();
      const data = result.data || [];
      records.push(...data);
      if (data.length < pageSize) break;
      skip += pageSize;
    }
    return records;
  } catch (err) {
    if (notFound(err)) return [];
    throw err;
  }
}

async function requirePermission(permissions) {
  const currentUser = await getCurrentUser();
  if (!currentUser) return { allowed: false, code: 'LOGIN_REQUIRED', errMsg: '请先登录' };

  const config = await getDocById(CONFIG_COLLECTION, CONFIG_ID);
  if (!config || !config.initialized) return { allowed: false, code: 'PERMISSION_UNINITIALIZED', errMsg: '权限系统未初始化' };

  const userRoles = await fetchAll(USER_ROLE_COLLECTION, { userId: currentUser.id });
  const userRole = userRoles[0];
  if (!userRole) return { allowed: false, code: 'ROLE_UNASSIGNED', errMsg: '当前用户未分配角色' };

  const role = await getDocById(ROLE_COLLECTION, userRole.roleId);
  if (!role) return { allowed: false, code: 'ROLE_NOT_FOUND', errMsg: '用户关联的角色不存在' };
  if (!hasAnyPermission(role.actionPermissions, permissions)) {
    return { allowed: false, code: 'ACCESS_DENIED', errMsg: '无权执行采购操作' };
  }

  return {
    allowed: true,
    currentUser: {
      ...currentUser,
      displayName: clean(userRole.nickName || userRole.username) || currentUser.id,
    },
  };
}

async function nextPurchaseNumber() {
  const year = new Date().getFullYear();
  const counterName = `purchaseOrderSerialNumber-${year}`;

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    const transaction = await db.startTransaction();
    try {
      let currentValue = 0;
      let exists = true;
      try {
        const result = await transaction.collection(COUNTER_COLLECTION).doc(counterName).get();
        currentValue = Number(result.data && result.data.value || 0);
      } catch (err) {
        if (!notFound(err)) throw err;
        exists = false;
      }

      const value = currentValue + 1;
      const data = { value, updatedAt: db.serverDate() };
      if (exists) {
        await transaction.collection(COUNTER_COLLECTION).doc(counterName).update({ data });
      } else {
        await transaction.collection(COUNTER_COLLECTION).add({ data: { _id: counterName, ...data } });
      }
      await transaction.commit();
      return `CG${year}${String(value).padStart(4, '0')}`;
    } catch (err) {
      try { await transaction.rollback(); } catch (_) {}
      const retryable = notFound(err)
        || String(err && err.message || '').includes('conflict')
        || String(err && err.message || '').includes('transaction');
      if (retryable && attempt < MAX_RETRY) continue;
      throw err;
    }
  }
  throw new Error('生成采购单号失败');
}

function normalizeVouchers(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => ({
    fileID: clean(item && item.fileID),
    fileName: clean(item && item.fileName),
  })).filter(item => item.fileID && item.fileName);
}

function normalizePaymentSplits(payload) {
  const raw = Array.isArray(payload.paymentSplits) && payload.paymentSplits.length > 0
    ? payload.paymentSplits
    : [{ account: payload.paymentAccount, amount: payload.paymentAmount }];
  return raw.map(item => ({
    account: clean(item && item.account),
    amount: Math.round(Number(item && item.amount || 0) * 100) / 100,
  })).filter(item => item.account || item.amount > 0);
}

function buildOperation(action, content, currentUser, operatorName, timestamp = now()) {
  return {
    action,
    content,
    operatedAt: timestamp,
    operatorId: currentUser.id,
    operatorName: clean(currentUser.displayName) || clean(operatorName) || currentUser.id,
  };
}

function normalizePurchaseInput(purchase) {
  return {
    date: clean(purchase.date),
    supplier: clean(purchase.supplier),
    supplierId: clean(purchase.supplierId),
    owner: clean(purchase.owner),
    brand: clean(purchase.brand),
    model: clean(purchase.model),
    specification: clean(purchase.specification),
    quantity: Number(purchase.quantity || 0),
    unitPrice: Number(purchase.unitPrice || 0),
  };
}

function validatePurchase(data) {
  if (!data.date || !data.supplier || !data.owner || !data.brand || !data.model || !data.specification) return '采购单信息不完整';
  if (!(data.quantity > 0) || !(data.unitPrice > 0)) return '数量和采购单价必须大于 0';
  return '';
}

function normalizeOperations(record) {
  if (Array.isArray(record.operations) && record.operations.length > 0) return record.operations;
  const operations = [];
  if (record.createdAt) {
    operations.push({
      action: 'created',
      content: '生成采购单',
      operatedAt: record.createdAt,
      operatorId: record.createdBy || '',
      operatorName: record.owner || record.createdBy || '-',
    });
  }
  if (record.paymentStatus === 'paid' && record.payment && record.payment.confirmedAt) {
    operations.push({
      action: 'payment_confirmed',
      content: `确认付款（¥${Number(record.payment.amount || 0).toFixed(2)}）`,
      operatedAt: record.payment.confirmedAt,
      operatorId: record.payment.confirmedBy || '',
      operatorName: record.payment.confirmedByName || record.payment.confirmedBy || '-',
    });
  }
  return operations;
}

function withFinancials(record) {
  const quantity = Number(record.quantity || 0);
  const unitPrice = Number(record.unitPrice || 0);
  const adjustmentQuantity = Array.isArray(record.adjustments)
    ? record.adjustments.reduce((sum, item) => sum + Number(item && item.quantity || 0), 0)
    : 0;
  const returnedQuantity = Math.max(0, Math.min(quantity, Number(record.returnedQuantity ?? adjustmentQuantity) || 0));
  const payableQuantity = Math.max(0, quantity - returnedQuantity);
  const originalAmount = Math.round(quantity * unitPrice * 100) / 100;
  const returnDeduction = Math.round(returnedQuantity * unitPrice * 100) / 100;
  const payableAmount = Math.round(payableQuantity * unitPrice * 100) / 100;
  return {
    ...record,
    totalAmount: originalAmount,
    returnedQuantity,
    payableQuantity,
    returnDeduction,
    payableAmount,
    adjustments: Array.isArray(record.adjustments) ? record.adjustments : [],
    paymentStatus: payableQuantity === 0 && record.paymentStatus !== 'paid' ? 'no_payment' : (record.paymentStatus || 'pending'),
  };
}

async function listPurchases() {
  await ensureCollection(PURCHASE_COLLECTION);
  const records = await fetchAll(PURCHASE_COLLECTION);
  records.sort((a, b) => (
    String(b.date || '').localeCompare(String(a.date || ''))
    || String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  ));
  return {
    success: true,
    data: records.map(record => withFinancials({ ...record, operations: normalizeOperations(record) })),
  };
}

async function createPurchase(payload, currentUser) {
  await Promise.all([ensureCollection(PURCHASE_COLLECTION), ensureCollection(COUNTER_COLLECTION)]);
  const purchase = payload.purchase || payload;
  const normalized = normalizePurchaseInput(purchase);
  const validationError = validatePurchase(normalized);
  if (validationError) return { success: false, errMsg: validationError };

  const purchaseNumber = await nextPurchaseNumber();
  const timestamp = now();
  const data = {
    purchaseNumber,
    ...normalized,
    totalAmount: Math.round(normalized.quantity * normalized.unitPrice * 100) / 100,
    returnedQuantity: 0,
    payableQuantity: normalized.quantity,
    returnDeduction: 0,
    payableAmount: Math.round(normalized.quantity * normalized.unitPrice * 100) / 100,
    adjustments: [],
    paymentStatus: 'pending',
    payment: null,
    createdAt: timestamp,
    createdBy: currentUser.id,
    updatedAt: timestamp,
    updatedBy: currentUser.id,
    operations: [buildOperation('created', '生成采购单', currentUser, purchase.operatorName, timestamp)],
  };
  const result = await db.collection(PURCHASE_COLLECTION).add({ data });
  return { success: true, data: { _id: result._id, ...data } };
}

async function returnToSupplier(payload, currentUser) {
  const purchaseId = clean(payload.purchaseId || payload._id);
  if (!purchaseId) return { success: false, errMsg: '缺少采购单ID' };
  const existing = await getDocById(PURCHASE_COLLECTION, purchaseId);
  if (!existing) return { success: false, errMsg: '采购单不存在' };
  if (existing.paymentStatus === 'paid' || existing.paymentStatus === 'no_payment') {
    return { success: false, errMsg: '该采购单已完成结算，不能再登记退货' };
  }

  const financials = withFinancials(existing);
  const quantity = Number(payload.quantity || 0);
  const reason = clean(payload.reason);
  if (!Number.isInteger(quantity) || quantity <= 0) return { success: false, errMsg: '退回数量必须为正整数' };
  if (quantity > financials.payableQuantity) return { success: false, errMsg: `最多可退回 ${financials.payableQuantity} 台` };
  if (!reason) return { success: false, errMsg: '请选择退货原因' };

  const timestamp = now();
  const adjustment = {
    id: `return-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'supplier_return',
    quantity,
    reason,
    remark: clean(payload.remark),
    operatedAt: timestamp,
    operatorId: currentUser.id,
    operatorName: clean(currentUser.displayName) || currentUser.id,
  };
  const returnedQuantity = financials.returnedQuantity + quantity;
  const payableQuantity = Math.max(0, Number(existing.quantity || 0) - returnedQuantity);
  const returnDeduction = Math.round(returnedQuantity * Number(existing.unitPrice || 0) * 100) / 100;
  const payableAmount = Math.round(payableQuantity * Number(existing.unitPrice || 0) * 100) / 100;
  const operation = buildOperation(
    'supplier_return',
    `退回供应商 ${quantity} 台（${reason}）`,
    currentUser,
    payload.operatorName,
    timestamp,
  );
  const data = {
    returnedQuantity,
    payableQuantity,
    returnDeduction,
    payableAmount,
    paymentStatus: payableQuantity === 0 ? 'no_payment' : 'pending',
    adjustments: [...financials.adjustments, adjustment],
    updatedAt: timestamp,
    updatedBy: currentUser.id,
    operations: [...normalizeOperations(existing), operation],
  };
  await db.collection(PURCHASE_COLLECTION).doc(purchaseId).update({ data });
  return { success: true, data: withFinancials({ ...existing, ...data }) };
}

async function deletePurchase(payload) {
  const purchaseId = clean(payload.purchaseId || payload._id);
  if (!purchaseId) return { success: false, errMsg: '缺少采购单ID' };
  const existing = await getDocById(PURCHASE_COLLECTION, purchaseId);
  if (!existing) return { success: true, removed: 0 };
  if (existing.paymentStatus === 'paid' || existing.paymentStatus === 'no_payment') return { success: false, errMsg: '已完成结算的采购单不能删除' };
  const result = await db.collection(PURCHASE_COLLECTION).doc(purchaseId).remove();
  return { success: true, removed: result.stats && result.stats.removed || 0 };
}

async function confirmPayment(payload, currentUser) {
  const purchaseId = clean(payload.purchaseId || payload._id);
  if (!purchaseId) return { success: false, errMsg: '缺少采购单ID' };
  const existing = await getDocById(PURCHASE_COLLECTION, purchaseId);
  if (!existing) return { success: false, errMsg: '采购单不存在' };
  if (existing.paymentStatus === 'paid') return { success: false, errMsg: '该采购单已确认付款' };
  const financials = withFinancials(existing);
  if (financials.payableQuantity <= 0) return { success: false, errMsg: '该采购单已全部退回，无需付款' };

  const paymentDate = clean(payload.paymentDate);
  const paymentSplits = normalizePaymentSplits(payload);
  const paymentAmount = Math.round(paymentSplits.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
  const paymentAccount = paymentSplits.map(item => item.account).join('、');
  const vouchers = normalizeVouchers(payload.vouchers);
  if (!paymentDate) return { success: false, errMsg: '请选择付款日期' };
  if (paymentSplits.length === 0 || paymentSplits.some(item => !item.account || !(item.amount > 0))) {
    return { success: false, errMsg: '付款账户和付款金额不完整' };
  }
  if (new Set(paymentSplits.map(item => item.account)).size !== paymentSplits.length) {
    return { success: false, errMsg: '同一个付款账户不能重复选择' };
  }
  if (!(paymentAmount > 0)) return { success: false, errMsg: '付款金额必须大于 0' };
  if (Math.abs(paymentAmount - financials.payableAmount) > 0.001) {
    return { success: false, errMsg: `付款金额应为 ¥${financials.payableAmount.toFixed(2)}` };
  }
  if (vouchers.length === 0) return { success: false, errMsg: '请上传至少一份付款凭证' };

  const timestamp = now();
  const payment = {
    amount: paymentAmount,
    date: paymentDate,
    account: paymentAccount,
    splits: paymentSplits,
    remark: clean(payload.remark),
    vouchers,
    confirmedBy: currentUser.id,
    confirmedByName: clean(currentUser.displayName) || clean(payload.confirmedByName) || currentUser.id,
    confirmedAt: timestamp,
  };
  const operation = buildOperation(
    'payment_confirmed',
    `确认付款（¥${paymentAmount.toFixed(2)}，${paymentAccount}）`,
    currentUser,
    payload.confirmedByName,
    timestamp,
  );
  const operations = [...normalizeOperations(existing), operation];
  const { _id: existingId, ...existingData } = existing;
  const updatedData = {
    ...existingData,
    paymentStatus: 'paid',
    payment,
    updatedAt: timestamp,
    updatedBy: currentUser.id,
    operations,
  };
  // payment 初始值为 null，update 会尝试写 payment.account 等子字段并失败；set 整体替换文档可安全写入对象。
  await db.collection(PURCHASE_COLLECTION).doc(purchaseId).set({ data: updatedData });
  return {
    success: true,
    data: withFinancials({ _id: existingId || purchaseId, ...updatedData }),
  };
}

exports.main = async (event) => {
  const payload = getPayload(event);
  const action = payload.action || 'list';
  try {
    const permissions = PERMISSIONS[action];
    if (!permissions) return { success: false, errMsg: '不支持的操作类型' };
    const auth = await requirePermission(permissions);
    if (!auth.allowed) return { success: false, code: auth.code, errMsg: auth.errMsg };

    if (action === 'list') return listPurchases();
    if (action === 'create') return createPurchase(payload, auth.currentUser);
    if (action === 'returnToSupplier') return returnToSupplier(payload, auth.currentUser);
    if (action === 'delete') return deletePurchase(payload);
    if (action === 'confirmPayment') return confirmPayment(payload, auth.currentUser);
    return { success: false, errMsg: '不支持的操作类型' };
  } catch (error) {
    console.error('采购订单操作失败:', error);
    return { success: false, code: 'PURCHASE_MANAGE_FAILED', errMsg: error.message || '采购订单操作失败' };
  }
};
