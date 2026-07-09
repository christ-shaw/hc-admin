/**
 * manageLoginLogs - 登录日志管理
 *
 * action: record | list
 *   record: 记录一条登录日志（登录成功/失败时由前端调用）
 *   list:   分页查询登录日志（设置页面展示）
 */

const cloud = require('wx-server-sdk');
const tcbSdk = require('@cloudbase/node-sdk');

const tcb = tcbSdk.default || tcbSdk;
const ENV_ID = process.env.TCB_ENV
  || process.env.SCF_NAMESPACE
  || process.env.CLOUDBASE_ENV_ID
  || 'cloud1-8gvbotkt966e5e19';

const app = tcb.init({ env: ENV_ID });

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTION = 'login_logs';
const CONFIG_COLLECTION = 'system_config';
const CONFIG_ID = 'permission_system';
const ROLE_COLLECTION = 'roles';
const USER_ROLE_COLLECTION = 'user_roles';

function now() {
  return new Date().toISOString();
}

function getPayload(event) {
  return event && event.data || event || {};
}

function firstNonEmpty(values) {
  return values.find(value => value !== undefined && value !== null && String(value).trim() !== '') || '';
}

function limitString(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function getMetadata(source) {
  return source && (source.user_metadata || source.userMetadata || source.metadata || source.customUserInfo) || {};
}

function extractUsername(source) {
  if (!source || typeof source !== 'object') return '';
  const metadata = getMetadata(source);
  return String(firstNonEmpty([
    source.username,
    source.userName,
    source.loginName,
    source.name,
    metadata.username,
    metadata.userName,
    metadata.loginName,
    metadata.name,
  ]));
}

function extractNickName(source) {
  if (!source || typeof source !== 'object') return '';
  const metadata = getMetadata(source);
  return String(firstNonEmpty([
    source.nickName,
    source.nickname,
    source.displayName,
    metadata.nickName,
    metadata.nickname,
    metadata.displayName,
  ]));
}

function notFound(err) {
  const message = String(err && err.message || '');
  return err && (err.errCode === -1 || err.errCode === -502005 || message.includes('not exist') || message.includes('does not exist'));
}

function hasPermission(actions, permission) {
  const list = actions || [];
  return list.includes('*') || list.includes(permission);
}

function getClientIp(payload, event) {
  const source = event || {};
  const serverIp = String(
    source.headers && (source.headers['x-forwarded-for'] || source.headers['X-Forwarded-For'])
    || source.requestContext && source.requestContext.sourceIp
    || source.clientIp
    || source.ip
    || ''
  ).split(',')[0].trim();
  return limitString(serverIp, 64);
}

function getUserAgent(payload, event) {
  const source = event || {};
  const serverUA = String(
    source.headers && (source.headers['user-agent'] || source.headers['User-Agent'])
    || source.userAgent
    || ''
  );
  return limitString(serverUA || payload.userAgent, 512);
}

function normalizeDateBoundary(value, isEnd) {
  if (!value) return '';
  const input = String(value).trim();
  if (!input) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [year, month, day] = input.split('-').map(Number);
    const utcTime = isEnd
      ? Date.UTC(year, month - 1, day + 1, -8, 0, 0, -1)
      : Date.UTC(year, month - 1, day, -8, 0, 0, 0);
    return new Date(utcTime).toISOString();
  }
  return input;
}

async function getDoc(collectionName, id) {
  try {
    const result = await db.collection(collectionName)
      .where({ _id: id })
      .limit(1)
      .get();
    return (result.data && result.data[0]) || null;
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

async function getCurrentUser(event) {
  const auth = app.auth();
  let identity = {};
  try {
    identity = auth.getUserInfo() || {};
  } catch (error) {
    console.warn('读取当前调用用户失败:', error.message || error);
  }

  const canonicalId = firstNonEmpty([identity.uid, identity.customUserId, identity.openId]);
  if (!canonicalId || canonicalId === 'anon') return null;

  const payload = getPayload(event);
  const clientUser = payload.currentUser || {};
  return {
    id: String(canonicalId),
    uid: identity.uid || '',
    username: extractUsername(identity) || extractUsername(clientUser) || payload.username || '',
    nickName: extractNickName(identity) || extractNickName(clientUser) || payload.nickName || '',
  };
}

async function loadCurrentPermission(currentUser) {
  const config = await getDoc(CONFIG_COLLECTION, CONFIG_ID);
  if (!config || !config.initialized) {
    return { allowed: false, code: 'PERMISSION_UNINITIALIZED', errMsg: '权限系统未初始化' };
  }

  try {
    const result = await db.collection(USER_ROLE_COLLECTION)
      .where({ userId: currentUser.id })
      .limit(1)
      .get();
    const userRole = result.data && result.data[0];
    if (!userRole) {
      return { allowed: false, code: 'ROLE_UNASSIGNED', errMsg: '当前用户未分配角色' };
    }

    const role = await getDoc(ROLE_COLLECTION, userRole.roleId);
    if (!role) {
      return { allowed: false, code: 'ROLE_NOT_FOUND', errMsg: '用户关联的角色不存在' };
    }

    return { allowed: true, role };
  } catch (err) {
    if (notFound(err)) {
      return { allowed: false, code: 'ROLE_UNASSIGNED', errMsg: '当前用户未分配角色' };
    }
    throw err;
  }
}

/** 记录登录日志 */
async function recordLogin(payload, event) {
  const currentUser = await getCurrentUser(event);
  const username = limitString(currentUser && currentUser.username || payload.username, 80);
  const nickName = limitString(currentUser && currentUser.nickName || payload.nickName, 80);
  const userId = limitString(currentUser && currentUser.id || '', 128);
  const success = payload.success !== false;
  const failReason = success ? '' : limitString(payload.failReason || '登录失败', 200);

  if (!username && !userId) {
    return { success: false, errMsg: '缺少用户信息' };
  }

  if (success && !currentUser) {
    return { success: false, code: 'LOGIN_REQUIRED', errMsg: '成功登录日志需要有效登录态' };
  }

  const record = {
    userId,
    username,
    nickName,
    loginTime: now(),
    ip: getClientIp(payload, event),
    userAgent: getUserAgent(payload, event),
    success,
    failReason,
  };

  const result = await db.collection(COLLECTION).add({ data: record });
  return { success: true, data: { _id: result._id, ...record } };
}

/** 分页查询登录日志 */
async function listLogs(payload, currentUser) {
  const limit = Math.min(Number(payload.limit || 20), 100);
  const skip = Number(payload.cursor || 0) || 0;
  const filter = {};

  if (payload.username) filter.username = payload.username;
  if (payload.success !== undefined && payload.success !== null && payload.success !== '') {
    filter.success = payload.success === true || payload.success === 'true';
  }

  const _db = db.command;
  if (payload.startDate || payload.endDate) {
    filter.loginTime = {};
    if (payload.startDate) filter.loginTime = _db.gte(normalizeDateBoundary(payload.startDate, false));
    if (payload.endDate) {
      const endFilter = _db.lte(normalizeDateBoundary(payload.endDate, true));
      filter.loginTime = payload.startDate ? _db.and([_db.gte(normalizeDateBoundary(payload.startDate, false)), endFilter]) : endFilter;
    }
  }

  const collection = Object.keys(filter).length > 0
    ? db.collection(COLLECTION).where(filter)
    : db.collection(COLLECTION);

  const countResult = await collection.count();
  const total = countResult.total || 0;

  const pageResult = await collection
    .orderBy('loginTime', 'desc')
    .skip(skip)
    .limit(limit)
    .get();

  return {
    success: true,
    data: pageResult.data || [],
    total,
    cursor: skip + (pageResult.data || []).length < total ? String(skip + limit) : null,
  };
}

exports.main = async (event, context) => {
  const payload = getPayload(event);
  const action = payload.action || 'list';

  try {
    // record 不需要权限校验（登录时调用，此时可能还没登录态）
    if (action === 'record') {
      return await recordLogin(payload, event);
    }

    // list 需要登录态和 settings:read 权限
    const currentUser = await getCurrentUser(event);
    if (!currentUser) {
      return { success: false, code: 'LOGIN_REQUIRED', errMsg: '请先登录' };
    }

    const permission = await loadCurrentPermission(currentUser);
    if (!permission.allowed) {
      return { success: false, code: permission.code, errMsg: permission.errMsg };
    }

    if (!hasPermission(permission.role.actionPermissions, 'settings:read')) {
      return { success: false, code: 'ACCESS_DENIED', errMsg: '无权查看登录日志' };
    }

    if (action === 'list') {
      return await listLogs(payload, currentUser);
    }

    return { success: false, errMsg: '不支持的操作类型' };
  } catch (error) {
    console.error('管理登录日志失败:', error);
    return {
      success: false,
      code: 'LOGIN_LOG_FAILED',
      errMsg: error.message || '管理登录日志失败',
    };
  }
};
