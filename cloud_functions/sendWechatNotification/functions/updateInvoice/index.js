/**
 * updateInvoice - 更新发票记录
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event, context) => {
  const payload = event.data || event;
  const { _id, updateData } = payload;

  if (!_id || !updateData) {
    return { success: false, errMsg: '缺少必要参数' };
  }

  try {
    await db.collection('invoices').doc(_id).update({
      data: {
        ...updateData,
        updateTime: db.serverDate(),
      },
    });

    return { success: true };
  } catch (error) {
    console.error('更新发票失败:', error);
    return { success: false, errMsg: error.message || '更新失败' };
  }
};
