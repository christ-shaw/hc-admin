'use strict';

function getOrderProducts(order) {
  if (Array.isArray(order && order.products) && order.products.length > 0) return order.products;
  if (order && (order.brand || order.productName || order.quantity)) {
    return [{
      brand: order.brand || '',
      productName: order.productName || '',
      specification: order.specification || '',
      quantity: Number(order.quantity) || 0,
    }];
  }
  return [];
}

function buildOutboundModel(item) {
  const brand = String(item && item.brand || '').trim();
  const productName = String(item && item.productName || '').trim();
  const specification = String(item && item.specification || '').trim();
  const base = [brand, productName].filter(Boolean).join(' / ');
  if (!base) return '';
  return specification && specification !== '默认'
    ? `${base} / ${specification}`
    : base;
}

function aggregateOutboundModels(orders) {
  const quantities = new Map();
  const modelOrder = [];
  for (const order of Array.isArray(orders) ? orders : []) {
    for (const item of getOrderProducts(order)) {
      const model = buildOutboundModel(item);
      if (!model) continue;
      const quantity = Number(item.quantity) || 0;
      if (quantities.has(model)) {
        quantities.set(model, quantities.get(model) + quantity);
      } else {
        quantities.set(model, quantity);
        modelOrder.push(model);
      }
    }
  }
  return modelOrder.map(model => ({ model, quantity: quantities.get(model) }));
}

function buildOrderModelsRemark(phoneModels) {
  const summary = (Array.isArray(phoneModels) ? phoneModels : [])
    .map(item => {
      const model = String(item && item.model || '').trim();
      if (!model) return '';
      return `${model}×${Number(item.quantity) || 0}`;
    })
    .filter(Boolean)
    .join('，');
  return summary ? `客户下单：${summary}` : '';
}

function replaceOrderModelsRemark(existingRemark, phoneModels) {
  const summary = buildOrderModelsRemark(phoneModels);
  const otherParts = String(existingRemark || '')
    .split('；')
    .map(part => part.trim())
    .filter(part => part && !part.startsWith('客户下单：'));
  return [summary, ...otherParts].filter(Boolean).join('；');
}

module.exports = {
  aggregateOutboundModels,
  replaceOrderModelsRemark,
};
