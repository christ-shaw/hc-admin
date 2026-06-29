/**
 * importOrderFromAssist - 接收 HC Order Assist 插件导入的待发货订单
 *
 * 鉴权：方案三 MVP —— 静态 API Token（Authorization: Bearer <token>）
 * 通过 CloudBase「HTTP 访问服务」绑定路径后，由浏览器扩展 fetch 调用。
 *
 * 职责：token 校验 -> 状态校验 -> 字段校验 -> 幂等 -> 映射写入 orders -> 写导入日志
 * 设计见 docs/order-assist-import-design.md
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const ORDERS_COLLECTION = 'orders';
const LOG_COLLECTION = 'order_import_logs';
const COUNTER_COLLECTION = 'system_counters';
const PRODUCT_MODELS_COLLECTION = 'product_models';
const ORDER_SERIAL_COUNTER = 'orderSerialNumber';
const SOURCE = 'zanchenzu';
const PENDING_SHIPMENT_TEXT = '待发货';
// 货品三级（brand/productName/specification）、销售渠道、人员（responsiblePerson）由插件选择后传入
const REQUIRED_FIELDS = ['sourceOrderNo', 'recipient', 'recipientPhone', 'recipientAddress', 'salesChannel', 'responsiblePerson', 'brand', 'productName', 'specification'];

const SALESPERSON_DICT_GROUP = 'salesperson';

// 固定业务字段（按需求）
const FIXED_ORDER_SOURCE = 'new';        // 订单来源：新增
const FIXED_ORDER_ATTRIBUTE = 'rental1'; // 订单属性：租赁1
const FIXED_ORDER_TYPE = 'newBusiness';  // 订单类型：新增业务

// 销售渠道枚举（与 hc-admin src/data/dict.ts 的 SALES_CHANNEL_MAP 保持一致）
const SALES_CHANNEL_MAP = {
  aRrz: 'A人人租', fRrz: 'F人人租', yuntu: '云途', huizuji: '汇租机', zujile: '租机乐',
  zhuoshi: '倬石电子', yunjie: '云界互联', jikejuzhen: '极客矩阵', jisushanzu: '极速闪租',
  lRrz: 'L人人租', jRrz: 'J人人租', gRrz: 'G人人租',
  xZz: 'X/ZZ', xLl: 'X/LL', xXx: 'X/XX', xYy: 'X/YY', xHh: 'X/HH',
};
const SALES_CHANNEL_OPTIONS = Object.keys(SALES_CHANNEL_MAP).map((k) => ({ value: k, label: SALES_CHANNEL_MAP[k] }));
const SALES_CHANNEL_KEYS = new Set(Object.keys(SALES_CHANNEL_MAP));

// ============ 工具 ============

function isNotFound(err) {
  const message = String((err && err.message) || '');
  return err && (err.errCode === -1 || err.errCode === -502005
    || message.includes('not exist') || message.includes('does not exist'));
}

function isDuplicateId(err) {
  const message = String((err && err.message) || '');
  // CloudBase 文档主键冲突的常见表现
  return err && (err.errCode === -502001 || message.includes('duplicate') || message.includes('已存在'));
}

// 统一返回：CloudBase「HTTP 访问服务」集成响应（带真实状态码）
function httpResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  };
}

function ok(code, message, data) {
  return httpResponse(200, { success: true, code, message, data: data || {} });
}

function fail(statusCode, code, message) {
  return httpResponse(statusCode, { success: false, code, message });
}

// 解析 HTTP 访问服务的请求体；兼容直接 callFunction（event 即为业务参数）
function parseEvent(event) {
  const isHttp = event && (event.httpMethod || event.headers || typeof event.body === 'string');
  if (!isHttp) {
    return { isHttp: false, headers: {}, payload: event || {} };
  }

  const headers = {};
  Object.keys(event.headers || {}).forEach((k) => {
    headers[k.toLowerCase()] = event.headers[k];
  });

  let raw = event.body || '';
  if (raw && event.isBase64Encoded) {
    raw = Buffer.from(raw, 'base64').toString('utf8');
  }

  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      payload = { __parseError: true };
    }
  }

  return { isHttp: true, headers, payload, httpMethod: event.httpMethod };
}

function getBearerToken(headers) {
  const value = headers.authorization || headers.Authorization || '';
  const match = String(value).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function isPendingShipment(order) {
  const code = String((order && order.sourceStatusCode) || '').trim();
  if (code) return code === 'PENDING_SHIPMENT';
  const text = String((order && order.sourceStatus) || '').trim();
  return text.includes(PENDING_SHIPMENT_TEXT);
}

// 序号自增（复刻 getAndIncrementCounter 的事务逻辑，集合 system_counters）
async function getNextSerialNumber() {
  const MAX_RETRY = 3;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    const transaction = await db.startTransaction();
    try {
      let currentValue = 0;
      let docExists = true;
      try {
        const result = await transaction.collection(COUNTER_COLLECTION).doc(ORDER_SERIAL_COUNTER).get();
        currentValue = (result.data && result.data.value) || 0;
      } catch (err) {
        if (isNotFound(err)) { docExists = false; currentValue = 0; } else { throw err; }
      }
      const newValue = currentValue + 1;
      if (docExists) {
        await transaction.collection(COUNTER_COLLECTION).doc(ORDER_SERIAL_COUNTER).update({
          data: { value: newValue, updatedAt: db.serverDate() },
        });
      } else {
        await transaction.collection(COUNTER_COLLECTION).add({
          data: { _id: ORDER_SERIAL_COUNTER, value: newValue, updatedAt: db.serverDate() },
        });
      }
      await transaction.commit();
      return newValue;
    } catch (err) {
      try { await transaction.rollback(); } catch (_) {}
      const retryable = err.errCode === -1 || /conflict|retry|transaction/.test(String(err.message || ''));
      if (retryable && attempt < MAX_RETRY) continue;
      throw err;
    }
  }
  throw new Error('计数器事务重试耗尽');
}

// 当天日期（北京时间，格式 YYYY-MM-DD），与前端建单的 date 一致
function todayInBeijing() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

// 读取某字典分组的启用项（dict_items），返回 [{value,label}]
async function fetchDictItems(groupCode) {
  const res = await db.collection('dict_items')
    .where({ groupCode, enabled: true })
    .orderBy('sort', 'asc')
    .limit(1000)
    .get();
  return (res.data || []).map((d) => ({ value: d.value, label: d.label || d.value }));
}

// 读取启用的货品三级结构（brand -> products -> specs），供插件选择
async function fetchProductModels() {
  const res = await db.collection(PRODUCT_MODELS_COLLECTION)
    .where({ enabled: true })
    .orderBy('sort', 'asc')
    .limit(1000)
    .get();
  const docs = (res.data || []);
  return docs.map((doc) => {
    const products = (doc.products || [])
      .filter((p) => p && p.enabled !== false)
      .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
      .map((p) => ({
        name: p.name,
        specs: (p.specs || [])
          .filter((s) => s && s.enabled !== false)
          .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
          .map((s) => s.name),
      }));
    return { brand: doc.brand, products };
  }).filter((b) => b.brand && b.products.length > 0);
}

// 插件 normalized 字段 -> orders 集合字段（扁平结构，与前端建单一致）
function mapToOrder(order, serialNumber, now) {
  const quantity = Number(order.goodsQuantity) || 1;
  const goodsTitle = String(order.goodsTitle || '').trim();
  // 原始页面商品名作为参考写入客服备注
  const remark = goodsTitle ? `【赞晨租导入】原商品：${goodsTitle}` : '【赞晨租导入】';
  return {
    serialNumber,
    date: todayInBeijing(),                // 订单日期固定为当天
    orderSource: FIXED_ORDER_SOURCE,       // 新增
    orderAttribute: FIXED_ORDER_ATTRIBUTE, // 租赁1
    orderType: FIXED_ORDER_TYPE,           // 新增业务
    salesChannel: order.salesChannel || '',// 插件按商户名称判定后传入（SALES_CHANNEL_MAP 的 key）
    salesperson: order.responsiblePerson || '',
    channelCategory: 'platform',           // 固定：平台
    onlineOrderNumber: order.sourceOrderNo || '',
    customerName: order.recipient || '',
    brand: order.brand || '',              // 插件从 manageProductModels 选择
    productName: order.productName || '',  // 选中的货品名
    specification: order.specification || '', // 选中的规格
    quantity,
    unitPrice: 0,
    amount: 0,
    paymentAccount: '',
    paymentSplits: [],
    trackingNumber: '',
    consignee: order.recipient || '',
    consigneePhone: order.recipientPhone || '',
    consigneeAddress: order.recipientAddress || '',
    shippingFee: '',
    status: 'unknown',                     // = '--'，待发货态，可进入发货/申请快递流程
    customerRemark: remark,
    transferBrand: '',
    transferProductName: '',
    transferSpecification: '',
    paidPeriod: 0,
    paidRent: 0,                           // 暂忽略插件 paidRent
    transferItems: '',
    attachments: [],
    returnStatus: '',
    returnTrackingNumbers: '',
    importSource: 'hc-order-assist',       // 来源标记（额外字段，UI 忽略）
    createTime: now,
  };
}

// ============ 主流程 ============

exports.main = async (event) => {
  const { isHttp, headers, payload } = parseEvent(event);

  // 只接受 POST（HTTP 模式）
  if (isHttp && event.httpMethod && String(event.httpMethod).toUpperCase() !== 'POST') {
    return fail(405, 'METHOD_NOT_ALLOWED', '仅支持 POST');
  }

  if (payload && payload.__parseError) {
    return fail(400, 'BAD_REQUEST', '请求体不是合法 JSON');
  }

  // 1. 鉴权：静态 token
  const expectedToken = process.env.HC_ORDER_ASSIST_TOKEN || '';
  if (!expectedToken) {
    console.error('[importOrderFromAssist] 未配置环境变量 HC_ORDER_ASSIST_TOKEN');
    return fail(500, 'INTERNAL_ERROR', '服务端未配置鉴权 token');
  }
  const token = isHttp ? getBearerToken(headers) : (payload.apiToken || '');
  if (!token) return fail(401, 'LOGIN_REQUIRED', '缺少 Authorization token');
  if (token !== expectedToken) return fail(401, 'LOGIN_REQUIRED', 'token 无效');

  // 按来源订单号查 hc-admin 订单的快递单号
  if (payload && payload.action === 'getTracking') {
    const sn = String(payload.sourceOrderNo || '').trim();
    if (!sn) return fail(422, 'MISSING_FIELDS', '缺少 sourceOrderNo');
    try {
      const res = await db.collection(ORDERS_COLLECTION)
        .where({ onlineOrderNumber: sn })
        .limit(20)
        .get();
      const docs = res.data || [];
      if (docs.length === 0) {
        return ok('NOT_FOUND', '未找到订单', { found: false });
      }
      // 优先取已有快递单号的那条
      const withTracking = docs.find((d) => String(d.trackingNumber || '').trim());
      const doc = withTracking || docs[0];
      return ok('OK', '查询成功', {
        found: true,
        trackingNumber: String(doc.trackingNumber || '').trim(),
        sfWaybillNo: String(doc.sfWaybillNo || '').trim(),
        expressProvider: doc.expressProvider || '',
        status: doc.status || '',
        serialNumber: doc.serialNumber,
      });
    } catch (err) {
      console.error('[importOrderFromAssist] 查快递单号失败:', err);
      return fail(500, 'INTERNAL_ERROR', err.message || '查快递单号失败');
    }
  }

  // 取货品三级结构（供插件下拉选择）；与销售渠道枚举一并返回
  if (payload && payload.action === 'getProductModels') {
    try {
      const [brands, salespersons] = await Promise.all([
        fetchProductModels(),
        fetchDictItems(SALESPERSON_DICT_GROUP),
      ]);
      return ok('OK', '获取成功', { brands, salesChannels: SALES_CHANNEL_OPTIONS, salespersons });
    } catch (err) {
      console.error('[importOrderFromAssist] 获取货品失败:', err);
      return fail(500, 'INTERNAL_ERROR', err.message || '获取货品失败');
    }
  }

  const order = (payload && payload.order) || {};
  const operator = (payload && payload.operator) || {};
  const sourceOrderNo = String(order.sourceOrderNo || '').trim();

  // 2. 状态校验
  if (!isPendingShipment(order)) {
    return fail(400, 'INVALID_STATUS', '只有待发货订单允许导入');
  }

  // 3. 字段校验
  const missing = REQUIRED_FIELDS.filter((f) => !String(order[f] || '').trim());
  if (missing.length > 0) {
    return fail(422, 'MISSING_FIELDS', '缺少必填字段: ' + missing.join(', '));
  }
  if (!SALES_CHANNEL_KEYS.has(String(order.salesChannel))) {
    return fail(422, 'INVALID_FIELD', `salesChannel 非法: ${order.salesChannel}`);
  }

  const importKey = `${SOURCE}_${sourceOrderNo}`;
  const now = db.serverDate();

  // 4. 幂等锁：先抢占日志 _id，重复则直接返回已有订单
  try {
    await db.collection(LOG_COLLECTION).add({
      data: {
        _id: importKey,
        source: SOURCE,
        sourceOrderNo,
        operatorId: operator.uid || '',
        operatorName: operator.username || '',
        rawPayload: order.raw || null,
        status: 'pending',
        createdOrderId: '',
        errorMessage: '',
        createTime: now,
      },
    });
  } catch (err) {
    if (isDuplicateId(err)) {
      let existingOrderId = '';
      try {
        const existing = await db.collection(LOG_COLLECTION).doc(importKey).get();
        existingOrderId = (existing.data && existing.data.createdOrderId) || '';
      } catch (readErr) {
        if (!isNotFound(readErr)) throw readErr;
      }
      return ok('DUPLICATED', '订单已存在', { orderId: existingOrderId, duplicated: true });
    }
    console.error('[importOrderFromAssist] 写入幂等锁失败:', err);
    return fail(500, 'INTERNAL_ERROR', err.message || '导入失败');
  }

  // 5. 映射并写入 orders
  let createdOrderId = '';
  try {
    const serialNumber = await getNextSerialNumber();
    const orderDoc = mapToOrder(order, serialNumber, now);
    const addRes = await db.collection(ORDERS_COLLECTION).add({ data: orderDoc });
    createdOrderId = addRes._id;

    await db.collection(LOG_COLLECTION).doc(importKey).update({
      data: {
        status: 'success',
        createdOrderId,
        normalizedPayload: orderDoc,
      },
    });

    return ok('CREATED', '订单创建成功', { orderId: createdOrderId });
  } catch (err) {
    console.error('[importOrderFromAssist] 创建订单失败:', err);
    // 回写失败原因，便于排查；保留锁避免脏数据反复写入
    try {
      await db.collection(LOG_COLLECTION).doc(importKey).update({
        data: { status: 'failed', errorMessage: err.message || '创建订单失败' },
      });
    } catch (logErr) {
      console.error('[importOrderFromAssist] 回写失败日志出错:', logErr);
    }
    return fail(500, 'INTERNAL_ERROR', err.message || '创建订单失败');
  }
};
