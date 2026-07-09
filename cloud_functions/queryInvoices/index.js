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

    let result;
    if (cursor) {
      result = await query.skip(cursor).limit(limit).orderBy('applyDate', 'desc').orderBy('createTime', 'desc').get();
    } else {
      result = await query.limit(limit).orderBy('applyDate', 'desc').orderBy('createTime', 'desc').get();
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
    console.error('查询发票失败:', error);
    return { success: false, data: [], cursor: null, hasMore: false };
  }
};
