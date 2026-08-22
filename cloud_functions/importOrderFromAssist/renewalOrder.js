'use strict';

function trim(value) {
  return String(value == null ? '' : value).trim();
}

function normalizePositiveAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) return 0;
  return Math.round(amount * 100) / 100;
}

function formatAmount(value) {
  const amount = Number(value) || 0;
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function formatAccount(value) {
  return trim(value).replace(/(微信|支付宝)$/u, ' $1');
}

function isRentIntroductionOrder(order, products) {
  if (trim(order && order.renewalSourceOrderId)) return true;
  return (Array.isArray(products) ? products : []).some((product) => {
    const productName = trim(product && product.productName);
    return productName === '平台租金' || productName === '续期租金';
  });
}

function buildRenewalIntroduction(order, salesChannelMap) {
  const channelKey = trim(order && order.salesChannel);
  const channel = salesChannelMap && salesChannelMap[channelKey] || channelKey || '-';
  const orderNumber = trim(order && (order.onlineOrderNumber || order.serialNumber)) || '-';
  const customerName = trim(order && order.customerName) || '-';
  const products = Array.isArray(order && order.products) ? order.products : [];
  const amount = products.reduce((sum, item) => sum + (Number(item && item.amount) || 0), 0);
  const splits = Array.isArray(order && order.paymentSplits) ? order.paymentSplits : [];
  let paymentText = '转-';
  if (splits.length === 1) {
    paymentText = splits[0].account === '未收款' ? '未收款' : `转${formatAccount(splits[0].account)}`;
  } else if (splits.length > 1) {
    paymentText = `转${splits.map((split) => `${formatAccount(split.account)} ${formatAmount(split.amount)}`).join('、')}`;
  } else if (trim(order && order.paymentAccount)) {
    paymentText = order.paymentAccount === '未收款' ? '未收款' : `转${formatAccount(order.paymentAccount)}`;
  }
  return `${channel} ${orderNumber} ${customerName}  租金 ${formatAmount(amount)} ${paymentText}`;
}

function buildRenewalOrderDoc(source, input, serialNumber, now, date) {
  const amount = normalizePositiveAmount(input && input.amount);
  const paymentAccount = trim(input && input.paymentAccount);
  const requestId = trim(input && input.requestId);
  const inheritedAttachments = Array.isArray(source && source.attachments)
    ? source.attachments.map((item) => ({ ...item }))
    : [];
  const uploadedAttachments = Array.isArray(input && input.attachments)
    ? input.attachments.map((item) => ({ fileID: trim(item && item.fileID), fileName: trim(item && item.fileName) }))
      .filter((item) => item.fileID && item.fileName)
    : [];
  return {
    serialNumber,
    date,
    orderSource: 'new',
    orderAttribute: trim(source && source.orderAttribute) || 'rental1',
    orderType: 'newBusiness',
    salesChannel: trim(source && source.salesChannel),
    salesperson: trim(source && source.salesperson),
    channelCategory: trim(source && source.channelCategory) || 'platform',
    onlineOrderNumber: trim(source && source.onlineOrderNumber),
    customerName: trim(source && source.customerName),
    products: [{
      brand: '虚拟产品',
      productName: '续期租金',
      specification: '默认',
      quantity: 1,
      unitPrice: amount,
      amount,
    }],
    paymentAccount,
    paymentSplits: [{ account: paymentAccount, amount }],
    trackingNumber: '',
    consignee: '',
    consigneePhone: '',
    consigneeAddress: '',
    shippingFee: '',
    status: 'noShip',
    customerRemark: trim(input && input.remark),
    transferBrand: '',
    transferProductName: '',
    transferSpecification: '',
    paidPeriod: 0,
    paidRent: 0,
    transferItems: '',
    attachments: [...inheritedAttachments, ...uploadedAttachments],
    returnStatus: '',
    returnTrackingNumbers: '',
    needsOutbound: false,
    outboundRecordId: '',
    importSource: 'hc-order-assist-renewal',
    renewalSourceOrderId: trim(source && source._id),
    renewalSourceSerialNumber: Number(source && source.serialNumber) || 0,
    renewalRequestId: requestId,
    renewalUploadedAttachmentCount: uploadedAttachments.length,
    createTime: now,
  };
}

module.exports = {
  buildRenewalIntroduction,
  buildRenewalOrderDoc,
  formatAccount,
  isRentIntroductionOrder,
  normalizePositiveAmount,
};
