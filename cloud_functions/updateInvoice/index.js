/**
 * updateInvoice - 更新发票记录
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function normalizeInvoiceUpdate(updateData) {
  if (updateData.invoiceCategory && updateData.invoiceCategory !== '二手手机') {
    return {
      success: true,
      data: {
        ...updateData,
        phoneProducts: [],
        phoneModel: '',
        phoneQuantity: 0,
        unitPrice: 0,
      },
    };
  }

  const shouldNormalize = updateData.invoiceCategory === '二手手机' || Array.isArray(updateData.phoneProducts);
  if (!shouldNormalize) return { success: true, data: updateData };

  const sourceProducts = Array.isArray(updateData.phoneProducts) && updateData.phoneProducts.length > 0
    ? updateData.phoneProducts
    : (updateData.phoneModel || updateData.phoneQuantity || updateData.unitPrice)
      ? [{ model: updateData.phoneModel, quantity: updateData.phoneQuantity, unitPrice: updateData.unitPrice }]
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

  return {
    success: true,
    data: {
      ...updateData,
      phoneProducts,
      invoiceAmount: Math.round(phoneProducts.reduce((sum, item) => sum + item.amount, 0) * 100) / 100,
      phoneModel: phoneProducts.map(item => item.model).join('、'),
      phoneQuantity: phoneProducts.reduce((sum, item) => sum + item.quantity, 0),
      unitPrice: phoneProducts.length === 1 ? phoneProducts[0].unitPrice : 0,
    },
  };
}

exports.main = async (event, context) => {
  const payload = event.data || event;
  const { _id, updateData } = payload;

  if (!_id || !updateData) {
    return { success: false, errMsg: '缺少必要参数' };
  }

  try {
    const normalized = normalizeInvoiceUpdate(updateData);
    if (!normalized.success) return normalized;
    await db.collection('invoices').doc(_id).update({
      data: {
        ...normalized.data,
        updateTime: db.serverDate(),
      },
    });

    return { success: true };
  } catch (error) {
    console.error('更新发票失败:', error);
    return { success: false, errMsg: error.message || '更新失败' };
  }
};
