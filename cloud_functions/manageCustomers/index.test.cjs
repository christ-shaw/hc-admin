const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeName, normalizePhone, normalizeAddress } = require('./normalizers');

test('客户名称归一化兼容全角、大小写与分隔符', () => {
  assert.equal(normalizeName(' Ａlice-租赁 1 '), 'alice租赁1');
});

test('手机号归一化只保留数字', () => {
  assert.equal(normalizePhone('+86 138-0013-8000'), '8613800138000');
});

test('地址归一化移除常见空白与标点', () => {
  assert.equal(normalizeAddress('上海市， 浦东新区；世纪大道 1 号'), '上海市浦东新区世纪大道1号');
});
