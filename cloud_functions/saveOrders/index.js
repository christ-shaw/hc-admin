/**
 * saveOrders - 批量保存订单记录
 * 
 * 支持批量导入订单到 orders 集合
 * 每条记录自动添加 createTime 字段
 */

const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

exports.main = async (event, context) => {
  const { orders } = event.data || {};

  if (!orders || !Array.isArray(orders) || orders.length === 0) {
    return {
      success: false,
      savedCount: 0,
      errMsg: '缺少订单数据或数据为空',
    };
  }

  try {
    const now = db.serverDate();
    let savedCount = 0;
    const errors = [];

    // 逐条插入，支持大批量数据
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      try {
        // 移除 _id 字段（如果存在），让数据库自动生成
        const { _id, ...orderData } = order;
        
        // 添加创建时间
        orderData.createTime = now;

        await db.collection('orders').add({ data: orderData });
        savedCount++;
      } catch (err) {
        console.error(`保存第 ${i + 1} 条订单失败:`, err);
        errors.push({
          index: i,
          serialNumber: order.serialNumber,
          customerName: order.customerName,
          error: err.message,
        });
      }
    }

    return {
      success: savedCount > 0,
      savedCount,
      failedCount: orders.length - savedCount,
      errors: errors.length > 0 ? errors : undefined,
      errMsg: savedCount === orders.length 
        ? `成功保存 ${savedCount} 条订单` 
        : `保存 ${savedCount}/${orders.length} 条订单，${orders.length - savedCount} 条失败`,
    };
  } catch (error) {
    console.error('批量保存订单失败:', error);
    return {
      success: false,
      savedCount: 0,
      errMsg: error.message || '批量保存订单失败',
    };
  }
};
