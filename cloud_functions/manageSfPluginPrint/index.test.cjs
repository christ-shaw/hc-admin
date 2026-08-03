const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadTestHelpers() {
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const module = { exports: {} };
  const cloudStub = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    database() {
      return { command: {} };
    },
  };
  const sandbox = {
    Buffer,
    URL,
    console,
    exports: module.exports,
    module,
    process: { env: {} },
    require(id) {
      if (id === 'wx-server-sdk') return cloudStub;
      if (id === './permissionAuth') return { getCurrentUser: async () => null };
      return require(id);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'manageSfPluginPrint/index.js' });
  return module.exports.__test__;
}

const helpers = loadTestHelpers();

test('插件开关按环境隔离且默认关闭', () => {
  const config = {
    pluginPrintEnabledByEnv: {
      sandbox: true,
      production: false,
    },
  };
  assert.equal(helpers.getPluginEnabled(config, 'sandbox'), true);
  assert.equal(helpers.getPluginEnabled(config, 'production'), false);
  assert.equal(helpers.getPluginEnabled({}, 'sandbox'), false);
});

test('普通单票优先使用结构化主运单号', () => {
  const result = helpers.validatePrintableOrder({
    isCurrent: true,
    status: 'applied',
    env: 'sandbox',
    waybillNo: 'SF_FALLBACK',
    waybillNoInfoList: [{ waybillType: 1, waybillNo: 'SF_PRIMARY' }],
    orderSnapshot: { customerRemark: '请放前台' },
  }, 'sandbox');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    waybillNo: 'SF_PRIMARY',
    documents: [{
      masterWaybillNo: 'SF_PRIMARY',
      remark: '订单1：无商品明细；备注：请放前台',
      customData: { hc_text: '订单1：无商品明细；备注：请放前台' },
    }],
  });
});

test('插件打印使用合包后的顺丰单备注', () => {
  assert.equal(helpers.getPrintRemark({
    shipmentPrintRemark: 'iPhone 15 / 256G×1；主单备注；Find X8×2；追加单备注',
    orderSnapshot: { customerRemark: '旧备注' },
  }), 'iPhone 15 / 256G×1；主单备注；Find X8×2；追加单备注');

  assert.equal(helpers.getPrintRemark({
    shipmentPrintRemark: '旧的合并备注',
    shipmentRemarkEntries: [
      { printProductRemark: 'OPPOA72×22', customerRemark: '壳 线' },
      { printProductRemark: 'OPPOA72×2', customerRemark: '壳 售后' },
    ],
  }), '订单1：OPPOA72×22；备注：壳 线\n订单2：OPPOA72×2；备注：壳 售后');
});

test('拒绝子单和签回单结构', () => {
  for (const waybillType of [2, 3]) {
    assert.throws(() => helpers.validatePrintableOrder({
      isCurrent: true,
      status: 'applied',
      env: 'sandbox',
      waybillNoInfoList: [
        { waybillType: 1, waybillNo: 'SF_PRIMARY' },
        { waybillType, waybillNo: `SF_EXTRA_${waybillType}` },
      ],
    }, 'sandbox'), error => error.code === 'UNSUPPORTED_WAYBILL_STRUCTURE');
  }
});

test('拒绝缺少环境或环境不一致的订单', () => {
  const baseOrder = {
    isCurrent: true,
    status: 'applied',
    waybillNo: 'SF_PRIMARY',
  };
  assert.throws(
    () => helpers.validatePrintableOrder(baseOrder, 'sandbox'),
    error => error.code === 'SF_ENV_MISSING',
  );
  assert.throws(
    () => helpers.validatePrintableOrder({ ...baseOrder, env: 'production' }, 'sandbox'),
    error => error.code === 'SF_ENV_MISMATCH',
  );
});

test('打印与预览结果采用不同计数口径', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.getRecordOutcome('print', 1))),
    { status: 'succeeded', counted: true },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.getRecordOutcome('preview', 15))),
    { status: 'previewed', counted: false },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.getRecordOutcome('print', 14))),
    { status: 'failed', counted: false },
  );
});

test('日志消息脱敏并限制长度', () => {
  const sanitized = helpers.sanitizeMessage(`{"accessToken":"secret-token"} authorization=Bearer-secret ${'x'.repeat(600)}`);
  assert.match(sanitized, /accessToken=\[REDACTED\]/);
  assert.match(sanitized, /authorization=\[REDACTED\]/);
  assert.equal(sanitized.includes('secret-token'), false);
  assert.equal(sanitized.length, 500);
});
