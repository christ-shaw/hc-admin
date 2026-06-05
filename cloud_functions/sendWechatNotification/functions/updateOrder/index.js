/**
 * updateOrder - 更新订单记录
 * 
 * 根据 _id 更新 orders 集合中的订单记录
 * 自动添加 updateTime 字段
 */

const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

exports.main = async (event, context) => {
  const { _id, updateData } = event.data || {};

  if (!_id) {
    return {
      success: false,
      errMsg: '缺少订单ID',
    };
  }

  if (!updateData || typeof updateData !== 'object' || Object.keys(updateData).length === 0) {
    return {
      success: false,
      errMsg: '缺少更新数据',
    };
  }

  try {
    // 不允许更新的字段
    const forbiddenFields = ['_id', 'createTime'];
    const cleanData = { ...updateData };
    for (const field of forbiddenFields) {
      delete cleanData[field];
    }

    // 添加更新时间
    cleanData.updateTime = db.serverDate();

    const result = await db.collection('orders').doc(_id).update({
      data: cleanData,
    });

    if (result.stats && result.stats.updated > 0) {
      return {
        success: true,
        data: {
          _id,
          updateTime: new Date().toISOString(),
        },
        errMsg: '更新成功',
      };
    } else {
      return {
        success: false,
        errMsg: '订单不存在或数据未变化',
      };
    }
  } catch (error) {
    console.error('更新订单失败:', error);
    return {
      success: false,
      errMsg: error.message || '更新订单失败',
    };
  }
};
