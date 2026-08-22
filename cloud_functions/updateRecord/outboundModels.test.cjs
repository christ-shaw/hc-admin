const test = require('node:test');
const assert = require('node:assert/strict');

const { aggregateOutboundModels, replaceOrderModelsRemark } = require('./outboundModels');

test('主动同步会按统一格式聚合关联订单', () => {
  assert.deepEqual(aggregateOutboundModels([
    { products: [{ brand: '苹果', productName: '苹果8P', specification: '64G', quantity: 20 }] },
    { products: [{ brand: '苹果', productName: '苹果8P', specification: '64G', quantity: 10 }] },
  ]), [{ model: '苹果 / 苹果8P / 64G', quantity: 30 }]);
});

test('主动同步同时更新下单摘要但保留业务备注', () => {
  assert.equal(
    replaceOrderModelsRemark('客户下单：旧型号×1；请勿放价格单', [{ model: '苹果 / 苹果8P / 64G', quantity: 30 }]),
    '客户下单：苹果 / 苹果8P / 64G×30；请勿放价格单',
  );
});
