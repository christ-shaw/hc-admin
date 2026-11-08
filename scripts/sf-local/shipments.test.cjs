const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('./runtime.cjs');

const ok = result => { assert.equal(result.success, true, JSON.stringify(result)); return result; };
const get = async (r, collection, id) => (await r.db.collection(collection).doc(id).get()).data;
async function merge(r, ids = ['demo-order-2', 'demo-order-1']) {
  const primary = await get(r, 'orders', ids[0]);
  const recipientChoice = Object.fromEntries(['consignee', 'consigneePhone', 'consigneeAddress', 'shippingFee'].map(key => [key, primary[key]]));
  return r.invoke('applySfExpress', { sourceOrderId: ids[0], mergeOrderIds: ids, recipientChoice });
}
async function outbound(r, orderId) {
  const order = await get(r, 'orders', orderId);
  const id = `out-${orderId}`;
  r.put('orders', { ...order, outboundRecordId: id });
  r.put('outbound_records', { _id: id, outboundStatus: 'pending', orderIds: [orderId], trackingNumber: '' });
}
async function printed(r) {
  const result = ok(await r.invoke('applySfExpress', { sourceOrderId: 'demo-order-1' }));
  const record = await get(r, 'sf_express_orders', result.sfExpressOrderId);
  r.put('sf_express_orders', { ...record, printCount: 1, lastPrintTime: new Date().toISOString() });
  return { action: 'appendOrders', sfExpressOrderId: record._id, shipmentVersion: record.shipmentVersion,
    sourceOrderIds: ['demo-order-2'], requestId: 'append-test', confirmShipmentRecipient: true };
}

test('不同收件信息合并仅创建一单，按选择确定收件信息并同步全部订单和出库单', async () => {
  const r = createRuntime();
  await outbound(r, 'demo-order-1'); await outbound(r, 'demo-order-2');
  const original = await get(r, 'orders', 'demo-order-1');
  const result = ok(await merge(r));
  assert.equal(r.calls.filter(call => call.service === 'EXP_RECE_CREATE_ORDER').length, 1);
  const record = await get(r, 'sf_express_orders', result.sfExpressOrderId);
  assert.equal(record.sourceOrderId, 'demo-order-2');
  assert.equal(record.orderSnapshot.consignee, '测试收件人 2');
  const request = JSON.parse(record.requestSummary);
  assert.equal(request.contactInfoList.find(contact => contact.contactType === 2).contact, '测试收件人 2');
  assert.equal(request.cargoDetails[0].count, 2);
  assert.equal(record.shipmentRemarkEntries.length, 2);
  for (const id of record.linkedOrderIds) {
    const order = await get(r, 'orders', id);
    assert.equal(order.trackingNumber, result.waybillNo);
    assert.equal(order.sfExpressOrderRecordId, record._id);
    assert.equal(order.sharedWaybill, true);
    assert.equal((await get(r, 'outbound_records', order.outboundRecordId)).trackingNumber, result.waybillNo);
  }
  assert.equal((await get(r, 'orders', original._id)).consignee, original.consignee);
});

test('合并申请超时后查询能恢复所有成员，避免子订单漏回填', async () => {
  const r = createRuntime(); r.state.timeoutNextCreate = true;
  const failed = await merge(r); assert.equal(failed.success, false);
  const recovered = ok(await r.invoke('querySfOrderResult', { sfExpressOrderId: failed.sfExpressOrderId }));
  for (const id of ['demo-order-1', 'demo-order-2']) assert.equal((await get(r, 'orders', id)).trackingNumber, recovered.waybillNo);
});

test('合并申请失败后从主订单重试保留全部成员', async () => {
  const r = createRuntime(); r.state.timeoutNextCreate = true;
  assert.equal((await merge(r)).success, false);
  const result = ok(await r.invoke('applySfExpress', { sourceOrderId: 'demo-order-2' }));
  assert.equal((await get(r, 'orders', 'demo-order-1')).trackingNumber, result.waybillNo);
});

test('已出单、已打印、已取消及其他环境历史都不能加入新合并', async () => {
  for (const patch of [{ waybillNo: 'SF-OLD' }, { printCount: 1 }, { status: 'cancelled' }, { env: 'production', waybillNo: 'SF-PROD' }]) {
    const r = createRuntime();
    r.put('sf_express_orders', { _id: 'history', sourceOrderId: 'demo-order-1', env: 'sandbox', status: 'failed', ...patch });
    assert.equal((await merge(r)).success, false);
    assert.equal(r.calls.length, 0);
  }
});

test('确认的收件资料已修改时拒绝出单', async () => {
  const r = createRuntime();
  const result = await r.invoke('applySfExpress', { sourceOrderId: 'demo-order-1', mergeOrderIds: ['demo-order-1', 'demo-order-2'], recipientChoice: {} });
  assert.equal(result.success, false); assert.equal(r.calls.length, 0);
});

test('合并占用订单后其他单独出单请求被拒绝且不影响原合并', async () => {
  const r = createRuntime(); let competing;
  r.state.beforeCreate = async () => {
    r.state.beforeCreate = null;
    competing = await r.invoke('applySfExpress', { sourceOrderId: 'demo-order-1' });
  };
  const result = ok(await merge(r));
  assert.equal(competing.success, false);
  assert.equal((await get(r, 'orders', 'demo-order-1')).trackingNumber, result.waybillNo);
  assert.equal(r.calls.filter(call => call.service === 'EXP_RECE_CREATE_ORDER').length, 1);
});

test('已打印运单无需开放追加，可追加不同收件信息订单且不生成新单', async () => {
  const r = createRuntime(); const payload = await printed(r);
  const before = r.calls.length;
  const result = ok(await r.invoke('manageSfShipment', payload));
  assert.equal(r.calls.length, before);
  assert.equal((await get(r, 'orders', 'demo-order-2')).trackingNumber, result.waybillNo);
  const record = await get(r, 'sf_express_orders', payload.sfExpressOrderId);
  assert.equal(record.orderSnapshot.consignee, '测试收件人 1');
  assert.equal(record.shipmentRemarkEntries.length, 2);
  assert.equal(record.shipmentHistory.at(-1).recipientConfirmed, true);
  assert.equal(ok(await r.invoke('manageSfShipment', payload)).duplicated, true);
});

test('批量追加任一订单不合格时整个事务不写回', async () => {
  const r = createRuntime(); const payload = await printed(r);
  await outbound(r, 'demo-order-2');
  const order = await get(r, 'orders', 'demo-order-3'); r.put('orders', { ...order, trackingNumber: 'OTHER' });
  const before = await get(r, 'sf_express_orders', payload.sfExpressOrderId);
  const result = await r.invoke('manageSfShipment', { ...payload, sourceOrderIds: ['demo-order-2', 'demo-order-3'] });
  assert.equal(result.success, false);
  assert.deepEqual(await get(r, 'sf_express_orders', payload.sfExpressOrderId), before);
  assert.equal((await get(r, 'outbound_records', 'out-demo-order-2')).trackingNumber, '');
});

test('追加需要打印、未交接、正确版本及明确确认', async () => {
  for (const patch of [{ printCount: 0, lastPrintTime: '' }, { shipmentStatus: 'handed_over' }, { shipmentStatus: 'picked_up' }, { status: 'cancelled' }, { shipmentVersion: 9 }]) {
    const r = createRuntime(); const payload = await printed(r);
    r.put('sf_express_orders', { ...await get(r, 'sf_express_orders', payload.sfExpressOrderId), ...patch });
    assert.equal((await r.invoke('manageSfShipment', payload)).success, false);
  }
  const r = createRuntime(); const payload = await printed(r);
  assert.equal((await r.invoke('manageSfShipment', { ...payload, confirmShipmentRecipient: false })).success, false);
  r.state.role = 'viewer';
  assert.equal((await r.invoke('manageSfShipment', payload)).success, false);
});

test('已打印面单候选支持日期和精确订单号筛选，排除已有单号订单', async () => {
  const r = createRuntime(); const payload = await printed(r);
  const target = await get(r, 'orders', 'demo-order-2'); r.put('orders', { ...target, onlineOrderNumber: 'TARGET' });
  const result = ok(await r.invoke('manageSfShipment', { action: 'listAppendOrders', sfExpressOrderId: payload.sfExpressOrderId, date: target.date, onlineOrderNumber: 'TARGET' }));
  assert.deepEqual(Array.from(result.data, order => order._id), ['demo-order-2']);
});

test('无权限不能合并出单', async () => {
  const r = createRuntime(); r.state.role = 'viewer';
  assert.equal((await merge(r)).success, false);
  assert.equal(r.calls.length, 0);
});

test('合并后再生成出库单，回填包裹关联；缺少任一出库单不能确认交接', async () => {
  const r = createRuntime(); const result = ok(await merge(r));
  const generated = ok(await r.invoke('generateOutboundFromOrders', { orderIds: ['demo-order-1'], shippingMethod: 'cod' }));
  const record = await get(r, 'sf_express_orders', result.sfExpressOrderId);
  assert.ok(record.linkedOutboundIds.includes(generated.outboundId));
  const out = await get(r, 'outbound_records', generated.outboundId);
  assert.equal(out.sfExpressOrderRecordId, record._id);
  assert.equal(out.trackingNumber, record.waybillNo);
  r.put('outbound_records', { ...out, outboundStatus: 'completed' });
  const handover = await r.invoke('manageSfShipment', { action: 'confirmHandover', sfExpressOrderId: record._id });
  assert.equal(handover.success, false);
  assert.match(handover.errMsg, /全部关联订单/);
});
