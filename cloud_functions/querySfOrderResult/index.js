/**
 * querySfOrderResult - 按独立顺丰记录查询顺丰订单
 *
 * event.data:
 * sfExpressOrderId: string  sf_express_orders._id
 * searchType?: string       1 正向单，默认 1
 */

const crypto = require('node:crypto');
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const ORDERS_COLLECTION = 'orders';
const OUTBOUND_COLLECTION = 'outbound_records';
const SF_ORDERS_COLLECTION = 'sf_express_orders';
const TOKEN_COLLECTION = 'sf_tokens';
const CONFIG_COLLECTION = 'system_config';
const SF_CONFIG_DOC_ID = 'sf_express';
const SERVICE_CODE = 'EXP_RECE_SEARCH_ORDER_RESP';
const DEFAULT_SERVICE_URLS = {
  sandbox: 'https://sfapi-sbox.sf-express.com/std/service',
  production: 'https://bspgw.sf-express.com/std/service',
};

function trimString(value) {
  return String(value || '').trim();
}

function planPendingOutboundTrackingSync(outbound, waybillNo) {
  if (!outbound) return { action: 'not_linked' };
  const outboundStatus = trimString(outbound.outboundStatus);
  if (outboundStatus !== 'pending') {
    return {
      action: 'skipped_status',
      outboundStatus,
    };
  }
  const existingTrackingNumber = trimString(outbound.trackingNumber);
  const targetTrackingNumber = trimString(waybillNo);
  if (existingTrackingNumber && existingTrackingNumber !== targetTrackingNumber) {
    return {
      action: 'conflict',
      existingTrackingNumber,
      targetTrackingNumber,
    };
  }
  if (existingTrackingNumber === targetTrackingNumber) {
    return {
      action: 'already_synced',
      trackingNumber: targetTrackingNumber,
    };
  }
  return {
    action: 'update',
    trackingNumber: targetTrackingNumber,
  };
}

function normalizeSfEnv(value = process.env.SF_ENV || 'sandbox') {
  const normalized = trimString(value).toLowerCase();
  if (!normalized || normalized === 'sandbox' || normalized === 'sbox') return 'sandbox';
  if (normalized === 'prod' || normalized === 'production') return 'production';
  throw new Error(`SF_ENV 仅支持 sandbox 或 production，当前值: ${value}`);
}

function getFirstEnv(names) {
  for (const name of names) {
    const value = trimString(process.env[name]);
    if (value) return value;
  }
  return '';
}

async function resolveSfEnv() {
  try {
    const result = await db.collection(CONFIG_COLLECTION).doc(SF_CONFIG_DOC_ID).get();
    const value = trimString(result.data && result.data.env);
    return value ? normalizeSfEnv(value) : normalizeSfEnv();
  } catch (_) {
    return normalizeSfEnv();
  }
}

function getSfConfig(env) {
  const partnerID = env === 'production'
    ? getFirstEnv(['SF_PROD_CLIENT_CODE', 'SF_PRODUCTION_CLIENT_CODE'])
    : getFirstEnv(['SF_SANDBOX_CLIENT_CODE']);
  const serviceUrl = env === 'production'
    ? getFirstEnv(['SF_PROD_SERVICE_URL', 'SF_PRODUCTION_SERVICE_URL']) || DEFAULT_SERVICE_URLS.production
    : getFirstEnv(['SF_SANDBOX_SERVICE_URL']) || DEFAULT_SERVICE_URLS.sandbox;
  if (!partnerID) {
    throw new Error(env === 'production'
      ? '缺少云函数环境变量 SF_PROD_CLIENT_CODE'
      : '缺少云函数环境变量 SF_SANDBOX_CLIENT_CODE');
  }
  return { env, partnerID, serviceUrl };
}

function buildRequestID() {
  return crypto.randomUUID().replace(/-/g, '');
}

function parseJsonMaybe(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return {}; }
}

function sanitizeForStorage(value, key = '') {
  if (value === null || value === undefined) return value;
  const normalizedKey = String(key).toLowerCase();
  if (normalizedKey.includes('token') || normalizedKey.includes('authorization')) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => sanitizeForStorage(item));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeForStorage(childValue, childKey)])
    );
  }
  return typeof value === 'string' ? value.slice(0, 4096) : value;
}

function toLimitedJson(value) {
  return JSON.stringify(sanitizeForStorage(value)).slice(0, 64 * 1024);
}

function normalizeWaybillNoInfoList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => ({
    waybillType: item && item.waybillType,
    waybillNo: trimString(item && item.waybillNo),
  })).filter(item => item.waybillNo);
}

function getPrimaryWaybillNo(list) {
  const normalized = normalizeWaybillNoInfoList(list);
  const primary = normalized.find(item => String(item.waybillType || '') === '1');
  return trimString((primary || normalized[0] || {}).waybillNo);
}

function parseSfSearchOrderResponse(result) {
  if (result.apiResultCode !== 'A1000') {
    return {
      success: false,
      authFailed: result.apiResultCode === 'A1011',
      errorCode: trimString(result.apiResultCode),
      errMsg: result.apiErrorMsg || `顺丰平台调用失败: ${result.apiResultCode || 'UNKNOWN'}`,
      raw: result,
    };
  }
  const apiResultData = parseJsonMaybe(result.apiResultData);
  const msgData = parseJsonMaybe(apiResultData.msgData);
  const errorCode = trimString(apiResultData.errorCode);
  const success = apiResultData.success === true || apiResultData.success === 'true';
  if (!success || errorCode !== 'S0000') {
    return {
      success: false,
      errorCode,
      errMsg: apiResultData.errorMsg || `顺丰业务查询失败: ${errorCode || 'UNKNOWN'}`,
      raw: result,
    };
  }
  const waybillNoInfoList = normalizeWaybillNoInfoList(msgData.waybillNoInfoList);
  const waybillNo = getPrimaryWaybillNo(waybillNoInfoList);
  if (!waybillNo) {
    return { success: false, errorCode, errMsg: '顺丰查询成功但未返回运单号', raw: result };
  }
  return {
    success: true,
    sfOrderId: trimString(msgData.orderId || apiResultData.orderId),
    waybillNo,
    waybillNoInfoList,
    raw: result,
  };
}

async function getDoc(collectionName, id) {
  try {
    const result = await db.collection(collectionName).doc(id).get();
    return result.data || null;
  } catch (error) {
    const message = String(error && error.message || '');
    if (error.errCode === -1 || error.errCode === -502005 || message.includes('not exist')) return null;
    throw error;
  }
}

async function getAccessToken(config, forceRefresh = false) {
  const result = await cloud.callFunction({
    name: 'getSfAccessToken',
    data: { forceRefresh, sfEnv: config.env },
  });
  const tokenResult = result.result || {};
  if (!tokenResult.success) throw new Error(tokenResult.errMsg || '获取顺丰 accessToken 失败');
  const tokenData = await getDoc(TOKEN_COLLECTION, config.env);
  if (!tokenData || !tokenData.accessToken) throw new Error('顺丰 accessToken 缓存为空');
  if (Number(tokenData.expiresAt || 0) <= Date.now()) throw new Error('顺丰 accessToken 已过期');
  return tokenData.accessToken;
}

async function callSearchOrder({ config, accessToken, requestID, msgData }) {
  const body = new URLSearchParams({
    partnerID: config.partnerID,
    requestID,
    serviceCode: SERVICE_CODE,
    timestamp: String(Date.now()),
    accessToken,
    msgData: JSON.stringify(msgData),
  });
  const response = await fetch(config.serviceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
  });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch (_) {
    throw new Error(`顺丰订单查询接口返回非 JSON，HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`顺丰订单查询接口 HTTP ${response.status}: ${result.apiErrorMsg || result.message || text}`);
  }
  return result;
}

async function searchOrderResult({ config, requestID, msgData }) {
  let accessToken = await getAccessToken(config, false);
  let result = await callSearchOrder({ config, accessToken, requestID, msgData });
  let parsed = parseSfSearchOrderResponse(result);
  if (parsed.authFailed) {
    accessToken = await getAccessToken(config, true);
    result = await callSearchOrder({ config, accessToken, requestID, msgData });
    parsed = parseSfSearchOrderResponse(result);
  }
  return parsed;
}

async function markQueryFailed(record, requestID, parsed) {
  const keepStatus = record.status === 'applied' || record.status === 'cancelled';
  await db.collection(SF_ORDERS_COLLECTION).doc(record._id).update({
    data: {
      ...(keepStatus ? {} : { status: 'failed' }),
      searchRequestId: requestID,
      searchTime: new Date().toISOString(),
      errorCode: trimString(parsed.errorCode),
      errorMessage: trimString(parsed.errMsg),
      responseSummary: toLimitedJson(parsed.raw),
      updatedAt: new Date().toISOString(),
    },
  });
}

async function markQueryApplied(record, order, requestID, parsed) {
  const now = new Date().toISOString();
  const transaction = await db.startTransaction();
  try {
    let currentOrderResult = null;
    try {
      currentOrderResult = await transaction.collection(ORDERS_COLLECTION).doc(record.sourceOrderId).get();
    } catch (_) {
      currentOrderResult = null;
    }
    if (!currentOrderResult || !currentOrderResult.data) {
      throw new Error('关联订单不存在');
    }
    const currentOrder = currentOrderResult.data;
    const outboundRecordId = trimString(currentOrder.outboundRecordId);
    let outbound = null;
    if (outboundRecordId) {
      try {
        const outboundResult = await transaction.collection(OUTBOUND_COLLECTION).doc(outboundRecordId).get();
        outbound = outboundResult && outboundResult.data || null;
      } catch (_) {
        outbound = null;
      }
    }
    const outboundSync = planPendingOutboundTrackingSync(outbound, parsed.waybillNo);

    await transaction.collection(SF_ORDERS_COLLECTION).doc(record._id).update({
      data: {
        status: 'applied',
        sfOrderId: parsed.sfOrderId || record.sfOrderId,
        waybillNo: parsed.waybillNo,
        waybillNoInfoList: parsed.waybillNoInfoList,
        searchRequestId: requestID,
        searchTime: now,
        applyTime: record.applyTime || now,
        errorCode: '',
        errorMessage: '',
        responseSummary: toLimitedJson(parsed.raw),
        updatedAt: now,
      },
    });
    await transaction.collection(ORDERS_COLLECTION).doc(order._id).update({
      data: {
        trackingNumber: parsed.waybillNo,
        expressProvider: 'sf',
        updateTime: db.serverDate(),
      },
    });
    if (outboundRecordId && outboundSync.action === 'update') {
      await transaction.collection(OUTBOUND_COLLECTION).doc(outboundRecordId).update({
        data: {
          trackingNumber: outboundSync.trackingNumber,
        },
      });
    }
    await transaction.commit();
    return {
      outboundSync: {
        ...outboundSync,
        outboundRecordId,
      },
    };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) { /* ignore */ }
    throw error;
  }
}

exports.main = async (event) => {
  const { sfExpressOrderId, searchType = '1' } = event.data || {};
  if (!trimString(sfExpressOrderId)) {
    return { success: false, errMsg: '缺少顺丰记录ID' };
  }

  let env = '';
  try {
    env = await resolveSfEnv();
    const config = getSfConfig(env);
    const record = await getDoc(SF_ORDERS_COLLECTION, trimString(sfExpressOrderId));
    if (!record) throw new Error('顺丰记录不存在');
    if (record.isCurrent !== true) throw new Error('该顺丰记录已不是当前记录');
    if (normalizeSfEnv(record.env) !== config.env) {
      throw new Error('顺丰记录环境与当前系统环境不一致，请切换环境后重试');
    }
    if (record.status === 'cancelled') throw new Error('顺丰订单已取消，不能继续查询');
    const order = await getDoc(ORDERS_COLLECTION, record.sourceOrderId);
    if (!order) throw new Error('关联订单不存在');

    const requestID = buildRequestID();
    const parsed = await searchOrderResult({
      config,
      requestID,
      msgData: {
        orderId: record.sfOrderId,
        searchType: String(searchType || '1'),
        language: 'zh-CN',
      },
    });
    if (!parsed.success) {
      await markQueryFailed(record, requestID, parsed);
      return {
        success: false,
        env,
        sourceOrderId: record.sourceOrderId,
        sfExpressOrderId: record._id,
        sfOrderId: record.sfOrderId,
        errMsg: parsed.errMsg,
        errorCode: parsed.errorCode || '',
      };
    }

    const appliedResult = await markQueryApplied(record, order, requestID, parsed);
    return {
      success: true,
      env,
      sourceOrderId: record.sourceOrderId,
      sfExpressOrderId: record._id,
      sfOrderId: parsed.sfOrderId || record.sfOrderId,
      waybillNo: parsed.waybillNo,
      waybillNoInfoList: parsed.waybillNoInfoList,
      outboundSync: appliedResult.outboundSync,
    };
  } catch (error) {
    console.error('查询顺丰订单失败:', {
      sfExpressOrderId,
      message: error.message,
    });
    return {
      success: false,
      env: env || trimString(process.env.SF_ENV) || 'sandbox',
      sfExpressOrderId,
      errMsg: error.message || String(error),
    };
  }
};

exports.__test__ = {
  planPendingOutboundTrackingSync,
};
