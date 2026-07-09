/**
 * countPendingInvoices - 统计待开票数量
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event, context) => {
  try {
    // 兼容旧数据（中文值'未开票'）和新数据（英文key 'unpaid'）
    const result = await db.collection('invoices').where({
      status: db.command.in(['未开票', 'unpaid']),
    }).count();
    return { success: true, total: result.total || 0 };
  } catch (error) {
    console.error('统计待开票数量失败:', error);
    return { success: false, total: 0 };
  }
};
