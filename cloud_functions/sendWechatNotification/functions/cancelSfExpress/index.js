/**
 * cancelSfExpress - 取消顺丰发货
 *
 * 依赖云函数：
 * getSfAccessToken
 *
 * 云函数环境变量：
 * SF_ENV                   sandbox | production，默认 sandbox
 * SF_CLIENT_CODE           默认顺丰客户编码
 * SF_SANDBOX_CLIENT_CODE   沙箱客户编码（可选，优先于 SF_CLIENT_CODE）
 * SF_PROD_CLIENT_CODE      生产客户编码（可选，优先于 SF_CLIENT_CODE）
 * SF_SANDBOX_SERVICE_URL   沙箱业务接口地址（可选）
 * SF_PROD_SERVICE_URL      生产业务接口地址（可选）
 *
 * event.data:
 * orderId: string          orders 集合的 _id
 */

const crypto = require('node:crypto');
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();

const ORDERS_COLLECTION = 'orders';
const TOKEN_COLLECTION = 'sf_tokens';
const SERVICE_CODE = 'EXP_RECE_UPDATE_ORDER';
const DEFAULT_SERVICE_URLS = {
  sandbox: 'https://sfapi-sbox.sf-express.com/std/service',
  production: 'https://bspgw.sf-express.com/std/service',
};

function trimString(value) {
  return String(value || '').trim();
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

function getSfConfig() {
  const env = normalizeSfEnv();
  const partnerID = env === 'production'
    ? getFirstEnv(['SF_PROD_CLIENT_CODE', 'SF_PRODUCTION_CLIENT_CODE', 'SF_CLIENT_CODE'])
    : getFirstEnv(['SF_SANDBOX_CLIENT_CODE', 'SF_CLIENT_CODE']);
  const serviceUrl = env === 'production'
    ? getFirstEnv(['SF_PROD_SERVICE_URL', 'SF_PRODUCTION_SERVICE_URL']) || DEFAULT_SERVICE_URLS.production
    : getFirstEnv(['SF_SANDBOX_SERVICE_URL']) || DEFAULT_SERVICE_URLS.sandbox;

  if (!partnerID) {
    throw new Error(env === 'production'
      ? '缺少云函数环境变量 SF_PROD_CLIENT_CODE 或 SF_CLIENT_CODE'
      : '缺少云函数环境变量 SF_SANDBOX_CLIENT_CODE 或 SF_CLIENT_CODE');
  }

  return { env, partnerID, serviceUrl };
}

function buildRequestID() {
  return crypto.randomUUID().replace(/-/g, '');
}

function buildSfOrderId(orderId) {
  const normalized = trimString(orderId).replace(/[^a-zA-Z0-9_-]/g, '');
  return `HC_${normalized}`.slice(0, 64);
}

async function getOrder(orderId) {
  try {
    const result = await db.collection(ORDERS_COLLECTION).doc(orderId).get();
    return result.data || null;
  } catch (err) {
    if (err.errCode === -1 || String(err.message || '').includes('not exist')) return null;
    throw err;
  }
}

async function updateOrder(orderId, data) {
  await db.collection(ORDERS_COLLECTION).doc(orderId).update({
    data: {
      ...data,
      updateTime: db.serverDate(),
    },
  });
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
  if (!Array.isArray(waybillNoInfoList)) return '';
  const primary = waybillNoInfoList.find(item => String(item.waybillType || '') === '1');
  return trimString((primary || waybillNoInfoList[0] || {}).waybillNo);
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
  const { orderId } = event.data || {};

  if (!orderId) {
    return {
      success: false,
      errMsg: '缺少订单ID',
    };
  }

  try {
    const config = getSfConfig();
    const order = await getOrder(orderId);
    if (!order) throw new Error('订单不存在');

    const sfOrderId = trimString(order.sfOrderId) || buildSfOrderId(orderId);
    if (!sfOrderId) throw new Error('订单缺少顺丰客户订单号');

    const waybillNo = trimString(order.sfWaybillNo || order.trackingNumber);
    const requestID = buildRequestID();
    const msgData = {
      orderId: sfOrderId,
      dealType: 2,
      language: 'zh-CN',
    };

    if (waybillNo) {
      msgData.waybillNoInfoList = [{ waybillType: 1, waybillNo }];
    }

    const parsed = await cancelOrder({ config, requestID, msgData });

    if (!parsed.success) {
      await updateOrder(orderId, {
        expressProvider: 'sf',
        sfEnv: config.env,
        expressErrorMsg: parsed.errMsg,
        sfCancelRequestId: requestID,
        sfOrderId,
        sfCancelRawResponse: parsed.raw || null,
      });

      return {
        success: false,
        env: config.env,
        orderId,
        sfOrderId,
        waybillNo,
        errMsg: parsed.errMsg,
        errorCode: parsed.errorCode || '',
        resStatus: parsed.resStatus || '',
      };
    }

    await updateOrder(orderId, {
      status: 'unknown',
      trackingNumber: '',
      shippingFee: '',
      expressProvider: 'sf',
      sfEnv: config.env,
      expressApplyStatus: 'cancelled',
      expressCancelTime: new Date().toISOString(),
      expressErrorMsg: '',
      sfCancelRequestId: requestID,
      sfOrderId: parsed.sfOrderId || sfOrderId,
      sfWaybillNo: '',
      sfCancelRawResponse: parsed.raw,
    });

    return {
      success: true,
      env: config.env,
      orderId,
      sfOrderId: parsed.sfOrderId || sfOrderId,
      waybillNo: parsed.waybillNo || waybillNo,
      resStatus: parsed.resStatus,
    };
  } catch (err) {
    console.error('取消顺丰发货失败:', {
      orderId,
      message: err.message,
    });

    return {
      success: false,
      env: (() => {
        try { return normalizeSfEnv(); } catch { return trimString(process.env.SF_ENV) || 'sandbox'; }
      })(),
      orderId,
      errMsg: err.message || String(err),
    };
  }
};
