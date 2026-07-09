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
 * SF_CLIENT_CODE           默认顺丰客户编码
 * SF_SANDBOX_CLIENT_CODE   沙箱客户编码（可选，优先于 SF_CLIENT_CODE）
 * SF_PROD_CLIENT_CODE      生产客户编码（可选，优先于 SF_CLIENT_CODE）
 * SF_SANDBOX_SERVICE_URL   沙箱业务接口地址（可选）
 * SF_PROD_SERVICE_URL      生产业务接口地址（可选）
 * SF_PAY_METHOD            付款方式，默认 1
 * SF_MONTHLY_CARD          顺丰月结卡号（可选）
 * SF_EXPRESS_TYPE_ID       快件产品类别，默认 1
 * SF_PARCEL_QTY            包裹数，默认 1
 * SF_SENDER_MAP            按订单人员切换寄件人，JSON 对象（可选）
 * SF_SENDER_CONTACT        默认寄件人
 * SF_SENDER_TEL            默认寄件电话
 * SF_SENDER_COMPANY        默认寄件公司（可选）
 * SF_SENDER_PROVINCE       默认寄件省（可选）
 * SF_SENDER_CITY           默认寄件市（可选）
 * SF_SENDER_COUNTY         默认寄件区县（可选）
 * SF_SENDER_ADDRESS        默认寄件详细地址
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

function getSfConfig(env) {
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

  return {
    env,
    partnerID,
    serviceUrl,
    payMethod: getPositiveIntegerEnv('SF_PAY_METHOD', 1),
    monthlyCard: getFirstEnv(['SF_MONTHLY_CARD', 'SF_MONTHLY_CARD_NO']),
    expressTypeId: getPositiveIntegerEnv('SF_EXPRESS_TYPE_ID', 1),
    parcelQty: getPositiveIntegerEnv('SF_PARCEL_QTY', 1),
    duplicateRetryLimit: getPositiveIntegerEnv('SF_DUPLICATE_ORDER_RETRY_LIMIT', 5),
  };
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

function buildSfOrderId(orderId, seq = 1) {
  const normalized = trimString(orderId).replace(/[^a-zA-Z0-9_-]/g, '');
  // 顺丰规定客户订单号取消后不可复用，取消重下时用 _2/_3 序号生成新单号
  const suffix = seq > 1 ? `_${seq}` : '';
  return `HC_${normalized}`.slice(0, 64 - suffix.length) + suffix;
}

function inferSfOrderIdSeq(order, orderId) {
  const configuredSeq = Math.max(1, Number(order.sfOrderIdSeq || 1) || 1);
  const sfOrderId = trimString(order.sfOrderId);
  if (!sfOrderId) return configuredSeq;

  const firstOrderId = buildSfOrderId(orderId, 1);
  if (sfOrderId === firstOrderId) return configuredSeq;

  const matched = sfOrderId.match(/_(\d+)$/);
  if (!matched) return configuredSeq;

  const suffixSeq = Number(matched[1]);
  if (!Number.isInteger(suffixSeq) || suffixSeq <= 1) return configuredSeq;
  return Math.max(configuredSeq, suffixSeq);
}

function hasCancelledSfOrder(order) {
  return order.expressApplyStatus === 'cancelled'
    || Boolean(order.expressCancelTime)
    || Boolean(order.sfCancelRequestId);
}

function resolveSfOrderId(order, orderId) {
  const wasCancelled = hasCancelledSfOrder(order);
  const currentSeq = inferSfOrderIdSeq(order, orderId);
  const seq = wasCancelled ? currentSeq + 1 : currentSeq;
  const sfOrderId = !wasCancelled && trimString(order.sfOrderId)
    ? trimString(order.sfOrderId)
    : buildSfOrderId(orderId, seq);
  return { sfOrderId, seq };
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
  if (order.sfWaybillNo || order.trackingNumber) throw new Error('订单已存在快递单号，请勿重复申请');
  if (order.expressApplyStatus === 'applying') throw new Error('订单正在申请快递，请稍后再试');
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
  const items = getOrderProducts(order).filter(item => trimString(item.productName));
  return items.map(item => {
    const productName = trimString(item.productName);
    const specification = trimString(item.specification);
    const name = specification && specification !== '默认'
      ? `${productName} ${specification}`.slice(0, 128)
      : productName.slice(0, 128);
    return {
      name,
      count: Number(item.quantity || 1) || 1,
      unit: '件',
    };
  });
}

function buildMsgData(order, sfOrderId, sender, config) {
  const msgData = {
    language: 'zh-CN',
    orderId: sfOrderId,
    cargoDetails: buildCargoDetails(order),
    contactInfoList: buildContactInfoList(order, sender),
    payMethod: config.payMethod,
    expressTypeId: config.expressTypeId,
    parcelQty: config.parcelQty,
    remark: trimString(order.customerRemark).slice(0, 100),
  };

  if (config.monthlyCard) {
    msgData.monthlyCard = config.monthlyCard;
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

async function recoverDuplicateOrder({ orderId }) {
  const result = await cloud.callFunction({
    name: 'querySfOrderResult',
    data: { orderId, searchType: '1' },
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

async function markApplyingOrder({ orderId, config, requestID, msgData, seq, sender }) {
  await updateOrder(orderId, {
    expressProvider: 'sf',
    sfEnv: config.env,
    expressApplyStatus: 'applying',
    expressErrorMsg: '',
    sfRequestId: requestID,
    sfOrderId: msgData.orderId,
    sfOrderIdSeq: seq,
    sfSenderContact: sender.contact,
    sfSenderTel: maskPhone(sender.tel),
  });
}

async function markFailedOrder({ orderId, parsed }) {
  await updateOrder(orderId, {
    expressApplyStatus: 'failed',
    expressErrorMsg: parsed.errMsg,
    sfRawResponse: parsed.raw || null,
  });
}

exports.main = async (event) => {
  const { orderId } = event.data || {};

  if (!orderId) {
    return {
      success: false,
      errMsg: '缺少订单ID',
    };
  }

  let hasMarkedApplying = false;

  try {
    const env = await resolveSfEnv();
    const config = getSfConfig(env);
    const order = await getOrder(orderId);
    validateOrder(order);
    const sender = getSenderConfig(order);

    const resolved = resolveSfOrderId(order, orderId);
    let nextSeq = resolved.seq;
    let lastParsed = null;

    for (let attempt = 1; attempt <= config.duplicateRetryLimit; attempt += 1) {
      const sfOrderId = attempt === 1 ? resolved.sfOrderId : buildSfOrderId(orderId, nextSeq);
      const requestID = buildRequestID();
      const msgData = buildMsgData(order, sfOrderId, sender, config);

      await markApplyingOrder({ orderId, config, requestID, msgData, seq: nextSeq, sender });
      hasMarkedApplying = true;

      const parsed = await applyCreateOrder({ config, requestID, msgData });
      lastParsed = parsed;

      if (parsed.success) {
        await updateOrder(orderId, {
          status: 'shipped',
          trackingNumber: parsed.waybillNo,
          shippingFee: order.shippingFee || 'prepaid',
          expressProvider: 'sf',
          sfEnv: config.env,
          expressApplyStatus: 'applied',
          expressApplyTime: new Date().toISOString(),
          expressErrorMsg: '',
          sfRequestId: requestID,
          sfOrderId: parsed.sfOrderId || msgData.orderId,
          sfWaybillNo: parsed.waybillNo,
          sfWaybillNoInfoList: parsed.waybillNoInfoList || [],
          sfRawResponse: parsed.raw,
        });

        return {
          success: true,
          env: config.env,
          orderId,
          sfOrderId: parsed.sfOrderId || msgData.orderId,
          waybillNo: parsed.waybillNo,
          waybillNoInfoList: parsed.waybillNoInfoList || [],
        };
      }

      if (parsed.duplicateOrder) {
        const recovered = await recoverDuplicateOrder({ orderId }).catch(err => ({
          success: false,
          errMsg: err.message || String(err),
        }));
        if (recovered.success) {
          return {
            success: true,
            env: recovered.env || config.env,
            orderId,
            sfOrderId: recovered.sfOrderId || msgData.orderId,
            waybillNo: recovered.waybillNo,
            waybillNoInfoList: recovered.waybillNoInfoList || [],
            recoveredFromDuplicate: true,
          };
        }

        if (shouldRetryWithNextSfOrderId(recovered) && attempt < config.duplicateRetryLimit) {
          nextSeq += 1;
          continue;
        }

        parsed.errMsg = `${parsed.errMsg}；已自动查询顺丰订单但未恢复成功：${recovered.errMsg || '未知错误'}`;
      }

      await markFailedOrder({ orderId, parsed });

      return {
        success: false,
        env: config.env,
        orderId,
        sfOrderId: msgData.orderId,
        errMsg: parsed.errMsg,
        errorCode: parsed.errorCode || '',
      };
    }

    const errMsg = lastParsed?.errMsg || '顺丰下单失败，已达到重复客户订单号自动换号重试上限';
    await markFailedOrder({ orderId, parsed: { ...(lastParsed || {}), errMsg } });

    return {
      success: false,
      env: config.env,
      orderId,
      errMsg,
      errorCode: lastParsed?.errorCode || '',
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
      env: (() => {
        try { return normalizeSfEnv(); } catch { return trimString(process.env.SF_ENV) || 'sandbox'; }
      })(),
      orderId,
      errMsg: err.message || String(err),
    };
  }
};
