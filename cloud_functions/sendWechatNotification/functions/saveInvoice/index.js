/**
 * saveInvoice - 新增发票记录
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event, context) => {
  const payload = event.data || event;
  const { invoice } = payload;

  if (!invoice || !invoice.companyName) {
    return { success: false, errMsg: '缺少必要参数' };
  }

  try {
    const record = {
      ...invoice,
      createTime: db.serverDate(),
    };

    const result = await db.collection('invoices').add({ data: record });

    return { success: true, _id: result._id };
  } catch (error) {
    console.error('新增发票失败:', error);
    return { success: false, errMsg: error.message || '新增失败' };
  }
};
