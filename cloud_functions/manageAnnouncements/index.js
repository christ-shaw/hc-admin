/**
 * manageAnnouncements - 新功能通知与用户已读回执
 *
 * 用户操作:
 * - listPublished
 * - markRead
 *
 * 管理操作:
 * - listAdmin
 * - create
 * - update
 * - publish
 * - archive
 */

const crypto = require('crypto');
const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const ANNOUNCEMENT_COLLECTION = 'feature_announcements';
const READ_COLLECTION = 'feature_announcement_reads';
const CONFIG_COLLECTION = 'system_config';
const CONFIG_ID = 'permission_system';
const ROLE_COLLECTION = 'roles';
const USER_ROLE_COLLECTION = 'user_roles';
const MANAGE_PERMISSIONS = ['announcements:manage', 'settings:update'];
const ALLOWED_ACTION_PATHS = new Set([
  '',
  '/orders',
  '/sf-express',
  '/purchases',
  '/inbound',
  '/outbound',
  '/inventory',
  '/invoices',
  '/companies',
  '/settings',
]);

function now() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value || '').trim();
}

function getPayload(event) {
  return event && event.data || event || {};
}

function isNotFound(error) {
  const message = String(error && error.message || '');
  return error && (
    error.errCode === -1
    || error.errCode === -502005
    || message.includes('not exist')
    || message.includes('does not exist')
  );
}

function hasPermission(actions, permission) {
  const list = actions || [];
  return list.includes('*') || list.includes(permission);
}

function hasAnyPermission(actions, permissions) {
  return permissions.some(permission => hasPermission(actions, permission));
}

async function ensureCollection(collectionName) {
  try {
    await db.collection(collectionName).limit(1).get();
  } catch (error) {
    if (!isNotFound(error)) throw error;
    if (typeof db.createCollection !== 'function') {
      throw new Error(`数据库集合不存在且当前 SDK 不支持自动创建: ${collectionName}`);
    }
    try {
      await db.createCollection(collectionName);
    } catch (createError) {
      const message = String(createError && createError.message || '');
      if (!message.includes('already exists') && !message.includes('exists')) throw createError;
    }
  }
}

async function getDocById(collectionName, id) {
  try {
    const result = await db.collection(collectionName).where({ _id: id }).limit(1).get();
    return result.data && result.data[0] || null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function fetchAll(collectionName, where = {}) {
  try {
    const collection = Object.keys(where).length
      ? db.collection(collectionName).where(where)
      : db.collection(collectionName);
    const result = [];
    let skip = 0;
    const pageSize = 100;

    while (true) {
      const page = await collection.skip(skip).limit(pageSize).get();
      const data = page.data || [];
      result.push(...data);
      if (data.length < pageSize) break;
      skip += pageSize;
    }
    return result;
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function loadCurrentRole(currentUser) {
  const config = await getDocById(CONFIG_COLLECTION, CONFIG_ID);
  if (!config || !config.initialized) {
    return { allowed: false, code: 'PERMISSION_UNINITIALIZED', errMsg: '权限系统未初始化' };
  }

  const userRoles = await fetchAll(USER_ROLE_COLLECTION, { userId: currentUser.id });
  const userRole = userRoles[0];
  if (!userRole) return { allowed: false, code: 'ROLE_UNASSIGNED', errMsg: '当前用户未分配角色' };

  const role = await getDocById(ROLE_COLLECTION, userRole.roleId);
  if (!role) return { allowed: false, code: 'ROLE_NOT_FOUND', errMsg: '用户关联的角色不存在' };
  return { allowed: true, role };
}

async function requireRole() {
  const currentUser = await getCurrentUser();
  if (!currentUser) return { allowed: false, code: 'LOGIN_REQUIRED', errMsg: '请先登录' };

  const permission = await loadCurrentRole(currentUser);
  if (!permission.allowed) return permission;
  return { allowed: true, currentUser, role: permission.role };
}

async function requireManagePermission() {
  const auth = await requireRole();
  if (!auth.allowed) return auth;
  if (!hasAnyPermission(auth.role.actionPermissions, MANAGE_PERMISSIONS)) {
    return { allowed: false, code: 'ACCESS_DENIED', errMsg: '无权管理新功能通知' };
  }
  return auth;
}

function sanitizeAnnouncement(payload, existing = {}) {
  const actionPath = clean(payload.actionPath !== undefined ? payload.actionPath : existing.actionPath);
  if (!ALLOWED_ACTION_PATHS.has(actionPath)) {
    return { error: '功能入口不在允许范围内' };
  }

  const data = {
    title: clean(payload.title !== undefined ? payload.title : existing.title),
    versionLabel: clean(payload.versionLabel !== undefined ? payload.versionLabel : existing.versionLabel),
    summary: clean(payload.summary !== undefined ? payload.summary : existing.summary),
    content: clean(payload.content !== undefined ? payload.content : existing.content),
    actionPath,
  };

  if (!data.title) return { error: '通知标题不能为空' };
  if (!data.content) return { error: '功能说明不能为空' };
  if (data.title.length > 80) return { error: '通知标题不能超过80个字' };
  if (data.versionLabel.length > 30) return { error: '版本号不能超过30个字' };
  if (data.summary.length > 200) return { error: '摘要不能超过200个字' };
  if (data.content.length > 5000) return { error: '功能说明不能超过5000个字' };
  return { data };
}

function sortByUpdatedDesc(list) {
  return [...list].sort((left, right) => (
    new Date(right.updatedAt || right.createdAt || 0).getTime()
    - new Date(left.updatedAt || left.createdAt || 0).getTime()
  ));
}

function sortByPublishedDesc(list) {
  return [...list].sort((left, right) => (
    new Date(right.publishedAt || 0).getTime()
    - new Date(left.publishedAt || 0).getTime()
  ));
}

async function listAdmin() {
  await ensureCollection(ANNOUNCEMENT_COLLECTION);
  return { success: true, data: sortByUpdatedDesc(await fetchAll(ANNOUNCEMENT_COLLECTION)) };
}

async function listPublished(currentUser) {
  await Promise.all([
    ensureCollection(ANNOUNCEMENT_COLLECTION),
    ensureCollection(READ_COLLECTION),
  ]);
  const [allAnnouncements, receipts] = await Promise.all([
    fetchAll(ANNOUNCEMENT_COLLECTION),
    fetchAll(READ_COLLECTION, { userId: currentUser.id }),
  ]);
  const readByAnnouncement = new Map(receipts.map(item => [item.announcementId, item.readAt]));
  const data = sortByPublishedDesc(
    allAnnouncements.filter(item => item.status === 'published'),
  ).map(item => ({
    ...item,
    read: readByAnnouncement.has(item._id),
    readAt: readByAnnouncement.get(item._id) || '',
  }));
  return { success: true, data };
}

async function createAnnouncement(payload, currentUser) {
  await ensureCollection(ANNOUNCEMENT_COLLECTION);
  const validated = sanitizeAnnouncement(payload);
  if (validated.error) return { success: false, errMsg: validated.error };

  const timestamp = now();
  const result = await db.collection(ANNOUNCEMENT_COLLECTION).add({
    data: {
      ...validated.data,
      status: 'draft',
      createdAt: timestamp,
      createdBy: currentUser.id,
      updatedAt: timestamp,
      updatedBy: currentUser.id,
    },
  });
  return { success: true, data: { _id: result._id } };
}

async function updateAnnouncement(payload, currentUser) {
  const announcementId = clean(payload.announcementId || payload._id);
  if (!announcementId) return { success: false, errMsg: '缺少通知ID' };
  const existing = await getDocById(ANNOUNCEMENT_COLLECTION, announcementId);
  if (!existing) return { success: false, errMsg: '通知不存在' };
  if (existing.status === 'archived') return { success: false, errMsg: '已下线通知不能编辑' };

  const validated = sanitizeAnnouncement(payload, existing);
  if (validated.error) return { success: false, errMsg: validated.error };
  await db.collection(ANNOUNCEMENT_COLLECTION).doc(announcementId).update({
    data: {
      ...validated.data,
      updatedAt: now(),
      updatedBy: currentUser.id,
    },
  });
  return { success: true };
}

async function publishAnnouncement(payload, currentUser) {
  const announcementId = clean(payload.announcementId || payload._id);
  if (!announcementId) return { success: false, errMsg: '缺少通知ID' };
  const existing = await getDocById(ANNOUNCEMENT_COLLECTION, announcementId);
  if (!existing) return { success: false, errMsg: '通知不存在' };
  if (existing.status !== 'draft') return { success: false, errMsg: '只有草稿可以发布' };

  const validated = sanitizeAnnouncement(existing, existing);
  if (validated.error) return { success: false, errMsg: validated.error };
  const timestamp = now();
  await db.collection(ANNOUNCEMENT_COLLECTION).doc(announcementId).update({
    data: {
      status: 'published',
      publishedAt: timestamp,
      publishedBy: currentUser.id,
      updatedAt: timestamp,
      updatedBy: currentUser.id,
    },
  });
  return { success: true };
}

async function archiveAnnouncement(payload, currentUser) {
  const announcementId = clean(payload.announcementId || payload._id);
  if (!announcementId) return { success: false, errMsg: '缺少通知ID' };
  const existing = await getDocById(ANNOUNCEMENT_COLLECTION, announcementId);
  if (!existing) return { success: false, errMsg: '通知不存在' };
  if (existing.status === 'archived') return { success: true };

  const timestamp = now();
  await db.collection(ANNOUNCEMENT_COLLECTION).doc(announcementId).update({
    data: {
      status: 'archived',
      archivedAt: timestamp,
      archivedBy: currentUser.id,
      updatedAt: timestamp,
      updatedBy: currentUser.id,
    },
  });
  return { success: true };
}

async function markRead(payload, currentUser) {
  await Promise.all([
    ensureCollection(ANNOUNCEMENT_COLLECTION),
    ensureCollection(READ_COLLECTION),
  ]);
  const announcementId = clean(payload.announcementId || payload._id);
  if (!announcementId) return { success: false, errMsg: '缺少通知ID' };
  const announcement = await getDocById(ANNOUNCEMENT_COLLECTION, announcementId);
  if (!announcement || announcement.status !== 'published') {
    return { success: false, errMsg: '通知不存在或已下线' };
  }

  const readAt = now();
  const receiptId = crypto
    .createHash('sha256')
    .update(`${currentUser.id}|${announcementId}`)
    .digest('hex');
  await db.collection(READ_COLLECTION).doc(receiptId).set({
    data: {
      announcementId,
      userId: currentUser.id,
      readAt,
    },
  });
  return { success: true, data: { readAt } };
}

exports.main = async (event) => {
  const payload = getPayload(event);
  const action = clean(payload.action || 'listPublished');

  try {
    const isManageAction = ['listAdmin', 'create', 'update', 'publish', 'archive'].includes(action);
    const auth = isManageAction ? await requireManagePermission() : await requireRole();
    if (!auth.allowed) return { success: false, code: auth.code, errMsg: auth.errMsg };

    if (action === 'listPublished') return listPublished(auth.currentUser);
    if (action === 'markRead') return markRead(payload, auth.currentUser);
    if (action === 'listAdmin') return listAdmin();
    if (action === 'create') return createAnnouncement(payload, auth.currentUser);
    if (action === 'update') return updateAnnouncement(payload, auth.currentUser);
    if (action === 'publish') return publishAnnouncement(payload, auth.currentUser);
    if (action === 'archive') return archiveAnnouncement(payload, auth.currentUser);
    return { success: false, errMsg: '不支持的操作类型' };
  } catch (error) {
    console.error('管理新功能通知失败:', error);
    return {
      success: false,
      code: 'ANNOUNCEMENT_MANAGE_FAILED',
      errMsg: error.message || '管理新功能通知失败',
    };
  }
};
