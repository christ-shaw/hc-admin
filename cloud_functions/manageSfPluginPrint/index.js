/**
 * manageSfPluginPrint - 管理顺丰 Windows 云打印插件会话
 *
 * action:
 * - bootstrap: 返回 SDK 初始化参数，不返回 accessToken
 * - prepare: 校验订单并返回 SCPPrint.print 所需参数
 * - record: 幂等记录 SDK 回调结果
 */

const crypto = require('node:crypto');
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
const SDK_VERSION = '2.7';
const SESSION_TTL_MS = 10 * 60 * 1000;
const MIN_TOKEN_REMAINING_MS = 30 * 1000;

function trimString(value) {
  return String(value || '').trim();
}

function normalizeSfEnv(value = process.env.SF_ENV || 'sandbox') {
  const normalized = trimString(value).toLowerCase();
  if (!normalized || normalized === 'sandbox' || normalized === 'sbox') return 'sandbox';
  if (normalized === 'prod' || normalized === 'production') return 'production';
  throw createError('SF_ENV_INVALID', `顺丰环境仅支持 sandbox 或 production，当前值: ${value}`);
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

function getPartnerID(env) {
  const partnerID = env === 'production'
    ? getFirstEnv(['SF_PROD_CLIENT_CODE', 'SF_PRODUCTION_CLIENT_CODE'])
    : getFirstEnv(['SF_SANDBOX_CLIENT_CODE']);
  if (!partnerID) {
    throw createError(
      'SF_PARTNER_ID_MISSING',
      env === 'production'
        ? '缺少云函数环境变量 SF_PROD_CLIENT_CODE'
        : '缺少云函数环境变量 SF_SANDBOX_CLIENT_CODE',
    );
  }
  return partnerID;
}

function getTemplateCode(env) {
  const templateCode = env === 'production'
    ? getFirstEnv(['SF_PROD_PRINT_TEMPLATE_CODE', 'SF_PRODUCTION_PRINT_TEMPLATE_CODE'])
    : getFirstEnv(['SF_SANDBOX_PRINT_TEMPLATE_CODE']);
  if (!templateCode) {
    throw createError(
      'SF_PRINT_TEMPLATE_MISSING',
      env === 'production'
        ? '缺少云函数环境变量 SF_PROD_PRINT_TEMPLATE_CODE'
        : '缺少云函数环境变量 SF_SANDBOX_PRINT_TEMPLATE_CODE',
    );
  }
  return templateCode;
}

function getCustomTemplateCode(env) {
  return env === 'production'
    ? getFirstEnv(['SF_PROD_CUSTOM_TEMPLATE_CODE', 'SF_PRODUCTION_CUSTOM_TEMPLATE_CODE'])
    : getFirstEnv(['SF_SANDBOX_CUSTOM_TEMPLATE_CODE']);
}

function getPluginEnabled(config, env) {
  const byEnv = config && config.pluginPrintEnabledByEnv;
  return !!(byEnv && byEnv[env] === true);
}

function buildRequestID() {
  return crypto.randomUUID().replace(/-/g, '');
}

function normalizeWaybillInfoList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .map(item => ({
      waybillType: String(item && item.waybillType || '').trim(),
      waybillNo: trimString(item && item.waybillNo),
    }))
    .filter(item => {
      if (!item.waybillNo || seen.has(item.waybillNo)) return false;
      seen.add(item.waybillNo);
      return true;
    });
}

function getPrimaryWaybillNo(record) {
  const list = normalizeWaybillInfoList(record && record.waybillNoInfoList);
  const primary = list.find(item => item.waybillType === '1');
  return trimString(primary && primary.waybillNo)
    || trimString(record && record.waybillNo);
}

function getPrintRemark(record) {
  return trimString(record && record.orderSnapshot && record.orderSnapshot.customerRemark).slice(0, 100);
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

function validatePrintableOrder(record, env) {
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
  const orderEnv = normalizeSfEnv(record.env);
  if (orderEnv !== env) {
    throw createError(
      'SF_ENV_MISMATCH',
      `该订单是在${orderEnv === 'production' ? '生产环境' : '沙箱环境'}下生成的，请切换到对应顺丰环境后打印`,
    );
  }

  const list = normalizeWaybillInfoList(record.waybillNoInfoList);
  if (list.some(item => item.waybillType === '2' || item.waybillType === '3')) {
    throw createError('UNSUPPORTED_WAYBILL_STRUCTURE', '当前版本仅支持普通单票打印，不支持子母单或签回单');
  }
  const waybillNo = getPrimaryWaybillNo(record);
  if (!waybillNo) throw createError('WAYBILL_NO_MISSING', '订单缺少顺丰运单号');
  return {
    waybillNo,
    documents: [buildPrintDocument(waybillNo, getPrintRemark(record))],
  };
}

function sanitizeMessage(value) {
  return trimString(value)
    .replace(/(accessToken|x-auth-token|authorization)[\"']?\s*[:=]\s*[\"']?[^\"'\s,;}]+/gi, '$1=[REDACTED]')
    .slice(0, 500);
}

function normalizeCallbackCode(value) {
  const code = Number(value);
  if (!Number.isInteger(code)) throw createError('PRINT_CALLBACK_CODE_INVALID', '打印结果 code 无效');
  return code;
}

function getRecordOutcome(operation, code) {
  if (operation === 'preview' && (code === 1 || code === 15)) {
    return { status: 'previewed', counted: false };
  }
  if (operation === 'print' && code === 1) {
    return { status: 'succeeded', counted: true };
  }
  return { status: 'failed', counted: false };
}

async function getDoc(collectionName, id) {
  try {
    const result = await db.collection(collectionName).doc(id).get();
    return result.data || null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function findUserRole(userIds) {
  for (const userId of userIds) {
    const result = await db.collection(USER_ROLE_COLLECTION)
      .where({ userId })
      .limit(1)
      .get();
    const userRole = result.data && result.data[0];
    if (userRole) return { userRole, matchedUserId: userId };
  }
  return null;
}

async function requirePrintPermission() {
  const currentUser = await getCurrentUser();
  if (!currentUser) throw createError('LOGIN_REQUIRED', '请先登录');
  const mapping = await findUserRole(currentUser.ids || [currentUser.id]);
  if (!mapping) throw createError('ROLE_UNASSIGNED', '当前用户未分配角色');
  const role = await getDoc(ROLE_COLLECTION, mapping.userRole.roleId);
  if (!role) throw createError('ROLE_NOT_FOUND', '用户关联的角色不存在');
  const actions = Array.isArray(role.actionPermissions) ? role.actionPermissions : [];
  if (!actions.includes('*') && !actions.includes(PRINT_PERMISSION)) {
    throw createError('ACCESS_DENIED', '无权打印顺丰面单');
  }
  return {
    currentUser,
    operatorId: mapping.matchedUserId,
    role,
  };
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

async function readSfConfig() {
  const config = await getDoc(CONFIG_COLLECTION, SF_CONFIG_DOC_ID);
  const rawEnv = trimString(config && config.env);
  const env = rawEnv ? normalizeSfEnv(rawEnv) : normalizeSfEnv();
  return { config: config || {}, env };
}

async function getSfExpressOrder(sfExpressOrderId) {
  return getDoc(SF_ORDERS_COLLECTION, sfExpressOrderId);
}

async function getAccessToken(env, forceRefresh) {
  const result = await cloud.callFunction({
    name: 'getSfAccessToken',
    data: { forceRefresh: !!forceRefresh, sfEnv: env },
  });
  const tokenResult = result.result || {};
  if (!tokenResult.success) {
    throw createError('SF_TOKEN_FAILED', tokenResult.errMsg || '获取顺丰 accessToken 失败');
  }
  const tokenData = await getDoc(TOKEN_COLLECTION, env);
  const accessToken = trimString(tokenData && tokenData.accessToken);
  const expiresAt = Number(tokenData && tokenData.expiresAt || 0);
  if (!accessToken) throw createError('SF_TOKEN_EMPTY', '顺丰 accessToken 缓存为空');
  if (expiresAt <= Date.now() + MIN_TOKEN_REMAINING_MS) {
    throw createError('SF_TOKEN_EXPIRED', '顺丰 accessToken 已过期');
  }
  return { accessToken, expiresAt };
}

async function handleBootstrap(auth) {
  const { config, env } = await readSfConfig();
  return {
    success: true,
    env,
    sdkEnv: env === 'production' ? 'pro' : 'sbox',
    partnerID: getPartnerID(env),
    pluginPrintEnabled: getPluginEnabled(config, env),
    sdkVersion: SDK_VERSION,
  };
}

async function consumeRetrySession(requestID, auth, sfExpressOrderId, operation, env) {
  const transaction = await db.startTransaction();
  try {
    const result = await transaction.collection(PRINT_LOG_COLLECTION).doc(requestID).get();
    const log = result.data || null;
    if (!log) throw createError('RETRY_SESSION_NOT_FOUND', '原打印会话不存在');
    if (log.operatorId !== auth.operatorId) throw createError('ACCESS_DENIED', '无权重试该打印会话');
    if (log.sfExpressOrderId !== sfExpressOrderId || log.operation !== operation || log.env !== env) {
      throw createError('RETRY_SESSION_MISMATCH', '原打印会话与本次请求不一致');
    }
    if (log.callbackCode !== 12 || log.apiResultCode !== 'A1011') {
      throw createError('RETRY_NOT_ALLOWED', '仅 accessToken 失效时允许自动刷新重试');
    }
    if (log.retryUsed) throw createError('RETRY_ALREADY_USED', '该打印会话已执行过刷新重试');
    await transaction.collection(PRINT_LOG_COLLECTION).doc(requestID).update({
      data: {
        retryUsed: true,
        updatedAt: db.serverDate(),
      },
    });
    await transaction.commit();
  } catch (error) {
    try { await transaction.rollback(); } catch (_) { /* ignore */ }
    throw error;
  }
}

async function createPrintSession({
  requestID,
  auth,
  sfExpressOrderId,
  sourceOrderId,
  waybillNo,
  env,
  operation,
  expiresAt,
  retryOfRequestID,
}) {
  await ensureCollection(PRINT_LOG_COLLECTION);
  await db.collection(PRINT_LOG_COLLECTION).add({
    data: {
      _id: requestID,
      requestID,
      sfExpressOrderId,
      sourceOrderId,
      waybillNo,
      env,
      channel: 'plugin',
      operation,
      status: 'prepared',
      operatorId: auth.operatorId,
      sdkVersion: SDK_VERSION,
      expiresAt,
      retryOfRequestID: retryOfRequestID || '',
      retryUsed: false,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
    },
  });
}

async function handlePrepare(payload, auth) {
  const sfExpressOrderId = trimString(payload.sfExpressOrderId);
  const operation = trimString(payload.operation);
  const retryOfRequestID = trimString(payload.retryOfRequestID);
  if (!sfExpressOrderId) throw createError('SF_ORDER_ID_MISSING', '缺少顺丰记录ID');
  if (!['print', 'preview'].includes(operation)) {
    throw createError('PRINT_OPERATION_INVALID', 'operation 仅支持 print 或 preview');
  }

  const { config, env } = await readSfConfig();
  if (!getPluginEnabled(config, env)) {
    throw createError('SF_PLUGIN_PRINT_DISABLED', '当前顺丰环境未启用 Windows 插件打印');
  }
  const record = await getSfExpressOrder(sfExpressOrderId);
  const { waybillNo, documents } = validatePrintableOrder(record, env);
  const templateCode = getTemplateCode(env);
  const customTemplateCode = getCustomTemplateCode(env);

  if (retryOfRequestID) {
    await ensureCollection(PRINT_LOG_COLLECTION);
    await consumeRetrySession(retryOfRequestID, auth, sfExpressOrderId, operation, env);
  }

  const token = await getAccessToken(env, !!retryOfRequestID);
  const requestID = buildRequestID();
  const expiresAt = Math.min(token.expiresAt, Date.now() + SESSION_TTL_MS);
  await createPrintSession({
    requestID,
    auth,
    sfExpressOrderId,
    sourceOrderId: record.sourceOrderId,
    waybillNo,
    env,
    operation,
    expiresAt,
    retryOfRequestID,
  });

  return {
    success: true,
    env,
    sdkEnv: env === 'production' ? 'pro' : 'sbox',
    sfExpressOrderId,
    sourceOrderId: record.sourceOrderId,
    waybillNo,
    requestID,
    accessToken: token.accessToken,
    accessTokenExpiresAt: token.expiresAt,
    sessionExpiresAt: expiresAt,
    templateCode,
    ...(customTemplateCode ? { customTemplateCode } : {}),
    version: '2.0',
    documents,
  };
}

async function handleRecord(payload, auth) {
  const requestID = trimString(payload.requestID);
  if (!requestID) throw createError('PRINT_REQUEST_ID_MISSING', '缺少打印 requestID');
  const code = normalizeCallbackCode(payload.code);
  const apiResultCode = trimString(payload.apiResultCode).slice(0, 32);
  const message = sanitizeMessage(payload.msg);
  const printerName = trimString(payload.printerName).slice(0, 128);
  const clientPlatform = trimString(payload.clientPlatform).slice(0, 64);

  const transaction = await db.startTransaction();
  try {
    const result = await transaction.collection(PRINT_LOG_COLLECTION).doc(requestID).get();
    const log = result.data || null;
    if (!log) throw createError('PRINT_SESSION_NOT_FOUND', '打印会话不存在');
    if (log.operatorId !== auth.operatorId) throw createError('ACCESS_DENIED', '无权更新该打印会话');

    if (['succeeded', 'previewed', 'failed', 'expired'].includes(log.status)) {
      await transaction.commit();
      return {
        success: true,
        requestID,
        status: log.status,
        counted: !!log.counted,
        duplicated: true,
      };
    }

    if (Number(log.expiresAt || 0) <= Date.now()) {
      await transaction.collection(PRINT_LOG_COLLECTION).doc(requestID).update({
        data: {
          status: 'expired',
          counted: false,
          callbackCode: code,
          apiResultCode,
          message,
          completedAt: db.serverDate(),
          updatedAt: db.serverDate(),
        },
      });
      await transaction.commit();
      return {
        success: false,
        code: 'PRINT_SESSION_EXPIRED',
        requestID,
        status: 'expired',
        counted: false,
        errMsg: '打印会话已过期，结果未计入打印次数',
      };
    }

    const outcome = getRecordOutcome(log.operation, code);
    await transaction.collection(PRINT_LOG_COLLECTION).doc(requestID).update({
      data: {
        status: outcome.status,
        counted: outcome.counted,
        callbackCode: code,
        apiResultCode,
        message,
        printerName,
        clientPlatform,
        completedAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });
    if (outcome.counted) {
      await transaction.collection(SF_ORDERS_COLLECTION).doc(log.sfExpressOrderId).update({
        data: {
          printCount: _.inc(1),
          lastPrintTime: new Date().toISOString(),
          lastPrintRequestId: requestID,
          updatedAt: new Date().toISOString(),
        },
      });
    }
    await transaction.commit();
    return {
      success: true,
      requestID,
      status: outcome.status,
      counted: outcome.counted,
      duplicated: false,
    };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) { /* ignore */ }
    throw error;
  }
}

exports.main = async (event) => {
  const payload = event && event.data || event || {};
  const action = trimString(payload.action) || 'bootstrap';
  try {
    const auth = await requirePrintPermission();
    if (action === 'bootstrap') return await handleBootstrap(auth);
    if (action === 'prepare') return await handlePrepare(payload, auth);
    if (action === 'record') return await handleRecord(payload, auth);
    return { success: false, code: 'ACTION_NOT_SUPPORTED', errMsg: '不支持的操作类型' };
  } catch (error) {
    console.error('管理顺丰插件打印失败:', {
      action,
      sfExpressOrderId: trimString(payload.sfExpressOrderId),
      requestID: trimString(payload.requestID),
      code: error.code || '',
      message: error.message,
    });
    return {
      success: false,
      code: error.code || 'SF_PLUGIN_PRINT_FAILED',
      errMsg: error.message || '顺丰插件打印失败',
    };
  }
};

exports.__test__ = {
  getPluginEnabled,
  normalizeWaybillInfoList,
  getPrimaryWaybillNo,
  getPrintRemark,
  buildPrintDocument,
  validatePrintableOrder,
  sanitizeMessage,
  normalizeCallbackCode,
  getRecordOutcome,
};
