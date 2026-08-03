/**
 * manageSfShipment - 管理一个顺丰实际包裹关联的多张订单/出库单。
 *
 * actions:
 * - listReusable: 查询与目标订单完全匹配且已明确开放追加的包裹
 * - enableReuse: 顺丰单申请成功且尚未交接时开放一次追加
 * - disableReuse: 主动关闭追加
 * - attach: 将目标订单及其待出库单关联到已有顺丰包裹
 * - detach: 交接前解除一张尚未完成出库的追加订单
 * - confirmHandover: 全部关联出库单完成后确认已交顺丰并永久锁定
 */

const crypto = require('node:crypto');
const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const ORDERS_COLLECTION = 'orders';
const OUTBOUND_COLLECTION = 'outbound_records';
const SF_ORDERS_COLLECTION = 'sf_express_orders';
const CONFIG_COLLECTION = 'system_config';
const SF_CONFIG_DOC_ID = 'sf_express';
const ROLE_COLLECTION = 'roles';
const USER_ROLE_COLLECTION = 'user_roles';
const MAX_CANDIDATES = 20;
const MAX_REUSE_SCAN = 100;
const MAX_HISTORY = 50;
const PENDING_ORDER_STATUSES = new Set(['', 'unknown', '--', 'unshipped']);
const REUSABLE_SHIPMENT_STATUSES = new Set(['packing', 'sealed']);

function trimString(value) {
  return String(value || '').trim();
}

function uniqueStrings(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : []).map(trimString).filter(Boolean)
  ));
}

function normalizeSfEnv(value = process.env.SF_ENV || 'sandbox') {
  const normalized = trimString(value).toLowerCase();
  if (!normalized || normalized === 'sandbox' || normalized === 'sbox') return 'sandbox';
  if (normalized === 'prod' || normalized === 'production') return 'production';
  throw new Error(`顺丰环境仅支持 sandbox 或 production，当前值: ${value}`);
}

function normalizeShippingFee(value) {
  const normalized = trimString(value);
  if (['prepaid', '包邮', '寄付月结'].includes(normalized)) return 'prepaid';
  if (['cod', '到付', '收方付'].includes(normalized)) return 'cod';
  if (['pickup', '自提'].includes(normalized)) return 'pickup';
  return normalized;
}

function normalizePhone(value) {
  return trimString(value).replace(/[^\d]/g, '');
}

function normalizeAddress(value) {
  return trimString(value).replace(/\s+/g, '').toLowerCase();
}

function normalizeName(value) {
  return trimString(value).replace(/\s+/g, '').toLowerCase();
}

function buildRecipientMatchKey(order) {
  const parts = [
    normalizeName(order && order.consignee),
    normalizePhone(order && order.consigneePhone),
    normalizeAddress(order && order.consigneeAddress),
    normalizeShippingFee(order && order.shippingFee),
    normalizeName(order && order.salesperson),
  ];
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function maskPhone(value) {
  const phone = trimString(value);
  if (phone.length <= 7) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function appendHistory(record, entry) {
  const history = Array.isArray(record && record.shipmentHistory)
    ? record.shipmentHistory.slice(-(MAX_HISTORY - 1))
    : [];
  return [...history, entry];
}

function getOrderProducts(order) {
  if (Array.isArray(order && order.products) && order.products.length > 0) return order.products;
  if (order && (order.productName || order.brand || order.quantity)) {
    return [{
      brand: order.brand || '',
      productName: order.productName || '',
      specification: order.specification || '',
      quantity: Number(order.quantity) || 0,
    }];
  }
  return [];
}

function buildProductLabel(item) {
  const brand = trimString(item && item.brand);
  const productName = trimString(item && item.productName);
  const specification = trimString(item && item.specification);
  const parts = [brand, productName].filter(Boolean);
  if (specification && specification !== '默认') parts.push(specification);
  return parts.join(' / ');
}

function buildOrderProductsRemark(order) {
  const summary = getOrderProducts(order)
    .map(item => {
      const label = buildProductLabel(item);
      if (!label) return '';
      const quantity = Number(item && item.quantity);
      return `${label}×${Number.isFinite(quantity) && quantity > 0 ? quantity : 0}`;
    })
    .filter(Boolean)
    .join('，');
  return summary ? `客户下单：${summary}` : '';
}

function buildPrintProductLabel(item) {
  const productName = trimString(item && item.productName);
  const specification = trimString(item && item.specification);
  const parts = [productName];
  if (specification && specification !== '默认') parts.push(specification);
  return parts.filter(Boolean).join(' / ');
}

function buildPrintProductsRemark(order) {
  return getOrderProducts(order)
    .map(item => {
      const label = buildPrintProductLabel(item);
      if (!label) return '';
      const quantity = Number(item && item.quantity);
      return `${label}×${Number.isFinite(quantity) && quantity > 0 ? quantity : 0}`;
    })
    .filter(Boolean)
    .join('，');
}

function buildPrintOrderLine(productRemark, customerRemark, index = 0) {
  const orderNo = Math.max(1, Number(index) + 1);
  const products = trimString(productRemark) || '无商品明细';
  const remark = trimString(customerRemark);
  return `订单${orderNo}：${products}${remark ? `；备注：${remark}` : ''}`;
}

function mergeRemarkParts(parts) {
  const merged = [];
  for (const value of parts || []) {
    const text = trimString(value);
    if (!text) continue;
    const containedIndex = merged.findIndex(existing => text.includes(existing));
    if (containedIndex >= 0) {
      merged[containedIndex] = text;
      continue;
    }
    if (merged.some(existing => existing.includes(text))) continue;
    merged.push(text);
  }
  return merged.join('；');
}

function buildShipmentRemarkEntry(order, role = 'appended', attachedAt = '') {
  const orderId = trimString(order && order._id);
  const serialNumber = Number(order && order.serialNumber || 0);
  return {
    orderId,
    orderNumber: trimString(order && order.onlineOrderNumber)
      || (serialNumber ? `序号 ${serialNumber}` : orderId),
    role: role === 'primary' ? 'primary' : 'appended',
    productRemark: buildOrderProductsRemark(order),
    printProductRemark: buildPrintProductsRemark(order),
    customerRemark: trimString(order && order.customerRemark),
    attachedAt: trimString(attachedAt),
  };
}

function buildSourceShipmentRemarkEntry(record) {
  const snapshot = record && record.orderSnapshot || {};
  const orderId = trimString(record && record.sourceOrderId);
  const serialNumber = Number(snapshot.serialNumber || record && record.sourceSerialNumber || 0);
  return {
    orderId,
    orderNumber: trimString(snapshot.onlineOrderNumber)
      || trimString(record && record.sourceOnlineOrderNumber)
      || (serialNumber ? `序号 ${serialNumber}` : orderId),
    role: 'primary',
    productRemark: trimString(snapshot.productRemark) || buildOrderProductsRemark({ products: snapshot.products }),
    printProductRemark: trimString(snapshot.printProductRemark) || buildPrintProductsRemark({ products: snapshot.products }),
    customerRemark: trimString(snapshot.rawCustomerRemark) || trimString(snapshot.customerRemark),
    attachedAt: trimString(record && record.createdAt),
  };
}

function normalizeShipmentRemarkEntry(entry, sourceOrderId) {
  const orderId = trimString(entry && entry.orderId);
  if (!orderId) return null;
  return {
    orderId,
    orderNumber: trimString(entry && entry.orderNumber) || orderId,
    role: orderId === sourceOrderId ? 'primary' : 'appended',
    productRemark: trimString(entry && entry.productRemark),
    printProductRemark: trimString(entry && entry.printProductRemark),
    customerRemark: trimString(entry && entry.customerRemark),
    attachedAt: trimString(entry && entry.attachedAt),
  };
}

function buildShipmentRemarkData(record, { appendEntry, ensureEntries, removeOrderId } = {}) {
  const sourceOrderId = trimString(record && record.sourceOrderId);
  const entriesByOrderId = new Map();
  for (const rawEntry of Array.isArray(record && record.shipmentRemarkEntries)
    ? record.shipmentRemarkEntries
    : []) {
    const entry = normalizeShipmentRemarkEntry(rawEntry, sourceOrderId);
    if (entry) entriesByOrderId.set(entry.orderId, entry);
  }
  if (sourceOrderId && !entriesByOrderId.has(sourceOrderId)) {
    entriesByOrderId.set(sourceOrderId, buildSourceShipmentRemarkEntry(record));
  }
  for (const rawEntry of Array.isArray(ensureEntries) ? ensureEntries : []) {
    const entry = normalizeShipmentRemarkEntry(rawEntry, sourceOrderId);
    if (!entry) continue;
    const existing = entriesByOrderId.get(entry.orderId);
    if (!existing) {
      entriesByOrderId.set(entry.orderId, entry);
      continue;
    }
    // 旧条目没有新版精简打印字段时，仅补齐该字段；原始备注快照仍保持不变。
    if (!existing.printProductRemark && entry.printProductRemark) {
      entriesByOrderId.set(entry.orderId, {
        ...existing,
        printProductRemark: entry.printProductRemark,
      });
    }
  }
  const normalizedAppendEntry = normalizeShipmentRemarkEntry(appendEntry, sourceOrderId);
  if (normalizedAppendEntry) entriesByOrderId.set(normalizedAppendEntry.orderId, normalizedAppendEntry);
  const removedOrderId = trimString(removeOrderId);
  if (removedOrderId) entriesByOrderId.delete(removedOrderId);

  const entries = Array.from(entriesByOrderId.values())
    .sort((left, right) => (left.role === 'primary' ? -1 : 0) - (right.role === 'primary' ? -1 : 0));
  const shipmentRemarkFull = entries
    .map(entry => {
      const remark = mergeRemarkParts([entry.productRemark, entry.customerRemark]);
      return `${entry.role === 'primary' ? '主单' : '追加单'} ${entry.orderNumber}：${remark || '无备注'}`;
    })
    .join('\n');
  const shipmentPrintRemark = entries
    .map((entry, index) => buildPrintOrderLine(
      entry.printProductRemark || entry.productRemark,
      entry.customerRemark,
      index,
    ))
    .join('\n')
    .slice(0, 100);
  return { shipmentRemarkEntries: entries, shipmentRemarkFull, shipmentPrintRemark };
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

async function getDoc(store, collectionName, id) {
  if (!trimString(id)) return null;
  try {
    const result = await store.collection(collectionName).doc(trimString(id)).get();
    return result.data || null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function getOrderWithShipping(store, orderId) {
  const order = await getDoc(store, ORDERS_COLLECTION, orderId);
  if (!order) return null;
  if (trimString(order.shippingFee) || !trimString(order.outboundRecordId)) return order;
  const outbound = await getDoc(store, OUTBOUND_COLLECTION, order.outboundRecordId);
  return trimString(outbound && outbound.shippingMethod)
    ? { ...order, shippingFee: outbound.shippingMethod }
    : order;
}

async function resolveSfEnv() {
  const config = await getDoc(db, CONFIG_COLLECTION, SF_CONFIG_DOC_ID);
  return normalizeSfEnv(config && config.env);
}

async function requireShipmentPermission() {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return { allowed: false, code: 'LOGIN_REQUIRED', errMsg: '请先登录' };
  }

  let userRole = null;
  for (const userId of currentUser.ids || [currentUser.id]) {
    const result = await db.collection(USER_ROLE_COLLECTION).where({ userId }).limit(1).get();
    userRole = result.data && result.data[0] || null;
    if (userRole) break;
  }
  if (!userRole) {
    return { allowed: false, code: 'ROLE_UNASSIGNED', errMsg: '当前用户未分配角色' };
  }

  const role = await getDoc(db, ROLE_COLLECTION, userRole.roleId);
  if (!role) {
    return { allowed: false, code: 'ROLE_NOT_FOUND', errMsg: '用户关联的角色不存在' };
  }
  const actions = Array.isArray(role.actionPermissions) ? role.actionPermissions : [];
  const allowed = actions.includes('*')
    || actions.includes('orders:create')
    || actions.includes('orders:update');
  return allowed
    ? { allowed: true, currentUser }
    : { allowed: false, code: 'ACCESS_DENIED', errMsg: '无权复用顺丰运单' };
}

function validateManagedShipment(record, env) {
  if (!record) throw new Error('顺丰包裹不存在');
  if (record.isCurrent !== true || trimString(record.status) !== 'applied') {
    throw new Error('仅申请成功的当前顺丰单可以管理包裹');
  }
  if (normalizeSfEnv(record.env) !== env) throw new Error('顺丰包裹环境与当前系统环境不一致');
  if (!Array.isArray(record.linkedOrderIds) || !trimString(record.shipmentStatus)) {
    throw new Error('历史顺丰单默认锁定，不能追加订单');
  }
  if (!trimString(record.waybillNo)) throw new Error('顺丰包裹缺少运单号');
}

function validateReuseToggle(record, env) {
  validateManagedShipment(record, env);
  if (!REUSABLE_SHIPMENT_STATUSES.has(trimString(record.shipmentStatus))) {
    throw new Error('包裹已经交接或取消，不能修改追加状态');
  }
}

async function resolveLinkedState(store, record) {
  const requestedOrderIds = uniqueStrings([record.sourceOrderId, ...(record.linkedOrderIds || [])]);
  const orders = [];
  for (const orderId of requestedOrderIds) {
    const order = await getDoc(store, ORDERS_COLLECTION, orderId);
    if (order) orders.push(order);
  }
  const orderIds = uniqueStrings(orders.map(order => order._id));
  const outboundIds = uniqueStrings([
    ...(record.linkedOutboundIds || []),
    ...orders.map(order => order.outboundRecordId),
  ]);
  const outbounds = [];
  for (const outboundId of outboundIds) {
    const outbound = await getDoc(store, OUTBOUND_COLLECTION, outboundId);
    if (outbound) outbounds.push(outbound);
  }
  return { orderIds, orders, outboundIds, outbounds };
}

function ensureAllOutboundsCompleted(linkedState) {
  if (linkedState.outboundIds.length === 0) throw new Error('包裹尚未关联出库单');
  if (linkedState.outbounds.length !== linkedState.outboundIds.length) {
    throw new Error('部分关联出库单不存在，请先核对');
  }
  const pending = linkedState.outbounds.filter(outbound => trimString(outbound.outboundStatus) !== 'completed');
  if (pending.length > 0) throw new Error('请先完成全部关联出库单的拍照和出库');
}

function requiresHandoverConfirmation(record) {
  const linkedOrderIds = uniqueStrings([
    record && record.sourceOrderId,
    ...((record && record.linkedOrderIds) || []),
  ]);
  return linkedOrderIds.length > 1
    || !!trimString(record && record.reuseEnabledAt)
    || (Array.isArray(record && record.shipmentHistory)
      && record.shipmentHistory.some(entry => trimString(entry && entry.action) === 'enable_reuse'));
}

function buildMissingRemarkEntries(orders, sourceOrderId, attachedAt) {
  return (Array.isArray(orders) ? orders : [])
    .map(order => buildShipmentRemarkEntry(
      order,
      trimString(order && order._id) === trimString(sourceOrderId) ? 'primary' : 'appended',
      attachedAt,
    ));
}

async function listReusable(sourceOrderId, env) {
  const targetOrder = await getOrderWithShipping(db, sourceOrderId);
  if (!targetOrder) throw new Error('目标订单不存在');
  if (trimString(targetOrder.trackingNumber) || trimString(targetOrder.sfExpressOrderRecordId)) {
    throw new Error('目标订单已经关联物流单号');
  }
  if (!PENDING_ORDER_STATUSES.has(trimString(targetOrder.status))) {
    throw new Error('仅未发货订单可以复用顺丰运单');
  }
  const targetOutbound = await getDoc(db, OUTBOUND_COLLECTION, targetOrder.outboundRecordId);
  if (!targetOutbound || trimString(targetOutbound.outboundStatus) !== 'pending') {
    throw new Error('请先为目标订单生成待出库单');
  }
  if (trimString(targetOutbound.trackingNumber)) throw new Error('目标出库单已经存在物流单号');
  const targetKey = buildRecipientMatchKey(targetOrder);

  const result = await db.collection(SF_ORDERS_COLLECTION)
    .where({ reuseEnabled: true })
    .limit(MAX_REUSE_SCAN)
    .get();
  const candidates = [];
  for (const record of result.data || []) {
    try {
      validateManagedShipment(record, env);
      if (!REUSABLE_SHIPMENT_STATUSES.has(trimString(record.shipmentStatus))) continue;
      const sourceOrder = await getOrderWithShipping(db, record.sourceOrderId);
      if (!sourceOrder || buildRecipientMatchKey(sourceOrder) !== targetKey) continue;
      candidates.push({
        _id: record._id,
        waybillNo: trimString(record.waybillNo),
        sfOrderId: trimString(record.sfOrderId),
        shipmentStatus: trimString(record.shipmentStatus),
        shipmentVersion: Math.max(1, Number(record.shipmentVersion || 1)),
        sourceOrderId: trimString(record.sourceOrderId),
        sourceSerialNumber: Number(sourceOrder.serialNumber || record.sourceSerialNumber || 0),
        sourceOnlineOrderNumber: trimString(sourceOrder.onlineOrderNumber),
        salesperson: trimString(sourceOrder.salesperson),
        consignee: trimString(sourceOrder.consignee),
        consigneePhone: maskPhone(sourceOrder.consigneePhone),
        consigneeAddress: trimString(sourceOrder.consigneeAddress),
        shippingFee: normalizeShippingFee(sourceOrder.shippingFee),
        linkedOrderCount: uniqueStrings([record.sourceOrderId, ...(record.linkedOrderIds || [])]).length,
        linkedOutboundCount: uniqueStrings(record.linkedOutboundIds).length,
        applyTime: trimString(record.applyTime),
        reuseEnabledAt: trimString(record.reuseEnabledAt),
      });
    } catch (_) {
      // 无效、历史或其他环境的记录不作为候选。
    }
  }
  candidates.sort((a, b) => b.reuseEnabledAt.localeCompare(a.reuseEnabledAt));
  return candidates.slice(0, MAX_CANDIDATES);
}

async function setReuseEnabled(sfExpressOrderId, env, actorId, enabled) {
  const transaction = await db.startTransaction();
  try {
    const record = await getDoc(transaction, SF_ORDERS_COLLECTION, sfExpressOrderId);
    validateReuseToggle(record, env);
    const linkedState = await resolveLinkedState(transaction, record);
    const shipmentRemarkData = buildShipmentRemarkData(record, {
      ensureEntries: buildMissingRemarkEntries(linkedState.orders, record.sourceOrderId, record.createdAt),
    });
    const now = new Date().toISOString();
    const nextVersion = Math.max(1, Number(record.shipmentVersion || 1)) + 1;
    await transaction.collection(SF_ORDERS_COLLECTION).doc(record._id).update({
      data: {
        linkedOrderIds: linkedState.orderIds,
        linkedOutboundIds: linkedState.outboundIds,
        ...shipmentRemarkData,
        reuseEnabled: enabled,
        reuseEnabledAt: enabled ? now : trimString(record.reuseEnabledAt),
        reuseDisabledAt: enabled ? '' : now,
        shipmentStatus: 'packing',
        shipmentVersion: nextVersion,
        shipmentHistory: appendHistory(record, {
          action: enabled ? 'enable_reuse' : 'disable_reuse',
          actorId,
          time: now,
        }),
        updatedAt: now,
      },
    });
    await transaction.commit();
    return {
      success: true,
      sfExpressOrderId: record._id,
      waybillNo: trimString(record.waybillNo),
      shipmentStatus: 'packing',
      shipmentVersion: nextVersion,
      reuseEnabled: enabled,
    };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) { /* ignore */ }
    throw error;
  }
}

async function attachOrder(payload, env, actorId) {
  const sourceOrderId = trimString(payload.sourceOrderId);
  const sfExpressOrderId = trimString(payload.sfExpressOrderId);
  const requestId = trimString(payload.requestId);
  const expectedVersion = Number(payload.shipmentVersion);
  if (!sourceOrderId || !sfExpressOrderId || !requestId) throw new Error('缺少关联请求参数');

  const transaction = await db.startTransaction();
  try {
    const record = await getDoc(transaction, SF_ORDERS_COLLECTION, sfExpressOrderId);
    validateManagedShipment(record, env);
    const targetOrder = await getOrderWithShipping(transaction, sourceOrderId);
    if (!targetOrder) throw new Error('目标订单不存在');
    if (trimString(targetOrder.sfExpressOrderRecordId) === record._id
      && trimString(targetOrder.trackingNumber) === trimString(record.waybillNo)) {
      await transaction.rollback();
      return {
        success: true,
        duplicated: true,
        sfExpressOrderId: record._id,
        waybillNo: trimString(record.waybillNo),
      };
    }
    if (!record.reuseEnabled || !REUSABLE_SHIPMENT_STATUSES.has(trimString(record.shipmentStatus))) {
      throw new Error('该包裹尚未开放追加或已经被锁定');
    }
    if (Number.isFinite(expectedVersion) && expectedVersion > 0
      && Number(record.shipmentVersion || 1) !== expectedVersion) {
      throw new Error('包裹状态已经变化，请刷新候选列表后重试');
    }

    if (trimString(targetOrder.trackingNumber) || trimString(targetOrder.sfExpressOrderRecordId)) {
      throw new Error('目标订单已经关联其他物流单号');
    }
    if (!PENDING_ORDER_STATUSES.has(trimString(targetOrder.status)) || targetOrder.needsOutbound === false) {
      throw new Error('仅需要出库的未发货订单可以复用顺丰运单');
    }
    const targetOutboundId = trimString(targetOrder.outboundRecordId);
    const targetOutbound = await getDoc(transaction, OUTBOUND_COLLECTION, targetOutboundId);
    if (!targetOutbound || trimString(targetOutbound.outboundStatus) !== 'pending') {
      throw new Error('目标订单必须先生成待出库单');
    }
    if (trimString(targetOutbound.trackingNumber)) throw new Error('目标出库单已经存在物流单号');

    const primaryOrder = await getOrderWithShipping(transaction, record.sourceOrderId);
    if (!primaryOrder || buildRecipientMatchKey(primaryOrder) !== buildRecipientMatchKey(targetOrder)) {
      throw new Error('收件人、电话、地址、付款方式或人员不一致，不能复用运单');
    }

    const linkedState = await resolveLinkedState(transaction, record);
    if (linkedState.orderIds.includes(sourceOrderId)) throw new Error('目标订单已经在该包裹中');
    const linkedOrderIds = uniqueStrings([...linkedState.orderIds, sourceOrderId]);
    const linkedOutboundIds = uniqueStrings([...linkedState.outboundIds, targetOutboundId]);
    const now = new Date().toISOString();
    const shipmentRemarkData = buildShipmentRemarkData(record, {
      ensureEntries: buildMissingRemarkEntries(linkedState.orders, record.sourceOrderId, record.createdAt),
      appendEntry: buildShipmentRemarkEntry(targetOrder, 'appended', now),
    });
    const nextVersion = Math.max(1, Number(record.shipmentVersion || 1)) + 1;
    await transaction.collection(SF_ORDERS_COLLECTION).doc(record._id).update({
      data: {
        linkedOrderIds,
        linkedOutboundIds,
        ...shipmentRemarkData,
        shipmentStatus: 'packing',
        shipmentVersion: nextVersion,
        reuseEnabled: false,
        reuseDisabledAt: now,
        finalPackagePhotos: [],
        packagePhotoInvalidatedAt: now,
        lastLinkRequestId: requestId,
        shipmentHistory: appendHistory(record, {
          action: 'attach_order',
          orderId: sourceOrderId,
          outboundRecordId: targetOutboundId,
          requestId,
          actorId,
          time: now,
        }),
        updatedAt: now,
      },
    });
    for (const orderId of linkedOrderIds) {
      await transaction.collection(ORDERS_COLLECTION).doc(orderId).update({
        data: {
          ...(orderId === sourceOrderId
            ? {
                trackingNumber: trimString(record.waybillNo),
                expressProvider: 'sf',
                sfExpressOrderRecordId: record._id,
              }
            : {}),
          sharedWaybill: true,
          updateTime: db.serverDate(),
        },
      });
    }
    await transaction.collection(OUTBOUND_COLLECTION).doc(targetOutboundId).update({
      data: {
        trackingNumber: trimString(record.waybillNo),
        sfExpressOrderRecordId: record._id,
      },
    });
    await transaction.commit();
    return {
      success: true,
      sfExpressOrderId: record._id,
      waybillNo: trimString(record.waybillNo),
      shipmentStatus: 'packing',
      shipmentVersion: nextVersion,
      linkedOrderCount: linkedOrderIds.length,
      linkedOutboundCount: linkedOutboundIds.length,
    };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) { /* ignore */ }
    throw error;
  }
}

async function detachOrder(payload, env, actorId) {
  const sourceOrderId = trimString(payload.sourceOrderId);
  const sfExpressOrderId = trimString(payload.sfExpressOrderId);
  const requestId = trimString(payload.requestId);
  if (!sourceOrderId || !sfExpressOrderId || !requestId) throw new Error('缺少解除关联请求参数');

  const transaction = await db.startTransaction();
  try {
    const record = await getDoc(transaction, SF_ORDERS_COLLECTION, sfExpressOrderId);
    validateManagedShipment(record, env);
    if (!REUSABLE_SHIPMENT_STATUSES.has(trimString(record.shipmentStatus))) {
      throw new Error('包裹已经交接或取消，不能解除共享运单');
    }
    if (sourceOrderId === trimString(record.sourceOrderId)) {
      throw new Error('主订单不能从顺丰包裹中解除');
    }
    const targetOrder = await getDoc(transaction, ORDERS_COLLECTION, sourceOrderId);
    if (!targetOrder || trimString(targetOrder.sfExpressOrderRecordId) !== record._id) {
      throw new Error('目标订单未关联该顺丰包裹');
    }
    const targetOutboundId = trimString(targetOrder.outboundRecordId);
    const targetOutbound = await getDoc(transaction, OUTBOUND_COLLECTION, targetOutboundId);
    if (!targetOutbound || trimString(targetOutbound.outboundStatus) !== 'pending') {
      throw new Error('仅尚未完成拍照出库的追加订单可以解除');
    }
    if (trimString(targetOrder.trackingNumber) !== trimString(record.waybillNo)
      || trimString(targetOutbound.trackingNumber) !== trimString(record.waybillNo)) {
      throw new Error('订单或出库单的物流单号与包裹不一致，请先人工核对');
    }

    const linkedState = await resolveLinkedState(transaction, record);
    const linkedOrderIds = linkedState.orderIds.filter(orderId => orderId !== sourceOrderId);
    const linkedOutboundIds = linkedState.outboundIds.filter(outboundId => outboundId !== targetOutboundId);
    const isStillShared = linkedOrderIds.length > 1;
    const now = new Date().toISOString();
    const shipmentRemarkData = buildShipmentRemarkData(record, {
      ensureEntries: buildMissingRemarkEntries(linkedState.orders, record.sourceOrderId, record.createdAt),
      removeOrderId: sourceOrderId,
    });
    const nextVersion = Math.max(1, Number(record.shipmentVersion || 1)) + 1;
    await transaction.collection(SF_ORDERS_COLLECTION).doc(record._id).update({
      data: {
        linkedOrderIds,
        linkedOutboundIds,
        ...shipmentRemarkData,
        shipmentVersion: nextVersion,
        reuseEnabled: false,
        reuseDisabledAt: now,
        shipmentHistory: appendHistory(record, {
          action: 'detach_order',
          orderId: sourceOrderId,
          outboundRecordId: targetOutboundId,
          requestId,
          actorId,
          time: now,
        }),
        updatedAt: now,
      },
    });
    await transaction.collection(ORDERS_COLLECTION).doc(sourceOrderId).update({
      data: {
        trackingNumber: '',
        expressProvider: '',
        sfExpressOrderRecordId: '',
        sharedWaybill: false,
        updateTime: db.serverDate(),
      },
    });
    await transaction.collection(OUTBOUND_COLLECTION).doc(targetOutboundId).update({
      data: {
        trackingNumber: '',
        sfExpressOrderRecordId: '',
      },
    });
    for (const orderId of linkedOrderIds) {
      await transaction.collection(ORDERS_COLLECTION).doc(orderId).update({
        data: {
          sharedWaybill: isStillShared,
          updateTime: db.serverDate(),
        },
      });
    }
    await transaction.commit();
    return {
      success: true,
      sfExpressOrderId: record._id,
      waybillNo: trimString(record.waybillNo),
      shipmentStatus: trimString(record.shipmentStatus),
      shipmentVersion: nextVersion,
      reuseEnabled: false,
      linkedOrderCount: linkedOrderIds.length,
      linkedOutboundCount: linkedOutboundIds.length,
    };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) { /* ignore */ }
    throw error;
  }
}

async function confirmHandover(sfExpressOrderId, env, actorId) {
  const transaction = await db.startTransaction();
  try {
    const record = await getDoc(transaction, SF_ORDERS_COLLECTION, sfExpressOrderId);
    validateManagedShipment(record, env);
    if (!REUSABLE_SHIPMENT_STATUSES.has(trimString(record.shipmentStatus))) {
      throw new Error('包裹当前状态不能确认交接');
    }
    if (!requiresHandoverConfirmation(record)) {
      throw new Error('普通顺丰单完成出库后自动结束，无需确认交接');
    }
    const linkedState = await resolveLinkedState(transaction, record);
    const shipmentRemarkData = buildShipmentRemarkData(record, {
      ensureEntries: buildMissingRemarkEntries(linkedState.orders, record.sourceOrderId, record.createdAt),
    });
    ensureAllOutboundsCompleted(linkedState);
    const now = new Date().toISOString();
    const nextVersion = Math.max(1, Number(record.shipmentVersion || 1)) + 1;
    await transaction.collection(SF_ORDERS_COLLECTION).doc(record._id).update({
      data: {
        linkedOrderIds: linkedState.orderIds,
        linkedOutboundIds: linkedState.outboundIds,
        ...shipmentRemarkData,
        shipmentStatus: 'handed_over',
        shipmentVersion: nextVersion,
        reuseEnabled: false,
        reuseDisabledAt: now,
        handedOverAt: now,
        shipmentHistory: appendHistory(record, {
          action: 'confirm_handover',
          actorId,
          time: now,
        }),
        updatedAt: now,
      },
    });
    await transaction.commit();
    return {
      success: true,
      sfExpressOrderId: record._id,
      waybillNo: trimString(record.waybillNo),
      shipmentStatus: 'handed_over',
      shipmentVersion: nextVersion,
      reuseEnabled: false,
    };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) { /* ignore */ }
    throw error;
  }
}

exports.main = async (event) => {
  const payload = event && event.data || {};
  const action = trimString(payload.action);
  try {
    const auth = await requireShipmentPermission();
    if (!auth.allowed) return { success: false, code: auth.code, errMsg: auth.errMsg };
    const env = await resolveSfEnv();
    const actorId = trimString(auth.currentUser && auth.currentUser.id);

    if (action === 'listReusable') {
      const candidates = await listReusable(trimString(payload.sourceOrderId), env);
      return { success: true, env, data: candidates, errMsg: '查询成功' };
    }
    if (action === 'enableReuse') {
      return await setReuseEnabled(trimString(payload.sfExpressOrderId), env, actorId, true);
    }
    if (action === 'disableReuse') {
      return await setReuseEnabled(trimString(payload.sfExpressOrderId), env, actorId, false);
    }
    if (action === 'attach') {
      return await attachOrder(payload, env, actorId);
    }
    if (action === 'detach') {
      return await detachOrder(payload, env, actorId);
    }
    if (action === 'confirmHandover') {
      return await confirmHandover(trimString(payload.sfExpressOrderId), env, actorId);
    }
    return { success: false, code: 'INVALID_ACTION', errMsg: '不支持的包裹操作' };
  } catch (error) {
    console.error('[manageSfShipment] 操作失败:', { action, message: error.message });
    return { success: false, code: 'SHIPMENT_OPERATION_FAILED', errMsg: error.message || '顺丰包裹操作失败' };
  }
};

exports.__test__ = {
  normalizeShippingFee,
  buildRecipientMatchKey,
  appendHistory,
  buildOrderProductsRemark,
  buildPrintProductsRemark,
  buildShipmentRemarkEntry,
  buildShipmentRemarkData,
  buildMissingRemarkEntries,
  validateManagedShipment,
  validateReuseToggle,
  requiresHandoverConfirmation,
};
