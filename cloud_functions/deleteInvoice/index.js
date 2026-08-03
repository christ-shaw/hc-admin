/**
 * deleteInvoice - 删除发票记录
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event, context) => {
  const payload = event.data || event;
  const { _id } = payload;

  if (!_id) {
    return { success: false, errMsg: '缺少_id参数' };
  }

  try {
    await db.collection('invoices').doc(_id).remove();
    return { success: true };
  } catch (error) {
    console.error('删除发票失败:', error);
    return { success: false, errMsg: error.message || '删除失败' };
  }
};
