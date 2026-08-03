/**
 * saveInvoice - 新增发票记录
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function normalizeSecondhandInvoice(invoice) {
  if (invoice.invoiceCategory !== '二手手机') {
    return { success: true, data: invoice };
  }

  const sourceProducts = Array.isArray(invoice.phoneProducts) && invoice.phoneProducts.length > 0
    ? invoice.phoneProducts
    : (invoice.phoneModel || invoice.phoneQuantity || invoice.unitPrice)
      ? [{ model: invoice.phoneModel, quantity: invoice.phoneQuantity, unitPrice: invoice.unitPrice }]
      : [];

  if (sourceProducts.length === 0) {
    return { success: false, errMsg: '请至少添加一个手机货品' };
  }

  const phoneProducts = sourceProducts.map(item => {
    const model = String(item.model || '').trim();
    const quantity = Number(item.quantity) || 0;
    const unitPrice = Number(item.unitPrice) || 0;
    return {
      model,
      quantity,
      unitPrice,
      amount: Math.round(quantity * unitPrice * 100) / 100,
    };
  });
  const invalidIndex = phoneProducts.findIndex(item => !item.model || item.quantity <= 0 || item.unitPrice <= 0);
  if (invalidIndex >= 0) {
    return { success: false, errMsg: `第 ${invalidIndex + 1} 个手机货品信息不完整` };
  }

  const invoiceAmount = Math.round(phoneProducts.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
  return {
    success: true,
    data: {
      ...invoice,
      phoneProducts,
      invoiceAmount,
      phoneModel: phoneProducts.map(item => item.model).join('、'),
      phoneQuantity: phoneProducts.reduce((sum, item) => sum + item.quantity, 0),
      unitPrice: phoneProducts.length === 1 ? phoneProducts[0].unitPrice : 0,
    },
  };
}

exports.main = async (event, context) => {
  const payload = event.data || event;
  const { invoice } = payload;

  if (!invoice || !invoice.companyName) {
    return { success: false, errMsg: '缺少必要参数' };
  }

  try {
    const normalized = normalizeSecondhandInvoice(invoice);
    if (!normalized.success) return normalized;
    const record = {
      ...normalized.data,
      createTime: db.serverDate(),
    };

    const result = await db.collection('invoices').add({ data: record });

    return { success: true, _id: result._id };
  } catch (error) {
    console.error('新增发票失败:', error);
    return { success: false, errMsg: error.message || '新增失败' };
  }
};
