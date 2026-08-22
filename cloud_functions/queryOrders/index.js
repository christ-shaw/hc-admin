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
    orderId,
    serialNumber,
    customerName,
    salesperson,
    salesChannel,
    orderType,
    orderSource,
    orderAttribute,
    status,
    onlineOrderNumber,
    outboundRecordId,
    startDate,
    endDate,
    abnormalStatus,
  } = data;

  const maxLimit = Math.min(limit, 100);

  try {
    // 出库记录等关联业务直接按数据库 ID 定位，不受分页和排序影响。
    if (orderId && String(orderId).trim()) {
      try {
        const orderResult = await db.collection('orders').doc(String(orderId).trim()).get();
        const order = orderResult && orderResult.data || null;
        return {
          success: true,
          data: order ? [order] : [],
          cursor: null,
          hasMore: false,
          total: order ? 1 : 0,
          errMsg: order ? '查询成功' : '订单不存在',
        };
      } catch (error) {
        const message = String(error && error.message || '').toLowerCase();
        if (message.includes('not exist') || message.includes('does not exist')) {
          return { success: true, data: [], cursor: null, hasMore: false, total: 0, errMsg: '订单不存在' };
        }
        throw error;
      }
    }

    // 构建查询条件
    const conditions = {};

    if (serialNumber !== undefined && serialNumber !== null && String(serialNumber).trim() !== '') {
      const parsedSerialNumber = Number(String(serialNumber).trim());
      if (!Number.isSafeInteger(parsedSerialNumber) || parsedSerialNumber < 0) {
        throw new Error('序号必须为非负整数');
      }
      conditions.serialNumber = parsedSerialNumber;
    }

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

    if (outboundRecordId) {
      conditions.outboundRecordId = String(outboundRecordId).trim();
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

    // 异常状态筛选：未退回入库 / 未收款
    let finalCondition = conditions;
    if (abnormalStatus === 'unreturned') {
      conditions.returnStatus = _.in(['notReturned', 'inTransit']);
    } else if (abnormalStatus === 'unreceived') {
      // 收款为订单级字段，旧数据可能在货品级；paymentSplits 为 JSON 字符串的极旧数据无法在库端匹配（前端红行仍会标出）
      finalCondition = _.and([
        conditions,
        _.or([
          { paymentAccount: '未收款' },
          { 'paymentSplits.account': '未收款' },
          { 'products.paymentAccount': '未收款' },
          { 'products.paymentSplits.account': '未收款' },
        ]),
      ]);
    }

    // 构建查询
    let query = db.collection('orders').where(finalCondition);

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
    const countResult = await db.collection('orders').where(finalCondition).count();
    const total = countResult.total;

    // 查询数据
    // 关联出库单为精确定位，结果量小且不需要复合排序索引。
    let resultQuery = query;
    if (!outboundRecordId) {
      resultQuery = resultQuery.orderBy('date', 'desc').orderBy('serialNumber', 'desc');
    }
    const result = await resultQuery.skip(skipCount).limit(maxLimit).get();

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
