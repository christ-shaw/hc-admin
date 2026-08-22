const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRenewalIntroduction,
  buildRenewalOrderDoc,
  isRentIntroductionOrder,
  normalizePositiveAmount,
} = require('./renewalOrder');

test('续租订单继承来源信息和附件，并固定为续期租金虚拟订单', () => {
  const source = {
    _id: 'order_1',
    serialNumber: 100,
    orderAttribute: 'rental1',
    salesChannel: 'yuntu',
    salesperson: 'XX',
    channelCategory: 'platform',
    onlineOrderNumber: 'ME20260715100629062996',
    customerName: '潘瑞',
    attachments: [{ fileID: 'cloud://file', fileName: '凭证.png' }],
  };
  const order = buildRenewalOrderDoc(source, {
    amount: 300,
    paymentAccount: 'XX微信',
    requestId: 'renewal-1',
    remark: '续租一个月',
    attachments: [{ fileID: 'cloud://new-file', fileName: '续租凭证.pdf' }],
  }, 101, 'server-date', '2026-08-20');

  assert.equal(order.onlineOrderNumber, source.onlineOrderNumber);
  assert.equal(order.products[0].productName, '续期租金');
  assert.equal(order.products[0].amount, 300);
  assert.deepEqual(order.paymentSplits, [{ account: 'XX微信', amount: 300 }]);
  assert.deepEqual(order.attachments, [
    ...source.attachments,
    { fileID: 'cloud://new-file', fileName: '续租凭证.pdf' },
  ]);
  assert.notEqual(order.attachments, source.attachments);
  assert.equal(order.renewalUploadedAttachmentCount, 1);
  assert.equal(order.renewalSourceOrderId, 'order_1');
  assert.equal(order.status, 'noShip');
  assert.equal(order.needsOutbound, false);
});

test('续租简介符合微信复制格式', () => {
  const text = buildRenewalIntroduction({
    salesChannel: 'yuntu',
    onlineOrderNumber: 'ME20260715100629062996',
    customerName: '潘瑞',
    products: [{ amount: 300 }],
    paymentSplits: [{ account: 'XX微信', amount: 300 }],
  }, { yuntu: '云途' });
  assert.equal(text, '云途 ME20260715100629062996 潘瑞  租金 300 转XX 微信');
});

test('平台租金和续期租金使用相同的租金简介', () => {
  assert.equal(isRentIntroductionOrder({}, [{ productName: '平台租金' }]), true);
  assert.equal(isRentIntroductionOrder({}, [{ productName: '续期租金' }]), true);
  assert.equal(isRentIntroductionOrder({}, [{ productName: '苹果12' }]), false);
});

test('续租金额只接受合理的正数并保留两位小数', () => {
  assert.equal(normalizePositiveAmount('300.126'), 300.13);
  assert.equal(normalizePositiveAmount(0), 0);
  assert.equal(normalizePositiveAmount('not-a-number'), 0);
});
