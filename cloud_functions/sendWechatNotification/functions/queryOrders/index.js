/**
 * queryOrders - 查询订单记录
 * 
 * 支持游标分页和多条件筛选
 * 数据库集合: orders
 */

const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const data = event.data || {};
  const {
    limit = 20,
    cursor,
    customerName,
    salesperson,
    salesChannel,
    orderType,
    orderSource,
    orderAttribute,
    status,
    onlineOrderNumber,
    startDate,
    endDate,
  } = data;

  const maxLimit = Math.min(limit, 100);

  try {
    // 构建查询条件
    const conditions = {};

    if (customerName) {
      conditions.customerName = db.RegExp({
        regexp: customerName,
        options: 'i',
      });
    }

    if (salesperson) {
      conditions.salesperson = salesperson;
    }

    if (salesChannel) {
      conditions.salesChannel = salesChannel;
    }

    if (orderType) {
      conditions.orderType = orderType;
    }

    if (orderSource) {
      conditions.orderSource = orderSource;
    }

    if (orderAttribute) {
      conditions.orderAttribute = orderAttribute;
    }

    if (status) {
      conditions.status = status;
    }

    if (onlineOrderNumber) {
      conditions.onlineOrderNumber = db.RegExp({
        regexp: onlineOrderNumber,
        options: 'i',
      });
    }

    // 日期范围筛选
    if (startDate || endDate) {
      const dateCondition = {};
      if (startDate) dateCondition['>='] = startDate;
      if (endDate) dateCondition['<='] = endDate;
      conditions.date = _.and(
        startDate ? _.gte(startDate) : _.gt(''),
        endDate ? _.lte(endDate) : _.lt('9999-12-31')
      );
    }

    // 构建查询
    let query = db.collection('orders').where(conditions);

    // 游标分页：使用 skip 实现
    let skipCount = 0;
    if (cursor) {
      try {
        skipCount = parseInt(cursor, 10) || 0;
      } catch (e) {
        skipCount = 0;
      }
    }

    // 先获取总数
    const countResult = await db.collection('orders').where(conditions).count();
    const total = countResult.total;

    // 查询数据
    const result = await query
      .orderBy('date', 'desc')
      .orderBy('serialNumber', 'desc')
      .skip(skipCount)
      .limit(maxLimit)
      .get();

    const records = result.data;
    const nextSkip = skipCount + records.length;
    const hasMore = nextSkip < total;

    return {
      success: true,
      data: records,
      cursor: hasMore ? String(nextSkip) : null,
      hasMore,
      total,
      errMsg: '查询成功',
    };
  } catch (error) {
    console.error('查询订单失败:', error);
    return {
      success: false,
      data: [],
      cursor: null,
      hasMore: false,
      total: 0,
      errMsg: error.message || '查询订单失败',
    };
  }
};
