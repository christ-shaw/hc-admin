/**
 * applySfExpress - 顺丰沙箱下快递单
 *
 * 当前仅支持沙箱环境：
 * POST https://sfapi-sbox.sf-express.com/std/service
 *
 * 依赖云函数：
 * getSfAccessToken
 *
 * 云函数环境变量：
 * SF_CLIENT_CODE       顺丰客户编码
 * SF_SENDER_MAP        按订单人员切换寄件人，JSON 对象（可选）
 * SF_SENDER_CONTACT   默认寄件人
 * SF_SENDER_TEL       默认寄件电话
 * SF_SENDER_COMPANY   默认寄件公司（可选）
 * SF_SENDER_PROVINCE  默认寄件省（可选）
 * SF_SENDER_CITY      默认寄件市（可选）
 * SF_SENDER_COUNTY    默认寄件区县（可选）
 * SF_SENDER_ADDRESS   默认寄件详细地址
 *
 * event.data:
 * orderId: string     orders 集合的 _id
 */

const crypto = require('node:crypto');
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();

const SF_ENV = 'sandbox';
const ORDERS_COLLECTION = 'orders';
const SERVICE_URL = 'https://sfapi-sbox.sf-express.com/std/service';
const SERVICE_CODE = 'EXP_RECE_CREATE_ORDER';
const DEFAULT_PAY_METHOD = 1;
const DEFAULT_EXPRESS_TYPE_ID = 1;
const DEFAULT_PARCEL_QTY = 1;

function trimString(value) {
  return String(value || '').trim();
}

function isApplicableOrderStatus(status) {
  return status === 'unknown' || status === '--';
}

function isMobilePhone(phone) {
  return /^1\d{10}$/.test(trimString(phone));
}

function maskPhone(phone) {
  const normalized = trimString(phone);
  return normalized.replace(/^(\d{3})\d+(\d{4})$/, '$1****$2');
}

function buildRequestID() {
  return crypto.randomUUID().replace(/-/g, '');
}

function buildSfOrderId(orderId) {
  const normalized = trimString(orderId).replace(/[^a-zA-Z0-9_-]/g, '');
  return `HC_${normalized}`.slice(0, 64);
}

function normalizeSenderConfig(raw = {}) {
  return {
    contact: trimString(raw.contact),
    tel: trimString(raw.tel),
    company: trimString(raw.company),
    country: trimString(raw.country) || 'CN',
    province: trimString(raw.province),
    city: trimString(raw.city),
    county: trimString(raw.county),
    address: trimString(raw.address),
  };
}

function validateSenderConfig(sender, label) {
  if (!sender.contact) throw new Error(`${label}缺少寄件人姓名 contact`);
  if (!sender.tel) throw new Error(`${label}缺少寄件电话 tel`);
  if (!sender.address) throw new Error(`${label}缺少寄件地址 address`);
}

function getDefaultSenderConfig() {
  const sender = normalizeSenderConfig({
    contact: process.env.SF_SENDER_CONTACT,
    tel: process.env.SF_SENDER_TEL,
    company: process.env.SF_SENDER_COMPANY,
    country: 'CN',
    province: process.env.SF_SENDER_PROVINCE,
    city: process.env.SF_SENDER_CITY,
    county: process.env.SF_SENDER_COUNTY,
    address: process.env.SF_SENDER_ADDRESS,
  });

  validateSenderConfig(sender, '默认寄件人配置');

  return sender;
}

function parseSenderMap() {
  const text = trimString(process.env.SF_SENDER_MAP);
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('SF_SENDER_MAP 必须是 JSON 对象');
    }
    return parsed;
  } catch (err) {
    throw new Error(`SF_SENDER_MAP 解析失败: ${err.message}`);
  }
}

function getSenderConfig(order) {
  const senderMap = parseSenderMap();
  if (!senderMap) return getDefaultSenderConfig();

  const salesperson = trimString(order.salesperson);
  if (!salesperson) {
    throw new Error('订单缺少人员，无法匹配顺丰寄件人配置');
  }

  const rawSender = senderMap[salesperson];
  if (!rawSender) {
    throw new Error(`未配置人员「${salesperson}」的顺丰寄件人信息`);
  }

  const sender = normalizeSenderConfig(rawSender);
  validateSenderConfig(sender, `人员「${salesperson}」的寄件人配置`);
  return sender;
}

function validateOrder(order) {
  if (!order) throw new Error('订单不存在');
  if (order.sfWaybillNo || order.trackingNumber) throw new Error('订单已存在快递单号，请勿重复申请');
  if (order.expressApplyStatus === 'applying') throw new Error('订单正在申请快递，请稍后再试');
  if (!isApplicableOrderStatus(order.status)) throw new Error('仅订单状态为 -- 的订单可申请快递');
  if (!trimString(order.consignee)) throw new Error('收货人名称不能为空');
  if (!trimString(order.consigneePhone)) throw new Error('收货人电话不能为空');
  if (!trimString(order.consigneeAddress)) throw new Error('收货人地址不能为空');
  if (!trimString(order.productName)) throw new Error('货品名称不能为空');
}

function buildContactInfoList(order, sender) {
  const receiverPhone = trimString(order.consigneePhone);
  const receiver = {
    contactType: 2,
    contact: trimString(order.consignee),
    country: 'CN',
    address: trimString(order.consigneeAddress),
  };

  if (isMobilePhone(receiverPhone)) {
    receiver.mobile = receiverPhone;
  } else {
    receiver.tel = receiverPhone;
  }

  const senderInfo = {
    contactType: 1,
    contact: sender.contact,
    tel: sender.tel,
    country: sender.country,
    address: sender.address,
  };

  if (sender.company) senderInfo.company = sender.company;
  if (sender.province) senderInfo.province = sender.province;
  if (sender.city) senderInfo.city = sender.city;
  if (sender.county) senderInfo.county = sender.county;

  return [senderInfo, receiver];
}

function buildCargoDetails(order) {
  const productName = trimString(order.productName);
  const specification = trimString(order.specification);
  const name = specification && specification !== '默认'
    ? `${productName} ${specification}`.slice(0, 128)
    : productName.slice(0, 128);

  return [
    {
      name,
      count: Number(order.quantity || 1) || 1,
      unit: '件',
    },
  ];
}

function buildMsgData(order, orderId, sender) {
  return {
    language: 'zh-CN',
    orderId: order.sfOrderId || buildSfOrderId(orderId),
    cargoDetails: buildCargoDetails(order),
    contactInfoList: buildContactInfoList(order, sender),
    payMethod: DEFAULT_PAY_METHOD,
    expressTypeId: DEFAULT_EXPRESS_TYPE_ID,
    parcelQty: DEFAULT_PARCEL_QTY,
    remark: trimString(order.customerRemark).slice(0, 100),
  };
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

async function getAccessToken(forceRefresh = false) {
  const result = await cloud.callFunction({
    name: 'getSfAccessToken',
    data: { forceRefresh },
  });

  const tokenResult = result.result || {};
  if (!tokenResult.success || !tokenResult.accessToken) {
    throw new Error(tokenResult.errMsg || '获取顺丰 accessToken 失败');
  }

  return tokenResult.accessToken;
}

async function callCreateOrder({ partnerID, accessToken, requestID, msgData }) {
  const body = new URLSearchParams({
    partnerID,
    requestID,
    serviceCode: SERVICE_CODE,
    timestamp: String(Date.now()),
    accessToken,
    msgData: JSON.stringify(msgData),
  });

  const response = await fetch(SERVICE_URL, {
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
    throw new Error(`顺丰下单接口返回非 JSON，HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(`顺丰下单接口 HTTP ${response.status}: ${result.apiErrorMsg || result.message || text}`);
  }

  return result;
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

function parseSfCreateOrderResponse(result) {
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
  const businessSuccess = apiResultData.success === true || apiResultData.success === 'true';
  const errorCode = apiResultData.errorCode || '';

  if (!businessSuccess || errorCode !== 'S0000') {
    return {
      success: false,
      errMsg: apiResultData.errorMsg || `顺丰业务下单失败: ${errorCode || 'UNKNOWN'}`,
      errorCode,
      raw: result,
      apiResultData,
    };
  }

  const waybillNo = msgData.waybillNoInfoList?.[0]?.waybillNo || '';
  if (!waybillNo) {
    return {
      success: false,
      errMsg: '顺丰下单成功但未返回运单号',
      errorCode,
      raw: result,
      apiResultData,
      msgData,
    };
  }

  return {
    success: true,
    waybillNo,
    sfOrderId: msgData.orderId || apiResultData.orderId || '',
    raw: result,
    apiResultData,
    msgData,
  };
}

async function applyCreateOrder({ partnerID, requestID, msgData }) {
  let accessToken = await getAccessToken(false);
  let result = await callCreateOrder({ partnerID, accessToken, requestID, msgData });
  let parsed = parseSfCreateOrderResponse(result);

  if (parsed.authFailed) {
    accessToken = await getAccessToken(true);
    result = await callCreateOrder({ partnerID, accessToken, requestID, msgData });
    parsed = parseSfCreateOrderResponse(result);
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

  const partnerID = trimString(process.env.SF_CLIENT_CODE);
  if (!partnerID) {
    return {
      success: false,
      errMsg: '缺少云函数环境变量 SF_CLIENT_CODE',
    };
  }

  let hasMarkedApplying = false;

  try {
    const order = await getOrder(orderId);
    validateOrder(order);
    const sender = getSenderConfig(order);

    const requestID = buildRequestID();
    const msgData = buildMsgData(order, orderId, sender);

    await updateOrder(orderId, {
      expressProvider: 'sf',
      expressApplyStatus: 'applying',
      expressErrorMsg: '',
      sfRequestId: requestID,
      sfOrderId: msgData.orderId,
      sfSenderContact: sender.contact,
      sfSenderTel: maskPhone(sender.tel),
    });
    hasMarkedApplying = true;

    const parsed = await applyCreateOrder({ partnerID, requestID, msgData });

    if (!parsed.success) {
      await updateOrder(orderId, {
        expressApplyStatus: 'failed',
        expressErrorMsg: parsed.errMsg,
        sfRawResponse: parsed.raw || null,
      });

      return {
        success: false,
        env: SF_ENV,
        errMsg: parsed.errMsg,
        errorCode: parsed.errorCode || '',
      };
    }

    await updateOrder(orderId, {
      status: 'shipped',
      trackingNumber: parsed.waybillNo,
      shippingFee: order.shippingFee || 'prepaid',
      expressProvider: 'sf',
      expressApplyStatus: 'applied',
      expressApplyTime: new Date().toISOString(),
      expressErrorMsg: '',
      sfRequestId: requestID,
      sfOrderId: parsed.sfOrderId || msgData.orderId,
      sfWaybillNo: parsed.waybillNo,
      sfRawResponse: parsed.raw,
    });

    return {
      success: true,
      env: SF_ENV,
      orderId,
      sfOrderId: parsed.sfOrderId || msgData.orderId,
      waybillNo: parsed.waybillNo,
    };
  } catch (err) {
    console.error('顺丰下快递单失败:', {
      orderId,
      message: err.message,
    });

    if (hasMarkedApplying) {
      try {
        await updateOrder(orderId, {
          expressApplyStatus: 'failed',
          expressErrorMsg: err.message || String(err),
        });
      } catch (updateErr) {
        console.error('写回顺丰下单失败状态失败:', {
          orderId,
          message: updateErr.message,
        });
      }
    }

    return {
      success: false,
      env: SF_ENV,
      orderId,
      errMsg: err.message || String(err),
    };
  }
};
