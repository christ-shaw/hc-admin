/**
 * queryInvoices - 查询发票记录
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const STATUS_COMPAT_MAP = {
  unpaid: ['unpaid', '未开票'],
  paid: ['paid', '已开票'],
  '未开票': ['unpaid', '未开票'],
  '已开票': ['paid', '已开票'],
};

exports.main = async (event, context) => {
  const payload = event.data || event;
  const { limit = 10, cursor, companyName, applicant, status, startDate, endDate } = payload;
  const pageSize = Math.max(1, Number(limit) || 10);

  try {
    let query = db.collection('invoices');

    const conditions = {};
    if (companyName) conditions['companyName'] = db.RegExp({ regexp: companyName, options: 'i' });
    if (applicant) conditions['applicant'] = db.RegExp({ regexp: applicant, options: 'i' });
    if (status) {
      const compatStatuses = STATUS_COMPAT_MAP[status];
      conditions['status'] = compatStatuses ? _.in(compatStatuses) : status;
    }
    if (startDate || endDate) {
      const dateCondition = {};
      if (startDate) dateCondition['gte'] = startDate;
      if (endDate) dateCondition['lte'] = endDate;
      conditions['applyDate'] = _.and(dateCondition);
    }

    if (Object.keys(conditions).length > 0) {
      query = query.where(conditions);
    }

    // 多取一条，准确判断是否还有下一页，避免记录数刚好等于整页时出现“空白末页”。
    const offset = cursor ? Number(cursor) : 0;
    const result = await query
      .skip(offset)
      .limit(pageSize + 1)
      .orderBy('applyDate', 'desc')
      .orderBy('createTime', 'desc')
      .get();

    const fetchedData = result.data || [];
    const hasMore = fetchedData.length > pageSize;
    const data = fetchedData.slice(0, pageSize);
    const nextCursor = hasMore ? offset + pageSize : null;

    return {
      success: true,
      data,
      cursor: nextCursor ? String(nextCursor) : null,
      hasMore,
    };
  } catch (error) {
    console.error('查询发票失败:', error);
    return { success: false, data: [], cursor: null, hasMore: false };
  }
};
