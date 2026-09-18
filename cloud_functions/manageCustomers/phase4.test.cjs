const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { database } = require('./test-support/database.cjs');
const { createOrderIngestion } = require('./orderIngestion');
const { createRepository } = require('./repository');
const { createWriter } = require('./writer');
const actor = { id: 'server-user' };
const identity = { customerName: '客户甲', consignee: '张三', consigneePhone: '13800138000', consigneeAddress: '上海市1-203室' };
const basic = { ...identity, orderAttribute: 'rental1', orderType: 'newBusiness', onlineOrderNumber: 'SOURCE-1', salesChannel: 'yuntu', products: [{ brand: '苹果', productName: '手机', specification: '默认', quantity: 1 }] };
function setup(extra = {}, options = {}) {
  const data = { customers: [{ _id: 'c', displayName: '客户甲', status: 'active' }, { _id: 'other', displayName: '其他客户', status: 'active' }],
    customer_aliases: [{ _id: 'a', customerId: 'c', name: identity.customerName, enabled: true }],
    customer_recipient_profiles: [{ _id: 'p', customerId: 'c', consignee: identity.consignee, phone: identity.consigneePhone, address: identity.consigneeAddress, enabled: true }],
    system_config: [{ _id: 'permission_system', initialized: true }, { _id: 'customer_modeling', autoLinkNewOrders: true }],
    roles: [{ _id: 'r', actionPermissions: ['orders:create', 'orders:update'] }], user_roles: [{ _id: 'ur', userId: actor.id, roleId: 'r' }],
    system_counters: [{ _id: 'orderSerialNumber', value: 100 }], orders: [], ...extra };
  const memory = database(data, options);
  const service = createOrderIngestion(memory.db);
  const save = async (input = basic) => {
    const tx = await memory.db.startTransaction();
    try {
      const order = await service.prepareOrder(input, actor, tx);
      const added = await tx.collection('orders').add({ data: order }); await tx.commit(); return added._id;
    } catch (error) { await tx.rollback(); throw error; }
  };
  return { ...memory, data, service, save };
}
function entry(name, memory, user = actor) {
  const filename = path.resolve(__dirname, '..', name, 'index.js');
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  const logs = [];
  const context = { module, exports: module.exports, Buffer, Date, process: { env: { HC_ORDER_ASSIST_TOKEN: 'test-token' } },
    console: { log() {}, warn(...values) { logs.push(values); }, error(...values) { logs.push(values); } },
    require(id) {
      if (id === 'wx-server-sdk') return { init() {}, database: () => memory.db };
      if (id === './permissionAuth') return { getCurrentUser: async () => user };
      return realRequire(id);
    } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { main: module.exports.main, logs };
}
const orderById = (s, id) => s.data.orders.find(row => row._id === id);
const expectedLink = order => Object.fromEntries(['customerId', 'customerAliasId', 'recipientProfileId'].map(field => [field, order[field] || '']));

test('编辑订单显式选择和取消关联随快照原子保存，普通名称编辑不改归属', async () => {
  const s = setup(); const id = await s.save({ ...basic, customerId: 'c' });
  const original = { ...orderById(s, id) };
  const update = updateData => entry('updateOrder', s).main({ data: { _id: id, updateData } });
  assert.equal((await update({ customerName: '手输临时名称' })).success, true);
  assert.equal(orderById(s, id).customerId, 'c'); assert.equal(orderById(s, id).customerLinkedAt, original.customerLinkedAt);
  assert.equal((await update({ customerSelectionMode: 'explicit', customerId: 'other', customerLinkExpected: expectedLink(original), customerName: '其他客户' })).success, true);
  assert.equal(orderById(s, id).customerId, 'other'); assert.equal(orderById(s, id).consigneeAddress, basic.consigneeAddress);
  assert.equal(s.data.customer_operation_audits.at(-1).action, 'editOrderCustomer');
  assert.equal('customerLinkExpected' in orderById(s, id), false);
  assert.equal((await update({ customerSelectionMode: 'none', customerLinkExpected: expectedLink(orderById(s, id)) })).success, true);
  assert.equal(orderById(s, id).customerId, ''); assert.equal(orderById(s, id).customerIngestState, 'done');
  assert.equal(orderById(s, id).customerName, '其他客户');
});

test('编辑客户关联校验跨客户引用、过期快照和停用档案；审计失败回滚整单', async () => {
  const s = setup(); const id = await s.save({ ...basic, customerId: 'c' });
  const before = JSON.stringify(orderById(s, id));
  for (const fields of [{ customerId: 'other', customerAliasId: 'a' }, { customerId: 'missing' },
    { customerId: 'other', customerLinkExpected: { customerId: 'stale' } }]) {
    const result = await entry('updateOrder', s).main({ data: { _id: id, updateData: {
      customerSelectionMode: 'explicit', customerLinkExpected: expectedLink(orderById(s, id)), customerName: '不可保存', ...fields,
    } } });
    assert.equal(result.success, false); assert.equal(JSON.stringify(orderById(s, id)), before);
  }
  s.data.customers[1].status = 'disabled';
  assert.equal((await entry('updateOrder', s).main({ data: { _id: id, updateData: { customerSelectionMode: 'explicit', customerId: 'other', customerLinkExpected: expectedLink(orderById(s, id)) } } })).success, false);
  const failing = setup({}, { failWriteCollection: 'customer_operation_audits' }); const failId = await failing.save(basic);
  const result = await entry('updateOrder', failing).main({ data: { _id: failId, updateData: { customerSelectionMode: 'explicit', customerId: 'c', customerLinkExpected: expectedLink(orderById(failing, failId)), customerName: '不应保存' } } });
  assert.equal(result.success, false); assert.equal(orderById(failing, failId).customerName, basic.customerName);
});
test('明确选择在事务内验证引用，操作人时间由服务端生成，临时快照不写主档', async () => {
  const s = setup();
  const id = await s.save({ ...basic, customerId: 'c', customerAliasId: 'a', recipientProfileId: 'p', customerLinkedBy: 'spoof', customerLinkedAt: 'spoof' });
  const order = orderById(s, id); assert.equal(order.customerLinkedBy, actor.id); assert.notEqual(order.customerLinkedAt, 'spoof');
  assert.equal(order.customerLinkMethod, 'manual'); assert.equal((await s.service.ingestOrder(id, actor)).status, 'skipped');
  const temporary = await s.save({ ...basic, customerId: 'c', recipientProfileId: 'p', consigneeAddress: '临时地址' });
  assert.equal(orderById(s, temporary).recipientProfileId, ''); assert.equal(s.data.customer_recipient_profiles[0].address, identity.consigneeAddress);
  for (const input of [{ customerId: 'other', recipientProfileId: 'p' }, { customerId: 'c', customerAliasId: 'missing' }, { recipientProfileId: 'p' }]) {
    await assert.rejects(s.save({ ...basic, ...input }));
  }
  assert.equal(s.data.orders.length, 2);
});
test('服务端合并解析与停用校验同样适用于手工选择', async () => {
  const s = setup(); s.data.customers.push({ _id: 'old', status: 'merged', mergedIntoCustomerId: 'c' });
  const id = await s.save({ ...basic, customerId: 'old' }); assert.equal(orderById(s, id).customerId, 'c');
  s.data.customers[0].status = 'disabled'; await assert.rejects(s.save({ ...basic, customerId: 'old' }), { code: 'CUSTOMER_UNAVAILABLE' });
});
test('唯一精确匹配在保存后执行，审计与订单关联原子提交，重复执行幂等', async () => {
  const s = setup(); const id = await s.save(); assert.equal(orderById(s, id).customerId, '');
  assert.equal((await s.service.ingestOrder(id, actor)).status, 'linked');
  assert.equal(orderById(s, id).recipientProfileId, 'p'); assert.equal(orderById(s, id).customerLinkMethod, 'exact');
  await s.service.ingestOrder(id, actor); assert.equal(s.data.customer_operation_audits.length, 1);
});
test('开关缺失或关闭、无匹配、多客户精确匹配、不完整身份均保持待归档', async () => {
  for (const kind of ['off', 'missing', 'no-match', 'ambiguous', 'incomplete']) {
    const s = setup();
    if (kind === 'off') s.data.system_config[1].autoLinkNewOrders = false;
    if (kind === 'missing') s.data.system_config.pop();
    if (kind === 'ambiguous') { s.data.customers[1].displayName = identity.customerName; s.data.customer_recipient_profiles.push({ ...s.data.customer_recipient_profiles[0], _id: 'q', customerId: 'other' }); }
    const id = await s.save({ ...basic, ...(kind === 'no-match' ? { customerName: '陌生人' } : {}), ...(kind === 'incomplete' ? { consigneePhone: '138****8000' } : {}) });
    await s.service.ingestOrder(id, actor); assert.equal(orderById(s, id).customerLinkStatus, 'pending', kind);
  }
});
test('匹配和审计存储失败不丢订单，保留持久 pending 标记，日志不暴露快照', async () => {
  for (const option of [{ failCollection: 'customers' }, { failWriteCollection: 'customer_operation_audits' }]) {
    const s = setup({}, option); const id = await s.save();
    const result = await s.service.ingestOrder(id, actor); assert.equal(result.status, 'pending');
    assert.equal(orderById(s, id).customerId, ''); assert.equal(orderById(s, id).customerIngestState, 'pending');
    assert.equal(JSON.stringify(result).includes(identity.consigneePhone), false);
  }
});
test('旧历史订单、已忽略订单、清除本次选择的订单不会被补偿自动绑定', async () => {
  const s = setup(); s.data.orders.push({ _id: 'legacy', ...basic });
  assert.equal((await s.service.ingestOrder('legacy', actor)).status, 'skipped');
  const id = await s.save({ ...basic, customerSelectionMode: 'none', customerId: 'c' });
  assert.equal((await s.service.ingestOrder(id, actor)).status, 'skipped');
  const ignored = await s.save(); await s.db.collection('orders').doc(ignored).update({ data: { customerLinkStatus: 'ignored' } });
  assert.equal((await s.service.ingestOrder(ignored, actor)).status, 'skipped');
});
function derived(sourceId, kind) {
  return { ...basic, consignee: '', consigneePhone: '', consigneeAddress: '', customerId: 'other',
    ...(kind === 'renewal' ? { renewalSourceOrderId: sourceId, products: [{ brand: '虚拟产品', productName: '续期租金' }] }
      : kind === 'transfer' ? { orderAttribute: 'rental2', rental2TransferSourceOrderId: sourceId, rental2TransferMode: 'partial', products: [{ brand: '虚拟产品', productName: '部分转租赁2' }] }
      : { orderAttribute: 'rental2', orderSource: 'service', orderType: 'postRentalShip', afterSaleSourceOrderId: sourceId }) };
}
test('续租/转租赁2/售后可信来源解析最终客户，不信草稿复制ID，开关关闭仍可继承', async () => {
  for (const kind of ['renewal', 'transfer', 'afterSale']) {
    const s = setup(); s.data.system_config[1].autoLinkNewOrders = false;
    s.data.customers.push({ _id: 'old', status: 'merged', mergedIntoCustomerId: 'c' });
    s.data.orders.push({ _id: 'source', ...basic, ...(kind === 'afterSale' ? { orderAttribute: 'rental2', status: 'shipped' } : {}), customerId: 'old', customerAliasId: 'a', recipientProfileId: 'p' });
    const id = await s.save(derived('source', kind)); await s.service.ingestOrder(id, actor);
    assert.equal(orderById(s, id).customerId, 'c', kind); assert.equal(orderById(s, id).recipientProfileId, '');
    assert.equal(orderById(s, id).customerLinkMethod, 'inherited'); assert.equal(orderById(s, id).customerLinkedBy, actor.id);
  }
});
test('所有衍生入口的来源缺失、名称/渠道冲突、停用客户和跨客户子引用均不继承', async () => {
  for (const kind of ['renewal', 'transfer', 'afterSale']) for (const problem of ['missing', 'name', 'channel', 'disabled', 'foreign']) {
    const s = setup();
    s.data.orders.push({ _id: 'source', ...basic, customerId: 'c', ...(kind === 'afterSale' ? { orderAttribute: 'rental2', status: 'shipped' } : {}) });
    const input = derived(problem === 'missing' ? 'missing' : 'source', kind);
    if (problem === 'name') input.customerName = '另一人';
    if (problem === 'channel') input.salesChannel = 'xXx';
    if (problem === 'disabled') s.data.customers[0].status = 'disabled';
    if (problem === 'foreign') { s.data.customer_aliases[0].customerId = 'other'; s.data.orders[0].customerAliasId = 'a'; }
    const id = await s.save(input); await s.service.ingestOrder(id, actor); assert.equal(orderById(s, id).customerId, '', `${kind}/${problem}`);
  }
});
test('匹配扫描之后新增冲突客户会变更全局版本，拒绝提交过期的唯一匹配', async () => {
  const s = setup(); const id = await s.save(); const original = s.db.startTransaction; let changed = false;
  s.db.startTransaction = async () => {
    if (!changed) {
      changed = true; s.db.startTransaction = original;
      await createWriter(createRepository(s.db))('create', { displayName: identity.customerName, requestId: 'concurrent-create' }, actor);
    }
    return original();
  };
  const result = await s.service.ingestOrder(id, actor); assert.equal(result.code, 'MATCH_CHANGED'); assert.equal(orderById(s, id).customerId, '');
});
test('saveOrders真实入口兼容旧客户端，拒绝伪造身份和引用，匹配失败仍返回保存成功', async () => {
  const s = setup({}, { failCollection: 'customers' }); const api = entry('saveOrders', s);
  const result = await api.main({ data: { orders: [basic], internal: true, userId: 'fake' } });
  assert.equal(result.success, true); assert.equal(s.data.orders[0].customerIngestActor, actor.id);
  const unauthenticated = await entry('saveOrders', setup(), null).main({ data: { orders: [basic], internal: true, userId: actor.id } });
  assert.equal(unauthenticated.success, false); assert.equal(unauthenticated.code, 'LOGIN_REQUIRED');
  const bad = await entry('saveOrders', setup()).main({ data: { orders: [{ ...basic, customerId: 'other', recipientProfileId: 'p' }] } });
  assert.equal(bad.savedCount, 0);
});
test('updateOrder真实入口全量旧表单及点路径不能改写关联和来源，普通快照可修改', async () => {
  const s = setup(); const id = await s.save({ ...basic, customerId: 'c' }); const before = { ...orderById(s, id) };
  const result = await entry('updateOrder', s).main({ data: { _id: id, updateData: { ...before, customerId: 'other', customerLinkedAt: 'spoof', customerLinkedBy: 'spoof', customerLinkStatus: 'ignored', customerIngestState: 'pending', renewalSourceOrderId: 'fake', 'customerId.x': 'fake', consigneeAddress: '本次新地址' } } });
  assert.equal(result.success, true);
  for (const field of ['customerId', 'customerLinkedAt', 'customerLinkedBy', 'customerLinkStatus', 'customerIngestState']) assert.equal(orderById(s, id)[field], before[field]);
  assert.equal(orderById(s, id).renewalSourceOrderId, undefined); assert.equal(orderById(s, id).consigneeAddress, '本次新地址');
});
const assistOrder = { sourceOrderNo: basic.onlineOrderNumber, sourceStatusCode: 'PENDING_SHIPMENT', recipient: identity.consignee,
  recipientPhone: identity.consigneePhone, recipientAddress: identity.consigneeAddress, orderPerson: identity.customerName,
  salesChannel: 'yuntu', responsiblePerson: 'XX', items: [{ sourceOrderItemNo: 'item1', brand: '苹果', productName: '手机', specification: '默认' }] };
test('Assist普通导入唯一匹配、追加保持原归属及时间，伪造token被拒绝', async () => {
  const s = setup(); const api = entry('importOrderFromAssist', s);
  const send = async payload => JSON.parse((await api.main({ apiToken: 'test-token', ...payload })).body);
  const created = await send({ order: assistOrder, operator: { uid: 'fake' } }); assert.equal(created.success, true, JSON.stringify(created));
  const before = { ...orderById(s, created.data.orderId) }; assert.equal(before.customerId, 'c'); assert.equal(before.customerLinkedBy, 'service:hc-order-assist');
  const appended = await send({ order: { ...assistOrder, customerId: 'other', items: [{ ...assistOrder.items[0], sourceOrderItemNo: 'item2' }] } });
  assert.equal(appended.success, true); assert.equal(s.data.orders.length, 1); assert.equal(s.data.orders[0].products.length, 2);
  assert.equal(s.data.orders[0].customerLinkedAt, before.customerLinkedAt); assert.equal(s.data.orders[0].customerId, 'c');
  assert.equal((await send({ apiToken: 'bad', order: assistOrder })).success, false);
});
test('Assist售后入口匹配异常仍成功建单并持久记录待处理', async () => {
  const s = setup({}, { failCollection: 'customers' });
  const result = JSON.parse((await entry('importOrderFromAssist', s).main({ apiToken: 'test-token', action: 'createAfterSaleOrder', order: { ...assistOrder, afterSaleRequestId: 'assist-after-sale', remark: '售后' } })).body);
  assert.equal(result.success, true, JSON.stringify(result)); assert.equal(s.data.orders[0].customerIngestState, 'pending');
});
test('manageAfterSaleOrders真实入口继承且重复请求不重复建单，临时收件不污染主档', async () => {
  const s = setup({ orders: [{ _id: 'source', ...basic, orderAttribute: 'rental2', status: 'shipped', customerId: 'c', recipientProfileId: 'p' }] });
  const api = entry('manageAfterSaleOrders', s);
  const payload = { data: { action: 'create', sourceOrderId: 'source', requestId: 'test-after-sale', products: basic.products,
    needsOutbound: true, consignee: identity.consignee, consigneePhone: identity.consigneePhone, consigneeAddress: '临时地址', shippingFee: 'cod' } };
  const result = await api.main(payload); assert.equal(result.success, true, JSON.stringify(result));
  const saved = orderById(s, result.orderId); assert.equal(saved.customerId, 'c'); assert.equal(saved.recipientProfileId, '');
  assert.equal(saved.customerLinkedBy, actor.id); assert.equal((await api.main(payload)).duplicated, true); assert.equal(s.data.orders.length, 2);
});
test('Assist续租真实入口从唯一来源继承；无来源/多来源保持pending且可保存', async () => {
  for (const scenario of ['unique', 'none', 'ambiguous', 'customer-failure']) {
    const source = { _id: 'source', ...basic, customerId: 'c' };
    const s = setup({ dict_items: [{ _id: 'pay', groupCode: 'payment_account', enabled: true, value: '测试账户', sort: 1 }],
      orders: scenario === 'none' ? [] : scenario === 'ambiguous' ? [source, { ...source, _id: 'source2' }] : [source] },
      scenario === 'customer-failure' ? { failCollection: 'customers' } : {});
    const result = JSON.parse((await entry('importOrderFromAssist', s).main({ apiToken: 'test-token', action: 'createRenewalOrder',
      order: { ...assistOrder, renewalRequestId: `renew-${scenario}`, paymentAccount: '测试账户', renewalAmount: 100 } })).body);
    assert.equal(result.success, true, JSON.stringify(result));
    const order = orderById(s, result.data.orderId);
    assert.equal(order.customerId, scenario === 'unique' ? 'c' : '', scenario);
    if (scenario === 'unique') { assert.equal(order.renewalSourceOrderId, 'source'); assert.equal(order.customerLinkedBy, 'service:hc-order-assist'); }
  }
});
test('saveOrders明确选择的审计失败会回滚未保存订单，批量其它有效订单仍成功', async () => {
  const s = setup({}, { failWriteCollection: 'customer_operation_audits' });
  const result = await entry('saveOrders', s).main({ data: { orders: [{ ...basic, customerId: 'c' }, { ...basic, customerName: '无匹配客户' }] } });
  assert.equal(result.savedCount, 1); assert.equal(result.failedCount, 1); assert.equal(s.data.orders.length, 1);
});
test('匹配提交时订单已被人工忽略则事务冲突，保留人工结果', async () => {
  let s, once = false;
  s = setup({}, { beforeCommit: async writes => {
    if (!once && writes.some(row => row.collection === 'orders' && row.data.customerLinkMethod === 'exact')) {
      once = true; const id = writes.find(row => row.collection === 'orders').id;
      await s.db.collection('orders').doc(id).update({ data: { customerLinkStatus: 'ignored', customerLinkIgnoreReason: '人工忽略' } });
    }
  } });
  const id = await s.save(); assert.equal((await s.service.ingestOrder(id, actor)).status, 'pending');
  assert.equal(orderById(s, id).customerLinkStatus, 'ignored'); assert.equal(s.data.customer_operation_audits, undefined);
});
