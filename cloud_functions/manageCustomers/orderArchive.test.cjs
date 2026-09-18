const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { database } = require('./test-support/database.cjs');
const { createOrderArchive } = require('./orderArchive');
const { stripLinkFields } = require('./orderIngestion');

const actor = { id: 'operator' };
const input = { customerName: '新客户', orderAttribute: 'rental1', customerSelectionMode: 'none',
  consignee: '张三', consigneePhone: '13800138000', consigneeAddress: '上海市一号', salesChannel: 'yuntu', createCustomerArchive: true };
function fixture(options = {}, permissions = ['orders:create', 'customers:write']) {
  const data = { customers: [], customer_aliases: [], customer_recipient_profiles: [], orders: [],
    system_config: [{ _id: 'permission_system', initialized: true }],
    roles: [{ _id: 'r', actionPermissions: permissions }], user_roles: [{ _id: 'ur', userId: actor.id, roleId: 'r' }] };
  const memory = database(data, options);
  return { ...memory, data, archive: createOrderArchive(memory.db) };
}
function entry(name, memory) {
  const filename = path.resolve(__dirname, '..', name, 'index.js');
  const realRequire = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, console: { log() {}, warn() {}, error() {} },
    require(id) {
      if (id === 'wx-server-sdk') return { init() {}, database: () => memory.db };
      if (id === './permissionAuth') return { getCurrentUser: async () => actor };
      return realRequire(id);
    },
  }, { filename });
  return module.exports.main;
}
const save = (f, order = input) => entry('saveOrders', f)({ data: { orders: [order] } });

test('保存新租赁订单后创建主档、渠道别名、收货档案并关联，重试不重复', async () => {
  const f = fixture(); const result = await save(f);
  assert.equal(result.savedCount, 1); assert.equal(result.failedCount, 0);
  assert.equal(result.customerArchives[0].status, 'created');
  assert.equal(f.data.customers.length, 1); assert.equal(f.data.customer_aliases.length, 1);
  assert.equal(f.data.customer_aliases[0].salesChannel, 'yuntu');
  assert.equal(f.data.customer_recipient_profiles.length, 1);
  assert.equal(f.data.orders[0].customerId, f.data.customers[0]._id);
  assert.equal(f.data.orders[0].recipientProfileId, f.data.customer_recipient_profiles[0]._id);
  assert.equal('createCustomerArchive' in f.data.orders[0], false);
  assert.equal(f.data.customer_operation_audits[0].action, 'createFromOrder');
  const retry = await entry('manageCustomers', f)({ action: 'createFromOrder', orderId: result.savedIds[0] });
  assert.equal(retry.data.status, 'linked'); assert.equal(f.data.customers.length, 1);
});

test('取消勾选、不支持的订单、派生订单和已有客户不触发建档', async () => {
  for (const patch of [{ createCustomerArchive: false }, { createCustomerArchive: undefined },
    { orderAttribute: 'sales' }, { renewalSourceOrderId: 'source' }, { rental2TransferSourceOrderId: 'source' },
    { afterSaleSourceOrderId: 'source' }]) {
    const f = fixture(); const result = await save(f, { ...input, ...patch, customerArchiveRequested: true });
    assert.equal(result.savedCount, 1); assert.equal(result.customerArchives.length, 0);
    assert.equal(f.data.customers.length, 0); assert.equal(f.data.orders[0].customerArchiveRequested, undefined);
  }
  const f = fixture(); f.data.customers.push({ _id: 'existing', displayName: '老客户', status: 'active' });
  const result = await save(f, { ...input, customerId: 'existing', customerSelectionMode: 'explicit' });
  assert.equal(result.savedCount, 1); assert.equal(result.customerArchives.length, 0);
  assert.equal(f.data.orders[0].customerId, 'existing'); assert.equal(f.data.customers.length, 1);
});

test('新客户没有完整收件信息时只建立主档与别名，不写入空收货档案', async () => {
  const f = fixture(); const result = await save(f, { ...input, consigneeAddress: '' });
  assert.equal(result.customerArchives[0].status, 'created');
  assert.equal(f.data.customers.length, 1); assert.equal(f.data.customer_recipient_profiles.length, 0);
});

test('同名或不同名同电话的客户均保留订单待归档，不自动合并或重复创建', async () => {
  for (const name of ['新客户', '别的名称']) {
    const f = fixture(); f.data.customers.push({ _id: 'existing', displayName: name, status: 'active' });
    if (name !== input.customerName) f.data.customer_recipient_profiles.push({ _id: 'p', customerId: 'existing', phone: input.consigneePhone });
    const result = await save(f);
    assert.equal(result.savedCount, 1); assert.equal(result.customerArchives[0].status, 'pending');
    assert.equal(result.customerArchives[0].code, 'CUSTOMER_POSSIBLE_DUPLICATE');
    assert.equal(f.data.customers.length, 1); assert.equal(f.data.orders[0].customerId, '');
  }
});

test('建档事务失败保留已保存订单，不留下孤立主档或地址', async () => {
  const f = fixture({ failWriteCollection: 'customer_operation_audits' });
  const result = await save(f);
  assert.equal(result.success, true); assert.equal(result.savedCount, 1); assert.equal(result.failedCount, 0);
  assert.equal(result.customerArchives[0].status, 'pending');
  assert.equal(f.data.orders.length, 1); assert.equal(f.data.orders[0].customerArchiveRequested, true);
  assert.equal(f.data.customers.length, 0); assert.equal(f.data.customer_aliases.length, 0);
  assert.equal(f.data.customer_recipient_profiles.length, 0);
});

test('没有建档权限仍能保存订单，独立重试接口拒绝越权', async () => {
  const f = fixture({}, ['orders:create']); const result = await save(f);
  assert.equal(result.savedCount, 1); assert.equal(result.customerArchives[0].code, 'ACCESS_DENIED');
  assert.equal(f.data.customers.length, 0);
  const retry = await entry('manageCustomers', f)({ action: 'createFromOrder', orderId: result.savedIds[0] });
  assert.equal(retry.success, false); assert.equal(retry.code, 'ACCESS_DENIED');
});

test('并发为同一订单建档仅创建一套资料，失败方可用订单 ID 重试', async () => {
  const f = fixture(); f.data.orders.push({ ...input, _id: 'o', customerArchiveRequested: true });
  await Promise.allSettled([f.archive('o', actor), f.archive('o', actor)]);
  assert.equal(f.data.customers.length, 1); assert.equal(f.data.customer_recipient_profiles.length, 1);
  assert.equal((await f.archive('o', actor)).status, 'linked');
});

test('不同订单并发为相同新客户建档，通过身份版本阻止重复', async () => {
  const f = fixture(); f.data.orders.push(...['a', 'b'].map(_id => ({ ...input, _id, customerArchiveRequested: true })));
  await Promise.allSettled([f.archive('a', actor), f.archive('b', actor)]);
  assert.equal(f.data.customers.length, 1);
  const pending = f.data.orders.find(row => !row.customerId);
  assert.equal((await f.archive(pending._id, actor)).code, 'CUSTOMER_POSSIBLE_DUPLICATE');
});

test('建档提交成功但响应丢失，重试不会重复创建', async () => {
  const f = fixture({ loseCommitReply: true }); f.data.orders.push({ ...input, _id: 'o', customerArchiveRequested: true });
  await assert.rejects(f.archive('o', actor));
  assert.equal((await f.archive('o', actor)).status, 'linked'); assert.equal(f.data.customers.length, 1);
});

test('拒绝未申请、忽略归档、缺失订单与无效名称；编辑不能伪造随单建档标记', async () => {
  const f = fixture(); await assert.rejects(f.archive('missing', actor), { code: 'ARCHIVE_NOT_REQUESTED' });
  f.data.orders.push({ ...input, _id: 'o' });
  await assert.rejects(f.archive('o', actor), { code: 'ARCHIVE_NOT_REQUESTED' });
  f.data.orders[0].customerArchiveRequested = true; f.data.orders[0].customerLinkStatus = 'ignored';
  await assert.rejects(f.archive('o', actor), { code: 'ARCHIVE_IGNORED' });
  f.data.orders[0].customerLinkStatus = 'pending'; f.data.orders[0].customerName = '   ';
  await assert.rejects(f.archive('o', actor), { code: 'INVALID_CUSTOMER_NAME' });
  assert.deepEqual(stripLinkFields({ customerArchiveRequested: true, createCustomerArchive: true, customerName: '正常名称' }, true), { customerName: '正常名称' });
  assert.equal(f.data.customers.length, 0);
});
