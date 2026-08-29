/**
 * importOrderFromAssist - 接收 HC Order Assist 插件导入的待发货订单
 *
 * 鉴权：方案三 MVP —— 静态 API Token（Authorization: Bearer <token>）
 * 通过 CloudBase「HTTP 访问服务」绑定路径后，由浏览器扩展 fetch 调用。
 *
 * 职责：token 校验 -> 状态校验 -> 字段校验 -> 幂等 -> 映射写入 orders -> 写导入日志
 * 设计见 docs/order-assist-import-design.md
 */

const crypto = require('crypto');
const cloud = require('wx-server-sdk');
const { mapProductModelDocs } = require('./productModelsCatalog');
const {
  analyzeTitle,
  buildHistoryCandidate,
  buildRuleMatch,
  createMatchRequestId,
  createSourceMappingIdV2,
  flattenCatalog,
  isMultiProductTitle,
  normalizeTitle,
  selectConsistentLegacyMapping,
} = require('./skuMatcher');
const {
  buildNextMapping,
  isLearningFeedback,
  normalizeFeedbackType,
  normalizeSelectedItems,
} = require('./skuFeedback');
const {
  buildRenewalIntroduction,
  buildRenewalOrderDoc,
  isRentIntroductionOrder,
  normalizePositiveAmount,
} = require('./renewalOrder');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const ORDERS_COLLECTION = 'orders';
const OUTBOUND_COLLECTION = 'outbound_records';
const LOG_COLLECTION = 'order_import_logs';
const COUNTER_COLLECTION = 'system_counters';
const PRODUCT_MODELS_COLLECTION = 'product_models';
const SOURCE_MAPPING_COLLECTION = 'source_sku_mapping';
const MATCH_LOG_COLLECTION = 'sku_match_log';
const CATALOG_VERSION_COUNTER = 'skuCatalogVersion';
const ORDER_SERIAL_COUNTER = 'orderSerialNumber';
const SOURCE = 'zanchenzu';
const SKU_MATCH_ALGORITHM_VERSION = 'rule-v2';
const PENDING_SHIPMENT_TEXT = '待发货';
// 货品三级（brand/productName/specification）、销售渠道、人员（responsiblePerson）由插件选择后传入
// 订单级必填（公共字段）与货品级必填（items[] 每项）分开校验
const REQUIRED_ORDER_FIELDS = ['sourceOrderNo', 'recipient', 'recipientPhone', 'recipientAddress', 'salesChannel', 'responsiblePerson'];
const REQUIRED_ITEM_FIELDS = ['sourceOrderItemNo', 'brand', 'productName', 'specification'];

const SALESPERSON_DICT_GROUP = 'salesperson';
const PAYMENT_ACCOUNT_DICT_GROUP = 'payment_account';
const RENEWAL_ATTACHMENT_MAX_COUNT = 5;
const RENEWAL_ATTACHMENT_MAX_FILE_SIZE = 4 * 1024 * 1024;
const RENEWAL_ATTACHMENT_MAX_TOTAL_SIZE = 4 * 1024 * 1024;
const RENEWAL_ATTACHMENT_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt',
]);

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
const ORDER_SOURCE_MAP = { new: '新增', service: '服务' };
const ORDER_ATTRIBUTE_MAP = { rental1: '租赁1', rental2: '租赁2' };
const ORDER_TYPE_MAP = {
  newBusiness: '新增业务',
  postRentalShip: '租后发货',
  postRentalReturn: '租后退货',
  postRentalPayment: '租后款项',
  deposit: '押金',
};

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

function normalizeHttpHeaders(value) {
  const headers = {};
  Object.keys(value || {}).forEach((key) => {
    headers[key.toLowerCase()] = value[key];
  });
  return headers;
}

// 解析 HTTP 访问服务的请求体；兼容直接 callFunction（event 即为业务参数）
function parseEvent(event) {
  const isHttp = event && (event.httpMethod || event.headers || typeof event.body === 'string');
  if (!isHttp) {
    return { isHttp: false, headers: {}, payload: event || {} };
  }

  const headers = normalizeHttpHeaders(event.headers);

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

function getOrderProducts(order) {
  if (Array.isArray(order.products) && order.products.length > 0) return order.products;
  if (order.brand || order.productName || order.quantity || order.amount || order.paymentAccount) {
    return [{
      brand: order.brand || '',
      productName: order.productName || '',
      specification: order.specification || '',
      quantity: Number(order.quantity) || 0,
    }];
  }
  return [];
}

function getProductLabel(productName) {
  return String(productName || '')
    .replace(/红米/g, '红粮')
    .replace(/华为/g, '菊花')
    .replace(/小米/g, '粗粮')
    .replace(/OPPO/gi, '绿厂')
    .replace(/vivo/gi, '蓝厂');
}

function getBrandLabel(brand) {
  const labels = { 华为: '菊花', vivo: '蓝厂', OPPO: '绿厂', 小米: '粗粮', 红米: '红粮' };
  const text = String(brand || '').trim();
  return labels[text] || text;
}

function buildOrderIntroduction(order) {
  const products = getOrderProducts(order);
  if (isRentIntroductionOrder(order, products)) {
    return buildRenewalIntroduction(order, SALES_CHANNEL_MAP);
  }

  const consigneeLine = [order.consignee, order.consigneePhone, order.consigneeAddress]
    .map((value) => String(value || '').trim() || '-')
    .join('，');
  const phoneSummary = products
    .map((product) => {
      const productName = getProductLabel(product.productName) || getBrandLabel(product.brand) || '-';
      const specification = product.specification && product.specification !== '默认'
        ? ` ${product.specification}`
        : '';
      return `${productName}${specification}*${Number(product.quantity) || 0}台`;
    })
    .join('，') || '-';
  const remark = String(order.customerRemark || '').trim() || '-';
  const customerName = String(order.customerName || '').trim() || '-';
  const orderNumber = String(order.onlineOrderNumber || order.serialNumber || '').trim() || '-';

  return `${consigneeLine}\n\n${phoneSummary}，${remark}\n\n订单下单人:  ${customerName},  订单编号: ${orderNumber}`;
}

function getDictLabel(map, value) {
  const text = String(value || '').trim();
  return map[text] || text || '-';
}

function mapIntroductionOrder(order) {
  return {
    orderId: order._id || '',
    orderDate: String(order.date || '').trim() || '-',
    orderSource: getDictLabel(ORDER_SOURCE_MAP, order.orderSource),
    orderAttribute: getDictLabel(ORDER_ATTRIBUTE_MAP, order.orderAttribute),
    orderType: getDictLabel(ORDER_TYPE_MAP, order.orderType),
    introduction: buildOrderIntroduction(order),
  };
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
  return mapProductModelDocs(res.data || []);
}

async function fetchCatalogVersion() {
  try {
    const result = await db.collection(COUNTER_COLLECTION).doc(CATALOG_VERSION_COUNTER).get();
    return Math.max(0, Number(result.data && result.data.value) || 0);
  } catch (err) {
    if (isNotFound(err)) return 0;
    throw err;
  }
}

async function fetchHistoryMapping(source, titleFingerprint, normalizedTitle, activeSkuIds, goodsQuantity) {
  try {
    const mappingId = createSourceMappingIdV2(source, titleFingerprint);
    const result = await db.collection(SOURCE_MAPPING_COLLECTION).doc(mappingId).get();
    const mapping = result.data || null;
    if (mapping && mapping.source === source && mapping.title_fingerprint === titleFingerprint) return mapping;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  // rule-v1 过渡双读：忽略商家维度，仅在所有旧版 verified 映射指向同一有效 SKU 时采用。
  const legacyResult = await db.collection(SOURCE_MAPPING_COLLECTION)
    .where({ source, normalized_title: normalizedTitle, status: 'verified' })
    .limit(100)
    .get();
  const legacyMappings = (legacyResult.data || []).filter(mapping => !mapping.title_fingerprint);
  return selectConsistentLegacyMapping(legacyMappings, activeSkuIds, goodsQuantity);
}

async function matchProductModels(payload) {
  const goodsTitle = String(payload && payload.goodsTitle || '').trim();
  if (!goodsTitle) return fail(422, 'MISSING_FIELDS', '缺少 goodsTitle');

  const source = String(payload && payload.source || SOURCE).trim().toLowerCase() || SOURCE;
  const merchant = String(payload && payload.merchant || '').trim();
  const goodsQuantity = Math.max(1, Number.parseInt(payload && payload.goodsQuantity, 10) || 1);
  const requestId = createMatchRequestId();
  const startedAt = Date.now();

  const [brands, catalogVersion] = await Promise.all([
    fetchProductModels(),
    fetchCatalogVersion(),
  ]);
  const analysis = analyzeTitle(goodsTitle, brands);
  const normalizedTitle = analysis.normalizedTitle;
  const titleFingerprint = analysis.titleFingerprint;
  const common = {
    requestId,
    normalizedTitle,
    titleFingerprint,
    catalogVersion,
    algorithmVersion: SKU_MATCH_ALGORITHM_VERSION,
    needsConfirmation: true,
  };

  const finish = async (message, matchData) => {
    const durationMs = Date.now() - startedAt;
    const responseData = { ...common, ...matchData, durationMs };
    await db.collection(MATCH_LOG_COLLECTION).add({
      data: {
        _id: requestId,
        source,
        source_order_no: String(payload && payload.sourceOrderNo || '').trim(),
        source_title: goodsTitle,
        normalized_title: normalizedTitle,
        title_fingerprint: titleFingerprint,
        merchant,
        merchant_ignored_for_matching: true,
        scene: payload && payload.scene === 'afterSale' ? 'afterSale' : 'import',
        goods_quantity: goodsQuantity,
        catalog_version: catalogVersion,
        algorithm_version: SKU_MATCH_ALGORITHM_VERSION,
        match_type: responseData.matchType,
        candidates: responseData.candidates || [],
        missing_attributes: responseData.missingAttributes || [],
        mapping_promotable: matchData.promotable !== false && analysis.promotable !== false,
        ambiguity_reason: matchData.ambiguityReason || analysis.ambiguityReason || '',
        duration_ms: durationMs,
        feedback_processed: false,
        created_at: new Date().toISOString(),
      },
    });
    return ok('OK', message, responseData);
  };

  if (isMultiProductTitle(goodsTitle)) {
    return finish('需要人工选择', {
      matchType: 'none',
      candidates: [],
      missingAttributes: [],
      promotable: false,
      ambiguityReason: '套装或多商品标题不进入自动学习映射',
      message: '识别到套装或多商品标题，阶段一不自动拆分，请人工选择。',
    });
  }

  const activeSkuIds = new Set(analysis.skus.map(sku => sku.skuId));
  const historyMapping = await fetchHistoryMapping(
    source,
    titleFingerprint,
    normalizedTitle,
    activeSkuIds,
    goodsQuantity,
  );
  const historyCandidate = buildHistoryCandidate(historyMapping, activeSkuIds, goodsQuantity);
  if (historyCandidate) {
    return finish('命中历史映射', {
      matchType: 'history',
      candidates: [historyCandidate],
      missingAttributes: [],
      promotable: true,
    });
  }

  const ruleResult = buildRuleMatch({ goodsTitle, goodsQuantity, brands, analysis });
  return finish(ruleResult.matchType === 'rule' ? '规则匹配完成' : '未找到可靠推荐', ruleResult);
}

async function verifySuccessfulImport(sourceOrderNo) {
  let logs;
  try {
    const result = await db.collection(LOG_COLLECTION)
      .where({ sourceOrderNo })
      .limit(100)
      .get();
    logs = (result.data || []).filter(log => (
      log.source === SOURCE && log.status === 'success' && String(log.createdOrderId || '').trim()
    ));
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }

  for (const log of logs) {
    try {
      const orderResult = await db.collection(ORDERS_COLLECTION).doc(log.createdOrderId).get();
      const order = orderResult.data || null;
      if (
        order
        && order.importSource === 'hc-order-assist'
        && String(order.onlineOrderNumber || '').trim() === sourceOrderNo
      ) return { logId: log._id, orderId: order._id || log.createdOrderId };
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  return null;
}

function cleanOperator(value) {
  const operator = value && typeof value === 'object' ? value : {};
  return {
    uid: String(operator.uid || '').trim(),
    username: String(operator.username || '').trim(),
    loginType: String(operator.loginType || '').trim(),
  };
}

async function submitProductMatchFeedback(payload) {
  const requestId = String(payload && payload.requestId || '').trim();
  const feedbackType = normalizeFeedbackType(payload && payload.feedbackType);
  if (!requestId) return fail(422, 'MISSING_FIELDS', '缺少 requestId');
  if (!feedbackType) return fail(422, 'INVALID_FIELD', 'feedbackType 非法');

  let initialLog;
  try {
    const result = await db.collection(MATCH_LOG_COLLECTION).doc(requestId).get();
    initialLog = result.data || null;
  } catch (err) {
    if (isNotFound(err)) return fail(404, 'MATCH_REQUEST_NOT_FOUND', '匹配请求不存在或已过期');
    throw err;
  }

  const source = String(payload && payload.source || SOURCE).trim().toLowerCase() || SOURCE;
  const sourceOrderNo = String(payload && payload.sourceOrderNo || '').trim();
  const goodsTitle = String(payload && payload.goodsTitle || '').trim();
  const normalizedTitle = normalizeTitle(goodsTitle);
  if (
    initialLog.source !== source
    || initialLog.source_order_no !== sourceOrderNo
    || initialLog.normalized_title !== normalizedTitle
  ) return fail(409, 'MATCH_CONTEXT_MISMATCH', '反馈内容与原匹配请求不一致');

  const selectedItems = normalizeSelectedItems(payload && payload.selectedItems);
  const learning = isLearningFeedback(feedbackType);
  let importEvidence = null;
  let feedbackAnalysis = null;
  if (learning) {
    if (!sourceOrderNo) return fail(422, 'MISSING_FIELDS', '学习反馈缺少 sourceOrderNo');
    if (selectedItems.length === 0) return fail(422, 'MISSING_FIELDS', '学习反馈缺少 selectedItems');
    const selectedQuantity = selectedItems.reduce((sum, item) => sum + item.quantity, 0);
    if (selectedQuantity > Math.max(1, Number(initialLog.goods_quantity) || 1)) {
      return fail(422, 'INVALID_FIELD', '选择数量超过来源商品数量');
    }

    const brands = await fetchProductModels();
    feedbackAnalysis = analyzeTitle(goodsTitle, brands);
    const activeSkuIds = new Set(flattenCatalog(brands).map(sku => sku.skuId));
    const invalidSkuIds = selectedItems.map(item => item.skuId).filter(skuId => !activeSkuIds.has(skuId));
    if (invalidSkuIds.length > 0) return fail(422, 'SKU_INVALID', `SKU 不存在或已停用: ${invalidSkuIds.join(', ')}`);

    importEvidence = await verifySuccessfulImport(sourceOrderNo);
    if (!importEvidence) return fail(409, 'IMPORT_NOT_CONFIRMED', '来源订单尚未成功导入，不能计入学习映射');
  }

  const operator = cleanOperator(payload && payload.operator);
  const recommendedSkuIds = Array.from(new Set(
    (Array.isArray(payload && payload.recommendedSkuIds) ? payload.recommendedSkuIds : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  ));
  const now = new Date().toISOString();
  const titleFingerprint = String(initialLog.title_fingerprint || feedbackAnalysis && feedbackAnalysis.titleFingerprint || '').trim();
  const mappingPromotable = initialLog.mapping_promotable !== undefined
    ? initialLog.mapping_promotable !== false
    : !!(feedbackAnalysis && feedbackAnalysis.promotable);
  const ambiguityReason = String(initialLog.ambiguity_reason || feedbackAnalysis && feedbackAnalysis.ambiguityReason || '').trim();
  const mappingId = learning ? createSourceMappingIdV2(source, titleFingerprint) : '';
  const transaction = await db.startTransaction();
  try {
    const logResult = await transaction.collection(MATCH_LOG_COLLECTION).doc(requestId).get();
    const log = logResult.data || null;
    if (!log) {
      await transaction.rollback();
      return fail(404, 'MATCH_REQUEST_NOT_FOUND', '匹配请求不存在或已过期');
    }
    if (log.feedback_processed) {
      await transaction.rollback();
      return ok('DUPLICATED', '反馈已处理', { requestId, duplicated: true });
    }

    let mapping = null;
    let nextMapping = null;
    if (learning) {
      try {
        const mappingResult = await transaction.collection(SOURCE_MAPPING_COLLECTION).doc(mappingId).get();
        mapping = mappingResult.data || null;
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      nextMapping = buildNextMapping(mapping, {
        source,
        goodsTitle,
        normalizedTitle,
        titleFingerprint,
        promotable: mappingPromotable,
        ambiguityReason,
        selectedItems,
        sourceOrderNo,
        operator,
        requestId,
        now,
      });
      if (mapping) {
        await transaction.collection(SOURCE_MAPPING_COLLECTION).doc(mappingId).update({ data: nextMapping });
      } else {
        await transaction.collection(SOURCE_MAPPING_COLLECTION).add({ data: { _id: mappingId, ...nextMapping } });
      }
    }

    await transaction.collection(MATCH_LOG_COLLECTION).doc(requestId).update({
      data: {
        feedback_processed: true,
        feedback_type: feedbackType,
        recommended_sku_ids: recommendedSkuIds,
        selected_items: selectedItems,
        operator,
        import_evidence: importEvidence,
        feedback_at: now,
      },
    });
    await transaction.commit();
    return ok('OK', '反馈已记录', {
      requestId,
      mappingId: learning ? mappingId : '',
      mappingStatus: nextMapping && nextMapping.status || '',
      confirmedCount: nextMapping && nextMapping.confirmed_count || 0,
      correctedCount: nextMapping && nextMapping.corrected_count || 0,
    });
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
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
    quantity: Number(item && item.quantity) || Number(item && item.goodsQuantity) || 1,
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
    quantity: item.quantity,
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
  // 客服备注 = 用户在导入弹窗填写的备注（插件端必填；不拼接平台商品信息，旧版插件未传时为空）
  const remark = String(order.remark || '').trim();
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
    customerName: order.orderPerson || order.recipient || '',
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

// 赞晨“申请售后” -> hc-admin 售后服务订单。
// 订单属性按产品约定固定为：服务 / 租赁1 / 租后发货 / 平台。
function mapToAfterSaleOrder(order, items, serialNumber, now) {
  const remark = String(order.remark || '').trim();
  return {
    serialNumber,
    date: todayInBeijing(),
    orderSource: 'service',
    orderAttribute: 'rental1',
    orderType: 'postRentalShip',
    salesChannel: order.salesChannel || '',
    salesperson: order.responsiblePerson || '',
    channelCategory: 'platform',
    onlineOrderNumber: order.sourceOrderNo || '',
    customerName: order.orderPerson || order.recipient || '',
    products: items.map(mapToProductItem),
    trackingNumber: '',
    sourceOrderItemNo: (items[0] && items[0].sourceOrderItemNo) || '',
    consignee: order.recipient || '',
    consigneePhone: order.recipientPhone || '',
    consigneeAddress: order.recipientAddress || '',
    shippingFee: '',
    status: 'unshipped',
    customerRemark: remark,
    transferBrand: '',
    transferProductName: '',
    transferSpecification: '',
    paidPeriod: 0,
    paidRent: 0,
    transferItems: '',
    attachments: [],
    returnStatus: 'notReturned',
    returnTrackingNumbers: '',
    needsOutbound: true,
    outboundRecordId: '',
    importSource: 'hc-order-assist-after-sale',
    afterSaleRequestId: order.afterSaleRequestId || '',
    createTime: now,
  };
}

async function createAfterSaleOrder(payload) {
  const order = (payload && payload.order) || {};
  const autoOutbound = (payload && payload.autoOutbound) || null;
  const requestId = String(order.afterSaleRequestId || '').trim();
  const required = REQUIRED_ORDER_FIELDS.concat(['orderPerson', 'afterSaleRequestId', 'remark']);
  const missing = required.filter((field) => !String(order[field] || '').trim());
  if (missing.length > 0) {
    return fail(422, 'MISSING_FIELDS', '缺少必填字段: ' + missing.join(', '));
  }
  if (!SALES_CHANNEL_KEYS.has(String(order.salesChannel))) {
    return fail(422, 'INVALID_FIELD', `salesChannel 非法: ${order.salesChannel}`);
  }

  const items = normalizeItems(order);
  for (let i = 0; i < items.length; i++) {
    const missingItem = REQUIRED_ITEM_FIELDS.filter((field) => !items[i][field]);
    if (missingItem.length > 0) {
      return fail(422, 'MISSING_FIELDS', `货品[${i + 1}] 缺少必填字段: ` + missingItem.join(', '));
    }
  }
  const itemNos = items.map((item) => item.sourceOrderItemNo);
  if (new Set(itemNos).size !== itemNos.length) {
    return fail(422, 'INVALID_FIELD', '货品明细存在重复的 sourceOrderItemNo');
  }

  try {
    const existingRes = await db.collection(ORDERS_COLLECTION)
      .where({ importSource: 'hc-order-assist-after-sale', afterSaleRequestId: requestId })
      .limit(1)
      .get();
    const existing = (existingRes.data || [])[0];
    if (existing) {
      return ok('DUPLICATED', '售后服务订单已存在', { orderId: existing._id, duplicated: true });
    }

    const now = db.serverDate();
    const serialNumber = await getNextSerialNumber();
    const orderDoc = mapToAfterSaleOrder(order, items, serialNumber, now);
    const addRes = await db.collection(ORDERS_COLLECTION).add({ data: orderDoc });
    const outboundSync = await syncOutboundAfterImport({
      orderId: addRes._id,
      orderDoc,
      appendedProducts: [],
      autoOutbound,
      now,
    });
    return ok('CREATED', '售后服务订单创建成功', { orderId: addRes._id, ...outboundSync });
  } catch (err) {
    console.error('[importOrderFromAssist] 创建售后服务订单失败:', err);
    return fail(500, 'INTERNAL_ERROR', err.message || '创建售后服务订单失败');
  }
}

function getRenewalAttachmentExtension(fileName, contentType) {
  const extensionMatch = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const extension = extensionMatch ? extensionMatch[1] : '';
  if (RENEWAL_ATTACHMENT_EXTENSIONS.has(extension)) return extension;
  return ({
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/csv': 'csv',
    'text/plain': 'txt',
  })[String(contentType || '').toLowerCase()] || '';
}

function getRenewalAttachmentRequestHash(requestId) {
  return crypto.createHash('sha256').update(requestId).digest('hex').slice(0, 24);
}

function normalizeRenewalAttachmentRefs(value, requestId) {
  const attachments = Array.isArray(value) ? value : [];
  if (attachments.length > RENEWAL_ATTACHMENT_MAX_COUNT) {
    throw new Error(`续租附件最多上传 ${RENEWAL_ATTACHMENT_MAX_COUNT} 个`);
  }
  const expectedPath = `/orders_attachments/renewals/${getRenewalAttachmentRequestHash(requestId)}/`;
  let totalSize = 0;
  return attachments.map((attachment, index) => {
    const fileID = String(attachment && attachment.fileID || '').trim();
    const fileName = String(attachment && attachment.fileName || '').trim().slice(0, 200);
    const size = Number(attachment && attachment.size) || 0;
    if (!fileID.startsWith('cloud://') || !fileID.includes(expectedPath) || !fileName
      || size <= 0 || size > RENEWAL_ATTACHMENT_MAX_FILE_SIZE) {
      throw new Error(`续租附件[${index + 1}]引用无效`);
    }
    totalSize += size;
    if (totalSize > RENEWAL_ATTACHMENT_MAX_TOTAL_SIZE) {
      throw new Error('续租附件总大小不能超过 4MB');
    }
    return { fileID, fileName };
  });
}

async function cleanupRenewalAttachments(attachments) {
  if (!attachments.length) return;
  await cloud.deleteFile({ fileList: attachments.map((attachment) => attachment.fileID) })
    .catch((cleanupErr) => console.error('[importOrderFromAssist] 清理续租附件失败:', cleanupErr));
}

async function handleRenewalAttachmentUpload(event, headers) {
  let fileName = '';
  try {
    fileName = decodeURIComponent(String(headers['x-hc-file-name'] || '')).trim().slice(0, 200);
  } catch (_) {
    return fail(422, 'INVALID_ATTACHMENT', '续租附件名称无效');
  }
  const requestId = String(headers['x-hc-renewal-request-id'] || '').trim();
  const contentType = String(headers['x-hc-file-content-type'] || '').trim().toLowerCase();
  const extension = getRenewalAttachmentExtension(fileName, contentType);
  if (!fileName || !requestId || requestId.length > 100 || !extension) {
    return fail(422, 'INVALID_ATTACHMENT', '续租附件信息或格式无效');
  }

  const rawBody = event && event.body || '';
  const fileContent = event && event.isBase64Encoded
    ? Buffer.from(rawBody, 'base64')
    : Buffer.from(rawBody, 'latin1');
  if (!fileContent.length || fileContent.length > RENEWAL_ATTACHMENT_MAX_FILE_SIZE) {
    return fail(422, 'INVALID_ATTACHMENT', '单个续租附件不能超过 4MB');
  }

  try {
    const requestHash = getRenewalAttachmentRequestHash(requestId);
    const fileHash = crypto.createHash('sha256').update(fileContent).digest('hex').slice(0, 12);
    const cloudPath = `orders_attachments/renewals/${requestHash}/${fileHash}.${extension}`;
    const result = await cloud.uploadFile({ cloudPath, fileContent });
    if (!result || !result.fileID) throw new Error('云存储未返回 fileID');
    return ok('UPLOADED', '续租附件上传成功', { fileID: result.fileID, fileName, size: fileContent.length });
  } catch (err) {
    console.error('[importOrderFromAssist] 上传续租附件失败:', err);
    return fail(500, 'ATTACHMENT_UPLOAD_FAILED', err.message || '续租附件上传失败');
  }
}

async function createRenewalOrder(payload) {
  const order = (payload && payload.order) || {};
  const sourceOrderNo = String(order.sourceOrderNo || '').trim();
  const requestId = String(order.renewalRequestId || '').trim();
  const paymentAccount = String(order.paymentAccount || '').trim();
  const salesChannel = String(order.salesChannel || '').trim();
  const salesperson = String(order.responsiblePerson || '').trim();
  const customerName = String(order.orderPerson || order.recipient || '').trim();
  const amount = normalizePositiveAmount(order.renewalAmount);

  if (!sourceOrderNo || !requestId || !paymentAccount || !salesChannel || !salesperson || !customerName || !amount) {
    return fail(422, 'MISSING_FIELDS', '请完整填写网店订单号、销售渠道、负责人、客户名称、续租金额和收款账户');
  }
  if (requestId.length > 100) return fail(422, 'INVALID_FIELD', '续租请求标识无效');
  if (!SALES_CHANNEL_KEYS.has(salesChannel)) {
    return fail(422, 'INVALID_FIELD', `salesChannel 非法: ${salesChannel}`);
  }
  let uploadedAttachments;
  try {
    uploadedAttachments = normalizeRenewalAttachmentRefs(order.renewalAttachments, requestId);
  } catch (err) {
    return fail(422, 'INVALID_ATTACHMENT', err.message || '续租附件无效');
  }

  try {
    const paymentAccounts = await fetchDictItems(PAYMENT_ACCOUNT_DICT_GROUP);
    const validAccounts = new Set(paymentAccounts.map((item) => item.value));
    if (!validAccounts.has(paymentAccount)) {
      await cleanupRenewalAttachments(uploadedAttachments);
      return fail(422, 'INVALID_FIELD', `收款账户无效: ${paymentAccount}`);
    }

    const existing = await queryFirst(ORDERS_COLLECTION, {
      importSource: 'hc-order-assist-renewal',
      renewalRequestId: requestId,
    });
    if (existing) {
      const attachmentCount = Array.isArray(existing.attachments) ? existing.attachments.length : 0;
      return ok('DUPLICATED', '续租订单已存在', {
        orderId: existing._id,
        duplicated: true,
        introduction: buildOrderIntroduction(existing),
        attachmentCount,
        uploadedAttachmentCount: Number(existing.renewalUploadedAttachmentCount) || 0,
      });
    }

    const currentOrder = {
      onlineOrderNumber: sourceOrderNo,
      customerName,
      salesChannel,
      salesperson,
      channelCategory: 'platform',
      orderAttribute: 'rental1',
      attachments: [],
    };

    const now = db.serverDate();
    const serialNumber = await getNextSerialNumber();
    const orderDoc = buildRenewalOrderDoc(currentOrder, {
      requestId,
      amount,
      paymentAccount,
      remark: order.remark,
      attachments: uploadedAttachments,
    }, serialNumber, now, todayInBeijing());
    orderDoc._id = `renewal_${crypto.createHash('sha256').update(requestId).digest('hex').slice(0, 24)}`;
    const addResult = await db.collection(ORDERS_COLLECTION).add({ data: orderDoc });
    return ok('CREATED', '续租订单创建成功', {
      orderId: addResult._id,
      duplicated: false,
      introduction: buildOrderIntroduction({ _id: addResult._id, ...orderDoc }),
      attachmentCount: orderDoc.attachments.length,
      uploadedAttachmentCount: uploadedAttachments.length,
    });
  } catch (err) {
    const concurrent = await queryFirst(ORDERS_COLLECTION, {
      importSource: 'hc-order-assist-renewal',
      renewalRequestId: requestId,
    }).catch(() => null);
    if (concurrent) {
      const attachmentCount = Array.isArray(concurrent.attachments) ? concurrent.attachments.length : 0;
      return ok('DUPLICATED', '续租订单已存在', {
        orderId: concurrent._id,
        duplicated: true,
        introduction: buildOrderIntroduction(concurrent),
        attachmentCount,
        uploadedAttachmentCount: Number(concurrent.renewalUploadedAttachmentCount) || 0,
      });
    }
    await cleanupRenewalAttachments(uploadedAttachments);
    console.error('[importOrderFromAssist] 创建续租订单失败:', err);
    return fail(500, 'INTERNAL_ERROR', err.message || '创建续租订单失败');
  }
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
    const qty = Number(item.quantity) || 0;
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
  const binaryHeaders = normalizeHttpHeaders(event && event.headers);
  if (binaryHeaders['x-hc-order-assist-action'] === 'upload-renewal-attachment') {
    if (event && event.httpMethod && String(event.httpMethod).toUpperCase() !== 'POST') {
      return fail(405, 'METHOD_NOT_ALLOWED', '仅支持 POST');
    }
    const expectedToken = process.env.HC_ORDER_ASSIST_TOKEN || '';
    if (!expectedToken) return fail(500, 'INTERNAL_ERROR', '服务端未配置鉴权 token');
    const token = getBearerToken(binaryHeaders);
    if (!token || token !== expectedToken) return fail(401, 'LOGIN_REQUIRED', 'token 无效');
    return handleRenewalAttachmentUpload(event, binaryHeaders);
  }

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
        sfWaybillNo: String(doc.expressProvider || '').toLowerCase() === 'sf'
          ? String(doc.trackingNumber || '').trim()
          : '',
        expressProvider: doc.expressProvider || (outbound && (outbound.expressProvider || outbound.expressCompany)) || '',
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

  // 按赞晨租编号返回全部 hc-admin 订单简介，供插件选择并复制。
  if (payload && payload.action === 'getOrderIntroductions') {
    const sn = String(payload.sourceOrderNo || '').trim();
    if (!sn) return fail(422, 'MISSING_FIELDS', '缺少 sourceOrderNo');
    try {
      const res = await db.collection(ORDERS_COLLECTION)
        .where({ onlineOrderNumber: sn })
        .limit(100)
        .get();
      const orders = (res.data || [])
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || Number(b.serialNumber || 0) - Number(a.serialNumber || 0))
        .map(mapIntroductionOrder);
      return ok(orders.length ? 'OK' : 'NOT_FOUND', orders.length ? '查询成功' : '未找到订单', {
        found: orders.length > 0,
        sourceOrderNo: sn,
        orders,
      });
    } catch (err) {
      console.error('[importOrderFromAssist] 获取订单简介失败:', err);
      return fail(500, 'INTERNAL_ERROR', err.message || '获取订单简介失败');
    }
  }

  // 取货品三级结构（供插件下拉选择）；与销售渠道枚举一并返回
  if (payload && payload.action === 'getProductModels') {
    try {
      const [brands, salespersons, paymentAccounts, catalogVersion] = await Promise.all([
        fetchProductModels(),
        fetchDictItems(SALESPERSON_DICT_GROUP),
        fetchDictItems(PAYMENT_ACCOUNT_DICT_GROUP),
        fetchCatalogVersion(),
      ]);
      return ok('OK', '获取成功', {
        brands,
        salesChannels: SALES_CHANNEL_OPTIONS,
        salespersons,
        paymentAccounts,
        catalogVersion,
      });
    } catch (err) {
      console.error('[importOrderFromAssist] 获取货品失败:', err);
      return fail(500, 'INTERNAL_ERROR', err.message || '获取货品失败');
    }
  }

  if (payload && payload.action === 'matchProductModels') {
    try {
      return await matchProductModels(payload);
    } catch (err) {
      console.error('[importOrderFromAssist] SKU 匹配失败:', err);
      return fail(500, 'INTERNAL_ERROR', err.message || 'SKU 匹配失败');
    }
  }

  if (payload && payload.action === 'submitProductMatchFeedback') {
    try {
      return await submitProductMatchFeedback(payload);
    } catch (err) {
      console.error('[importOrderFromAssist] SKU 匹配反馈失败:', err);
      return fail(500, 'INTERNAL_ERROR', err.message || 'SKU 匹配反馈失败');
    }
  }

  // 由插件“申请售后”发起，创建独立的售后服务订单；不要求赞晨订单处于待发货状态。
  if (payload && payload.action === 'createAfterSaleOrder') {
    return createAfterSaleOrder(payload);
  }

  // 由插件“申请续租”发起，直接使用当前赞晨订单信息创建虚拟续期租金订单，不查询历史订单。
  if (payload && payload.action === 'createRenewalOrder') {
    return createRenewalOrder(payload);
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

  // 4. 幂等锁：逐货品项抢占日志 _id；全部已存在则整单视为重复。
  //    锁已存在但其指向的订单已被删除（或此前导入失败未建单）时，视为失效锁回收后重新导入。
  const lockedItems = []; // [{ item, importKey }]
  let duplicatedCount = 0;
  const orderExistsCache = new Map();
  const orderStillExists = async (orderId) => {
    const id = String(orderId || '').trim();
    if (!id) return false;
    if (orderExistsCache.has(id)) return orderExistsCache.get(id);
    let exists = false;
    try {
      const res = await db.collection(ORDERS_COLLECTION).doc(id).get();
      exists = !!(res && res.data);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    orderExistsCache.set(id, exists);
    return exists;
  };
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
      if (isDuplicateId(err)) {
        let staleLock = false;
        try {
          const existing = await db.collection(LOG_COLLECTION).doc(importKey).get();
          const createdOrderId = existing.data && existing.data.createdOrderId;
          staleLock = !(await orderStillExists(createdOrderId));
        } catch (readErr) {
          staleLock = isNotFound(readErr);
          if (!staleLock) console.error('[importOrderFromAssist] 校验幂等锁失败:', readErr);
        }
        if (staleLock) {
          await db.collection(LOG_COLLECTION).doc(importKey).update({
            data: {
              sourceOrderNo,
              operatorId: operator.uid || '',
              operatorName: operator.username || '',
              status: 'pending',
              createdOrderId: '',
              errorMessage: '',
              reclaimedAt: now,
            },
          });
          lockedItems.push({ item, importKey });
        } else {
          duplicatedCount += 1;
        }
        continue;
      }
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
