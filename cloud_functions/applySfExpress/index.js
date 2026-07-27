/**
 * applySfExpress - 顺丰下快递单
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
 * SF_SANDBOX_MONTHLY_CARD 沙箱月结卡号（可选）
 * SF_PROD_MONTHLY_CARD    生产月结卡号（包邮/寄方月结订单必填）
 * SF_SANDBOX_SENDER_MAP_BASE64 沙箱寄件人映射 JSON 的 Base64
 * SF_PROD_SENDER_MAP_BASE64    生产寄件人映射 JSON 的 Base64
 * SF_EXPRESS_TYPE_ID       快件产品类别，默认 2（顺丰标快）
 * SF_PARCEL_QTY            包裹数，默认 1
 * SF_SANDBOX_SENDER_*      沙箱默认寄件人配置（不使用映射时）
 * SF_PROD_SENDER_*         生产默认寄件人配置（不使用映射时）
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

const ORDERS_COLLECTION = 'orders';
const OUTBOUND_COLLECTION = 'outbound_records';
const SF_ORDERS_COLLECTION = 'sf_express_orders';
const TOKEN_COLLECTION = 'sf_tokens';
const CONFIG_COLLECTION = 'system_config';
const SF_CONFIG_DOC_ID = 'sf_express';
const SERVICE_CODE = 'EXP_RECE_CREATE_ORDER';
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

function getPositiveIntegerEnv(name, defaultValue) {
  const value = trimString(process.env[name]);
  if (!value) return defaultValue;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }

  return parsed;
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

async function assertDataModelV2() {
  try {
    const result = await db.collection(CONFIG_COLLECTION).doc(SF_CONFIG_DOC_ID).get();
    if (Number(result.data && result.data.dataModelVersion) !== 2) {
      throw new Error('顺丰独立订单模型尚未启用，请先完成 V2 切换');
    }
  } catch (error) {
    if (String(error && error.message || '').includes('尚未启用')) throw error;
    throw new Error('顺丰独立订单模型尚未启用，请先完成 V2 切换');
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

  return {
    env,
    partnerID,
    serviceUrl,
    monthlyCard: env === 'production'
      ? getFirstEnv([
        'SF_PROD_MONTHLY_CARD',
        'SF_PRODUCTION_MONTHLY_CARD',
      ])
      : getFirstEnv([
        'SF_SANDBOX_MONTHLY_CARD',
      ]),
    expressTypeId: getPositiveIntegerEnv('SF_EXPRESS_TYPE_ID', 2),
    parcelQty: getPositiveIntegerEnv('SF_PARCEL_QTY', 1),
    duplicateRetryLimit: getPositiveIntegerEnv('SF_DUPLICATE_ORDER_RETRY_LIMIT', 5),
  };
}

function isApplicableOrderStatus(status) {
  return status === 'unknown' || status === '--' || status === 'unshipped';
}

function normalizeShippingFee(value) {
  const normalized = trimString(value);
  if (['prepaid', '包邮', '寄付月结'].includes(normalized)) return 'prepaid';
  if (['cod', '到付', '收方付'].includes(normalized)) return 'cod';
  if (['pickup', '自提'].includes(normalized)) return 'pickup';
  return normalized;
}

function getOrderPaymentConfig(order, config) {
  const shippingFee = normalizeShippingFee(order.shippingFee);
  if (shippingFee === 'prepaid') {
    if (!config.monthlyCard) {
      throw new Error(
        `包邮订单缺少顺丰月结卡号配置 ${
          config.env === 'production' ? 'SF_PROD_MONTHLY_CARD' : 'SF_SANDBOX_MONTHLY_CARD'
        }`
      );
    }
    return { payMethod: 1, monthlyCard: config.monthlyCard };
  }
  if (shippingFee === 'cod') {
    return { payMethod: 2, monthlyCard: '' };
  }
  if (shippingFee === 'pickup') {
    throw new Error('自提订单不能生成顺丰单');
  }
  throw new Error('订单缺少包邮/到付快递方式，无法生成顺丰单');
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

function buildSfOrderId(orderId, seq = 1) {
  const normalized = trimString(orderId).replace(/[^a-zA-Z0-9_-]/g, '');
  // 顺丰规定客户订单号取消后不可复用，取消重下时用 _2/_3 序号生成新单号
  const suffix = seq > 1 ? `_${seq}` : '';
  return `HC_${normalized}`.slice(0, 64 - suffix.length) + suffix;
}

function buildSfRecordId(env, orderId, attemptNo) {
  return crypto.createHash('sha256')
    .update(`${env}:${orderId}:${attemptNo}`)
    .digest('hex');
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

function getDefaultSenderConfig(env) {
  const prefix = env === 'production' ? 'SF_PROD_SENDER_' : 'SF_SANDBOX_SENDER_';
  const sender = normalizeSenderConfig({
    contact: process.env[`${prefix}CONTACT`],
    tel: process.env[`${prefix}TEL`],
    company: process.env[`${prefix}COMPANY`],
    country: 'CN',
    province: process.env[`${prefix}PROVINCE`],
    city: process.env[`${prefix}CITY`],
    county: process.env[`${prefix}COUNTY`],
    address: process.env[`${prefix}ADDRESS`],
  });

  validateSenderConfig(sender, `${env === 'production' ? '生产' : '沙箱'}默认寄件人配置`);

  return sender;
}

function parseSenderMap(env) {
  const variableName = env === 'production' ? 'SF_PROD_SENDER_MAP' : 'SF_SANDBOX_SENDER_MAP';
  const base64VariableName = `${variableName}_BASE64`;
  const encodedText = trimString(process.env[base64VariableName]);
  const text = encodedText
    ? Buffer.from(encodedText, 'base64').toString('utf8')
    : trimString(process.env[variableName]);
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${variableName} 必须是 JSON 对象`);
    }
    return parsed;
  } catch (err) {
    throw new Error(`${encodedText ? base64VariableName : variableName} 解析失败: ${err.message}`);
  }
}

function findSenderMapEntry(senderMap, salespersonValue) {
  const salesperson = trimString(salespersonValue);
  if (!salesperson) {
    throw new Error('订单缺少人员，无法匹配顺丰寄件人配置');
  }

  const normalizedSalesperson = salesperson.toLowerCase();
  const matches = Object.entries(senderMap).filter(
    ([key]) => trimString(key).toLowerCase() === normalizedSalesperson
  );
  if (matches.length === 0) {
    throw new Error(`未配置人员「${salesperson}」的顺丰寄件人信息`);
  }
  if (matches.length > 1) {
    throw new Error(`顺丰寄件人映射存在多个忽略大小写后相同的人员「${salesperson}」`);
  }
  return matches[0][1];
}

function getSenderConfig(order, env) {
  const senderMap = parseSenderMap(env);
  if (!senderMap) return getDefaultSenderConfig(env);

  const salesperson = trimString(order.salesperson);
  const rawSender = findSenderMapEntry(senderMap, salesperson);
  const sender = normalizeSenderConfig(rawSender);
  validateSenderConfig(sender, `人员「${salesperson}」的寄件人配置`);
  return sender;
}

// 读取订单货品明细：新结构 products 数组，旧扁平字段回退为单货品
function getOrderProducts(order) {
  if (Array.isArray(order.products) && order.products.length > 0) return order.products;
  if (order.productName || order.brand || order.quantity) {
    return [{
      brand: order.brand || '',
      productName: order.productName || '',
      specification: order.specification || '',
      quantity: Number(order.quantity) || 0,
    }];
  }
  return [];
}

function validateOrder(order) {
  if (!order) throw new Error('订单不存在');
  if (order.trackingNumber) throw new Error('订单已存在快递单号，请勿重复申请');
  if (!isApplicableOrderStatus(order.status)) throw new Error('仅订单状态为 -- 的订单可申请快递');
  if (!trimString(order.consignee)) throw new Error('收货人名称不能为空');
  if (!trimString(order.consigneePhone)) throw new Error('收货人电话不能为空');
  if (!trimString(order.consigneeAddress)) throw new Error('收货人地址不能为空');
  if (!getOrderProducts(order).some(item => trimString(item.productName))) throw new Error('货品名称不能为空');
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
  const totalCount = getOrderProducts(order).reduce((sum, item) => {
    const quantity = Number(item.quantity);
    return sum + (Number.isFinite(quantity) && quantity > 0 ? Math.trunc(quantity) : 1);
  }, 0);
  return [{
    name: '电子产品',
    count: Math.max(1, totalCount),
    unit: '件',
  }];
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
      const quantity = Number(item.quantity);
      return `${label}×${Number.isFinite(quantity) && quantity > 0 ? quantity : 0}`;
    })
    .filter(Boolean)
    .join('，');
  return summary ? `客户下单：${summary}` : '';
}

function mergeRemarkParts(parts, limit) {
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
  const remark = merged.join('；');
  return limit ? remark.slice(0, limit) : remark;
}

function buildOrderRemark(order, limit = 500) {
  return mergeRemarkParts([
    buildOrderProductsRemark(order),
    trimString(order && order.customerRemark),
  ], limit);
}

function buildMsgData(order, sfOrderId, sender, config) {
  const payment = getOrderPaymentConfig(order, config);
  const msgData = {
    language: 'zh-CN',
    orderId: sfOrderId,
    cargoDetails: buildCargoDetails(order),
    contactInfoList: buildContactInfoList(order, sender),
    payMethod: payment.payMethod,
    expressTypeId: config.expressTypeId,
    parcelQty: config.parcelQty,
    remark: buildOrderRemark(order, 100),
  };

  if (payment.monthlyCard) {
    msgData.monthlyCard = payment.monthlyCard;
  }

  return msgData;
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

async function resolveOrderShippingFee(order) {
  if (!order || trimString(order.shippingFee) || !trimString(order.outboundRecordId)) return order;
  try {
    const result = await db.collection(OUTBOUND_COLLECTION).doc(trimString(order.outboundRecordId)).get();
    const shippingMethod = trimString(result.data && result.data.shippingMethod);
    return shippingMethod ? { ...order, shippingFee: shippingMethod } : order;
  } catch (err) {
    return order;
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

function isNotFound(error) {
  const message = String(error && error.message || '');
  return !!error && (
    error.errCode === -1
    || error.errCode === -502005
    || message.includes('not exist')
    || message.includes('does not exist')
  );
}

async function ensureCollection(collectionName) {
  try {
    await db.collection(collectionName).limit(1).get();
  } catch (error) {
    if (!isNotFound(error)) throw error;
    if (typeof db.createCollection !== 'function') {
      throw new Error(`数据库集合不存在: ${collectionName}`);
    }
    try {
      await db.createCollection(collectionName);
    } catch (createError) {
      const message = String(createError && createError.message || '');
      if (!message.includes('already exists') && !message.includes('exists')) throw createError;
    }
  }
}

async function getSfRecord(recordId) {
  try {
    const result = await db.collection(SF_ORDERS_COLLECTION).doc(recordId).get();
    return result.data || null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function getSfRecordsBySource(orderId, env) {
  try {
    const result = await db.collection(SF_ORDERS_COLLECTION)
      .where({ sourceOrderId: orderId, env })
      .limit(100)
      .get();
    return result.data || [];
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

function getCurrentSfRecord(records) {
  return records
    .filter(record => record.isCurrent === true)
    .sort((a, b) => Number(b.attemptNo || 0) - Number(a.attemptNo || 0))[0] || null;
}

function planSfAttempt(records, orderId) {
  const current = getCurrentSfRecord(records);
  if (current && current.status === 'applied') return { action: 'reject_applied', current };
  if (current && current.status === 'applying') return { action: 'reject_applying', current };
  if (current && current.status === 'failed') {
    return {
      action: 'retry',
      current,
      attemptNo: Number(current.attemptNo || 1),
      sfOrderId: current.sfOrderId,
    };
  }
  const maxAttemptNo = records.reduce(
    (max, record) => Math.max(max, Number(record.attemptNo || 0)),
    0
  );
  const attemptNo = Math.max(1, maxAttemptNo + 1);
  return {
    action: 'create',
    current,
    attemptNo,
    sfOrderId: buildSfOrderId(orderId, attemptNo),
  };
}

function sanitizeForStorage(value, key = '') {
  if (value === null || value === undefined) return value;
  const normalizedKey = String(key).toLowerCase();
  if (normalizedKey.includes('token') || normalizedKey.includes('authorization')) return '[REDACTED]';
  if (['tel', 'mobile', 'phone', 'consigneephone'].some(name => normalizedKey.includes(name))) {
    return maskPhone(value);
  }
  if (Array.isArray(value)) return value.map(item => sanitizeForStorage(item));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeForStorage(childValue, childKey)])
    );
  }
  if (typeof value === 'string') return value.slice(0, 4096);
  return value;
}

function toLimitedJson(value) {
  return JSON.stringify(sanitizeForStorage(value)).slice(0, 64 * 1024);
}

function buildOrderSnapshot(order) {
  const rawCustomerRemark = trimString(order.customerRemark).slice(0, 500);
  const productRemark = buildOrderProductsRemark(order).slice(0, 500);
  return {
    serialNumber: Number(order.serialNumber || 0),
    onlineOrderNumber: trimString(order.onlineOrderNumber),
    date: trimString(order.date),
    salesperson: trimString(order.salesperson),
    consignee: trimString(order.consignee),
    consigneePhone: maskPhone(order.consigneePhone),
    consigneeAddress: trimString(order.consigneeAddress),
    shippingFee: normalizeShippingFee(order.shippingFee),
    paymentAccount: trimString(order.paymentAccount),
    paymentSplits: sanitizeForStorage(order.paymentSplits || []),
    customerRemark: buildOrderRemark(order, 500),
    rawCustomerRemark,
    productRemark,
    products: getOrderProducts(order).map(item => ({
      brand: trimString(item.brand),
      productName: trimString(item.productName),
      specification: trimString(item.specification),
      quantity: Number(item.quantity || 0),
    })),
  };
}

function getOperatorId() {
  try {
    const context = cloud.getWXContext() || {};
    return trimString(context.OPENID || context.UNIONID || context.UID);
  } catch (_) {
    return '';
  }
}

async function createSfRecord({ order, env, attemptNo, sfOrderId, sender, requestID, msgData }) {
  const recordId = buildSfRecordId(env, order._id, attemptNo);
  const createdAt = new Date().toISOString();
  const data = {
    _id: recordId,
    sourceOrderId: order._id,
    sourceSerialNumber: Number(order.serialNumber || 0),
    sourceOnlineOrderNumber: trimString(order.onlineOrderNumber),
    sourceOrderDate: trimString(order.date),
    sfOrderId,
    attemptNo,
    env,
    isCurrent: true,
    status: 'applying',
    waybillNo: '',
    waybillNoInfoList: [],
    applyRequestId: requestID,
    applyRequestTime: createdAt,
    searchRequestId: '',
    searchTime: '',
    cancelRequestId: '',
    cancelRequestTime: '',
    applyTime: '',
    cancelTime: '',
    errorCode: '',
    errorMessage: '',
    orderSnapshot: buildOrderSnapshot(order),
    senderSnapshot: {
      contact: sender.contact,
      tel: maskPhone(sender.tel),
      company: sender.company,
      province: sender.province,
      city: sender.city,
      county: sender.county,
      address: sender.address,
    },
    requestSummary: toLimitedJson(msgData),
    responseSummary: '',
    printCount: 0,
    lastPrintTime: '',
    lastPrintRequestId: '',
    operatorId: getOperatorId(),
    createdAt,
    updatedAt: createdAt,
  };

  try {
    await db.collection(SF_ORDERS_COLLECTION).add({ data });
    return data;
  } catch (error) {
    const existing = await getSfRecord(recordId);
    if (existing) return existing;
    throw error;
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

async function prepareSfRecord({ order, config, sender }) {
  await ensureCollection(SF_ORDERS_COLLECTION);
  const records = await getSfRecordsBySource(order._id, config.env);
  const plan = planSfAttempt(records, order._id);
  const current = plan.current;

  if (plan.action === 'reject_applied') {
    throw new Error('该订单已成功生成顺丰单，请勿重复申请');
  }
  if (plan.action === 'reject_applying') {
    throw new Error('订单正在申请顺丰单，请稍后查询结果');
  }

  if (plan.action === 'retry') {
    const requestID = buildRequestID();
    const msgData = buildMsgData(order, plan.sfOrderId, sender, config);
    const claimResult = await db.collection(SF_ORDERS_COLLECTION)
      .where({
        _id: current._id,
        status: 'failed',
        isCurrent: true,
      })
      .update({
        data: {
          status: 'applying',
          applyRequestId: requestID,
          applyRequestTime: new Date().toISOString(),
          errorCode: '',
          errorMessage: '',
          requestSummary: toLimitedJson(msgData),
          updatedAt: new Date().toISOString(),
        },
      });
    if (!claimResult.stats || claimResult.stats.updated !== 1) {
      throw new Error('订单正在被其他请求申请顺丰单，请稍后查询结果');
    }
    const claimed = await getSfRecord(current._id);
    if (!claimed || claimed.applyRequestId !== requestID) {
      throw new Error('订单正在被其他请求申请顺丰单，请稍后查询结果');
    }
    return {
      ...claimed,
      requestID,
      msgData,
    };
  }

  const attemptNo = plan.attemptNo;
  const sfOrderId = plan.sfOrderId;
  const requestID = buildRequestID();
  const msgData = buildMsgData(order, sfOrderId, sender, config);

  if (current) {
    await updateSfRecord(current._id, { isCurrent: false });
  }
  let record;
  try {
    record = await createSfRecord({
      order,
      env: config.env,
      attemptNo,
      sfOrderId,
      sender,
      requestID,
      msgData,
    });
  } catch (error) {
    if (current) {
      try { await updateSfRecord(current._id, { isCurrent: true }); } catch (_) { /* ignore */ }
    }
    throw error;
  }
  if (record.status !== 'applying' || record.applyRequestId !== requestID) {
    throw new Error('订单正在被其他请求申请顺丰单，请稍后查询结果');
  }
  return { ...record, requestID, msgData };
}

async function prepareNextDuplicateRecord({ order, config, sender, currentRecord, parsed }) {
  await updateSfRecord(currentRecord._id, {
    status: 'failed',
    isCurrent: false,
    errorCode: trimString(parsed && parsed.errorCode),
    errorMessage: trimString(parsed && parsed.errMsg),
    responseSummary: toLimitedJson(parsed && parsed.raw),
  });

  const records = await getSfRecordsBySource(order._id, config.env);
  const maxAttemptNo = records.reduce(
    (max, record) => Math.max(max, Number(record.attemptNo || 0)),
    0
  );
  const attemptNo = Math.max(Number(currentRecord.attemptNo || 0) + 1, maxAttemptNo + 1);
  const sfOrderId = buildSfOrderId(order._id, attemptNo);
  const requestID = buildRequestID();
  const msgData = buildMsgData(order, sfOrderId, sender, config);
  let record;
  try {
    record = await createSfRecord({
      order,
      env: config.env,
      attemptNo,
      sfOrderId,
      sender,
      requestID,
      msgData,
    });
  } catch (error) {
    try { await updateSfRecord(currentRecord._id, { isCurrent: true }); } catch (_) { /* ignore */ }
    throw error;
  }
  if (record.status !== 'applying' || record.applyRequestId !== requestID) {
    throw new Error('订单正在被其他请求申请顺丰单，请稍后查询结果');
  }
  return {
    ...record,
    requestID,
    msgData,
  };
}

async function markSfApplied({ sfRecord, order, parsed, requestID }) {
  const appliedAt = new Date().toISOString();
  const transaction = await db.startTransaction();
  try {
    let currentOrderResult = null;
    try {
      currentOrderResult = await transaction.collection(ORDERS_COLLECTION).doc(order._id).get();
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

    await transaction.collection(SF_ORDERS_COLLECTION).doc(sfRecord._id).update({
      data: {
        status: 'applied',
        sfOrderId: parsed.sfOrderId || sfRecord.sfOrderId,
        waybillNo: parsed.waybillNo,
        waybillNoInfoList: parsed.waybillNoInfoList || [],
        applyRequestId: requestID,
        applyTime: appliedAt,
        errorCode: '',
        errorMessage: '',
        responseSummary: toLimitedJson(parsed.raw),
        updatedAt: appliedAt,
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
      appliedAt,
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

async function markSfFailed(sfRecord, parsed) {
  await updateSfRecord(sfRecord._id, {
    status: 'failed',
    errorCode: trimString(parsed && parsed.errorCode),
    errorMessage: trimString(parsed && parsed.errMsg) || '顺丰下单失败',
    responseSummary: toLimitedJson(parsed && parsed.raw),
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

function isDuplicateOrderError(errorCode, message) {
  const code = trimString(errorCode);
  const text = trimString(message).toLowerCase();
  return code === '8016'
    || text.includes('重复')
    || text.includes('duplicate')
    || text.includes('已存在')
    || text.includes('客户订单号');
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

function getPrimaryWaybillNo(waybillNoInfoList = []) {
  const list = normalizeWaybillNoInfoList(waybillNoInfoList);
  const primary = list.find(item => String(item.waybillType || '') === '1');
  return trimString((primary || list[0] || {}).waybillNo);
}

function parseSfCreateOrderResponse(result) {
  if (result.apiResultCode !== 'A1000') {
    const errMsg = result.apiErrorMsg || `顺丰平台调用失败: ${result.apiResultCode || 'UNKNOWN'}`;
    return {
      success: false,
      authFailed: result.apiResultCode === 'A1011',
      duplicateOrder: isDuplicateOrderError(result.apiResultCode, errMsg),
      errMsg,
      raw: result,
    };
  }

  const apiResultData = parseJsonMaybe(result.apiResultData);
  const msgData = parseJsonMaybe(apiResultData.msgData);
  const businessSuccess = apiResultData.success === true || apiResultData.success === 'true';
  const errorCode = apiResultData.errorCode || '';

  if (!businessSuccess || errorCode !== 'S0000') {
    const errMsg = apiResultData.errorMsg || `顺丰业务下单失败: ${errorCode || 'UNKNOWN'}`;
    return {
      success: false,
      duplicateOrder: isDuplicateOrderError(errorCode, errMsg),
      errMsg,
      errorCode,
      raw: result,
      apiResultData,
    };
  }

  const waybillNoInfoList = normalizeWaybillNoInfoList(msgData.waybillNoInfoList);
  const waybillNo = getPrimaryWaybillNo(waybillNoInfoList);
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
    waybillNoInfoList,
    sfOrderId: msgData.orderId || apiResultData.orderId || '',
    raw: result,
    apiResultData,
    msgData,
  };
}

async function callCreateOrder({ config, accessToken, requestID, msgData }) {
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
    throw new Error(`顺丰下单接口返回非 JSON，HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(`顺丰下单接口 HTTP ${response.status}: ${result.apiErrorMsg || result.message || text}`);
  }

  return result;
}

async function applyCreateOrder({ config, requestID, msgData }) {
  let accessToken = await getAccessToken(config, false);
  let result = await callCreateOrder({ config, accessToken, requestID, msgData });
  let parsed = parseSfCreateOrderResponse(result);

  if (parsed.authFailed) {
    accessToken = await getAccessToken(config, true);
    result = await callCreateOrder({ config, accessToken, requestID, msgData });
    parsed = parseSfCreateOrderResponse(result);
  }

  return parsed;
}

async function recoverDuplicateOrder({ sfExpressOrderId }) {
  const result = await cloud.callFunction({
    name: 'querySfOrderResult',
    data: { sfExpressOrderId, searchType: '1' },
  });
  return result.result || {};
}

function shouldRetryWithNextSfOrderId(recovered) {
  const errorCode = trimString(recovered.errorCode);
  const errMsg = trimString(recovered.errMsg);
  return errorCode === '8018'
    || errorCode === '6150'
    || errMsg.includes('未获取到订单信息')
    || errMsg.includes('找不到该订单')
    || errMsg.includes('未查询到订单')
    || errMsg.includes('订单不存在');
}

exports.main = async (event) => {
  const sourceOrderId = trimString((event.data || {}).sourceOrderId || (event.data || {}).orderId);

  if (!sourceOrderId) {
    return {
      success: false,
      errMsg: '缺少订单ID',
    };
  }

  let activeSfRecord = null;
  let resolvedEnv = '';

  try {
    const env = await resolveSfEnv();
    resolvedEnv = env;
    await assertDataModelV2();
    const config = getSfConfig(env);
    const order = await resolveOrderShippingFee(await getOrder(sourceOrderId));
    validateOrder(order);
    const sender = getSenderConfig(order, env);
    activeSfRecord = await prepareSfRecord({ order, config, sender });
    let lastParsed = null;

    for (let attempt = 1; attempt <= config.duplicateRetryLimit; attempt += 1) {
      const requestID = activeSfRecord.requestID || activeSfRecord.applyRequestId;
      const msgData = activeSfRecord.msgData
        || buildMsgData(order, activeSfRecord.sfOrderId, sender, config);
      const parsed = await applyCreateOrder({ config, requestID, msgData });
      lastParsed = parsed;

      if (parsed.success) {
        const appliedResult = await markSfApplied({
          sfRecord: activeSfRecord,
          order,
          parsed,
          requestID,
        });

        return {
          success: true,
          env: config.env,
          sourceOrderId,
          sfExpressOrderId: activeSfRecord._id,
          sfOrderId: parsed.sfOrderId || msgData.orderId,
          waybillNo: parsed.waybillNo,
          waybillNoInfoList: parsed.waybillNoInfoList || [],
          outboundSync: appliedResult.outboundSync,
        };
      }

      if (parsed.duplicateOrder) {
        const recovered = await recoverDuplicateOrder({
          sfExpressOrderId: activeSfRecord._id,
        }).catch(err => ({
          success: false,
          errMsg: err.message || String(err),
        }));
        if (recovered.success) {
          return {
            success: true,
            env: recovered.env || config.env,
            sourceOrderId,
            sfExpressOrderId: activeSfRecord._id,
            sfOrderId: recovered.sfOrderId || msgData.orderId,
            waybillNo: recovered.waybillNo,
            waybillNoInfoList: recovered.waybillNoInfoList || [],
            recoveredFromDuplicate: true,
          };
        }

        if (shouldRetryWithNextSfOrderId(recovered) && attempt < config.duplicateRetryLimit) {
          activeSfRecord = await prepareNextDuplicateRecord({
            order,
            config,
            sender,
            currentRecord: activeSfRecord,
            parsed,
          });
          continue;
        }

        parsed.errMsg = `${parsed.errMsg}；已自动查询顺丰订单但未恢复成功：${recovered.errMsg || '未知错误'}`;
      }

      await markSfFailed(activeSfRecord, parsed);

      return {
        success: false,
        env: config.env,
        sourceOrderId,
        sfExpressOrderId: activeSfRecord._id,
        sfOrderId: msgData.orderId,
        errMsg: parsed.errMsg,
        errorCode: parsed.errorCode || '',
      };
    }

    const errMsg = lastParsed?.errMsg || '顺丰下单失败，已达到重复客户订单号自动换号重试上限';
    await markSfFailed(activeSfRecord, { ...(lastParsed || {}), errMsg });

    return {
      success: false,
      env: config.env,
      sourceOrderId,
      sfExpressOrderId: activeSfRecord && activeSfRecord._id,
      errMsg,
      errorCode: lastParsed?.errorCode || '',
    };
  } catch (err) {
    console.error('顺丰下快递单失败:', {
      sourceOrderId,
      message: err.message,
    });

    if (activeSfRecord) {
      try {
        await markSfFailed(activeSfRecord, {
          errMsg: err.message || String(err),
          errorCode: '',
          raw: null,
        });
      } catch (updateErr) {
        console.error('写回顺丰下单失败状态失败:', {
          sourceOrderId,
          message: updateErr.message,
        });
      }
    }

    return {
      success: false,
      env: resolvedEnv || (() => {
        try { return normalizeSfEnv(); } catch { return trimString(process.env.SF_ENV) || 'sandbox'; }
      })(),
      sourceOrderId,
      sfExpressOrderId: activeSfRecord && activeSfRecord._id,
      errMsg: err.message || String(err),
    };
  }
};

exports.__test__ = {
  buildSfOrderId,
  buildSfRecordId,
  getCurrentSfRecord,
  planSfAttempt,
  sanitizeForStorage,
  findSenderMapEntry,
  buildCargoDetails,
  buildOrderProductsRemark,
  buildOrderRemark,
  buildMsgData,
  buildOrderSnapshot,
  planPendingOutboundTrackingSync,
};
