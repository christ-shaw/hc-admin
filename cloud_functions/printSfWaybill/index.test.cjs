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
    fetch: async () => {
      throw new Error('unexpected fetch');
    },
    module,
    process: { env: {} },
    require(id) {
      if (id === 'wx-server-sdk') return cloudStub;
      if (id === './permissionAuth') return { getCurrentUser: async () => null };
      return require(id);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'printSfWaybill/index.js' });
  return module.exports.__test__;
}

const helpers = loadTestHelpers();

test('解析同步云打印成功响应', () => {
  const result = helpers.parseSfPrintResponse({
    apiResultCode: 'A1000',
    apiResultData: JSON.stringify({
      success: true,
      errorCode: 'S0000',
      obj: {
        files: [{
          url: 'https://download.example.com/waybill.pdf',
          token: 'download-token',
        }],
      },
    }),
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    success: true,
    fileUrl: 'https://download.example.com/waybill.pdf',
    fileToken: 'download-token',
  });
});

test('识别 accessToken 失效并允许刷新重试', () => {
  const result = helpers.parseSfPrintResponse({
    apiResultCode: 'A1011',
    apiErrorMsg: 'accessToken invalid',
  });
  assert.equal(result.success, false);
  assert.equal(result.authFailed, true);
});

test('业务失败时返回顺丰的 errorMessage 而不是 UNKNOWN', () => {
  const result = helpers.parseSfPrintResponse({
    apiResultCode: 'A1000',
    apiResultData: JSON.stringify({
      success: false,
      errorCode: 'SFM001',
      errorMessage: '自定义模板未发布',
    }),
  });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'SFM001');
  assert.equal(result.errMsg, '自定义模板未发布');
});

test('顺丰未返回下载 token 时明确失败', () => {
  const result = helpers.parseSfPrintResponse({
    apiResultCode: 'A1000',
    apiResultData: {
      success: 'true',
      errorCode: 'S0000',
      obj: {
        files: [{ url: 'https://download.example.com/waybill.pdf' }],
      },
    },
  });
  assert.equal(result.success, false);
  assert.match(result.errMsg, /下载 token/);
});

test('普通单票优先使用结构化主运单号并生成安全文件名', () => {
  const waybillNo = helpers.getWaybillNo({
    waybillNo: 'fallback',
    waybillNoInfoList: [
      { waybillType: 1, waybillNo: 'SF_MASTER' },
    ],
  });
  assert.equal(waybillNo, 'SF_MASTER');
  assert.equal(helpers.buildFileName('SF123/../../x'), 'SF_SF123x.pdf');
});

test('面单备注读取顺丰下单时保存的订单备注快照', () => {
  assert.equal(helpers.getPrintRemark({
    orderSnapshot: { customerRemark: '  测试订单备注  ' },
  }), '订单1：无商品明细；备注：测试订单备注');
  assert.equal(helpers.getPrintRemark({
    orderSnapshot: {
      customerRemark: '客户备注',
      products: [
        { brand: 'Apple', productName: 'iPhone 15', specification: '256G', quantity: 2 },
        { brand: 'OPPO', productName: 'Reno12', specification: '默认', quantity: 1 },
      ],
    },
  }), '订单1：iPhone 15 / 256G×2，Reno12×1；备注：客户备注');
  assert.equal(helpers.getPrintRemark({
    orderSnapshot: {
      rawCustomerRemark: '客户备注',
      products: [
        { brand: 'Apple', productName: 'iPhone 15', quantity: 1 },
      ],
    },
  }), '订单1：iPhone 15×1；备注：客户备注');
  assert.equal(helpers.getPrintRemark({}), '');
  assert.equal(helpers.getPrintRemark({
    orderSnapshot: { customerRemark: '备'.repeat(120) },
  }).length, 100);
});

test('合包面单优先使用主顺丰单保存的合并备注', () => {
  const record = {
    shipmentPrintRemark: 'iPhone 15 / 256G×1；主单备注；Find X8×2；追加单备注',
    shipmentRemarkEntries: [
      { orderId: 'order-1', orderNumber: 'ME-1', role: 'primary', printProductRemark: 'iPhone 15 / 256G×1', customerRemark: '主单备注' },
      { orderId: 'order-2', orderNumber: 'ME-2', role: 'appended', printProductRemark: 'Find X8×2', customerRemark: '追加单备注' },
    ],
    orderSnapshot: { customerRemark: '不应回退到这里' },
  };
  assert.equal(helpers.getPrintRemark(record), '订单1：iPhone 15 / 256G×1；备注：主单备注\n订单2：Find X8×2；备注：追加单备注');
  assert.equal(helpers.getPrintRemark({
    shipmentRemarkEntries: record.shipmentRemarkEntries,
  }), '订单1：iPhone 15 / 256G×1；备注：主单备注\n订单2：Find X8×2；备注：追加单备注');
});

test('自定义模板字段 hc_text 动态使用订单备注', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.buildPrintDocument('SF_MASTER', '测试订单备注'))),
    {
      masterWaybillNo: 'SF_MASTER',
      remark: '测试订单备注',
      customData: { hc_text: '测试订单备注' },
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.buildPrintDocument('SF_MASTER', ''))),
    {
      masterWaybillNo: 'SF_MASTER',
      remark: '',
      customData: { hc_text: '' },
    },
  );
});

test('拦截常见内网与本机地址', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:192.168.1.8']) {
    assert.equal(helpers.isPrivateIp(address), true, address);
  }
  assert.equal(helpers.isPrivateIp('8.8.8.8'), false);
  assert.equal(helpers.isPrivateIp('::ffff:8.8.8.8'), false);
});

test('拒绝缺少环境的顺丰记录', () => {
  assert.throws(() => helpers.validateSfExpressOrder({
    isCurrent: true,
    status: 'applied',
    waybillNo: 'SF123',
  }, 'sandbox'), error => error.code === 'SF_ENV_MISSING');
});

test('拒绝子母单和签回单结构', () => {
  for (const waybillType of ['2', '3']) {
    assert.throws(() => helpers.validateSfExpressOrder({
      isCurrent: true,
      status: 'applied',
      env: 'sandbox',
      waybillNoInfoList: [
        { waybillType: '1', waybillNo: 'SF_MASTER' },
        { waybillType, waybillNo: 'SF_EXTRA' },
      ],
    }, 'sandbox'), error => error.code === 'UNSUPPORTED_WAYBILL_STRUCTURE');
  }
});
