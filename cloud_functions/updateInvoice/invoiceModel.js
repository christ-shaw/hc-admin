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
    const quantity = Number(item.quantity);
    const unitPrice = Number(item.unitPrice);
    return {
      model,
      quantity,
      unitPrice,
      amount: Math.round(quantity * unitPrice * 100) / 100,
    };
  });
  const invalidIndex = phoneProducts.findIndex(item => !item.model || !Number.isFinite(item.quantity) || !Number.isFinite(item.unitPrice) || !Number.isInteger(item.quantity) || item.quantity <= 0 || item.unitPrice <= 0);
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

// 此文件由 scripts/sync-invoice-modules.cjs 同步，源文件位于 saveInvoice。
const { randomUUID } = require('node:crypto');
const LINKS = 'invoiceOrderLinks';
async function get(tx, collection, id) {
  try { return (await tx.collection(collection).doc(id).get()).data || null; }
  catch (error) {
    if (/not exist|does not exist|not found|DOCUMENT_NOT_FOUND/i.test(String(error.message || ''))) return null;
    throw error;
  }
}
function cents(value, label) {
  const n = Number(value);
  if (value === null || value === '' || !Number.isFinite(n) || n < 0 || !Number.isSafeInteger(Math.round(n * 100))) throw new Error(`${label}无效`);
  if (Math.abs(n * 100 - Math.round(n * 100)) > 0.00001) throw new Error(`${label}最多两位小数`);
  return Math.round(n * 100);
}
function clean(input) {
  const result = { ...input };
  for (const key of Object.keys(result)) {
    if (key.includes('.') || key.startsWith('$')) throw new Error('不支持的更新字段');
  }
  for (const key of ['_id', 'createTime', 'updateTime']) delete result[key];
  return result;
}
async function normalize(tx, data, existing, patch) {
  const mode = data.entryMode || 'manual';
  if (!['manual', 'linkedOrders'].includes(mode)) throw new Error('开票方式无效');
  if (!String(data.companyName || '').trim()) throw new Error('请填写公司名称');
  if (mode === 'manual') {
    let normalized = { ...data };
    const amountFields = ['entryMode', 'invoiceCategory', 'phoneProducts', 'phoneModel', 'phoneQuantity', 'unitPrice', 'invoiceAmount'];
    // 仅修改状态、附件等字段时，不重算历史金额。
    if (!existing || amountFields.some(key => Object.hasOwn(patch, key))) {
      const result = normalizeSecondhandInvoice(normalized);
      if (!result.success) throw new Error(result.errMsg);
      normalized = result.data;
      if (data.invoiceCategory !== '二手手机') Object.assign(normalized, { phoneProducts: [], phoneModel: '', phoneQuantity: 0, unitPrice: 0 });
      if (cents(normalized.invoiceAmount, '开票金额') <= 0) throw new Error('开票金额必须大于零');
    }
    return { ...normalized, entryMode: mode, linkedOrders: [], linkedOrderTotal: 0, amountAdjustmentReason: '' };
  }
  if (!Array.isArray(data.linkedOrders) || !data.linkedOrders.length) throw new Error('请至少关联一张订单');
  const ids = data.linkedOrders.map(item => String(item && item.orderId || '').trim());
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('关联订单为空或重复');
  const previous = new Map((existing?.linkedOrders || []).map(item => [item.orderId, item]));
  const linkedOrders = [];
  for (const id of ids) {
    // 已有关联保留原始快照，前端不得修改逐单金额或附件。
    if (existing?.entryMode === 'linkedOrders' && previous.has(id)) {
      const snapshot = previous.get(id);
      if (snapshot.salesChannel === undefined) {
        const source = await get(tx, 'orders', id);
        linkedOrders.push({ ...snapshot, salesChannel: source?.salesChannel || '' });
      } else linkedOrders.push(snapshot);
      continue;
    }
    const order = await get(tx, 'orders', id);
    if (!order) throw new Error(`订单 ${id} 不存在`);
    const products = Array.isArray(order.products) && order.products.length ? order.products : [order];
    const total = products.reduce((sum, item) => sum + cents(item.amount ?? 0, '订单金额'), 0);
    linkedOrders.push({ orderId: id, serialNumber: order.serialNumber ?? 0, onlineOrderNumber: order.onlineOrderNumber || '', customerName: order.customerName || '', salesChannel: order.salesChannel || '', orderDate: order.date || '', productSummary: products.map(item => [item.brand, item.productName, item.specification, item.quantity ? `×${item.quantity}` : ''].filter(Boolean).join(' ')).join('；'), amount: total / 100, attachments: (order.attachments || []).map(item => ({ fileID: item.fileID, fileName: item.fileName })) });
  }
  const total = linkedOrders.reduce((sum, item) => sum + cents(item.amount, '订单金额'), 0);
  const amount = cents(data.invoiceAmount, '开票金额');
  if (amount <= 0) throw new Error('开票金额必须大于零');
  const reason = String(data.amountAdjustmentReason || '').trim();
  if (amount !== total && !reason) throw new Error('请填写金额调整原因');
  return { ...data, entryMode: mode, linkedOrders, linkedOrderTotal: total / 100, invoiceAmount: amount / 100, amountAdjustmentReason: amount === total ? '' : reason, phoneProducts: [], phoneModel: '', phoneQuantity: 0, unitPrice: 0 };
}
async function execute(db, action, payload) {
  const invoiceId = action === 'save' ? randomUUID() : payload._id;
  if (typeof invoiceId !== 'string' || !invoiceId.trim()) return { success: false, errMsg: '缺少发票ID' };
  for (let attempt = 0; attempt < 3; attempt++) {
    const tx = await db.startTransaction();
    try {
      const existing = action === 'save' ? null : await get(tx, 'invoices', invoiceId);
      if (action !== 'save' && !existing) throw new Error('发票记录不存在');
      const patch = action === 'delete' ? {} : clean(action === 'save' ? payload.invoice || {} : payload.updateData || {});
      if (action === 'update' && (!payload.updateData || typeof payload.updateData !== 'object' || Array.isArray(payload.updateData))) throw new Error('缺少更新数据');
      const next = action === 'delete' ? null : await normalize(tx, { ...clean(existing || {}), ...patch }, existing, patch);
      const oldIds = (existing?.linkedOrders || []).map(item => item.orderId);
      const newIds = (next?.linkedOrders || []).map(item => item.orderId);
      const links = new Map();
      const conflicts = [];
      for (const id of new Set([...oldIds, ...newIds])) {
        const link = await get(tx, LINKS, id);
        links.set(id, link);
        if (newIds.includes(id) && link && link.invoiceId !== invoiceId) conflicts.push({ orderId: id, invoiceId: link.invoiceId });
        if (oldIds.includes(id) && link && link.invoiceId !== invoiceId) throw new Error(`订单 ${id} 关联关系异常`);
      }
      if (conflicts.length) {
        const error = new Error('部分订单已关联其他发票，请移除后重试'); error.conflicts = conflicts; throw error;
      }
      for (const id of oldIds) if (!newIds.includes(id) && links.get(id)) await tx.collection(LINKS).doc(id).remove();
      for (const id of newIds) if (!links.get(id)) await tx.collection(LINKS).add({ data: { _id: id, invoiceId, createTime: db.serverDate() } });
      if (action === 'delete') await tx.collection('invoices').doc(invoiceId).remove();
      else if (action === 'save') await tx.collection('invoices').add({ data: { ...next, _id: invoiceId, createTime: db.serverDate() } });
      else await tx.collection('invoices').doc(invoiceId).update({ data: { ...next, updateTime: db.serverDate() } });
      await tx.commit();
      return { success: true, _id: invoiceId };
    } catch (error) {
      try { await tx.rollback(); } catch (_) {}
      if (!error.conflicts && /conflict|transaction.*(?:fail|abort)|duplicate/i.test(String(error.message || '')) && attempt < 2) continue;
      return { success: false, errMsg: error.message || '保存失败', ...(error.conflicts ? { conflicts: error.conflicts } : {}) };
    }
  }
}
module.exports = { execute };
