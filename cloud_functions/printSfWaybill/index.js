/**
 * printSfWaybill - 获取顺丰丰密面单 PDF
 *
 * 调用顺丰 COM_RECE_CLOUD_PRINT_WAYBILLS 同步接口，随后由云函数携带
 * X-Auth-token 下载 PDF。浏览器端不会接触顺丰 accessToken 或下载 token。
 *
 * 环境变量：
 * SF_SANDBOX_PRINT_TEMPLATE_CODE  沙箱面单模板编码
 * SF_PROD_PRINT_TEMPLATE_CODE     生产面单模板编码
 * SF_SANDBOX_CUSTOM_TEMPLATE_CODE 沙箱自定义模板编码（可选）
 * SF_PROD_CUSTOM_TEMPLATE_CODE    生产自定义模板编码（可选）
 * SF_PRINT_MAX_FILE_BYTES         PDF 最大字节数，默认 4 MiB
 *
 * event.data:
 * sfExpressOrderId: string        sf_express_orders 集合的 _id
 */

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const SF_ORDERS_COLLECTION = 'sf_express_orders';
const TOKEN_COLLECTION = 'sf_tokens';
const CONFIG_COLLECTION = 'system_config';
const ROLE_COLLECTION = 'roles';
const USER_ROLE_COLLECTION = 'user_roles';
const PRINT_LOG_COLLECTION = 'sf_print_logs';
const SF_CONFIG_DOC_ID = 'sf_express';
const PRINT_PERMISSION = 'sf:print';
const SERVICE_CODE = 'COM_RECE_CLOUD_PRINT_WAYBILLS';
// 云函数返回体还要经过 Base64（约增加 1/3），默认限制 4 MiB。
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;
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

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
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

function getFirstEnv(names) {
  for (const name of names) {
    const value = trimString(process.env[name]);
    if (value) return value;
  }
  return '';
}

function getMaxFileBytes() {
  const raw = trimString(process.env.SF_PRINT_MAX_FILE_BYTES);
  if (!raw) return DEFAULT_MAX_FILE_BYTES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('SF_PRINT_MAX_FILE_BYTES 必须是正整数');
  }
  return parsed;
}

async function resolveSfEnv() {
  let raw = '';
  try {
    const result = await db.collection(CONFIG_COLLECTION).doc(SF_CONFIG_DOC_ID).get();
    raw = trimString(result.data && result.data.env);
  } catch (error) {
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
  const templateCode = env === 'production'
    ? getFirstEnv(['SF_PROD_PRINT_TEMPLATE_CODE', 'SF_PRODUCTION_PRINT_TEMPLATE_CODE'])
    : getFirstEnv(['SF_SANDBOX_PRINT_TEMPLATE_CODE']);
  const customTemplateCode = env === 'production'
    ? getFirstEnv(['SF_PROD_CUSTOM_TEMPLATE_CODE', 'SF_PRODUCTION_CUSTOM_TEMPLATE_CODE'])
    : getFirstEnv(['SF_SANDBOX_CUSTOM_TEMPLATE_CODE']);

  if (!partnerID) {
    throw new Error(env === 'production'
      ? '缺少云函数环境变量 SF_PROD_CLIENT_CODE'
      : '缺少云函数环境变量 SF_SANDBOX_CLIENT_CODE');
  }
  if (!templateCode) {
    throw new Error(env === 'production'
      ? '缺少云函数环境变量 SF_PROD_PRINT_TEMPLATE_CODE'
      : '缺少云函数环境变量 SF_SANDBOX_PRINT_TEMPLATE_CODE');
  }

  return {
    env,
    partnerID,
    serviceUrl,
    templateCode,
    customTemplateCode,
    maxFileBytes: getMaxFileBytes(),
  };
}

async function requirePrintPermission() {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return { allowed: false, code: 'LOGIN_REQUIRED', errMsg: '请先登录' };
  }

  let mapping = null;
  for (const userId of currentUser.ids || [currentUser.id]) {
    const userRoleResult = await db.collection(USER_ROLE_COLLECTION)
      .where({ userId })
      .limit(1)
      .get();
    const userRole = userRoleResult.data && userRoleResult.data[0];
    if (userRole) {
      mapping = { userRole, matchedUserId: userId };
      break;
    }
  }
  if (!mapping) {
    return { allowed: false, code: 'ROLE_UNASSIGNED', errMsg: '当前用户未分配角色' };
  }

  let role = null;
  try {
    const roleResult = await db.collection(ROLE_COLLECTION).doc(mapping.userRole.roleId).get();
    role = roleResult.data || null;
  } catch (error) {
    role = null;
  }
  if (!role) {
    return { allowed: false, code: 'ROLE_NOT_FOUND', errMsg: '用户关联的角色不存在' };
  }

  const actions = Array.isArray(role.actionPermissions) ? role.actionPermissions : [];
  const allowed = actions.includes('*') || actions.includes(PRINT_PERMISSION);
  return allowed
    ? { allowed: true, operatorId: mapping.matchedUserId }
    : { allowed: false, code: 'ACCESS_DENIED', errMsg: '无权打印顺丰面单' };
}

async function ensureCollection(collectionName) {
  try {
    await db.collection(collectionName).limit(1).get();
  } catch (error) {
    if (!isNotFound(error)) throw error;
    if (typeof db.createCollection !== 'function') {
      throw createError('COLLECTION_NOT_FOUND', `数据库集合不存在: ${collectionName}`);
    }
    try {
      await db.createCollection(collectionName);
    } catch (createErrorValue) {
      const message = String(createErrorValue && createErrorValue.message || '');
      if (!message.includes('already exists') && !message.includes('exists')) throw createErrorValue;
    }
  }
}

async function getSfExpressOrder(sfExpressOrderId) {
  try {
    const result = await db.collection(SF_ORDERS_COLLECTION).doc(sfExpressOrderId).get();
    return result.data || null;
  } catch (error) {
    return null;
  }
}

function getWaybillNo(record) {
  const primary = Array.isArray(record.waybillNoInfoList)
    ? record.waybillNoInfoList.find(item => String(item.waybillType || '') === '1')
    : null;
  return trimString((primary && primary.waybillNo) || record.waybillNo);
}

function buildSnapshotProductLabel(item) {
  const brand = trimString(item && item.brand);
  const productName = trimString(item && item.productName);
  const specification = trimString(item && item.specification);
  const parts = [brand, productName].filter(Boolean);
  if (specification && specification !== '默认') parts.push(specification);
  return parts.join(' / ');
}

function buildSnapshotProductsRemark(products) {
  if (!Array.isArray(products)) return '';
  const summary = products
    .map(item => {
      const label = buildSnapshotProductLabel(item);
      if (!label) return '';
      const quantity = Number(item && item.quantity || 0);
      return `${label}×${Number.isFinite(quantity) && quantity > 0 ? quantity : 0}`;
    })
    .filter(Boolean)
    .join('，');
  return summary ? `客户下单：${summary}` : '';
}

function mergePrintRemarkParts(parts) {
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
  return merged.join('；');
}

function getPrintRemark(record) {
  const snapshot = record && record.orderSnapshot || {};
  return mergePrintRemarkParts([
    buildSnapshotProductsRemark(snapshot.products),
    snapshot.customerRemark || snapshot.rawCustomerRemark,
  ]).slice(0, 100);
}

function buildPrintDocument(waybillNo, remark) {
  return {
    masterWaybillNo: waybillNo,
    remark,
    customData: {
      hc_text: remark,
    },
  };
}

function validateSfExpressOrder(record, env) {
  if (!record) throw createError('SF_ORDER_NOT_FOUND', '顺丰记录不存在');
  if (record.isCurrent !== true) {
    throw createError('SF_ORDER_NOT_CURRENT', '该顺丰记录已不是当前记录');
  }
  if (record.status === 'cancelled') {
    throw createError('SF_ORDER_CANCELLED', '顺丰订单已取消，不能打印面单');
  }
  if (record.status !== 'applied') {
    throw createError('SF_ORDER_NOT_APPLIED', '只有申请成功的顺丰订单可以打印面单');
  }
  if (!trimString(record.env)) {
    throw createError('SF_ENV_MISSING', '顺丰记录缺少环境信息');
  }
  if (normalizeSfEnv(record.env) !== env) {
    throw createError(
      'SF_ENV_MISMATCH',
      `该订单是在${normalizeSfEnv(record.env) === 'production' ? '生产环境' : '沙箱环境'}下生成的，请切换到对应顺丰环境后打印`,
    );
  }
  const list = Array.isArray(record.waybillNoInfoList) ? record.waybillNoInfoList : [];
  if (list.some(item => ['2', '3'].includes(String(item && item.waybillType || '').trim()))) {
    throw createError('UNSUPPORTED_WAYBILL_STRUCTURE', '当前版本仅支持普通单票打印，不支持子母单或签回单');
  }
  const waybillNo = getWaybillNo(record);
  if (!waybillNo) throw createError('WAYBILL_NO_MISSING', '订单缺少顺丰运单号');
  return waybillNo;
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
  if (!tokenData.accessToken) throw new Error('顺丰 accessToken 缓存为空');
  if (Number(tokenData.expiresAt || 0) <= Date.now()) throw new Error('顺丰 accessToken 已过期');
  return tokenData.accessToken;
}

function parseJsonMaybe(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return {};
  }
}

function findPrintFiles(apiResultData) {
  const msgData = parseJsonMaybe(apiResultData.msgData);
  const obj = parseJsonMaybe(apiResultData.obj);
  const msgObj = parseJsonMaybe(msgData.obj);
  const candidates = [
    obj.files,
    msgObj.files,
    msgData.files,
    apiResultData.files,
  ];
  return candidates.find(Array.isArray) || [];
}

function parseSfPrintResponse(result) {
  if (result.apiResultCode !== 'A1000') {
    return {
      success: false,
      authFailed: result.apiResultCode === 'A1011',
      errMsg: result.apiErrorMsg || `顺丰平台调用失败: ${result.apiResultCode || 'UNKNOWN'}`,
    };
  }

  const apiResultData = parseJsonMaybe(result.apiResultData);
  const businessSuccess = apiResultData.success === true || apiResultData.success === 'true';
  const errorCode = trimString(apiResultData.errorCode);
  if (!businessSuccess || (errorCode && errorCode !== 'S0000')) {
    const errorMessage = trimString(
      apiResultData.errorMessage
      || apiResultData.errorMsg
      || apiResultData.message
      || apiResultData.msg,
    );
    return {
      success: false,
      errorCode,
      errMsg: errorMessage || `顺丰面单生成失败: ${errorCode || 'UNKNOWN'}`,
    };
  }

  const file = findPrintFiles(apiResultData).find(item => trimString(item && item.url));
  if (!file) {
    return { success: false, errMsg: '顺丰面单生成成功，但未返回 PDF 文件地址' };
  }
  if (!trimString(file.token)) {
    return { success: false, errMsg: '顺丰面单生成成功，但未返回 PDF 下载 token' };
  }

  return {
    success: true,
    fileUrl: trimString(file.url),
    fileToken: trimString(file.token),
  };
}

async function callPrintApi({ config, accessToken, requestID, waybillNo, remark }) {
  const msgData = {
    templateCode: config.templateCode,
    ...(config.customTemplateCode ? { customTemplateCode: config.customTemplateCode } : {}),
    version: '2.0',
    fileType: 'pdf',
    sync: true,
    documents: [buildPrintDocument(waybillNo, remark)],
  };
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
  try {
    result = JSON.parse(text);
  } catch (error) {
    throw new Error(`顺丰面单接口返回非 JSON，HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`顺丰面单接口 HTTP ${response.status}: ${result.apiErrorMsg || result.message || '请求失败'}`);
  }
  return result;
}

async function requestPrintFile({ config, requestID, waybillNo, remark }) {
  let accessToken = await getAccessToken(config, false);
  let result = await callPrintApi({ config, accessToken, requestID, waybillNo, remark });
  let parsed = parseSfPrintResponse(result);

  if (parsed.authFailed) {
    accessToken = await getAccessToken(config, true);
    result = await callPrintApi({ config, accessToken, requestID, waybillNo, remark });
    parsed = parseSfPrintResponse(result);
  }
  return parsed;
}

function isPrivateIp(address) {
  const normalized = trimString(address).toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    return isPrivateIp(normalized.slice('::ffff:'.length));
  }
  if (net.isIP(normalized) === 4) {
    const parts = normalized.split('.').map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || parts[0] === 0;
  }
  if (net.isIP(normalized) === 6) {
    return normalized === '::1'
      || normalized === '::'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe8')
      || normalized.startsWith('fe9')
      || normalized.startsWith('fea')
      || normalized.startsWith('feb');
  }
  return true;
}

async function assertPublicHttpUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new Error('顺丰返回的 PDF 地址无效');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('顺丰返回的 PDF 地址协议不受支持');
  }
  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new Error('顺丰返回的 PDF 地址不安全');
  }
  const addresses = await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(item => isPrivateIp(item.address))) {
    throw new Error('顺丰返回的 PDF 地址解析到非公网地址');
  }
  return url;
}

async function downloadPdf(rawUrl, token, maxFileBytes) {
  let currentUrl = rawUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const safeUrl = await assertPublicHttpUrl(currentUrl);
    const response = await fetch(safeUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'X-Auth-token': token },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirectCount === MAX_REDIRECTS) {
        throw new Error('顺丰 PDF 下载重定向异常');
      }
      currentUrl = new URL(location, safeUrl).toString();
      continue;
    }
    if (!response.ok) throw new Error(`顺丰 PDF 下载失败，HTTP ${response.status}`);

    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > maxFileBytes) throw new Error('顺丰 PDF 文件超过允许大小');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error('顺丰返回的 PDF 文件为空');
    if (bytes.length > maxFileBytes) throw new Error('顺丰 PDF 文件超过允许大小');
    if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('顺丰返回的文件不是有效 PDF');
    }
    return bytes;
  }
  throw new Error('顺丰 PDF 下载重定向次数过多');
}

function buildFileName(waybillNo) {
  const safeWaybillNo = trimString(waybillNo).replace(/[^a-zA-Z0-9_-]/g, '');
  return `SF_${safeWaybillNo || 'waybill'}.pdf`;
}

async function recordPdfSuccess({
  requestID,
  sfExpressOrderId,
  sourceOrderId,
  waybillNo,
  env,
  operatorId,
  printedAt,
}) {
  await ensureCollection(PRINT_LOG_COLLECTION);
  const transaction = await db.startTransaction();
  try {
    await transaction.collection(PRINT_LOG_COLLECTION).add({
      data: {
        _id: requestID,
        requestID,
        sfExpressOrderId,
        sourceOrderId,
        waybillNo,
        env,
        operatorId,
        channel: 'pdf',
        operation: 'generate_pdf',
        status: 'succeeded',
        callbackCode: null,
        counted: true,
        createdAt: printedAt,
        completedAt: printedAt,
        expiresAt: null,
      },
    });
    await transaction.collection(SF_ORDERS_COLLECTION).doc(sfExpressOrderId).update({
      data: {
        printCount: _.inc(1),
        lastPrintTime: printedAt,
        lastPrintRequestId: requestID,
        updatedAt: printedAt,
      },
    });
    await transaction.commit();
  } catch (error) {
    try { await transaction.rollback(); } catch (_) { /* ignore */ }
    throw error;
  }
}

exports.main = async (event) => {
  const { sfExpressOrderId } = event.data || {};
  if (!trimString(sfExpressOrderId)) return { success: false, errMsg: '缺少顺丰记录ID' };

  try {
    const permission = await requirePrintPermission();
    if (!permission.allowed) {
      return { success: false, code: permission.code, errMsg: permission.errMsg };
    }

    const env = await resolveSfEnv();
    const config = getSfConfig(env);
    const record = await getSfExpressOrder(sfExpressOrderId);
    const waybillNo = validateSfExpressOrder(record, env);
    const remark = getPrintRemark(record);
    const requestID = crypto.randomUUID().replace(/-/g, '');
    const parsed = await requestPrintFile({ config, requestID, waybillNo, remark });
    if (!parsed.success) {
      return {
        success: false,
        env,
        sfExpressOrderId,
        sourceOrderId: record.sourceOrderId,
        waybillNo,
        errorCode: parsed.errorCode || '',
        errMsg: parsed.errMsg,
      };
    }

    const pdf = await downloadPdf(parsed.fileUrl, parsed.fileToken, config.maxFileBytes);
    const printedAt = new Date().toISOString();
    await recordPdfSuccess({
      requestID,
      sfExpressOrderId,
      sourceOrderId: record.sourceOrderId,
      waybillNo,
      env,
      operatorId: permission.operatorId,
      printedAt,
    });

    return {
      success: true,
      env,
      sfExpressOrderId,
      sourceOrderId: record.sourceOrderId,
      waybillNo,
      fileName: buildFileName(waybillNo),
      mimeType: 'application/pdf',
      pdfBase64: pdf.toString('base64'),
      printedAt,
    };
  } catch (error) {
    console.error('获取顺丰丰密面单失败:', {
      sfExpressOrderId,
      message: error.message,
    });
    return {
      success: false,
      sfExpressOrderId,
      code: error.code || 'SF_PDF_PRINT_FAILED',
      errMsg: error.message || String(error),
    };
  }
};

exports.__test__ = {
  parseSfPrintResponse,
  getWaybillNo,
  getPrintRemark,
  buildSnapshotProductsRemark,
  buildPrintDocument,
  isPrivateIp,
  buildFileName,
  validateSfExpressOrder,
};
