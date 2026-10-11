const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function handler({ fail = false, empty = false } = {}) {
  const calls = [];
  const module = { exports: {} };
  const cloud = { init() {}, database: () => ({ command: { in: ids => ids }, collection: name => ({ doc: id => ({ get: async () => ({ data: { _id: id, companyName: '公司' } }) }), where: condition => { calls.push(condition); return { limit: () => ({ get: async () => { if (fail) throw new Error('关联查询失败'); return { data: name === 'orders' ? [{ _id: 'a', salesChannel: 'channel-a' }] : [{ _id: 'a', invoiceId: 'invoice-a' }] }; } }) }; } }) }), callFunction: async args => { calls.push(args); return { result: { success: true, data: empty ? [] : [{ _id: 'a' }, { _id: 'b' }], cursor: null } }; } };
  vm.runInNewContext(fs.readFileSync(__dirname + '/index.js', 'utf8'), { module, exports: module.exports, require: () => cloud });
  return { main: module.exports.main, calls };
}
test('搜索结果附带占用状态，限定批量查询当前页，空页无需查关联', async () => {
  const { main, calls } = handler();
  const result = await main({ data: { customerName: '客户' } });
  assert.equal(result.success, true); assert.equal(result.data[0].linkedInvoiceId, 'invoice-a'); assert.equal(result.data[1].linkedInvoiceId, '');
  assert.equal(calls[0].data.data.customerName, '客户'); assert.equal(calls[1]._id.length, 2);
  const empty = handler({ empty: true }); await empty.main({ data: {} }); assert.equal(empty.calls.length, 1);
});
test('关联查询失败不能伪装为可选订单，查看关联发票返回真实记录', async () => {
  assert.equal((await handler({ fail: true }).main({ data: {} })).success, false);
  const record = await handler().main({ data: { action: 'invoiceDetail', invoiceId: 'invoice-a' } });
  assert.equal(record.invoice._id, 'invoice-a');
  assert.equal((await handler().main({ data: { action: 'invoiceDetail' } })).success, false);
});

test('历史快照可批量查渠道，拒绝无效订单ID', async () => {
  const { main } = handler();
  const result = await main({ data: { action: 'orderChannels', orderIds: ['a'] } });
  assert.equal(result.channels[0].salesChannel, 'channel-a');
  assert.equal((await main({ data: { action: 'orderChannels', orderIds: [''] } })).success, false);
});
