const cloud = require("wx-server-sdk");
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;
const { requireMiniappPermission, deniedResult } = require('./miniappAuth');

const ROLE_COLLECTION = 'roles';
const USER_ROLE_COLLECTION = 'user_roles';
const PAGE_PERMISSION_FALLBACKS = {
  'inbound:update': ['/inbound'],
  'outbound:update': ['/outbound'],
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
  if (payload.currentUser) {
    const webAuth = await requireWebPermission(payload.currentUser, [requiredPermission]);
    if (webAuth.allowed || webAuth.code !== 'LOGIN_REQUIRED') return webAuth;
  }
  return await requireMiniappPermission(cloud, db, [requiredPermission]);
}

exports.main = async (event, context) => {
  try {
    const payload = event.data || {};
    const { recordId, type, updateData, operator } = payload;

    // 参数校验
    console.log('data=  ',event.data )
    console.log('recordid = ',recordId)
    if (!recordId) {
      return {
        success: false,
        errMsg: '记录ID不能为空'
      };
    }

    if (!type || (type !== 'inbound' && type !== 'outbound')) {
      return {
        success: false,
        errMsg: '记录类型必须为 inbound 或 outbound'
      };
    }

    const requiredPermission = type === 'inbound' ? 'inbound:update' : 'outbound:update';
    const auth = await requireRecordPermission(payload, requiredPermission);
    if (!auth.allowed) return deniedResult(auth);

    if (!updateData || Object.keys(updateData).length === 0) {
      return {
        success: false,
        errMsg: '更新数据不能为空'
      };
    }

    // 根据类型选择集合
    const collectionName = type === 'inbound' ? 'inbound_records' : 'outbound_records';

    // 检查记录是否存在
    const existingRecord = await db.collection(collectionName).doc(recordId).get();

    if (!existingRecord.data) {
      return {
        success: false,
        errMsg: '记录不存在'
      };
    }

    // 构建更新数据
    const dataToUpdate = {
      ...updateData,
      updateTime: new Date().toISOString()
    };

    // 比对变更字段，生成修改记录
    const changes = [];
    for (const [field, newValue] of Object.entries(updateData)) {
      const oldValue = existingRecord.data[field];
      // 使用 JSON 序列化比较，处理对象和数组
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        changes.push({
          field,
          oldValue: oldValue !== undefined ? oldValue : null,
          newValue
        });
      }
    }

    // 更新记录
    const result = await db.collection(collectionName).doc(recordId).update({
      data: dataToUpdate
    });

    // 写入修改历史
    if (changes.length > 0) {
      try {
        await db.collection('record_history').add({
          data: {
            recordId,
            recordType: type,
            modifiedBy: operator || '未知用户',
            modifiedByOpenid: auth.openid || '',
            modifiedAt: db.serverDate(),
            changes
          }
        });
        console.log('修改历史记录成功，变更字段数:', changes.length);
      } catch (historyErr) {
        // 修改历史记录失败不影响主流程
        console.error('记录修改历史失败:', historyErr);
      }
    }

    return {
      success: true,
      errMsg: '更新成功',
      data: {
        _id: result._id,
        recordId: recordId,
        ...dataToUpdate
      }
    };
  } catch (e) {
    console.error('更新记录失败:', e);
    return {
      success: false,
      errMsg: e.message || '更新记录失败'
    };
  }
};
