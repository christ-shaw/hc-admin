/**
 * cancelSfExpress - 取消顺丰发货
 *
 * 依赖云函数：
 * getSfAccessToken
 *
 * 环境切换：
 * 优先读数据库 system_config/sf_express 的 env 字段（sandbox | production），
 * 改这条文档即可动态切换环境，无需重新部署；文档不存在时回退到 SF_ENV 环境变量。
 *
 * 云函数环境变量：
 * SF_ENV                   sandbox | production，默认 sandbox（仅作为数据库配置缺失时的回退）
 * SF_SANDBOX_CLIENT_CODE   沙箱客户编码
 * SF_PROD_CLIENT_CODE      生产客户编码
 * SF_SANDBOX_SERVICE_URL   沙箱业务接口地址（可选）
 * SF_PROD_SERVICE_URL      生产业务接口地址（可选）
 *
 * event.data:
 * sfExpressOrderId: string sf_express_orders 集合的 _id
 */

const crypto = require('node:crypto');
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();

const ORDERS_COLLECTION = 'orders';
const OUTBOUND_COLLECTION = 'outbound_records';
const SF_ORDERS_COLLECTION = 'sf_express_orders';
const TOKEN_COLLECTION = 'sf_tokens';
const CONFIG_COLLECTION = 'system_config';
const SF_CONFIG_DOC_ID = 'sf_express';
const SERVICE_CODE = 'EXP_RECE_UPDATE_ORDER';
const DEFAULT_SERVICE_URLS = {
  sandbox: 'https://sfapi-sbox.sf-express.com/std/service',
  production: 'https://bspgw.sf-express.com/std/service',
};

function trimString(value) {
  return String(value || '').trim();
}

function planPendingOutboundTrackingClear(outbound, waybillNo) {
  if (!outbound) return { action: 'not_linked' };
  const outboundStatus = trimString(outbound.outboundStatus);
  if (outboundStatus !== 'pending') {
    return {
      action: 'skipped_status',
      outboundStatus,
    };
  }
  const existingTrackingNumber = trimString(outbound.trackingNumber);
  if (existingTrackingNumber !== trimString(waybillNo)) {
    return {
      action: 'unchanged',
      existingTrackingNumber,
    };
  }
  return {
    action: 'clear',
    trackingNumber: existingTrackingNumber,
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
  let raw = '';
  try {
    const result = await db.collection(CONFIG_COLLECTION).doc(SF_CONFIG_DOC_ID).get();
    raw = trimString(result.data && result.data.env);
  } catch (err) {
    raw = '';
  }
  return raw ? normalizeSfEnv(raw) : normalizeSfEnv();
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

async function getDoc(collectionName, id) {
  try {
    const result = await db.collection(collectionName).doc(id).get();
    return result.data || null;
  } catch (err) {
    if (
      err.errCode === -1
      || err.errCode === -502005
      || String(err.message || '').includes('not exist')
    ) return null;
    throw err;
  }
}

async function updateSfRecord(recordId, data) {
  await db.collection(SF_ORDERS_COLLECTION).doc(recordId).update({
    data: {
      ...data,
      updatedAt: new Date().toISOString(),
    },
  });
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

async function getAccessToken(config, forceRefresh = false) {
  const result = await cloud.callFunction({
    name: 'getSfAccessToken',
    data: { forceRefresh, sfEnv: config.env },
  });

  const tokenResult = result.result || {};
  if (!tokenResult.success) {
    throw new Error(tokenResult.errMsg || '获取顺丰 accessToken 失败');
  }

  const tokenDoc = await db.collection(TOKEN_COLLECTION).doc(config.env).get();
  const tokenData = tokenDoc.data || {};
  if (!tokenData.accessToken) {
    throw new Error('顺丰 accessToken 缓存为空');
  }

  if (Number(tokenData.expiresAt || 0) <= Date.now()) {
    throw new Error('顺丰 accessToken 已过期');
  }

  return tokenData.accessToken;
}

function parseJsonMaybe(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return {};
  }
}

function isBusinessSuccess(apiResultData) {
  return apiResultData.success === true || apiResultData.success === 'true';
}

function getPrimaryWaybillNo(waybillNoInfoList = []) {
  const list = normalizeWaybillNoInfoList(waybillNoInfoList);
  const primary = list.find(item => String(item.waybillType || '') === '1');
  return trimString((primary || list[0] || {}).waybillNo);
}

function normalizeWaybillNoInfoList(waybillNoInfoList = []) {
  if (!Array.isArray(waybillNoInfoList)) return [];
  return waybillNoInfoList
    .map(item => ({
      waybillType: item.waybillType,
      waybillNo: trimString(item.waybillNo),
    }))
    .filter(item => item.waybillNo);
}

function parseSfCancelResponse(result) {
  if (result.apiResultCode !== 'A1000') {
    return {
      success: false,
      authFailed: result.apiResultCode === 'A1011',
      errMsg: result.apiErrorMsg || `顺丰平台调用失败: ${result.apiResultCode || 'UNKNOWN'}`,
      raw: result,
    };
  }

  const apiResultData = parseJsonMaybe(result.apiResultData);
  const msgData = parseJsonMaybe(apiResultData.msgData);
  const errorCode = trimString(apiResultData.errorCode);
  const resStatus = trimString(msgData.resStatus);

  if (!isBusinessSuccess(apiResultData) || errorCode !== 'S0000') {
    return {
      success: false,
      errMsg: apiResultData.errorMsg || `顺丰取消发货失败: ${errorCode || 'UNKNOWN'}`,
      errorCode,
      raw: result,
      apiResultData,
      msgData,
    };
  }

  if (resStatus && resStatus !== '2') {
    return {
      success: false,
      errMsg: `顺丰取消发货未成功，resStatus=${resStatus}`,
      errorCode,
      resStatus,
      raw: result,
      apiResultData,
      msgData,
    };
  }

  return {
    success: true,
    sfOrderId: trimString(msgData.orderId || apiResultData.orderId),
    waybillNoInfoList: normalizeWaybillNoInfoList(msgData.waybillNoInfoList),
    waybillNo: getPrimaryWaybillNo(msgData.waybillNoInfoList),
    resStatus: resStatus || '2',
    raw: result,
    apiResultData,
    msgData,
  };
}

async function callUpdateOrder({ config, accessToken, requestID, msgData }) {
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
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body,
  });

  const text = await response.text();
  let result;

  try {
    result = JSON.parse(text);
  } catch (err) {
    throw new Error(`顺丰订单确认/取消接口返回非 JSON，HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(`顺丰订单确认/取消接口 HTTP ${response.status}: ${result.apiErrorMsg || result.message || text}`);
  }

  return result;
}

async function cancelOrder({ config, requestID, msgData }) {
  let accessToken = await getAccessToken(config, false);
  let result = await callUpdateOrder({ config, accessToken, requestID, msgData });
  let parsed = parseSfCancelResponse(result);

  if (parsed.authFailed) {
    accessToken = await getAccessToken(config, true);
    result = await callUpdateOrder({ config, accessToken, requestID, msgData });
    parsed = parseSfCancelResponse(result);
  }

  return parsed;
}

exports.main = async (event) => {
  const { sfExpressOrderId } = event.data || {};

  if (!trimString(sfExpressOrderId)) {
    return {
      success: false,
      errMsg: '缺少顺丰记录ID',
    };
  }

  let resolvedEnv = '';
  try {
    const env = await resolveSfEnv();
    resolvedEnv = env;
    const config = getSfConfig(env);
    const record = await getDoc(SF_ORDERS_COLLECTION, trimString(sfExpressOrderId));
    if (!record) throw new Error('顺丰记录不存在');
    if (record.isCurrent !== true) throw new Error('该顺丰记录已不是当前记录');
    if (normalizeSfEnv(record.env) !== config.env) {
      throw new Error('顺丰记录环境与当前系统环境不一致，请切换环境后重试');
    }
    if (record.status === 'cancelled') throw new Error('该顺丰订单已经取消');
    if (record.status !== 'applied') throw new Error('只有申请成功的顺丰订单可以取消');
    const order = await getDoc(ORDERS_COLLECTION, record.sourceOrderId);
    if (!order) throw new Error('关联订单不存在');
    const linkedOutboundRecordId = trimString(order.outboundRecordId);
    if (linkedOutboundRecordId) {
      const linkedOutbound = await getDoc(OUTBOUND_COLLECTION, linkedOutboundRecordId);
      if (linkedOutbound && trimString(linkedOutbound.outboundStatus) === 'completed') {
        throw new Error('关联出库记录已完成，不能取消顺丰订单');
      }
    }

    const sfOrderId = trimString(record.sfOrderId);
    if (!sfOrderId) throw new Error('订单缺少顺丰客户订单号');

    const storedWaybillNoInfoList = normalizeWaybillNoInfoList(record.waybillNoInfoList);
    const waybillNo = trimString(record.waybillNo);
    const waybillNoInfoList = storedWaybillNoInfoList.length
      ? storedWaybillNoInfoList
      : (waybillNo ? [{ waybillType: 1, waybillNo }] : []);
    const requestID = buildRequestID();
    const msgData = {
      orderId: sfOrderId,
      dealType: 2,
      language: 'zh-CN',
    };

    if (waybillNoInfoList.length) {
      msgData.waybillNoInfoList = waybillNoInfoList;
    }

    const parsed = await cancelOrder({ config, requestID, msgData });

    if (!parsed.success) {
      await updateSfRecord(record._id, {
        errorCode: trimString(parsed.errorCode),
        errorMessage: trimString(parsed.errMsg),
        cancelRequestId: requestID,
        cancelRequestTime: new Date().toISOString(),
        responseSummary: toLimitedJson(parsed.raw),
      });

      return {
        success: false,
        env: config.env,
        sourceOrderId: record.sourceOrderId,
        sfExpressOrderId: record._id,
        sfOrderId,
        waybillNo,
        errMsg: parsed.errMsg,
        errorCode: parsed.errorCode || '',
        resStatus: parsed.resStatus || '',
      };
    }

    const cancelledAt = new Date().toISOString();
    const transaction = await db.startTransaction();
    let outboundSyncResult = { action: 'not_linked', outboundRecordId: '' };
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
      const outboundSync = planPendingOutboundTrackingClear(outbound, waybillNo);
      const shouldClearOrder = trimString(currentOrder.trackingNumber) === waybillNo
        && trimString(currentOrder.expressProvider).toLowerCase() === 'sf'
        && trimString(outbound && outbound.outboundStatus) !== 'completed';

      await transaction.collection(SF_ORDERS_COLLECTION).doc(record._id).update({
        data: {
          status: 'cancelled',
          sfOrderId: parsed.sfOrderId || sfOrderId,
          cancelRequestId: requestID,
          cancelRequestTime: cancelledAt,
          cancelTime: cancelledAt,
          errorCode: '',
          errorMessage: '',
          responseSummary: toLimitedJson(parsed.raw),
          updatedAt: cancelledAt,
        },
      });
      if (shouldClearOrder) {
        await transaction.collection(ORDERS_COLLECTION).doc(record.sourceOrderId).update({
          data: {
            status: 'unshipped',
            trackingNumber: '',
            expressProvider: '',
            updateTime: db.serverDate(),
          },
        });
      }
      if (outboundRecordId && outboundSync.action === 'clear') {
        await transaction.collection(OUTBOUND_COLLECTION).doc(outboundRecordId).update({
          data: {
            trackingNumber: '',
          },
        });
      }
      outboundSyncResult = {
        ...outboundSync,
        outboundRecordId,
      };
      await transaction.commit();
    } catch (error) {
      try { await transaction.rollback(); } catch (_) { /* ignore */ }
      throw error;
    }

    return {
      success: true,
      env: config.env,
      sourceOrderId: record.sourceOrderId,
      sfExpressOrderId: record._id,
      sfOrderId: parsed.sfOrderId || sfOrderId,
      waybillNo: parsed.waybillNo || waybillNo,
      resStatus: parsed.resStatus,
      outboundSync: outboundSyncResult,
    };
  } catch (err) {
    console.error('取消顺丰发货失败:', {
      sfExpressOrderId,
      message: err.message,
    });

    return {
      success: false,
      env: resolvedEnv || (() => {
        try { return normalizeSfEnv(); } catch { return trimString(process.env.SF_ENV) || 'sandbox'; }
      })(),
      sfExpressOrderId,
      errMsg: err.message || String(err),
    };
  }
};

exports.__test__ = {
  planPendingOutboundTrackingClear,
};
