const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync('src/pages/Orders.tsx', 'utf8');
const functions = ['calcChannelCategory', 'normalizeShippingFeeValue', 'hasCompleteOutboundDetails', 'getRecipientFieldsForSave'].map(name => source.match(new RegExp(`function ${name}\\([^]*?\\n}`))[0]);
const context = {};
vm.runInNewContext(ts.transpileModule(source.match(/const PLATFORM_CHANNELS = [^\n]+/)[0] + '\nconst CONSIGNEE_PHONE_PATTERN = /^\\d{6,20}$/;\n' + functions.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
test('R企业租按平台处理，支持字典编码与显示名称', () => {
  assert.equal(context.calcChannelCategory('R企业租'), 'platform');
  assert.equal(context.calcChannelCategory('custom-r', { 'custom-r': 'R企业租' }), 'platform');
  assert.equal(context.calcChannelCategory('aRrz'), 'platform');
  assert.equal(context.calcChannelCategory('线下'), 'offline');
});
test('自提空收件资料可继续；寄送仍要求有效姓名电话和地址', () => {
  const empty = { consignee: '', consigneePhone: '', consigneeAddress: '' };
  assert.equal(context.hasCompleteOutboundDetails({ ...empty, shippingFee: 'pickup' }), true);
  assert.equal(context.hasCompleteOutboundDetails({ ...empty, shippingFee: '自提' }), true);
  assert.equal(context.hasCompleteOutboundDetails({ ...empty, shippingFee: 'prepaid' }), false);
  assert.equal(context.hasCompleteOutboundDetails({ consignee: '客户', consigneePhone: '13800138000', consigneeAddress: '地址', shippingFee: 'prepaid' }), true);
});
test('保存自提订单时清空历史收件资料，寄送订单保留并去除首尾空格', () => {
  const fields = {
    needsOutbound: true,
    consignee: ' 客户 ',
    consigneePhone: ' 13800138000 ',
    consigneeAddress: ' 地址 ',
    recipientProfileId: 'recipient-1',
  };
  assert.equal(
    JSON.stringify(context.getRecipientFieldsForSave({ ...fields, shippingFee: 'pickup' })),
    JSON.stringify({ consignee: '', consigneePhone: '', consigneeAddress: '', recipientProfileId: '' }),
  );
  assert.equal(
    JSON.stringify(context.getRecipientFieldsForSave({ ...fields, shippingFee: 'prepaid' })),
    JSON.stringify({ consignee: '客户', consigneePhone: '13800138000', consigneeAddress: '地址', recipientProfileId: 'recipient-1' }),
  );
});
