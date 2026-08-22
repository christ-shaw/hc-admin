const test = require('node:test');
const assert = require('node:assert/strict');

const {
  aggregateOutboundModels,
  buildOutboundModel,
  getOrderProducts,
  isOrderLinkedPendingOutbound,
  replaceOrderModelsRemark,
} = require('./outboundModels');

test('出库型号统一为品牌 / 货品 / 规格格式', () => {
  assert.equal(buildOutboundModel({ brand: 'vivo', productName: 'Y33S', specification: '默认' }), 'vivo / Y33S');
  assert.equal(buildOutboundModel({ brand: 'vivo', productName: 'Y35', specification: '256G' }), 'vivo / Y35 / 256G');
});

test('订单型号聚合兼容 products 和旧扁平字段', () => {
  const models = aggregateOutboundModels([
    { products: [{ brand: 'vivo', productName: 'Y33S', specification: '默认', quantity: 28 }] },
    { brand: 'vivo', productName: 'Y33S', specification: '默认', quantity: 1 },
    { products: [{ brand: 'vivo', productName: 'Y35', specification: '256G', quantity: 2 }] },
  ]);
  assert.deepEqual(models, [
    { model: 'vivo / Y33S', quantity: 29 },
    { model: 'vivo / Y35 / 256G', quantity: 2 },
  ]);
  assert.equal(getOrderProducts({ brand: 'OPPO', productName: 'A72', quantity: 3 }).length, 1);
});

test('仅订单关联的待出库记录允许自动同步', () => {
  assert.equal(isOrderLinkedPendingOutbound({ source: 'order', outboundStatus: 'pending', orderIds: ['o1'] }), true);
  assert.equal(isOrderLinkedPendingOutbound({ source: 'order', outboundStatus: 'completed', orderIds: ['o1'] }), false);
  assert.equal(isOrderLinkedPendingOutbound({ source: 'manual', outboundStatus: 'pending', orderIds: ['o1'] }), false);
});

test('重新同步时替换客户下单摘要并保留其他备注', () => {
  assert.equal(
    replaceOrderModelsRemark('客户下单：旧型号×1；优先发货', [{ model: 'vivo / Y35', quantity: 2 }]),
    '客户下单：vivo / Y35×2；优先发货',
  );
});
