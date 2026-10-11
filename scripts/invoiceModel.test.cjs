const test = require('node:test');
const assert = require('node:assert/strict');
const { execute } = require('../cloud_functions/saveInvoice/invoiceModel');
function database(initial = {}) {
  let records = structuredClone({ invoices: {}, orders: {}, invoiceOrderLinks: {}, ...initial });
  let version = 0;
  let fail = '';
  const db = {
    serverDate: () => ({ $date: '2026-10-11' }),
    read: () => structuredClone(records),
    fail: value => { fail = value; },
    async startTransaction() {
      const start = version;
      const working = structuredClone(records);
      return {
        collection(name) {
          return {
            doc(id) {
              return {
                async get() {
                  if (fail === 'read') throw new Error('数据库读取失败');
                  return { data: structuredClone(working[name][id] || null) };
                },
                async update({ data }) { working[name][id] = { ...working[name][id], ...structuredClone(data) }; },
                async remove() { delete working[name][id]; },
              };
            },
            async add({ data }) {
              if (working[name][data._id]) throw new Error('duplicate');
              working[name][data._id] = structuredClone(data);
            },
          };
        },
        async commit() {
          if (fail === 'commit') throw new Error('提交失败');
          if (version !== start) throw new Error('transaction conflict');
          records = working; version++;
        },
        async rollback() {},
      };
    },
  };
  return db;
}
const order = amount => ({ serialNumber: 12, date: '2026-10-10', customerName: '客户', products: [{ productName: '手机', quantity: 1, amount }], attachments: [{ fileID: 'cloud://a', fileName: 'a.png' }] });
const linked = ids => ({ companyName: '公司', invoiceCategory: '二手手机', entryMode: 'linkedOrders', linkedOrders: ids.map(orderId => ({ orderId, amount: 0, attachments: [] })), invoiceAmount: 145, amountAdjustmentReason: '折扣' });
test('多订单从数据库建立金额和附件快照，保留总金额调整，忽略客户端伪造的合计', async () => {
  const db = database({ orders: { a: order(100), b: order(50) } });
  const result = await execute(db, 'save', { invoice: { ...linked(['a', 'b']), linkedOrderTotal: 1 } });
  assert.equal(result.success, true);
  const invoice = db.read().invoices[result._id];
  assert.equal(invoice.linkedOrderTotal, 150);
  assert.equal(invoice.invoiceAmount, 145);
  assert.equal(invoice.linkedOrders[0].attachments[0].fileID, 'cloud://a');
  assert.equal(db.read().invoiceOrderLinks.a.invoiceId, result._id);
});
test('并发关联同一订单只有一个成功，另一请求返回冲突发票', async () => {
  const db = database({ orders: { a: order(150) } });
  const results = await Promise.all([execute(db, 'save', { invoice: linked(['a']) }), execute(db, 'save', { invoice: linked(['a']) })]);
  assert.equal(results.filter(item => item.success).length, 1);
  const loser = results.find(item => !item.success);
  assert.equal(loser.conflicts[0].orderId, 'a');
  assert.equal(Object.keys(db.read().invoices).length, 1);
});
test('编辑增减订单同步释放和占用，保留已有快照，删除释放全部订单', async () => {
  const db = database({ orders: { a: order(100), b: order(50), c: order(60) } });
  const saved = await execute(db, 'save', { invoice: linked(['a', 'b']) });
  const edit = await execute(db, 'update', { _id: saved._id, updateData: { linkedOrders: [{ orderId: 'b', amount: 999 }, { orderId: 'c' }] } });
  assert.equal(edit.success, true);
  assert.equal(db.read().invoices[saved._id].linkedOrderTotal, 110);
  assert.equal(db.read().invoiceOrderLinks.a, undefined);
  assert.equal(db.read().invoiceOrderLinks.c.invoiceId, saved._id);
  assert.equal((await execute(db, 'delete', { _id: saved._id })).success, true);
  assert.deepEqual(db.read().invoiceOrderLinks, {});
  assert.deepEqual(db.read().invoices, {});
});
test('冲突编辑和提交失败不改变发票或原关联', async () => {
  const db = database({ orders: { a: order(150), b: order(150) } });
  const a = await execute(db, 'save', { invoice: linked(['a']) });
  await execute(db, 'save', { invoice: linked(['b']) });
  const before = db.read();
  assert.equal((await execute(db, 'update', { _id: a._id, updateData: { linkedOrders: [{ orderId: 'b' }] } })).success, false);
  assert.deepEqual(db.read(), before);
  db.fail('commit');
  assert.equal((await execute(db, 'delete', { _id: a._id })).success, false);
  assert.deepEqual(db.read(), before);
});
test('历史二手手机仅更新状态不重算金额，货品变更才重算，切换关联与手工释放订单', async () => {
  const db = database({ invoices: { old: { _id: 'old', companyName: '公司', invoiceCategory: '二手手机', phoneModel: '型号', phoneQuantity: 2, unitPrice: 100, invoiceAmount: 180 } }, orders: { a: order(150) } });
  assert.equal((await execute(db, 'update', { _id: 'old', updateData: { status: 'paid' } })).success, true);
  assert.equal(db.read().invoices.old.invoiceAmount, 180);
  assert.equal((await execute(db, 'update', { _id: 'old', updateData: { phoneQuantity: 3 } })).success, true);
  assert.equal(db.read().invoices.old.invoiceAmount, 300);
  assert.equal((await execute(db, 'update', { _id: 'old', updateData: linked(['a']) })).success, true);
  assert.equal((await execute(db, 'update', { _id: 'old', updateData: { entryMode: 'manual', invoiceCategory: '租赁服务费', invoiceAmount: 130 } })).success, true);
  assert.deepEqual(db.read().invoiceOrderLinks, {});
  assert.deepEqual(db.read().invoices.old.linkedOrders, []);
});
test('拒绝空关联、重复订单、不存在订单、非法金额和缺失调整原因', async () => {
  for (const patch of [{ linkedOrders: [] }, { linkedOrders: [{ orderId: 'a' }, { orderId: 'a' }] }, { linkedOrders: [{ orderId: 'missing' }] }, { invoiceAmount: -1 }, { invoiceAmount: Infinity }, { invoiceAmount: 1.234 }, { amountAdjustmentReason: '' }, { entryMode: 'unknown' }]) {
    const db = database({ orders: { a: order(150) } });
    assert.equal((await execute(db, 'save', { invoice: { ...linked(['a']), ...patch } })).success, false);
    assert.deepEqual(db.read().invoices, {});
    assert.deepEqual(db.read().invoiceOrderLinks, {});
  }
});
test('旧扁平订单与手工多货品金额兼容，读取失败不伪装为无关联', async () => {
  const db = database({ orders: { a: { ...order(1), products: [], amount: 150, productName: '租金' } } });
  const saved = await execute(db, 'save', { invoice: linked(['a']) });
  assert.equal(db.read().invoices[saved._id].linkedOrderTotal, 150);
  const manual = await execute(db, 'save', { invoice: { companyName: '公司', invoiceCategory: '二手手机', invoiceAmount: 1, phoneProducts: [{ model: 'A', quantity: 2, unitPrice: 12.5 }, { model: 'B', quantity: 1, unitPrice: 10 }] } });
  assert.equal(db.read().invoices[manual._id].invoiceAmount, 35);
  db.fail('read');
  assert.match((await execute(db, 'delete', { _id: saved._id })).errMsg, /读取失败/);
});

test('渠道由来源订单生成快照，旧快照补渠道但不改变历史金额', async () => {
  const source = { ...order(150), salesChannel: 'channel-a' };
  const db = database({ orders: { a: source }, invoices: { old: { ...linked(['a']), _id: 'old', linkedOrders: [{ orderId: 'a', amount: 100, attachments: [] }], invoiceAmount: 100 } }, invoiceOrderLinks: { a: { _id: 'a', invoiceId: 'old' } } });
  assert.equal((await execute(db, 'update', { _id: 'old', updateData: { status: 'paid' } })).success, true);
  assert.equal(db.read().invoices.old.linkedOrders[0].salesChannel, 'channel-a');
  assert.equal(db.read().invoices.old.linkedOrders[0].amount, 100);
  const fresh = database({ orders: { a: source } });
  const saved = await execute(fresh, 'save', { invoice: linked(['a']) });
  assert.equal(fresh.read().invoices[saved._id].linkedOrders[0].salesChannel, 'channel-a');
});
