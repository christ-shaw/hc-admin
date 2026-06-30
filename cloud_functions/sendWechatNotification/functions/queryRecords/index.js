const cloud = require("wx-server-sdk");
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;
const MAX_LIMIT = 100; // 微信云数据库单次查询最大限制
const { requireMiniappPermission, deniedResult } = require('./miniappAuth');
const { getCurrentUser } = require('./permissionAuth');

const ROLE_COLLECTION = 'roles';
const USER_ROLE_COLLECTION = 'user_roles';
const PAGE_PERMISSION_FALLBACKS = {
  'inbound:read': ['/inbound', '/stats'],
  'outbound:read': ['/outbound', '/stats'],
};

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean).map(String)));
}

function hasPermission(actions, permission) {
  const list = unique(actions);
  return list.includes('*') || list.includes(permission);
}

function hasPagePermission(pages, permission) {
  const list = unique(pages);
  const allowedPages = PAGE_PERMISSION_FALLBACKS[permission] || [];
  return list.includes('*') || allowedPages.some(page => list.includes(page));
}

async function findOne(collectionName, condition) {
  const result = await db.collection(collectionName).where(condition).limit(1).get();
  return result.data && result.data[0] || null;
}

async function findRole(roleId) {
  if (!roleId) return null;
  try {
    const result = await db.collection(ROLE_COLLECTION).doc(roleId).get();
    return result.data || null;
  } catch (err) {
    const message = String(err && err.message || '');
    if (message.includes('not exist') || message.includes('does not exist')) return null;
    throw err;
  }
}

function getWebUserIds(currentUser) {
  if (!currentUser || typeof currentUser !== 'object') return [];
  return unique([
    currentUser.id,
    currentUser.uid,
    currentUser.userId,
    currentUser.customUserId,
    currentUser.openid,
    currentUser.openId,
  ]).map(value => String(value).trim()).filter(value => value && value !== 'anon');
}

async function findUserRoleByIds(userIds) {
  for (const userId of userIds) {
    const userRole = await findOne(USER_ROLE_COLLECTION, { userId });
    if (userRole) return userRole;
  }
  return null;
}

async function requireWebPermission(currentUser, permissions = []) {
  const userIds = getWebUserIds(currentUser);
  if (userIds.length === 0) {
    return { allowed: false, code: 'LOGIN_REQUIRED', errMsg: '请先登录' };
  }

  const userRole = await findUserRoleByIds(userIds);
  if (!userRole) {
    return { allowed: false, code: 'ROLE_UNASSIGNED', errMsg: '当前用户未分配角色，请联系管理员' };
  }

  const role = await findRole(userRole.roleId);
  if (!role) {
    return { allowed: false, code: 'ROLE_NOT_FOUND', errMsg: '用户关联的角色不存在，请联系管理员' };
  }

  const actionPermissions = unique(role.actionPermissions);
  const pagePermissions = unique(role.pagePermissions);
  const required = unique(Array.isArray(permissions) ? permissions : [permissions]);
  const missing = required.filter(permission => !hasPermission(actionPermissions, permission) && !hasPagePermission(pagePermissions, permission));
  if (missing.length > 0) {
    return { allowed: false, code: 'PERMISSION_DENIED', errMsg: '当前用户无权执行该操作' };
  }

  return { allowed: true, role, actionPermissions };
}

async function requireRecordPermission(payload, requiredPermission) {
  // 小程序调用带平台注入的可信 OPENID，走小程序鉴权
  const wxContext = (typeof cloud.getWXContext === 'function' && cloud.getWXContext()) || {};
  if (wxContext.OPENID) {
    return await requireMiniappPermission(cloud, db, [requiredPermission]);
  }
  // 网页端：身份从服务端登录态解析，绝不信任 payload.currentUser（否则可伪造身份越权）
  const currentUser = await getCurrentUser();
  return await requireWebPermission(currentUser, [requiredPermission]);
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasTrackingNumber(record) {
  return trimString(record.trackingNumber) !== '';
}

function isPendingStatus(record) {
  return record.outboundStatus === 'pending';
}

function isOrderOutboundRecord(record) {
  return record.source === 'order' || (!record.source && trimString(record.linkedOrderId) !== '');
}

function isPendingOutboundRecord(record) {
  return isOrderOutboundRecord(record) && isPendingStatus(record) && !hasTrackingNumber(record);
}

function normalizePageSize(limit) {
  const pageSize = parseInt(limit, 10);
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    return 20;
  }
  return Math.min(pageSize, MAX_LIMIT);
}

function normalizeSkip(cursor) {
  const skipValue = parseInt(cursor, 10);
  if (!Number.isFinite(skipValue) || skipValue < 0) {
    return 0;
  }
  return skipValue;
}

function normalizeDateValue(value) {
  if (!value) return '';
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  if (typeof value === 'object' && value.$date) {
    return normalizeDateValue(value.$date);
  }

  const raw = String(value).trim();
  if (!raw) return '';
  const match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (match) {
    return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  }

  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) {
    return normalizeDateValue(date);
  }
  return '';
}

function isDateInRange(recordDate, startDate, endDate) {
  const normalized = normalizeDateValue(recordDate);
  if (!normalized) return false;
  const start = normalizeDateValue(startDate);
  const end = normalizeDateValue(endDate);
  if (start && normalized < start) return false;
  if (end && normalized > end) return false;
  return true;
}

async function fetchAllFromQuery(query, maxRecords = 10000) {
  const records = [];
  let offset = 0;
  let batch = [];

  do {
    const batchResult = await query
      .skip(offset)
      .limit(MAX_LIMIT)
      .get();
    batch = batchResult.data || [];
    records.push(...batch);
    offset += MAX_LIMIT;
  } while (batch.length === MAX_LIMIT && records.length < maxRecords);

  return records.slice(0, maxRecords);
}

exports.main = async (event, context) => {
  try {
    const payload = event.data || {};
    const requiredPermission = payload.type === 'inbound' ? 'inbound:read' : 'outbound:read';
    const auth = await requireRecordPermission(payload, requiredPermission);
    if (!auth.allowed) return deniedResult(auth);

    const { type, limit = 20, cursor, customerName, trackingNumber, startDate, endDate, shopName, channelType, model, _id, hasIssue, pendingOnly } = payload;

    // 根据类型选择集合
    const collectionName = type === 'inbound' ? 'inbound_records' : 'outbound_records';
    let query = db.collection(collectionName);

    // 构建查询条件对象（使用 AND 逻辑）
    const conditions = {};

    // 根据客户姓名筛选 (模糊查询)
    if (customerName && customerName.trim() !== '') {
      conditions.customerName = db.RegExp({
        regexp: customerName,
        options: 'i'
      });
    }

    // 根据物流单号筛选 (模糊查询)
    if (trackingNumber && trackingNumber.trim() !== '') {
      conditions.trackingNumber = db.RegExp({
        regexp: trackingNumber,
        options: 'i'
      });
    }

    // 根据店铺名称筛选 (仅入库记录支持)
    if (type === 'inbound' && shopName && shopName.trim() !== '') {
      conditions.shopName = db.RegExp({
        regexp: shopName,
        options: 'i'
      });
    }

    // 根据渠道类型筛选 (仅入库记录支持)
    if (type === 'inbound' && channelType && channelType.trim() !== '') {
      conditions.type = channelType;
    }

    if(_id && _id !== '')
    {
      conditions._id = _id
    }

    // 根据手机型号筛选 (模糊查询)
    if (model && model.trim() !== '') {
      conditions['phoneModels.model'] = db.RegExp({
        regexp: model,
        options: 'i'
      });
    }

    // 根据 hasIssue 筛选 (仅入库记录支持)
    if (type === 'inbound' && hasIssue !== undefined && hasIssue !== null) {
      conditions.hasIssue = hasIssue === true;
    }

    if (type === 'outbound' && pendingOnly === true) {
      conditions.outboundStatus = 'pending';
    }

    // 日期字段可能存在 YYYY-MM-DD、YYYY/MM/DD、ISO 时间等历史格式，不能直接用字符串范围比较。
    const dateField = type === 'inbound' ? 'inboundDate' : 'outboundDate';
    const hasDateFilter = !!(startDate || endDate);

    



    // 应用所有过滤条件（AND 逻辑）
    if (Object.keys(conditions).length > 0) {
      query = query.where(conditions);
    }

    // 按创建时间倒序查询
    query = query.orderBy('createTime', 'desc');

    let result;
    let nextCursor = null;

    const pageSize = normalizePageSize(limit);
    const skipValue = normalizeSkip(cursor);

    if (hasDateFilter || (type === 'outbound' && pendingOnly === true)) {
      const allRecords = await fetchAllFromQuery(query);
      const filteredRecords = allRecords.filter(record => {
        if (type === 'outbound' && pendingOnly === true && !isPendingOutboundRecord(record)) return false;
        if (hasDateFilter && !isDateInRange(record[dateField], startDate, endDate)) return false;
        return true;
      });

      result = {
        data: filteredRecords.slice(skipValue, skipValue + pageSize)
      };

      const total = filteredRecords.length;
      if (skipValue + result.data.length < total) {
        nextCursor = skipValue + pageSize;
      }

      return {
        success: true,
        data: result.data,
        cursor: nextCursor,
        hasMore: nextCursor !== null,
        total,
        errMsg: '查询记录成功'
      };
    }

    result = await query
      .limit(pageSize)
      .skip(skipValue)
      .get();

    // 查询总数以准确判断是否还有更多数据
    const countResult = await query.count();
    const total = countResult.total;

    // 判断是否还有更多数据
    if (skipValue + result.data.length < total) {
      nextCursor = skipValue + pageSize;
    }

    return {
      success: true,
      data: result.data,
      cursor: nextCursor,
      hasMore: nextCursor !== null,
      total,
      errMsg: '查询记录成功'
    };
  } catch (e) {
    console.error('查询记录失败:', e);
    return {
      success: false,
      errMsg: e.message || '查询记录失败'
    };
  }
};
