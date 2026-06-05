/**
 * deleteOrder - 删除订单记录
 * 
 * 根据 _id 删除 orders 集合中的订单记录
 */

const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

exports.main = async (event, context) => {
  const { _id } = event.data || {};

  if (!_id) {
    return {
      success: false,
      errMsg: '缺少订单ID',
    };
  }

  try {
    const result = await db.collection('orders').doc(_id).remove();

    if (result.stats && result.stats.removed > 0) {
      return {
        success: true,
        removed: result.stats.removed,
        errMsg: '删除成功',
      };
    } else {
      return {
        success: false,
        errMsg: '订单不存在或已删除',
      };
    }
  } catch (error) {
    console.error('删除订单失败:', error);
    return {
      success: false,
      errMsg: error.message || '删除订单失败',
    };
  }
};
