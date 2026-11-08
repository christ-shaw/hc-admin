const test = require('node:test');
const assert = require('node:assert/strict');
const { database } = require('./test-support/database.cjs');
const { createRepository } = require('./repository');
const { createSuggestions } = require('./suggestions');
const { permissionsFor } = require('./permissions');
const { normalizeName } = require('./normalizers');

function normalizedDatabase(data) {
  for (const row of data.customers || []) row.normalizedDisplayName = normalizeName(row.displayName);
  for (const row of data.customer_aliases || []) row.normalizedName = normalizeName(row.name);
  return database(data);
}

test('推荐按精确、前缀、包含匹配排序，别名归并到客户，最多三位，仅返回允许的摘要', async () => {
  const memory = normalizedDatabase({
    customers: [
      { _id: 'c1', displayName: '长城公司', status: 'active', remark: 'private', updatedAt: '2026' },
      { _id: 'c2', displayName: '老长城', status: 'active', updatedAt: '2027' },
      { _id: 'c3', displayName: '张三', status: 'active' },
      { _id: 'c4', displayName: '小长城', status: 'active' },
      { _id: 'c5', displayName: '长城', status: 'disabled' },
    ],
    customer_aliases: [{ _id: 'a1', customerId: 'c3', name: '长城', enabled: true, remark: 'private' },
      { _id: 'a2', customerId: 'c3', name: '长城客户', enabled: true },
      { _id: 'a3', customerId: 'c5', name: '长城', enabled: true }],
    customer_recipient_profiles: [
      { _id: 'r1', customerId: 'c3', consignee: '张三', address: '北京', enabled: true, useCount: 1 },
      { _id: 'r2', customerId: 'c3', consignee: '李四', address: '上海', enabled: true, useCount: 5 },
      { _id: 'r3', customerId: 'c3', enabled: false, useCount: 100 },
    ],
  });
  const result = await createSuggestions(createRepository(memory.db))({ keyword: '长城', pageSize: 999 });
  assert.deepEqual(result.data.map(row => row._id), ['c3', 'c1', 'c2']);
  assert.equal(result.data[0].aliases.length, 2);
  assert.deepEqual(result.data[0].recipients, []);
  assert.equal(result.data[0].detailsDeferred, true);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(memory.reads.filter(row => row.collection === 'customer_recipient_profiles').length, 0);
  assert.ok(memory.reads.every(row => row.limit === 20 && row.field));
  assert.equal(memory.writes.length, 0);
});

test('推荐处理全半角、大小写、分隔符与正则字符，空输入不查询', async () => {
  const memory = normalizedDatabase({ customers: [{ _id: 'a', displayName: 'Ａ—Ｂ', status: 'active' },
    { _id: 'b', displayName: 'a+b', status: 'active' }], customer_aliases: [], customer_recipient_profiles: [] });
  const suggest = createSuggestions(createRepository(memory.db));
  assert.deepEqual((await suggest({ keyword: ' ' })).data, []); assert.equal(memory.reads.length, 0);
  assert.equal((await suggest({ keyword: 'a b' })).data[0]._id, 'a');
  assert.deepEqual((await suggest({ keyword: '.*' })).data, []);
  assert.equal((await suggest({ keyword: '+' })).data[0]._id, 'b');
  assert.equal((await suggest({ keyword: 'a'.repeat(101) })).success, false);
  assert.ok(permissionsFor('search', 'orderSuggestions').includes('orders:update'));
  assert.equal(permissionsFor('get', 'orderSuggestions'), null);
});

test('大量宽泛匹配不挤掉精确命中；精确命中三位后不运行模糊查询', async () => {
  const memory = normalizedDatabase({ customers: [
    ...Array.from({ length: 500 }, (_, i) => ({ _id: `prefix${i}`, displayName: `朱贵${i}`, status: 'active' })),
    ...['a', 'b', 'c'].map(_id => ({ _id, displayName: '朱贵', status: 'active' })),
  ] });
  const result = await createSuggestions(createRepository(memory.db))({ keyword: '朱贵' });
  assert.deepEqual(result.data.map(row => row._id), ['a', 'b', 'c']);
  assert.equal(memory.reads.length, 2);
  assert.ok(memory.reads.every(row => typeof (row.where.normalizedDisplayName || row.where.normalizedName) === 'string'));
});

test('前缀已足够时不查包含匹配，所有返回均为受限字段且读取有上限', async () => {
  const memory = normalizedDatabase({ customers: [
    { _id: 'contains', displayName: '老朱贵', status: 'active' },
    ...Array.from({ length: 1000 }, (_, i) => ({ _id: `c${i}`, displayName: `朱贵${i}`, status: 'active', remark: 'private' })),
  ] });
  const result = await createSuggestions(createRepository(memory.db))({ keyword: '朱贵' });
  assert.equal(result.data.length, 3);
  assert.ok(result.data.every(row => row._id !== 'contains' && row.detailsDeferred));
  assert.equal(memory.reads.length, 4);
  assert.ok(memory.reads.every(row => row.limit === 20 && row.field && !row.skip));
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('停用/合并客户及其别名不进入推荐；重复别名归并且不查询无关收货资料', async () => {
  const memory = normalizedDatabase({ customers: [
    { _id: 'active', displayName: '甲', status: 'active' },
    { _id: 'disabled', displayName: '乙', status: 'disabled' },
    { _id: 'merged', displayName: '丙', status: 'merged' },
  ], customer_aliases: [
    ...['active', 'disabled', 'merged'].map(customerId => ({ _id: customerId, customerId, name: '朱贵', enabled: true })),
    { _id: 'second', customerId: 'active', name: '朱贵', enabled: true, salesChannel: '微信' },
    { _id: 'off', customerId: 'active', name: '朱贵', enabled: false },
  ] });
  const result = await createSuggestions(createRepository(memory.db))({ keyword: '朱贵', salesChannel: '微信' });
  assert.deepEqual(result.data.map(row => row._id), ['active']);
  assert.deepEqual(result.data[0].aliases.map(row => row._id), ['second', 'active']);
  assert.equal(memory.reads.filter(row => row.collection === 'customer_recipient_profiles').length, 0);
  assert.ok(memory.reads.length <= 9);
});
