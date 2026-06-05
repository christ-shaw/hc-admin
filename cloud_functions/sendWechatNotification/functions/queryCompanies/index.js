/**
 * queryCompanies - 查询公司模版
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event, context) => {
  const payload = event.data || event;
  const { limit = 50, cursor, companyName } = payload;

  try {
    let query = db.collection('companies');
    const conditions = {};
    if (companyName) conditions['companyName'] = db.RegExp({ regexp: companyName, options: 'i' });

    if (Object.keys(conditions).length > 0) {
      query = query.where(conditions);
    }

    let result;
    if (cursor) {
      result = await query.skip(cursor).limit(limit).orderBy('createTime', 'desc').get();
    } else {
      result = await query.limit(limit).orderBy('createTime', 'desc').get();
    }

    const data = result.data || [];
    const nextCursor = data.length === limit ? (cursor ? Number(cursor) + limit : limit) : null;

    return {
      success: true,
      data,
      cursor: nextCursor ? String(nextCursor) : null,
      hasMore: data.length === limit,
    };
  } catch (error) {
    console.error('查询公司模版失败:', error);
    return { success: false, data: [], cursor: null, hasMore: false };
  }
};
