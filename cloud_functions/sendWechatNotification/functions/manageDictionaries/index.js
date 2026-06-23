/**
 * manageDictionaries - 普通数据字典管理
 *
 * action:
 * - list
 * - initializeDefault
 * - createItem
 * - updateItem
 * - deleteItem
 */

const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const GROUP_COLLECTION = 'dict_groups';
const ITEM_COLLECTION = 'dict_items';
const CONFIG_COLLECTION = 'system_config';
const CONFIG_ID = 'permission_system';
const ROLE_COLLECTION = 'roles';
const USER_ROLE_COLLECTION = 'user_roles';

const READ_PERMISSION = 'settings:read';
const UPDATE_PERMISSION = 'settings:update';
const DICT_MANAGE_PERMISSION = 'settings:dict_manage';

const DEFAULT_GROUPS = [
  { code: 'channel_type', name: '渠道类型', category: 'inbound', editable: true, sort: 10 },
  { code: 'order_status', name: '订单状态', category: 'order', editable: true, sort: 20 },
  { code: 'return_status', name: '归还状态', category: 'order', editable: true, sort: 30 },
  { code: 'order_source', name: '订单来源', category: 'order', editable: true, sort: 40 },
  { code: 'order_attribute', name: '订单属性', category: 'order', editable: true, sort: 50 },
  { code: 'order_type', name: '订单类型', category: 'order', editable: true, sort: 60 },
  { code: 'sales_channel', name: '销售渠道', category: 'order', editable: true, sort: 70 },
  { code: 'channel_category', name: '渠道类别', category: 'order', editable: true, sort: 80 },
  { code: 'invoice_status', name: '发票状态', category: 'invoice', editable: true, sort: 90 },
  { code: 'invoice_category', name: '发票类目', category: 'invoice', editable: true, sort: 100 },
  { code: 'salesperson', name: '业务员', category: 'common', editable: true, sort: 110 },
  { code: 'payment_account', name: '收款账户', category: 'common', editable: true, sort: 120 },
  { code: 'shop_name', name: '店铺名称', category: 'common', editable: true, sort: 130 },
  { code: 'shipping_fee', name: '邮费类型', category: 'common', editable: true, sort: 140 },
];

const DEFAULT_ITEMS = {
  channel_type: [
    ['return', '归还'],
    ['afterSale', '售后'],
    ['recycle', '回收'],
    ['purchase', '采购'],
    ['normal', '正常'],
  ],
  order_status: [
    ['shipped', '已发货'],
    ['noShip', '不用发货'],
    ['returnReceived', '退货已收'],
    ['returnShipped', '退发已发'],
    ['unknown', '--'],
  ],
  return_status: [
    ['returned', '产品已退回入库'],
    ['inTransit', '产品运输途中'],
    ['notReturned', '客户未退回'],
  ],
  order_source: [
    ['new', '新增'],
    ['service', '服务'],
  ],
  order_attribute: [
    ['rental1', '租赁1'],
    ['rental2', '租赁2'],
  ],
  order_type: [
    ['newBusiness', '新增业务'],
    ['postRentalShip', '租后发货'],
    ['postRentalReturn', '租后退货'],
    ['postRentalPayment', '租后款项'],
    ['deposit', '押金'],
  ],
  sales_channel: [
    ['aRrz', 'A人人租'],
    ['fRrz', 'F人人租'],
    ['yuntu', '云途'],
    ['huizuji', '汇租机'],
    ['zujile', '租机乐'],
    ['zhuoshi', '倬石电子'],
    ['yunjie', '云界互联'],
    ['jikejuzhen', '极客矩阵'],
    ['jisushanzu', '极速闪租'],
    ['lRrz', 'L人人租'],
    ['jRrz', 'J人人租'],
    ['gRrz', 'G人人租'],
    ['xZz', 'X/ZZ'],
    ['xLl', 'X/LL'],
    ['xXx', 'X/XX'],
    ['xYy', 'X/YY'],
    ['xHh', 'X/HH'],
  ],
  channel_category: [
    ['platform', '平台'],
    ['offline', '线下'],
  ],
  invoice_status: [
    ['unpaid', '未开票'],
    ['paid', '已开票'],
  ],
  invoice_category: [
    ['租赁服务费', '租赁服务费'],
    ['二手手机', '二手手机'],
  ],
  salesperson: [
    ['XX', 'XX'],
    ['YY', 'YY'],
    ['LL', 'LL'],
    ['ZZ', 'ZZ'],
    ['HH', 'HH'],
  ],
  payment_account: [
    ['XX微信', 'XX微信'],
    ['YY微信', 'YY微信'],
    ['ZZ微信', 'ZZ微信'],
    ['XX支付宝', 'XX支付宝'],
    ['YY支付宝', 'YY支付宝'],
    ['ZKP支付宝', 'ZKP支付宝'],
    ['XXY支付宝', 'XXY支付宝'],
    ['MAJINGLONG微信', 'MAJINGLONG微信'],
    ['倬石公户', '倬石公户'],
    ['租机乐公户', '租机乐公户'],
    ['云途公户', '云途公户'],
    ['汇创公户', '汇创公户'],
    ['YYFISH', 'YYFISH'],
    ['XXFISH', 'XXFISH'],
    ['HHFISH', 'HHFISH'],
    ['未收款', '未收款'],
    ['其他', '其他'],
  ],
  shop_name: [
    ['倬石电子', '倬石电子'],
    ['云途', '云途'],
    ['租机乐', '租机乐'],
    ['汇创', '汇创'],
    ['鸿城数码', '鸿城数码'],
  ],
  shipping_fee: [
    ['prepaid', '包邮'],
    ['cod', '到付'],
    ['pickup', '自提'],
  ],
};

function now() {
  return new Date().toISOString();
}

function getPayload(event) {
  return event && event.data || event || {};
}

function notFound(err) {
  const message = String(err && err.message || '');
  return err && (err.errCode === -1 || err.errCode === -502005 || message.includes('not exist') || message.includes('does not exist'));
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
  } catch (err) {
    if (!notFound(err)) throw err;
    if (typeof db.createCollection !== 'function') {
      throw new Error(`数据库集合不存在且当前 SDK 不支持自动创建: ${collectionName}`);
    }
    try {
      await db.createCollection(collectionName);
    } catch (createErr) {
      const message = String(createErr && createErr.message || '');
      if (!message.includes('already exists') && !message.includes('exists')) throw createErr;
    }
  }
}

async function ensureDictionaryCollections() {
  await Promise.all([
    ensureCollection(GROUP_COLLECTION),
    ensureCollection(ITEM_COLLECTION),
  ]);
}

async function getDocById(collectionName, id) {
  try {
    const result = await db.collection(collectionName)
      .where({ _id: id })
      .limit(1)
      .get();
    return result.data && result.data[0] || null;
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

async function fetchAll(collectionName, where = {}) {
  try {
    const collection = Object.keys(where).length > 0
      ? db.collection(collectionName).where(where)
      : db.collection(collectionName);
    const result = [];
    const pageSize = 100;
    let skip = 0;

    while (true) {
      const page = await collection.skip(skip).limit(pageSize).get();
      const data = page.data || [];
      result.push(...data);
      if (data.length < pageSize) break;
      skip += pageSize;
    }

    return result;
  } catch (err) {
    if (notFound(err)) return [];
    throw err;
  }
}

async function loadCurrentPermission(currentUser) {
  const config = await getDocById(CONFIG_COLLECTION, CONFIG_ID);
  if (!config || !config.initialized) {
    return { allowed: false, code: 'PERMISSION_UNINITIALIZED', errMsg: '权限系统未初始化' };
  }

  const userRoles = await fetchAll(USER_ROLE_COLLECTION, { userId: currentUser.id });
  const userRole = userRoles[0];
  if (!userRole) {
    return { allowed: false, code: 'ROLE_UNASSIGNED', errMsg: '当前用户未分配角色' };
  }

  const role = await getDocById(ROLE_COLLECTION, userRole.roleId);
  if (!role) {
    return { allowed: false, code: 'ROLE_NOT_FOUND', errMsg: '用户关联的角色不存在' };
  }

  return { allowed: true, role };
}

async function requirePermission(permissions) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return { allowed: false, code: 'LOGIN_REQUIRED', errMsg: '请先登录' };
  }

  const permission = await loadCurrentPermission(currentUser);
  if (!permission.allowed) return permission;

  if (!hasAnyPermission(permission.role.actionPermissions, permissions)) {
    return { allowed: false, code: 'ACCESS_DENIED', errMsg: '无权管理数据字典' };
  }

  return { allowed: true, currentUser, role: permission.role };
}

function buildSeedGroups() {
  return DEFAULT_GROUPS.map(group => ({
    _id: group.code,
    ...group,
    enabled: true,
    seed: true,
  }));
}

function buildSeedItems() {
  const result = {};
  Object.entries(DEFAULT_ITEMS).forEach(([groupCode, items]) => {
    result[groupCode] = items.map(([value, label], index) => ({
      groupCode,
      value,
      label,
      enabled: true,
      sort: (index + 1) * 10,
      systemItem: true,
      seed: true,
    }));
  });
  return result;
}

async function listDictionaries() {
  const [groups, items] = await Promise.all([
    fetchAll(GROUP_COLLECTION),
    fetchAll(ITEM_COLLECTION),
  ]);

  if (groups.length === 0) {
    return {
      success: true,
      initialized: false,
      groups: buildSeedGroups(),
      data: buildSeedItems(),
    };
  }

  const data = {};
  groups.forEach(group => {
    data[group.code] = [];
  });
  items
    .sort((a, b) => (Number(a.sort || 0) - Number(b.sort || 0)) || String(a.label || '').localeCompare(String(b.label || ''), 'zh-Hans-CN'))
    .forEach(item => {
      if (!data[item.groupCode]) data[item.groupCode] = [];
      data[item.groupCode].push(item);
    });

  return {
    success: true,
    initialized: true,
    groups: groups.sort((a, b) => (Number(a.sort || 0) - Number(b.sort || 0)) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN')),
    data,
  };
}

async function findItemByValue(groupCode, value) {
  const result = await db.collection(ITEM_COLLECTION)
    .where({ groupCode, value })
    .limit(1)
    .get();
  return result.data && result.data[0] || null;
}

async function initializeDefault(currentUser) {
  await ensureDictionaryCollections();
  const timestamp = now();
  let groupCreated = 0;
  let itemCreated = 0;

  for (const group of DEFAULT_GROUPS) {
    const existing = await getDocById(GROUP_COLLECTION, group.code);
    if (!existing) {
      await db.collection(GROUP_COLLECTION).add({
        data: {
          _id: group.code,
          ...group,
          enabled: true,
          createdAt: timestamp,
          createdBy: currentUser.id,
          updatedAt: timestamp,
          updatedBy: currentUser.id,
        },
      });
      groupCreated++;
    }

    const items = DEFAULT_ITEMS[group.code] || [];
    for (let i = 0; i < items.length; i++) {
      const [value, label] = items[i];
      const existedItem = await findItemByValue(group.code, value);
      if (existedItem) continue;
      await db.collection(ITEM_COLLECTION).add({
        data: {
          groupCode: group.code,
          value,
          label,
          enabled: true,
          sort: (i + 1) * 10,
          systemItem: true,
          createdAt: timestamp,
          createdBy: currentUser.id,
          updatedAt: timestamp,
          updatedBy: currentUser.id,
        },
      });
      itemCreated++;
    }
  }

  return {
    success: true,
    groupCreated,
    itemCreated,
    errMsg: `已初始化默认字典，新增 ${groupCreated} 个字典组、${itemCreated} 个字典项`,
  };
}

async function createItem(payload, currentUser) {
  await ensureDictionaryCollections();
  const groupCode = String(payload.groupCode || '').trim();
  const value = String(payload.value || '').trim();
  const label = String(payload.label || '').trim();

  if (!groupCode) return { success: false, errMsg: '缺少字典组' };
  if (!value) return { success: false, errMsg: '字典值不能为空' };
  if (!label) return { success: false, errMsg: '显示名称不能为空' };

  const group = await getDocById(GROUP_COLLECTION, groupCode);
  if (!group) return { success: false, errMsg: '字典组不存在，请先初始化默认字典' };

  const existing = await findItemByValue(groupCode, value);
  if (existing) return { success: false, errMsg: '同一字典组内字典值已存在' };

  const timestamp = now();
  const result = await db.collection(ITEM_COLLECTION).add({
    data: {
      groupCode,
      value,
      label,
      enabled: payload.enabled !== false,
      sort: Number(payload.sort || 0),
      systemItem: false,
      createdAt: timestamp,
      createdBy: currentUser.id,
      updatedAt: timestamp,
      updatedBy: currentUser.id,
    },
  });

  return { success: true, data: { _id: result._id } };
}

async function updateItem(payload, currentUser) {
  const itemId = String(payload.itemId || payload._id || '').trim();
  if (!itemId) return { success: false, errMsg: '缺少字典项ID' };

  const existing = await getDocById(ITEM_COLLECTION, itemId);
  if (!existing) return { success: false, errMsg: '字典项不存在' };

  const updateData = {
    updatedAt: now(),
    updatedBy: currentUser.id,
  };

  if (payload.value !== undefined) {
    const value = String(payload.value || '').trim();
    if (!value) return { success: false, errMsg: '字典值不能为空' };
    if (value !== existing.value) {
      const duplicated = await findItemByValue(existing.groupCode, value);
      if (duplicated) return { success: false, errMsg: '同一字典组内字典值已存在' };
    }
    updateData.value = value;
  }
  if (payload.label !== undefined) {
    const label = String(payload.label || '').trim();
    if (!label) return { success: false, errMsg: '显示名称不能为空' };
    updateData.label = label;
  }
  if (payload.enabled !== undefined) updateData.enabled = payload.enabled !== false;
  if (payload.sort !== undefined) updateData.sort = Number(payload.sort || 0);

  await db.collection(ITEM_COLLECTION).doc(itemId).update({ data: updateData });
  return { success: true };
}

async function deleteItem(payload, currentUser) {
  const itemId = String(payload.itemId || payload._id || '').trim();
  if (!itemId) return { success: false, errMsg: '缺少字典项ID' };

  const existing = await getDocById(ITEM_COLLECTION, itemId);
  if (!existing) return { success: true, removed: 0 };

  if (existing.systemItem) {
    await db.collection(ITEM_COLLECTION).doc(itemId).update({
      data: {
        enabled: false,
        updatedAt: now(),
        updatedBy: currentUser.id,
      },
    });
    return { success: true, removed: 0, disabled: true };
  }

  const result = await db.collection(ITEM_COLLECTION).doc(itemId).remove();
  return { success: true, removed: result.stats && result.stats.removed || 0 };
}

exports.main = async (event, context) => {
  const payload = getPayload(event);
  const action = payload.action || 'list';

  try {
    const readActions = new Set(['list']);
    const permissions = readActions.has(action)
      ? [READ_PERMISSION, UPDATE_PERMISSION, DICT_MANAGE_PERMISSION]
      : [DICT_MANAGE_PERMISSION, UPDATE_PERMISSION];
    const auth = await requirePermission(permissions);
    if (!auth.allowed) {
      return { success: false, code: auth.code, errMsg: auth.errMsg };
    }

    if (action === 'list') return listDictionaries();
    if (action === 'initializeDefault') return initializeDefault(auth.currentUser);
    if (action === 'createItem') return createItem(payload, auth.currentUser);
    if (action === 'updateItem') return updateItem(payload, auth.currentUser);
    if (action === 'deleteItem') return deleteItem(payload, auth.currentUser);

    return { success: false, errMsg: '不支持的操作类型' };
  } catch (error) {
    console.error('管理数据字典失败:', error);
    const message = String(error && error.message || '');
    if (message.includes('not exist') || message.includes('collection')) {
      return {
        success: false,
        code: 'COLLECTION_NOT_EXIST',
        errMsg: '数据库集合不存在，请先初始化默认字典',
      };
    }
    return {
      success: false,
      code: 'DICTIONARY_MANAGE_FAILED',
      errMsg: error.message || '管理数据字典失败',
    };
  }
};
