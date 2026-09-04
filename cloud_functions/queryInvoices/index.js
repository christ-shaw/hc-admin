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

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(Math.floor(number)) && number > 0
    ? Math.max(1, Math.floor(number))
    : fallback;
}

function literalPattern(value) {
  return String(value).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

exports.main = async (event, context) => {
  const payload = event && (event.data || event) || {};
  const { limit = 10, cursor, companyName, applicant, status, startDate, endDate } = payload;
  const pageSize = Math.min(100, positiveInteger(payload.pageSize ?? limit, 10));
  const usesPageNumber = payload.page !== undefined && payload.page !== null;

  try {
    let query = db.collection('invoices');

    const conditions = {};
    if (companyName) conditions['companyName'] = db.RegExp({ regexp: literalPattern(companyName), options: 'i' });
    if (applicant) conditions['applicant'] = db.RegExp({ regexp: literalPattern(applicant), options: 'i' });
    if (status) {
      const compatStatuses = STATUS_COMPAT_MAP[status];
      conditions['status'] = compatStatuses ? _.in(compatStatuses) : status;
    }
    if (startDate || endDate) {
      conditions['applyDate'] = startDate && endDate
        ? _.gte(startDate).and(_.lte(endDate))
        : startDate ? _.gte(startDate) : _.lte(endDate);
    }

    if (Object.keys(conditions).length > 0) {
      query = query.where(conditions);
    }

    // 总数与当前页使用相同筛选条件；删除最后一页记录后自动回到有效页。
    const countResult = await query.count();
    const total = Number(countResult.total) || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const legacyOffset = Math.max(0, positiveInteger(cursor, 0));
    const page = usesPageNumber
      ? Math.min(positiveInteger(payload.page, 1), totalPages)
      : Math.floor(legacyOffset / pageSize) + 1;
    const offset = usesPageNumber ? (page - 1) * pageSize : legacyOffset;
    const result = await query
      .skip(offset)
      .limit(pageSize)
      .orderBy('applyDate', 'desc')
      .orderBy('createTime', 'desc')
      .orderBy('_id', 'desc')
      .get();

    const data = result.data || [];
    const nextOffset = offset + data.length;
    const hasMore = data.length > 0 && nextOffset < total;

    return {
      success: true,
      data,
      total,
      page,
      pageSize,
      // 兼容仍使用 limit/cursor 的旧客户端。
      cursor: hasMore ? String(nextOffset) : null,
      hasMore,
    };
  } catch (error) {
    console.error('查询发票失败:', error);
    return { success: false, data: [], total: 0, cursor: null, hasMore: false, errMsg: error.message || '查询发票失败' };
  }
};
