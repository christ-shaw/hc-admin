const test = require('node:test');
const assert = require('node:assert/strict');
const { database } = require('./test-support/database.cjs');
const { createRepository } = require('./repository');
const { matchIdentity } = require('./matcher');
const { resolveCustomer, validateCustomerReferences } = require('./cluster');
const { createWriter } = require('./writer');
const identity = { customerName: '客户甲', consignee: '张三', phone: '13800138000', address: '上海市1-203室' };
const customer = (id, name = '客户甲') => ({ _id: id, displayName: name, status: 'active' });
const profile = (id, owner, patch = {}) => ({ _id: id, customerId: owner, ...identity, enabled: true, ...patch });
function setup(data, options) {
  const memory = database({ customer_aliases: [], customer_recipient_profiles: [], ...data }, options);
  const repository = createRepository(memory.db);
  return { ...memory, repository, write: (action, payload, actor = 'actor') => createWriter(repository)(action, payload, { id: actor }) };
}
test('唯一精确名称和同一完整档案返回可解释结果，不读取或修改订单', async () => {
  const service = setup({ customers: [customer('c')], customer_recipient_profiles: [profile('p', 'c')] });
  const result = await matchIdentity(service.repository, identity);
  assert.equal(result.status, 'exact'); assert.equal(result.customerId, 'c');
  assert.equal(result.candidates[0].score, 100); assert.equal(result.candidates[0].evidence.length, 4);
  assert.equal(service.writes.length, 0); assert.equal(service.reads.some(row => row.collection === 'orders'), false);
  assert.equal(JSON.stringify(result).includes(identity.phone), false);
});
test('同名、共享电话地址、不完整观察、停用资料、不同房号均不自动关联', async () => {
  for (const [profiles, observed] of [
    [[], identity],
    [[profile('p', 'c')], { ...identity, customerName: '陌生人' }],
    [[profile('p', 'c')], { ...identity, phone: '138****8000' }],
    [[profile('p', 'c')], { ...identity, consignee: '' }],
    [[profile('p', 'c')], { ...identity, address: '上海市1203室' }],
    [[profile('p', 'c', { enabled: false })], identity],
    [[profile('p', 'c', { phone: 'x13800138000' })], identity],
  ]) {
    const service = setup({ customers: [customer('c')], customer_recipient_profiles: profiles });
    assert.equal((await matchIdentity(service.repository, observed)).autoLinkEligible, false);
  }
});
test('不能跨收货档案拼凑证据，排序分值取单份档案最高分', async () => {
  const service = setup({ customers: [customer('c')], customer_recipient_profiles: [
    profile('p1', 'c', { address: '其它地址' }), profile('p2', 'c', { phone: '13900139000' }),
  ] });
  const result = await matchIdentity(service.repository, identity);
  assert.equal(result.autoLinkEligible, false); assert.equal(result.candidates[0].score, 80);
});
test('启用别名可精确匹配，停用别名不能参与；两个最终客户匹配必须人工确认', async () => {
  const service = setup({ customers: [customer('c', '主名'), customer('d')], customer_aliases: [{ _id: 'a', customerId: 'c', name: identity.customerName, enabled: true }], customer_recipient_profiles: [profile('p', 'c'), profile('q', 'd')] });
  const ambiguous = await matchIdentity(service.repository, identity);
  assert.equal(ambiguous.status, 'ambiguous'); assert.equal(ambiguous.customerId, null);
  await service.db.collection('customer_aliases').doc('a').update({ data: { enabled: false } });
  const unique = await matchIdentity(service.repository, identity);
  assert.equal(unique.customerId, 'd');
});
test('合并链归到最终客户去重，禁用目标、缺失目标、循环明确失败', async () => {
  const rows = [customer('c'), { ...customer('b'), status: 'merged', mergedIntoCustomerId: 'c' }, { ...customer('a'), status: 'merged', mergedIntoCustomerId: 'b' }];
  const service = setup({ customers: rows, customer_recipient_profiles: [profile('p', 'a'), profile('q', 'c')] });
  assert.equal((await matchIdentity(service.repository, identity)).customerId, 'c');
  const get = async id => rows.find(row => row._id === id);
  rows[0].status = 'disabled';
  await assert.rejects(resolveCustomer('a', get), { code: 'CUSTOMER_UNAVAILABLE' });
  rows[0].status = 'merged'; rows[0].mergedIntoCustomerId = 'a';
  await assert.rejects(resolveCustomer('a', get), { code: 'CUSTOMER_MERGE_CYCLE' });
  assert.equal((await matchIdentity(service.repository, identity)).status, 'invalid_cluster');
  rows[0].mergedIntoCustomerId = 'missing';
  await assert.rejects(resolveCustomer('a', get), { code: 'CUSTOMER_NOT_FOUND' });
  rows[0].mergedIntoCustomerId = '';
  await assert.rejects(resolveCustomer('a', get), { code: 'CUSTOMER_MERGE_TARGET_INVALID' });
});
test('引用校验接受有效簇中的启用记录，拒绝跨客户和停用、缺失引用', async () => {
  const service = setup({ customers: [customer('c'), customer('d'), { ...customer('a'), status: 'merged', mergedIntoCustomerId: 'c' }], customer_aliases: [{ _id: 'alias', customerId: 'a', enabled: true }, { _id: 'off', customerId: 'c', enabled: false }], customer_recipient_profiles: [profile('p', 'd')] });
  assert.deepEqual(await validateCustomerReferences(service.repository, { customerId: 'a', customerAliasId: 'alias' }), { customerId: 'c', customerAliasId: 'alias' });
  for (const ref of [{ recipientProfileId: 'p' }, { customerAliasId: 'off' }, { customerAliasId: 'missing' }]) await assert.rejects(validateCustomerReferences(service.repository, { customerId: 'c', ...ref }));
  await assert.rejects(validateCustomerReferences(service.repository, { customerAliasId: 'alias' }), { code: 'CUSTOMER_REQUIRED' });
});
test('创建客户/初始别名/审计/幂等记录原子提交，任一写入失败全部回滚', async () => {
  for (const collection of ['customer_aliases', 'customer_operation_audits', 'customer_write_requests']) {
    const service = setup({ customers: [] }, { failWriteCollection: collection });
    await assert.rejects(service.write('create', { requestId: 'request-1', displayName: '客户甲' }));
    assert.equal(service.writes.length, 0);
    assert.equal((await service.repository.fetchAll('customers')).length, 0);
  }
});
test('重复提交和并发同请求只建一套资料，同名不同请求仍允许不同客户', async () => {
  const service = setup({ customers: [] });
  const payload = { requestId: 'request-1', displayName: '客户甲', createdBy: 'forged' };
  const [a, b] = await Promise.all([service.write('create', payload), service.write('create', payload)]);
  assert.deepEqual(a, b); assert.deepEqual(await service.write('create', payload), a);
  assert.equal((await service.repository.fetchAll('customers')).length, 1);
  const audit = (await service.repository.fetchAll('customer_operation_audits'))[0];
  assert.equal(audit.actorId, 'actor'); assert.equal(JSON.stringify(audit).includes('客户甲'), false);
  await assert.rejects(service.write('create', { ...payload, displayName: '另一客户' }), { code: 'IDEMPOTENCY_KEY_REUSED' });
  await service.write('create', { ...payload, requestId: 'request-2' });
  assert.equal((await service.repository.fetchAll('customers')).length, 2);
});
test('提交成功后响应丢失，以原请求重试返回原结果且不重复写入', async () => {
  const service = setup({ customers: [] }, { loseCommitReply: true });
  const payload = { requestId: 'request-1', displayName: '客户甲' };
  await assert.rejects(service.write('create', payload));
  const result = await service.write('create', payload);
  assert.equal(result.success, true); assert.equal((await service.repository.fetchAll('customers')).length, 1);
  assert.equal((await service.repository.fetchAll('customer_aliases')).length, 1);
});
test('同客户相同标准化别名与渠道的并发新增只成功一次；其他渠道独立', async () => {
  const service = setup({ customers: [customer('c')] });
  const payload = { customerId: 'c', name: 'Ａ—Ｂ', salesChannel: '平台' };
  const results = await Promise.allSettled([service.write('createAlias', { ...payload, requestId: 'request-1' }), service.write('createAlias', { ...payload, name: 'a b', requestId: 'request-2' })]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.find(row => row.status === 'rejected').reason.code, 'DUPLICATE_ALIAS');
  await service.write('createAlias', { ...payload, salesChannel: '其它平台', requestId: 'request-3' });
  assert.equal((await service.repository.fetchAll('customer_aliases')).length, 2);
});
test('并发别名改名和新增同名也执行去重，旧标准化字段不影响判定', async () => {
  const service = setup({ customers: [customer('c')], customer_aliases: [{ _id: 'a', customerId: 'c', name: '旧名', normalizedName: 'wrong', enabled: true }] });
  const results = await Promise.allSettled([
    service.write('updateAlias', { aliasId: 'a', name: '新名', requestId: 'request-1' }),
    service.write('createAlias', { customerId: 'c', name: '新名', requestId: 'request-2' }),
  ]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal((await service.repository.fetchAll('customer_aliases')).filter(row => row.name === '新名').length, 1);
});
test('写入必须有请求 ID，不能维护停用/合并客户的子资料，不修改订单', async () => {
  const service = setup({ customers: [{ ...customer('c'), status: 'disabled' }], orders: [{ _id: 'o', customerName: '历史快照' }] });
  await assert.rejects(service.write('create', { displayName: '新客户' }), { code: 'REQUEST_ID_REQUIRED' });
  await assert.rejects(service.write('createRecipient', { customerId: 'c', ...identity, requestId: 'request-1' }), { code: 'CUSTOMER_UNAVAILABLE' });
  assert.equal(service.writes.length, 0);
});
