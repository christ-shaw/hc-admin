/**
 * querySfExpressOrders - 顺丰快递统一日期工作台
 *
 * 先按 orders.date 分页读取订单，再批量关联：
 * - sf_express_orders：当前环境的最新顺丰单及其他环境提示
 * - sf_export_logs：顺丰模板导出统计
 */

const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const ORDERS_COLLECTION = 'orders';
const OUTBOUND_COLLECTION = 'outbound_records';
const SF_ORDERS_COLLECTION = 'sf_express_orders';
const SF_EXPORT_LOGS_COLLECTION = 'sf_export_logs';
const CONFIG_COLLECTION = 'system_config';
const SF_CONFIG_DOC_ID = 'sf_express';
const ROLE_COLLECTION = 'roles';
const USER_ROLE_COLLECTION = 'user_roles';
const RAW_PAGE_SIZE = 100;
const MAX_DATE_SCAN = 2000;
const PENDING_STATUSES = new Set(['unknown', '--', 'unshipped']);

const LEGACY_SF_FIELDS = [
  'sfEnv',
  'expressApplyStatus',
  'expressApplyTime',
  'expressErrorMsg',
  'sfRequestId',
  'sfOrderId',
  'sfOrderIdSeq',
  'sfWaybillNo',
  'sfWaybillNoInfoList',
  'sfSenderContact',
  'sfSenderTel',
  'sfSearchRequestId',
  'sfSearchRawResponse',
  'expressCancelTime',
  'sfCancelRequestId',
  'sfCancelRawResponse',
  'sfRawResponse',
  'sfPrintCount',
  'sfLastPrintTime',
  'sfPrintRequestId',
  'sfExportCount',
  'sfLastExportTime',
  'sfExportLastBatchId',
];

function trimString(value) {
  return String(value || '').trim();
}

function normalizeSfEnv(value = process.env.SF_ENV || 'sandbox') {
  const normalized = trimString(value).toLowerCase();
  if (!normalized || normalized === 'sandbox' || normalized === 'sbox') return 'sandbox';
  if (normalized === 'prod' || normalized === 'production') return 'production';
  throw new Error(`顺丰环境仅支持 sandbox 或 production，当前值: ${value}`);
}

function todayInShanghai() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(item => [item.type, item.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(trimString(value));
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

async function getDoc(collectionName, id) {
  try {
    const result = await db.collection(collectionName).doc(id).get();
    return result.data || null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function requireOrderReadPermission() {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return { allowed: false, code: 'LOGIN_REQUIRED', errMsg: '请先登录' };
  }

  const userIds = currentUser.ids || [currentUser.id];
  let userRole = null;
  for (const userId of userIds) {
    const result = await db.collection(USER_ROLE_COLLECTION).where({ userId }).limit(1).get();
    userRole = result.data && result.data[0] || null;
    if (userRole) break;
  }
  if (!userRole) {
    return { allowed: false, code: 'ROLE_UNASSIGNED', errMsg: '当前用户未分配角色' };
  }

  const role = await getDoc(ROLE_COLLECTION, userRole.roleId);
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

function stripLegacySfFields(order) {
  const result = { ...order };
  for (const field of LEGACY_SF_FIELDS) delete result[field];
  return result;
}

function isNotRequired(order) {
  return order.needsOutbound === false
    || normalizeShippingFee(order.shippingFee) === 'pickup'
    || !PENDING_STATUSES.has(trimString(order.status));
}

function deriveSfStatus(order, currentSfOrder, cutoverDate) {
  if (currentSfOrder) return trimString(currentSfOrder.status) || 'failed';
  if (trimString(order.date) < cutoverDate) return 'legacy_unmanaged';
  if (trimString(order.expressProvider).toLowerCase() === 'sf' && trimString(order.trackingNumber)) {
    return 'legacy_unmanaged';
  }
  if (trimString(order.trackingNumber)) return 'other_express';
  if (isNotRequired(order)) return 'not_required';
  return 'not_created';
}

async function resolveSfConfig() {
  const config = await getDoc(CONFIG_COLLECTION, SF_CONFIG_DOC_ID);
  const env = normalizeSfEnv(config && config.env);
  return {
    env,
    dataModelVersion: Number(config && config.dataModelVersion || 1),
    dataModelCutoverDate: isValidDate(config && config.dataModelCutoverDate)
      ? config.dataModelCutoverDate
      : todayInShanghai(),
  };
}

async function fetchByIds(collectionName, sourceOrderIds, extraConditions = {}, limit = 1000) {
  if (sourceOrderIds.length === 0) return [];
  const rows = [];
  for (let index = 0; index < sourceOrderIds.length; index += 20) {
    const chunk = sourceOrderIds.slice(index, index + 20);
    try {
      const result = await db.collection(collectionName)
        .where({ sourceOrderId: _.in(chunk), ...extraConditions })
        .limit(Math.min(limit, Math.max(chunk.length * 20, chunk.length)))
        .get();
      rows.push(...(result.data || []));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return rows;
}

async function enrichShippingFees(orders) {
  const outboundIds = Array.from(new Set(
    orders
      .filter(order => !trimString(order.shippingFee) && trimString(order.outboundRecordId))
      .map(order => trimString(order.outboundRecordId))
  ));
  if (outboundIds.length === 0) return orders;

  const shippingMap = new Map();
  for (let index = 0; index < outboundIds.length; index += 20) {
    const chunk = outboundIds.slice(index, index + 20);
    const result = await db.collection(OUTBOUND_COLLECTION)
      .where({ _id: _.in(chunk) })
      .limit(chunk.length)
      .get();
    for (const record of result.data || []) {
      if (trimString(record.shippingMethod)) shippingMap.set(record._id, record.shippingMethod);
    }
  }

  return orders.map(order => ({
    ...order,
    shippingFee: trimString(order.shippingFee)
      || shippingMap.get(trimString(order.outboundRecordId))
      || '',
  }));
}

function selectLatestCurrent(records) {
  return records
    .filter(record => record.isCurrent === true)
    .sort((a, b) => Number(b.attemptNo || 0) - Number(a.attemptNo || 0))[0] || null;
}

function buildOtherEnvSummary(records, currentEnv) {
  const summary = {};
  for (const record of records) {
    const env = normalizeSfEnv(record.env);
    if (env === currentEnv || record.isCurrent !== true) continue;
    const existing = summary[env];
    if (!existing || Number(record.attemptNo || 0) > Number(existing.attemptNo || 0)) {
      summary[env] = {
        env,
        status: trimString(record.status),
        sfOrderId: trimString(record.sfOrderId),
        waybillNo: trimString(record.waybillNo),
        attemptNo: Number(record.attemptNo || 0),
      };
    }
  }
  return Object.values(summary);
}

function publicSfOrder(record) {
  if (!record) return null;
  return {
    _id: record._id,
    sourceOrderId: record.sourceOrderId,
    sourceSerialNumber: record.sourceSerialNumber,
    sourceOnlineOrderNumber: record.sourceOnlineOrderNumber,
    sourceOrderDate: record.sourceOrderDate,
    sfOrderId: record.sfOrderId,
    attemptNo: Number(record.attemptNo || 1),
    env: normalizeSfEnv(record.env),
    isCurrent: record.isCurrent === true,
    status: record.status,
    waybillNo: record.waybillNo || '',
    waybillNoInfoList: Array.isArray(record.waybillNoInfoList) ? record.waybillNoInfoList : [],
    applyRequestId: record.applyRequestId || '',
    applyRequestTime: record.applyRequestTime || '',
    searchRequestId: record.searchRequestId || '',
    searchTime: record.searchTime || '',
    cancelRequestId: record.cancelRequestId || '',
    cancelRequestTime: record.cancelRequestTime || '',
    applyTime: record.applyTime || '',
    cancelTime: record.cancelTime || '',
    errorCode: record.errorCode || '',
    errorMessage: record.errorMessage || '',
    printCount: Number(record.printCount || 0),
    lastPrintTime: record.lastPrintTime || '',
    lastPrintRequestId: record.lastPrintRequestId || '',
    createdAt: record.createdAt || '',
    updatedAt: record.updatedAt || '',
  };
}

exports.main = async (event) => {
  const payload = event && event.data || {};
  const pageLimit = Math.max(1, Math.min(Number(payload.limit) || 20, 100));
  const targetDate = trimString(payload.date) || todayInShanghai();
  let rawOffset = Math.max(0, Number.parseInt(payload.cursor, 10) || 0);

  try {
    const auth = await requireOrderReadPermission();
    if (!auth.allowed) {
      return { success: false, code: auth.code, data: [], cursor: null, hasMore: false, errMsg: auth.errMsg };
    }
    if (!isValidDate(targetDate)) {
      return { success: false, code: 'INVALID_DATE', data: [], cursor: null, hasMore: false, errMsg: '日期格式必须为 YYYY-MM-DD' };
    }

    const config = await resolveSfConfig();
    const conditions = { date: targetDate };
    if (trimString(payload.serialNumber)) {
      const serialNumber = Number(trimString(payload.serialNumber));
      if (!Number.isSafeInteger(serialNumber) || serialNumber < 0) throw new Error('序号必须为非负整数');
      conditions.serialNumber = serialNumber;
    }
    if (trimString(payload.onlineOrderNumber)) {
      conditions.onlineOrderNumber = db.RegExp({ regexp: escapeRegExp(payload.onlineOrderNumber), options: 'i' });
    }
    if (trimString(payload.consignee)) {
      conditions.consignee = db.RegExp({ regexp: escapeRegExp(payload.consignee), options: 'i' });
    }
    if (trimString(payload.salesperson)) conditions.salesperson = trimString(payload.salesperson);

    const query = db.collection(ORDERS_COLLECTION).where(conditions);
    const matchingOrders = [];
    let scanned = 0;
    let exhausted = false;
    const shippingFeeFilter = normalizeShippingFee(payload.shippingFee);

    while (!exhausted && matchingOrders.length <= pageLimit && scanned < MAX_DATE_SCAN) {
      const page = await query
        .orderBy('serialNumber', 'desc')
        .skip(rawOffset)
        .limit(RAW_PAGE_SIZE)
        .get();
      const rawOrders = page.data || [];
      if (rawOrders.length === 0) break;
      const orders = await enrichShippingFees(rawOrders);
      for (const order of orders) {
        rawOffset += 1;
        scanned += 1;
        if (shippingFeeFilter && normalizeShippingFee(order.shippingFee) !== shippingFeeFilter) continue;
        matchingOrders.push(order);
        if (matchingOrders.length > pageLimit) break;
      }
      exhausted = rawOrders.length < RAW_PAGE_SIZE;
    }

    const hasMore = matchingOrders.length > pageLimit;
    const pageOrders = matchingOrders.slice(0, pageLimit);
    const sourceOrderIds = pageOrders.map(order => trimString(order._id)).filter(Boolean);
    const sfRecords = await fetchByIds(SF_ORDERS_COLLECTION, sourceOrderIds);
    const exportLogs = await fetchByIds(SF_EXPORT_LOGS_COLLECTION, sourceOrderIds);

    const sfBySource = new Map();
    for (const record of sfRecords) {
      const list = sfBySource.get(record.sourceOrderId) || [];
      list.push(record);
      sfBySource.set(record.sourceOrderId, list);
    }
    const exportBySource = new Map();
    for (const log of exportLogs) {
      const current = exportBySource.get(log.sourceOrderId) || { count: 0, lastExportTime: '' };
      current.count += 1;
      const exportedAt = trimString(log.exportedAt);
      if (exportedAt > current.lastExportTime) current.lastExportTime = exportedAt;
      exportBySource.set(log.sourceOrderId, current);
    }

    const data = pageOrders.map(rawOrder => {
      const order = stripLegacySfFields(rawOrder);
      const related = sfBySource.get(order._id) || [];
      const currentSfOrder = selectLatestCurrent(
        related.filter(record => normalizeSfEnv(record.env) === config.env)
      );
      return {
        order,
        sfStatus: deriveSfStatus(order, currentSfOrder, config.dataModelCutoverDate),
        currentSfOrder: publicSfOrder(currentSfOrder),
        otherEnvSummary: buildOtherEnvSummary(related, config.env),
        exportSummary: exportBySource.get(order._id) || { count: 0, lastExportTime: '' },
      };
    });

    return {
      success: true,
      date: targetDate,
      env: config.env,
      dataModelVersion: config.dataModelVersion,
      dataModelCutoverDate: config.dataModelCutoverDate,
      data,
      cursor: hasMore ? String(rawOffset - 1) : null,
      hasMore,
      errMsg: '查询成功',
    };
  } catch (error) {
    console.error('查询顺丰快递工作台失败:', error);
    return {
      success: false,
      data: [],
      cursor: null,
      hasMore: false,
      errMsg: error.message || '查询顺丰快递工作台失败',
    };
  }
};

exports.__test__ = {
  normalizeShippingFee,
  stripLegacySfFields,
  deriveSfStatus,
  selectLatestCurrent,
  buildOtherEnvSummary,
};
