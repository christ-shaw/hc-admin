const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadHelpers() {
  const filename = path.join(__dirname, 'index.js');
  const source = fs.readFileSync(filename, 'utf8');
  const module = { exports: {} };
  const cloudStub = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    database() {
      return {};
    },
  };
  const sandbox = {
    console,
    Date,
    Math,
    exports: module.exports,
    module,
    require(id) {
      if (id === 'wx-server-sdk') return cloudStub;
      if (id === './permissionAuth') return { getCurrentUser: async () => null };
      return require(id);
    },
  };
  vm.runInNewContext(source, sandbox, { filename });
  return module.exports.__test__;
}

const helpers = loadHelpers();

test('修改采购数量和单价后重新计算应付金额', () => {
  const result = helpers.withFinancials({
    quantity: 5,
    unitPrice: 120,
    returnedQuantity: 2,
    paymentStatus: 'pending',
    adjustments: [],
  });

  assert.equal(result.totalAmount, 600);
  assert.equal(result.returnDeduction, 240);
  assert.equal(result.payableQuantity, 3);
  assert.equal(result.payableAmount, 360);
  assert.equal(result.paymentStatus, 'pending');
});

test('采购数量等于已退数量时自动转为无需付款', () => {
  const result = helpers.withFinancials({
    quantity: 2,
    unitPrice: 100,
    returnedQuantity: 2,
    paymentStatus: 'pending',
    adjustments: [],
  });

  assert.equal(result.payableQuantity, 0);
  assert.equal(result.payableAmount, 0);
  assert.equal(result.paymentStatus, 'no_payment');
});

test('采购单必填字段和正数金额由后端校验', () => {
  assert.equal(
    helpers.validatePurchase(helpers.normalizePurchaseInput({
      date: '2026-07-28',
      supplier: '供应商A',
      owner: 'LL',
      brand: 'Apple',
      model: 'iPhone 15',
      specification: '256G',
      quantity: 2,
      unitPrice: 3000,
    })),
    '',
  );
  assert.equal(
    helpers.validatePurchase(helpers.normalizePurchaseInput({
      date: '2026-07-28',
      supplier: '',
      owner: 'LL',
      brand: 'Apple',
      model: 'iPhone 15',
      specification: '256G',
      quantity: 2,
      unitPrice: 3000,
    })),
    '采购单信息不完整',
  );
});

test('采购属性支持采购和回收，历史数据默认按采购处理', () => {
  const legacy = helpers.normalizePurchaseInput({
    date: '2026-07-28',
    supplier: '供应商A',
    owner: 'LL',
    brand: 'Apple',
    model: 'iPhone 15',
    specification: '256G',
    quantity: 2,
    unitPrice: 3000,
  });
  assert.equal(legacy.purchaseType, 'purchase');
  assert.equal(helpers.validatePurchase(legacy), '');

  const recycle = helpers.normalizePurchaseInput({ ...legacy, purchaseType: 'recycle' });
  assert.equal(recycle.purchaseType, 'recycle');
  assert.equal(helpers.validatePurchase(recycle), '');

  const invalid = helpers.normalizePurchaseInput({ ...legacy, purchaseType: 'unknown' });
  assert.equal(helpers.validatePurchase(invalid), '采购属性无效');
});
