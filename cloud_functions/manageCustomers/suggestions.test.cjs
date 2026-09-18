const test = require('node:test');
const assert = require('node:assert/strict');
const { database } = require('./test-support/database.cjs');
const { createRepository } = require('./repository');
const { createSuggestions } = require('./suggestions');
const { permissionsFor } = require('./permissions');

test('推荐按精确、前缀、包含匹配排序，别名归并到客户，最多三位，仅返回允许的摘要', async () => {
  const memory = database({
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
  assert.equal(result.data[0].recipients[0]._id, 'r2');
  assert.equal(result.data[0].recipientTotal, 2);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.ok(memory.reads.filter(row => row.collection === 'customer_recipient_profiles').every(row => row.where.customerId));
  assert.equal(memory.writes.length, 0);
});

test('推荐处理全半角、大小写、分隔符与正则字符，空输入不查询', async () => {
  const memory = database({ customers: [{ _id: 'a', displayName: 'Ａ—Ｂ', status: 'active' },
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
