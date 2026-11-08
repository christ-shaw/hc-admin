const test = require('node:test');
const assert = require('node:assert/strict');
const { queryDynamicMessages } = require('./dynamicMessages');
function database(rows) {
  const reads = [];
  const values = (value, parts) => {
    if (!parts.length) return [value];
    if (Array.isArray(value)) return value.flatMap(item => values(item, parts));
    return values(value?.[parts[0]], parts.slice(1));
  };
  const match = (row, condition) => typeof condition === 'function' ? condition(row)
    : Object.entries(condition).every(([key, rule]) => values(row, key.split('.')).some(value =>
      rule instanceof RegExp ? typeof value === 'string' && rule.test(value)
        : typeof rule === 'function' ? rule(value) : value === rule));
  const db = {
    command: { in: list => value => list.includes(value), neq: target => value => value !== target,
      or: list => row => list.some(condition => match(row, condition)) },
    RegExp: ({ regexp, options }) => new RegExp(regexp, options),
    collection(name) {
      assert.equal(name, 'orders');
      let condition, skip = 0, limit = Infinity, sorting = [];
      const query = {
        where(value) { condition = value; return query; },
        field() { return query; },
        orderBy(key, direction) { sorting.push([key, direction]); return query; },
        skip(value) { skip = value; return query; },
        limit(value) { limit = value; return query; },
        async count() { assert.ok(condition); return { total: rows.filter(row => match(row, condition)).length }; },
        async get() {
          assert.ok(condition, 'must filter on server');
          reads.push({ skip, limit });
          return { data: rows.filter(row => match(row, condition)).sort((a, b) => {
            for (const [key, direction] of sorting) {
              const comparison = a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0;
              if (comparison) return direction === 'desc' ? -comparison : comparison;
            }
            return 0;
          }).slice(skip, skip + limit) };
        },
      };
      return query;
    },
  };
  return { db, reads };
}
test('counts all matching orders but returns only newest 20 per category, with no full-order pagination', async () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ _id: String(i), date: '2026-09-27', serialNumber: i,
    orderType: i < 50 ? 'postRentalShip' : 'sale', paymentAccount: i < 80 ? '未收款' : 'paid' }));
  rows[0].returnStatus = 'returned';
  const { db, reads } = database(rows);
  const { data } = await queryDynamicMessages(db);
  assert.equal(data.unreturned.total, 49);
  assert.equal(data.unreceived.total, 80);
  assert.equal(data.unreturned.orders.length, 20);
  assert.equal(data.unreceived.orders.length, 20);
  assert.equal(data.unreceived.orders[0]._id, '79');
  assert.equal(reads.length, 3);
});
test('legacy JSON payments, nested products, invalid JSON and double counting', async () => {
  const rows = [
    { paymentAccount: '未收款', paymentSplits: '[{"account":"未收款"}]' },
    { paymentSplits: [{ account: '未收款' }] },
    { products: [{ paymentAccount: '未收款' }] },
    { products: [{ paymentSplits: [{ account: '未收款' }] }] },
    { paymentSplits: '  [{"account":"未收款"}]' },
    { products: [{ paymentSplits: '[{"account":"未收款"}]' }] },
    { paymentSplits: '[{"account":"已收款","note":"未收款"}]' },
    { paymentSplits: '[invalid 未收款' },
  ].map((row, i) => ({ ...row, _id: String(i), date: '2026-09-27', serialNumber: i }));
  const { db } = database(rows);
  const { data } = await queryDynamicMessages(db);
  assert.equal(data.unreceived.total, 6);
  assert.deepEqual(data.unreceived.orders.map(row => row._id), ['5','4','3','2','1','0']);
  assert.equal(data.unreturned.total, 0);
});
test('legacy candidates beyond the first page are counted and sorted', async () => {
  const rows = Array.from({ length: 105 }, (_, i) => ({ _id: String(i).padStart(3,'0'),
    serialNumber: i, date: '2026-09-27', paymentSplits: '[{"account":"未收款"}]' }));
  const { db } = database(rows);
  const { data } = await queryDynamicMessages(db);
  assert.equal(data.unreceived.total, 105);
  assert.equal(data.unreceived.orders[0]._id, '104');
});
test('query failure is not presented as zero pending orders', async () => {
  const { db } = database([]);
  db.collection = () => { throw new Error('database unavailable'); };
  await assert.rejects(queryDynamicMessages(db), /database unavailable/);
});
