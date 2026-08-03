/**
 * getDictionaries - 读取普通数据字典
 *
 * event.data:
 * groupCodes?: string[]  需要读取的字典组，空数组表示全部
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const GROUP_COLLECTION = 'dict_groups';
const ITEM_COLLECTION = 'dict_items';

function getPayload(event) {
  return event && event.data || event || {};
}

function notFound(err) {
  const message = String(err && err.message || '');
  return err && (err.errCode === -1 || err.errCode === -502005 || message.includes('not exist') || message.includes('does not exist'));
}

function normalizeCodes(value) {
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
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

exports.main = async (event) => {
  const payload = getPayload(event);
  const groupCodes = normalizeCodes(payload.groupCodes);

  try {
    const groupWhere = groupCodes.length > 0
      ? { code: _.in(groupCodes), enabled: true }
      : { enabled: true };
    const itemWhere = groupCodes.length > 0
      ? { groupCode: _.in(groupCodes), enabled: true }
      : { enabled: true };

    const [groups, items] = await Promise.all([
      fetchAll(GROUP_COLLECTION, groupWhere),
      fetchAll(ITEM_COLLECTION, itemWhere),
    ]);

    const enabledGroupCodes = new Set(groups.map(group => group.code));
    const data = {};
    groups.forEach(group => {
      data[group.code] = [];
    });
    items
      .filter(item => enabledGroupCodes.has(item.groupCode))
      .sort((a, b) => (Number(a.sort || 0) - Number(b.sort || 0)) || String(a.label || '').localeCompare(String(b.label || ''), 'zh-Hans-CN'))
      .forEach(item => {
        if (!data[item.groupCode]) data[item.groupCode] = [];
        data[item.groupCode].push(item);
      });

    return {
      success: true,
      groups: groups.sort((a, b) => (Number(a.sort || 0) - Number(b.sort || 0)) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN')),
      data,
    };
  } catch (error) {
    console.error('读取数据字典失败:', error);
    return {
      success: false,
      groups: [],
      data: {},
      errMsg: error.message || '读取数据字典失败',
    };
  }
};
