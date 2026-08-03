/**
 * queryCompanies - 查询公司模版
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event, context) => {
  const payload = event.data || event;
  const { limit = 50, cursor, companyName } = payload;
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 20));
  const offset = Math.max(0, Number(cursor) || 0);

  try {
    let query = db.collection('companies');
    const conditions = {};
    if (companyName) conditions['companyName'] = db.RegExp({ regexp: companyName, options: 'i' });

    if (Object.keys(conditions).length > 0) {
      query = query.where(conditions);
    }

    const [result, countResult] = await Promise.all([
      query.skip(offset).limit(pageSize).orderBy('createTime', 'desc').get(),
      query.count(),
    ]);
    const data = result.data || [];
    const total = Number(countResult.total || 0);
    const nextOffset = offset + data.length;
    const nextCursor = nextOffset < total ? String(nextOffset) : null;

    return {
      success: true,
      data,
      cursor: nextCursor,
      hasMore: nextCursor !== null,
      total,
    };
  } catch (error) {
    console.error('查询公司模版失败:', error);
    return { success: false, data: [], cursor: null, hasMore: false, total: 0 };
  }
};
