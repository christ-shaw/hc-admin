const cloud = require('wx-server-sdk');
const { execute } = require('./invoiceModel');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
exports.main = async event => {
  try { return await execute(db, 'save', event.data || event); }
  catch (error) { console.error('发票操作失败:', error); return { success: false, errMsg: error.message || '操作失败' }; }
};
