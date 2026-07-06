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
const _ = db.command;

const ORDERS_COLLECTION = 'orders';
const OUTBOUND_COLLECTION = 'outbound_records';
const LOG_COLLECTION = 'order_import_logs';
const COUNTER_COLLECTION = 'system_counters';
const PRODUCT_MODELS_COLLECTION = 'product_models';
const ORDER_SERIAL_COUNTER = 'orderSerialNumber';
const SOURCE = 'zanchenzu';
const PENDING_SHIPMENT_TEXT = '待发货';
// 货品三级（brand/productName/specification）、销售渠道、人员（responsiblePerson）由插件选择后传入
// 订单级必填（公共字段）与货品级必填（items[] 每项）分开校验
const REQUIRED_ORDER_FIELDS = ['sourceOrderNo', 'recipient', 'recipientPhone', 'recipientAddress', 'salesChannel', 'responsiblePerson'];
const REQUIRED_ITEM_FIELDS = ['sourceOrderItemNo', 'brand', 'productName', 'specification'];

const SALESPERSON_DICT_GROUP = 'salesperson';

// 自动生成出库单的快递方式（与 dict.ts SHIPPING_FEE_MAP 的 key 一致），非法值回退寄付
const SHIPPING_METHOD_KEYS = new Set(['prepaid', 'cod', 'pickup']);
const DEFAULT_SHIPPING_METHOD = 'prepaid';

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

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean).map((v) => String(v).trim()).filter(Boolean)));
}

function normalizePhotoList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((item) => normalizePhotoList(item));
  if (typeof value === 'object') {
    return normalizePhotoList(value.tempFileURL || value.tempFileUrl || value.url || value.fileUrl || value.path || value.fileID || value.fileId);
  }
  const text = String(value).trim();
  if (!text) return [];
  if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'))) {
    try { return normalizePhotoList(JSON.parse(text)); } catch (_) {}
  }
  return text.split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean);
}

async function toTempPhotoUrls(photos) {
  const list = unique(normalizePhotoList(photos));
  const cloudFileIds = list.filter((url) => /^cloud:\/\//i.test(url));
  const plainUrls = list.filter((url) => !/^cloud:\/\//i.test(url));
  if (cloudFileIds.length === 0) return plainUrls;

  try {
    const result = await cloud.getTempFileURL({ fileList: cloudFileIds });
    const tempUrls = (result.fileList || [])
      .map((item) => item.tempFileURL || item.fileID || '')
      .filter(Boolean);
    return unique([...plainUrls, ...tempUrls]);
  } catch (err) {
    console.error('[importOrderFromAssist] 转换出库照片临时链接失败:', err);
    return list;
  }
}

async function getDocById(collectionName, id) {
  if (!id) return null;
  try {
    const res = await db.collection(collectionName).doc(id).get();
    return res.data || null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function queryFirst(collectionName, condition) {
  const res = await db.collection(collectionName).where(condition).limit(1).get();
  return (res.data || [])[0] || null;
}

async function findOutboundForOrder(orderDoc) {
  if (!orderDoc) return null;

  const direct = await getDocById(OUTBOUND_COLLECTION, String(orderDoc.outboundRecordId || '').trim());
  if (direct) return direct;

  const orderId = String(orderDoc._id || '').trim();
  if (orderId) {
    const byOrderIds = await queryFirst(OUTBOUND_COLLECTION, { orderIds: _.in([orderId]) });
    if (byOrderIds) return byOrderIds;
  }

  const trackingNumber = String(orderDoc.trackingNumber || '').trim();
  if (trackingNumber) {
    const byTracking = await queryFirst(OUTBOUND_COLLECTION, { trackingNumber });
    if (byTracking) return byTracking;
  }

  return null;
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

// 归一化货品明细：新契约 order.items[] 一次多货品；不带 items 时兼容旧形态（顶层货品字段视为唯一条目）
function normalizeItems(order) {
  const rawItems = Array.isArray(order.items) && order.items.length > 0 ? order.items : [order];
  return rawItems.map((item) => ({
    sourceOrderItemNo: String((item && item.sourceOrderItemNo) || '').trim(),
    brand: String((item && item.brand) || '').trim(),          // 插件从 manageProductModels 选择
    productName: String((item && item.productName) || '').trim(),
    specification: String((item && item.specification) || '').trim(),
    goodsQuantity: Number(item && item.goodsQuantity) || 1,
    goodsTitle: String((item && item.goodsTitle) || '').trim(),
    raw: (item && item.raw) || null,
  }));
}

// 归一化后的货品项 -> 货品条目（orders.products 数组的一项）
function mapToProductItem(item) {
  return {
    brand: item.brand,
    productName: item.productName,
    specification: item.specification,
    quantity: item.goodsQuantity,
    unitPrice: 0,
    amount: 0,
    paymentAccount: '',
    paymentSplits: [],
    sourceOrderItemNo: item.sourceOrderItemNo, // 货品项幂等键（追加去重用）
  };
}

// 批量回写本次抢占的导入日志（成功/失败）；单条失败仅记录，不阻断主流程
async function updateImportLogs(lockedItems, data) {
  for (const { importKey } of lockedItems) {
    try {
      await db.collection(LOG_COLLECTION).doc(importKey).update({ data });
    } catch (err) {
      console.error('[importOrderFromAssist] 回写导入日志失败:', importKey, err);
    }
  }
}

// 旧扁平结构订单文档 -> 货品条目（追加货品前先把原扁平货品收进 products，避免被数组遮蔽丢失）
function legacyOrderToProductItem(doc) {
  return {
    brand: doc.brand || '',
    productName: doc.productName || '',
    specification: doc.specification || '',
    quantity: Number(doc.quantity) || 0,
    unitPrice: Number(doc.unitPrice) || 0,
    amount: Number(doc.amount) || 0,
    paymentAccount: doc.paymentAccount || '',
    paymentSplits: Array.isArray(doc.paymentSplits) ? doc.paymentSplits : [],
    sourceOrderItemNo: doc.sourceOrderItemNo || '',
  };
}

// 插件 normalized 字段 -> orders 集合字段（一条订单含 products 数组，同源订单多货品共用一条）
function mapToOrder(order, items, serialNumber, now) {
  // 客服备注 = 用户在导入弹窗填写的备注（可选）+ 原始页面商品名参考（多货品去重后合并）
  const titles = Array.from(new Set(
    items.map((it) => it.goodsTitle).concat([String(order.goodsTitle || '').trim()]).filter(Boolean)
  ));
  const autoRemark = titles.length > 0 ? `【赞晨租导入】原商品：${titles.join('；')}` : '【赞晨租导入】';
  const userRemark = String(order.remark || '').trim();
  const remark = userRemark ? `${userRemark}；${autoRemark}` : autoRemark;
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
    products: items.map(mapToProductItem),
    trackingNumber: '',
    sourceOrderItemNo: (items[0] && items[0].sourceOrderItemNo) || '',
    consignee: order.recipient || '',
    consigneePhone: order.recipientPhone || '',
    consigneeAddress: order.recipientAddress || '',
    shippingFee: '',
    status: 'unshipped',                   // 未发货（需要出库），可进入生成出库单/发货流程
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
    needsOutbound: true,                    // 赞晨导入订单默认需要出库
    outboundRecordId: '',                  // 尚未生成出库单
    importSource: 'hc-order-assist',       // 来源标记（额外字段，UI 忽略）
    createTime: now,
  };
}

// ============ 出库单联动 ============

// 货品条目 → model 字符串（与 generateOutboundFromOrders / 小程序拼法一致：规格非"默认"时带规格）
function buildModel(item) {
  const brand = String(item.brand || '').trim();
  const product = String(item.productName || '').trim();
  const spec = String(item.specification || '').trim();
  const base = [brand, product].filter(Boolean).join(' / ');
  if (!base) return '';
  return spec && spec !== '默认' ? `${base} / ${spec}` : base;
}

// 货品数组聚合为 phoneModels：相同 model 累加数量
function productsToPhoneModels(products, base) {
  const map = new Map();
  const orderKeys = [];
  for (const entry of base || []) {
    map.set(entry.model, Number(entry.quantity) || 0);
    orderKeys.push(entry.model);
  }
  for (const item of products || []) {
    const model = buildModel(item);
    if (!model) continue;
    const qty = Number(item.quantity) || Number(item.goodsQuantity) || 0;
    if (map.has(model)) {
      map.set(model, map.get(model) + qty);
    } else {
      map.set(model, qty);
      orderKeys.push(model);
    }
  }
  return orderKeys.map((model) => ({ model, quantity: map.get(model) }));
}

function normalizeShippingMethod(value) {
  const method = String(value || '').trim();
  return SHIPPING_METHOD_KEYS.has(method) ? method : DEFAULT_SHIPPING_METHOD;
}

/**
 * 导入后的出库单联动：
 * - 订单已有出库单且 pending → 把追加货品合并进 phoneModels（无论是否勾选自动生成）
 * - 订单已有出库单但已完成/取消 → 不动，返回 skipped_completed 提示人工处理
 * - 订单无出库单且勾选自动生成 → 按订单全量货品创建待出库单并回写 outboundRecordId
 * 出库单联动失败不影响订单导入结果，仅在响应中标记 failed。
 */
async function syncOutboundAfterImport({ orderId, orderDoc, appendedProducts, autoOutbound, now }) {
  const enabled = !!(autoOutbound && autoOutbound.enabled);
  try {
    if (orderDoc.outboundRecordId) {
      if (!appendedProducts || appendedProducts.length === 0) {
        return { outboundSync: 'none', outboundId: orderDoc.outboundRecordId };
      }
      let outbound = null;
      try {
        const res = await db.collection(OUTBOUND_COLLECTION).doc(orderDoc.outboundRecordId).get();
        outbound = res.data || null;
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      if (!outbound) return { outboundSync: 'none', outboundId: '' };
      if (outbound.outboundStatus !== 'pending') {
        return { outboundSync: 'skipped_completed', outboundId: orderDoc.outboundRecordId };
      }
      const phoneModels = productsToPhoneModels(appendedProducts, outbound.phoneModels || []);
      await db.collection(OUTBOUND_COLLECTION).doc(orderDoc.outboundRecordId).update({
        data: { phoneModels, updateTime: now },
      });
      return { outboundSync: 'updated', outboundId: orderDoc.outboundRecordId };
    }

    if (!enabled) return { outboundSync: 'none', outboundId: '' };
    if (orderDoc.needsOutbound === false) return { outboundSync: 'none', outboundId: '' };

    const allProducts = Array.isArray(orderDoc.products) ? orderDoc.products : [];
    const phoneModels = productsToPhoneModels(allProducts, []);
    if (phoneModels.length === 0) return { outboundSync: 'none', outboundId: '' };

    const addRes = await db.collection(OUTBOUND_COLLECTION).add({
      data: {
        customerName: orderDoc.customerName || '',
        outboundStatus: 'pending',
        source: 'order',
        orderIds: [orderId],
        shippingMethod: normalizeShippingMethod(autoOutbound.shippingMethod),
        remark: String(orderDoc.customerRemark || '').trim(), // 客服备注（含原商品名）带入出库单
        salesperson: orderDoc.salesperson || '',
        consignee: orderDoc.consignee || '',
        consigneePhone: orderDoc.consigneePhone || '',
        consigneeAddress: orderDoc.consigneeAddress || '',
        phoneModels,
        outboundDate: todayInBeijing(),
        trackingNumber: '',
        phonePhotos: [],
        createTime: now,
      },
    });
    await db.collection(ORDERS_COLLECTION).doc(orderId).update({
      data: { outboundRecordId: addRes._id },
    });
    return { outboundSync: 'created', outboundId: addRes._id };
  } catch (err) {
    console.error('[importOrderFromAssist] 出库单联动失败:', err);
    return { outboundSync: 'failed', outboundId: '', outboundError: err.message || '出库单联动失败' };
  }
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
      const outbound = await findOutboundForOrder(doc);
      const phonePhotos = normalizePhotoList(outbound && outbound.phonePhotos);
      const shipmentPhotos = await toTempPhotoUrls(phonePhotos);
      return ok('OK', '查询成功', {
        found: true,
        trackingNumber: String(doc.trackingNumber || '').trim(),
        sfWaybillNo: String(doc.sfWaybillNo || '').trim(),
        expressProvider: doc.expressProvider || '',
        customerName: (outbound && outbound.customerName) || doc.customerName || doc.consignee || '',
        status: doc.status || '',
        serialNumber: doc.serialNumber,
        outboundId: outbound && outbound._id || '',
        outboundDate: outbound && outbound.outboundDate || '',
        completedBy: outbound && outbound.completedBy || '',
        phonePhotos,
        shipmentPhotos,
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
  const autoOutbound = (payload && payload.autoOutbound) || null;
  const sourceOrderNo = String(order.sourceOrderNo || '').trim();

  // 2. 状态校验
  if (!isPendingShipment(order)) {
    return fail(400, 'INVALID_STATUS', '只有待发货订单允许导入');
  }

  // 3. 字段校验：订单级公共字段 + 货品级每项字段
  const missing = REQUIRED_ORDER_FIELDS.filter((f) => !String(order[f] || '').trim());
  if (missing.length > 0) {
    return fail(422, 'MISSING_FIELDS', '缺少必填字段: ' + missing.join(', '));
  }
  if (!SALES_CHANNEL_KEYS.has(String(order.salesChannel))) {
    return fail(422, 'INVALID_FIELD', `salesChannel 非法: ${order.salesChannel}`);
  }
  const items = normalizeItems(order);
  for (let i = 0; i < items.length; i++) {
    const missingItem = REQUIRED_ITEM_FIELDS.filter((f) => !items[i][f]);
    if (missingItem.length > 0) {
      return fail(422, 'MISSING_FIELDS', `货品[${i + 1}] 缺少必填字段: ` + missingItem.join(', '));
    }
  }
  const itemNos = items.map((it) => it.sourceOrderItemNo);
  if (new Set(itemNos).size !== itemNos.length) {
    return fail(422, 'INVALID_FIELD', '货品明细存在重复的 sourceOrderItemNo');
  }

  const now = db.serverDate();

  // 4. 幂等锁：逐货品项抢占日志 _id；全部已存在则整单视为重复
  const lockedItems = []; // [{ item, importKey }]
  let duplicatedCount = 0;
  for (const item of items) {
    const importKey = `${SOURCE}_${item.sourceOrderItemNo}`;
    try {
      await db.collection(LOG_COLLECTION).add({
        data: {
          _id: importKey,
          source: SOURCE,
          sourceOrderNo,
          sourceOrderItemNo: item.sourceOrderItemNo,
          operatorId: operator.uid || '',
          operatorName: operator.username || '',
          rawPayload: item.raw || order.raw || null,
          status: 'pending',
          createdOrderId: '',
          errorMessage: '',
          createTime: now,
        },
      });
      lockedItems.push({ item, importKey });
    } catch (err) {
      if (isDuplicateId(err)) { duplicatedCount += 1; continue; }
      console.error('[importOrderFromAssist] 写入幂等锁失败:', err);
      await updateImportLogs(lockedItems, { status: 'failed', errorMessage: err.message || '写入幂等锁失败' });
      return fail(500, 'INTERNAL_ERROR', err.message || '导入失败');
    }
  }

  if (lockedItems.length === 0) {
    // 所有货品项此前都已导入
    let existingOrderId = '';
    try {
      const existing = await db.collection(LOG_COLLECTION).doc(`${SOURCE}_${itemNos[0]}`).get();
      existingOrderId = (existing.data && existing.data.createdOrderId) || '';
    } catch (readErr) {
      if (!isNotFound(readErr)) console.error('[importOrderFromAssist] 读取已有导入日志失败:', readErr);
    }
    return ok('DUPLICATED', '订单已存在', { orderId: existingOrderId, duplicated: true, duplicatedCount });
  }

  // 5. 映射并写入 orders：同一来源订单已存在时追加货品，否则新建（一条订单含全部货品）
  let createdOrderId = '';
  try {
    const existingRes = await db.collection(ORDERS_COLLECTION)
      .where({ importSource: 'hc-order-assist', onlineOrderNumber: sourceOrderNo })
      .limit(1)
      .get();
    const existingOrder = (existingRes.data || [])[0];

    if (existingOrder) {
      createdOrderId = existingOrder._id;
      const hasProductsArray = Array.isArray(existingOrder.products) && existingOrder.products.length > 0;
      // 旧扁平结构订单：原货品在文档扁平字段上，需先折算为条目参与去重与合并
      const legacyItem = !hasProductsArray && (existingOrder.brand || existingOrder.productName || existingOrder.quantity)
        ? legacyOrderToProductItem(existingOrder)
        : null;
      const existingItems = hasProductsArray ? existingOrder.products : (legacyItem ? [legacyItem] : []);
      const existingItemNos = new Set(
        existingItems.map((item) => String((item && item.sourceOrderItemNo) || '')).filter(Boolean)
      );
      const toAppend = lockedItems.filter(({ item }) => !existingItemNos.has(item.sourceOrderItemNo));

      // 用户填写的备注：追加进已有订单客服备注（已包含时不重复）
      const appendUserRemark = String(order.remark || '').trim();
      const existingRemark = String(existingOrder.customerRemark || '');
      const remarkPatch = appendUserRemark && !existingRemark.includes(appendUserRemark)
        ? { customerRemark: existingRemark ? `${existingRemark}；${appendUserRemark}` : appendUserRemark }
        : {};

      if (toAppend.length > 0) {
        const newProducts = toAppend.map(({ item }) => mapToProductItem(item));
        const updateData = hasProductsArray
          ? { products: _.push(newProducts), ...remarkPatch, updateTime: now }
          : {
              products: existingItems.concat(newProducts),
              // 清空旧扁平货品字段，避免与 products 并存产生歧义
              brand: '',
              productName: '',
              specification: '',
              quantity: 0,
              unitPrice: 0,
              amount: 0,
              paymentAccount: '',
              paymentSplits: [],
              ...remarkPatch,
              updateTime: now,
            };
        await db.collection(ORDERS_COLLECTION).doc(createdOrderId).update({ data: updateData });
      } else if (Object.keys(remarkPatch).length > 0) {
        await db.collection(ORDERS_COLLECTION).doc(createdOrderId).update({ data: { ...remarkPatch, updateTime: now } });
      }

      await updateImportLogs(lockedItems, { status: 'success', createdOrderId });
      const appendedCount = toAppend.length;
      const appendSync = await syncOutboundAfterImport({
        orderId: createdOrderId,
        orderDoc: { ...existingOrder, products: existingItems.concat(toAppend.map(({ item }) => mapToProductItem(item))) },
        appendedProducts: toAppend.map(({ item }) => mapToProductItem(item)),
        autoOutbound,
        now,
      });
      return ok(
        'CREATED',
        appendedCount > 0 ? `货品已追加到已有订单（${appendedCount} 条）` : '货品已存在',
        {
          orderId: createdOrderId, appended: appendedCount > 0, appendedCount,
          duplicatedCount: items.length - appendedCount, ...appendSync,
        }
      );
    }

    const serialNumber = await getNextSerialNumber();
    const orderDoc = mapToOrder(order, lockedItems.map((l) => l.item), serialNumber, now);
    const addRes = await db.collection(ORDERS_COLLECTION).add({ data: orderDoc });
    createdOrderId = addRes._id;

    await updateImportLogs(lockedItems, { status: 'success', createdOrderId, normalizedPayload: orderDoc });

    const createSync = await syncOutboundAfterImport({
      orderId: createdOrderId,
      orderDoc,
      appendedProducts: [],
      autoOutbound,
      now,
    });

    return ok(
      'CREATED',
      lockedItems.length > 1 ? `订单创建成功，含 ${lockedItems.length} 条货品` : '订单创建成功',
      { orderId: createdOrderId, importedCount: lockedItems.length, duplicatedCount, ...createSync }
    );
  } catch (err) {
    console.error('[importOrderFromAssist] 创建订单失败:', err);
    // 回写失败原因，便于排查；保留锁避免脏数据反复写入
    await updateImportLogs(lockedItems, { status: 'failed', errorMessage: err.message || '创建订单失败' });
    return fail(500, 'INTERNAL_ERROR', err.message || '创建订单失败');
  }
};
