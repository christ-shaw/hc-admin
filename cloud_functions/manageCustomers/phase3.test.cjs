const test = require('node:test');
const assert = require('node:assert/strict');
const { database } = require('./test-support/database.cjs');
const { createRepository } = require('./repository');
const { createScanner } = require('./archiveScanner');
const { createResolver } = require('./archiveResolver');
const { createArchiveQueries } = require('./archiveQueries');
const { CANDIDATES, MEMBERS, TASKS, REQUESTS, digest } = require('./archiveCommon');
function fixture(n = 3, options) {
  const data = { customers: [{ _id: 'customer', displayName: '主客户', status: 'active' }], customer_aliases: [{ _id: 'alias', customerId: 'customer', name: '客户甲', enabled: true }], customer_recipient_profiles: [],
    orders: Array.from({ length: n }, (_, i) => ({ _id: `o${String(i).padStart(3, '0')}`, customerName: '客户甲', consignee: '张三', consigneePhone: '13800138000', consigneeAddress: '上海1号', orderAttribute: i % 2 ? 'rental2' : 'rental1', serialNumber: i + 1, date: '2026-09-01' })) };
  const memory = database(data, options), repo = createRepository(memory.db), actor = { id: 'operator' };
  return { data, ...memory, repo, scan: (p = {}) => createScanner(repo)(p, actor), resolve: p => createResolver(repo)(p, actor), list: p => createArchiveQueries(repo)(p, actor) };
}
async function scanned(f) { await f.scan({ dryRun: false, taskId: 'scan-test-1', limit: 100 }); return selection(f); }
async function selection(f) {
  const candidate = (await f.repo.fetchAll(CANDIDATES)).find(row => row.status === 'pending');
  const members = (await f.repo.fetchAll(MEMBERS)).filter(row => row.status === 'pending' && row.candidateId === candidate._id);
  return { candidate, members, plan: { requestId: 'archive-test-1', candidateId: candidate._id, evidenceVersion: candidate.evidenceVersion, members: members.map(row => ({ memberId: row._id, revision: row.revision })), mode: 'link', customerId: 'customer' } };
}
test('分批扫描更新组推荐后，早期成员可按当前组证据归档，过期页面仍被拒绝', async () => {
  for (const mode of ['link', 'create']) {
    const f = fixture(2);
    await f.scan({ dryRun: false, taskId: 'scan-test-1', limit: 1 });
    const earlier = await selection(f);
    await f.db.collection('customer_recipient_profiles').doc('profile').set({ data: {
      customerId: 'customer', consignee: '张三', phone: '13800138000', address: '上海1号', enabled: true,
    } });
    await f.scan({ dryRun: false, taskId: 'scan-test-1', limit: 1 });
    const current = await selection(f);
    assert.notEqual(current.candidate.evidenceVersion, earlier.candidate.evidenceVersion);
    assert.equal(current.members[0].evidenceVersion, earlier.candidate.evidenceVersion);
    const stale = await f.resolve({ ...earlier.plan, requestId: `stale-${mode}-request` });
    assert.equal(stale.data.results[0].code, 'ARCHIVE_EVIDENCE_CHANGED');
    const result = await f.resolve({ ...current.plan, mode, displayName: '新客户', requestId: `current-${mode}-request` });
    assert.deepEqual(result.data.results.map(row => row.status), ['accepted', 'accepted']);
    assert.equal(f.data[CANDIDATES][0].pendingCount, 0);
    assert.equal(f.data[MEMBERS][0].evidenceVersion, current.candidate.evidenceVersion);
    assert.equal(f.data.customers.length, mode === 'create' ? 2 : 1);
  }
});
test('dry-run 零写入、稳定游标最多100条，只扫描租赁未关联未忽略订单', async () => {
  const f = fixture(105); f.data.orders[0].customerId = 'customer'; f.data.orders[1].customerLinkStatus = 'ignored'; f.data.orders[2].orderAttribute = 'sales';
  const a = await f.scan({ limit: 999 });
  assert.equal(a.data.scanned, 100); assert.equal(a.data.skipped, 3); assert.equal(a.data.previews.length, 97);
  const b = await f.scan({ cursor: a.data.cursor, limit: 100 });
  assert.equal(b.data.scanned, 5); assert.equal(b.data.completed, true); assert.equal(f.writes.length, 0);
  assert.equal(JSON.stringify(a).includes('13800138000'), false);
});
test('扫描分批持久化游标、完成重试无新增；重复任务扫描候选和成员不重复', async () => {
  const f = fixture(5), original = JSON.stringify(f.data.orders);
  const a = await f.scan({ dryRun: false, taskId: 'scan-test-1', limit: 2 });
  assert.equal(a.data.cursor, 'o001'); assert.equal(a.data.scanned, 2);
  await f.scan({ dryRun: false, taskId: 'scan-test-1', limit: 100 });
  await f.scan({ dryRun: false, taskId: 'scan-test-1', limit: 100 });
  await f.scan({ dryRun: false, taskId: 'scan-test-2', limit: 100 });
  assert.equal(f.data[MEMBERS].length, 5); assert.equal(f.data[CANDIDATES].length, 1);
  assert.equal(f.data[CANDIDATES][0].orderCount, 5); assert.equal(f.data[CANDIDATES][0].pendingCount, 5);
  assert.equal('orderIds' in f.data[CANDIDATES][0], false); assert.equal(JSON.stringify(f.data.orders), original);
});
test('并发扫描同一任务不会重复计数或让游标回退', async () => {
  const f = fixture(3);
  await Promise.all([f.scan({ dryRun: false, taskId: 'scan-test-1' }), f.scan({ dryRun: false, taskId: 'scan-test-1' })]);
  assert.equal(f.data[TASKS][0].scanned, 3); assert.equal(f.data[CANDIDATES][0].pendingCount, 3); assert.equal(f.data[MEMBERS].length, 3);
});

test('新增扫描补齐旧游标前后的新订单，不重复扫描已有候选或改写订单', async () => {
  const f = fixture(4);
  await scanned(f);
  const oldMembers = JSON.parse(JSON.stringify(f.data[MEMBERS]));
  f.data.orders.push(
    { ...f.data.orders[0], _id: 'a-new-sep13', date: '2026-09-13' },
    { ...f.data.orders[0], _id: 'z-new-sep14', date: '2026-09-14' },
    { ...f.data.orders[0], _id: 'linked', customerId: 'customer' },
    { ...f.data.orders[0], _id: 'ignored', customerLinkStatus: 'ignored' },
    { ...f.data.orders[0], _id: 'sale', orderAttribute: 'sales' },
  );
  const originalOrders = JSON.stringify(f.data.orders);
  const first = await f.scan({ dryRun: false, scanMode: 'new', taskId: 'new-scan-1', limit: 1 });
  assert.equal(first.data.totalOrders, 2);
  assert.equal(first.data.cursor, 'a-new-sep13');
  assert.equal(first.data.status, 'running');
  const last = await f.scan({ dryRun: false, scanMode: 'new', taskId: 'new-scan-1', limit: 1 });
  assert.equal(last.data.status, 'completed');
  assert.equal(last.data.scanned, 2); assert.equal(last.data.eligible, 2);
  assert.equal(f.data[MEMBERS].length, 6);
  for (const row of oldMembers) assert.deepEqual(f.data[MEMBERS].find(item => item._id === row._id), row);
  assert.equal(JSON.stringify(f.data.orders), originalOrders);
  const writes = f.writes.length;
  await f.scan({ dryRun: false, scanMode: 'new', taskId: 'new-scan-1' });
  assert.equal(f.writes.length, writes);
  const empty = await f.scan({ dryRun: false, scanMode: 'new', taskId: 'new-scan-2' });
  assert.equal(empty.data.totalOrders, 0); assert.equal(empty.data.status, 'completed');
  assert.equal(f.data[MEMBERS].length, 6);
});

test('新增扫描只读取历史订单必要字段，不处理任何已有成员状态', async () => {
  const { memberId } = require('./archiveCommon');
  const f = fixture(104);
  f.data[MEMBERS] = f.data.orders.slice(0, 103).map((row, index) => ({
    _id: memberId(row._id), orderId: row._id, status: ['pending', 'accepted', 'ignored', 'stale'][index % 4],
  }));
  const result = await f.scan({ dryRun: false, scanMode: 'new', taskId: 'new-paged-scan' });
  assert.equal(result.data.scanned, 1); assert.equal(result.data.eligible, 1);
  assert.ok(f.reads.filter(row => row.collection === 'orders' && row.field).length >= 2);
  assert.equal(f.reads.filter(row => row.collection === 'orders' && row.id && row.id !== 'o103').length, 0);
  assert.equal(f.writes.filter(row => row.collection === MEMBERS).length, 1);
});

test('新增扫描中断后继续原清单，订单删除或其他扫描抢先生成候选时安全跳过', async () => {
  const f = fixture(4);
  const first = await f.scan({ dryRun: false, scanMode: 'new', taskId: 'new-race-scan', limit: 1 });
  assert.equal(first.data.scanned, 1);
  f.data.orders.splice(1, 1);
  f.data.orders.find(row => row._id === 'o002').customerId = 'customer';
  await f.scan({ dryRun: false, taskId: 'full-other-scan', limit: 100 });
  const existing = JSON.stringify(f.data[MEMBERS]);
  const result = await f.scan({ dryRun: false, scanMode: 'new', taskId: 'new-race-scan', limit: 100 });
  assert.equal(result.data.status, 'completed'); assert.equal(result.data.scanned, 4);
  assert.equal(result.data.eligible, 1); assert.equal(result.data.skipped, 3);
  assert.equal(JSON.stringify(f.data[MEMBERS]), existing);
});

test('新增扫描写入中断后原任务重试，不遗漏或重复计数', async () => {
  let fail = true;
  const f = fixture(3, { beforeCommit(writes) {
    if (fail && writes.some(row => row.collection === MEMBERS && row.data.orderId === 'o001')) throw new Error('interrupted');
  } });
  const failed = await f.scan({ dryRun: false, scanMode: 'new', taskId: 'new-retry-scan' });
  assert.equal(failed.data.status, 'failed'); assert.equal(failed.data.scanned, 1);
  fail = false;
  const done = await f.scan({ dryRun: false, scanMode: 'new', taskId: 'new-retry-scan' });
  assert.equal(done.data.status, 'completed'); assert.equal(done.data.eligible, 3);
  assert.equal(f.data[MEMBERS].length, 3); assert.equal(f.data[CANDIDATES][0].pendingCount, 3);
});

test('新增扫描并发幂等，旧任务不能改成新增扫描，读取失败不误报无新增', async () => {
  const f = fixture(3);
  await Promise.all([f.scan({ dryRun: false, scanMode: 'new', taskId: 'new-scan-same' }), f.scan({ dryRun: false, scanMode: 'new', taskId: 'new-scan-same' })]);
  assert.equal(f.data[TASKS][0].scanned, 3); assert.equal(f.data[MEMBERS].length, 3);
  assert.equal(f.data[CANDIDATES][0].pendingCount, 3);
  await assert.rejects(f.scan({ dryRun: false, taskId: 'new-scan-same' }), { code: 'SCAN_MODE_CHANGED' });
  await assert.rejects(f.scan({ scanMode: 'new' }), { code: 'INVALID_SCAN_MODE' });
  for (const collection of ['orders', MEMBERS]) {
    const bad = fixture(1, { failCollection: collection });
    await assert.rejects(bad.scan({ dryRun: false, scanMode: 'new', taskId: 'new-failed-plan' }));
    assert.equal(bad.writes.length, 0);
  }
});

test('超过500条新增订单分批计划，下批从头核对仍补齐小编号新订单', async () => {
  const { findNewOrders } = require('./newOrderScan');
  const { memberId } = require('./archiveCommon');
  const f = fixture(502);
  const first = await findNewOrders(f.repo);
  assert.equal(first.orderIds.length, 500); assert.equal(first.hasMoreNewOrders, true);
  f.data[MEMBERS] = first.orderIds.map(orderId => ({ _id: memberId(orderId), orderId, status: 'pending' }));
  f.data.orders.push({ ...f.data.orders[0], _id: 'a-late-import', date: '2026-08-01' });
  const next = await findNewOrders(f.repo);
  assert.deepEqual(next.orderIds, ['a-late-import', 'o500', 'o501']);
  assert.equal(next.hasMoreNewOrders, false);
});
test('同组部分订单可归到不同客户；确认保留全部订单身份快照', async () => {
  const f = fixture(3), before = JSON.parse(JSON.stringify(f.data.orders));
  const { plan } = await scanned(f);
  const result = await f.resolve({ ...plan, members: plan.members.slice(0, 1) });
  assert.equal(result.data.results[0].status, 'accepted'); assert.equal(f.data[CANDIDATES][0].pendingCount, 2);
  const second = await selection(f);
  await f.resolve({ ...second.plan, mode: 'create', displayName: '新客户', requestId: 'archive-test-2' });
  assert.equal(f.data.customers.length, 2);
  assert.equal(new Set(f.data.orders.map(row => row.customerId)).size, 2);
  for (let i = 0; i < before.length; i++) for (const key of Object.keys(before[i])) assert.deepEqual(f.data.orders[i][key], before[i][key]);
});
test('超过十条按批推进，重试仅处理剩余订单且新客户/初始别名只建一套', async () => {
  const f = fixture(13), { plan } = await scanned(f);
  const input = { ...plan, mode: 'create', displayName: '新客户', newAlias: { name: '客户甲' }, newRecipient: { consignee: '张三', phone: '13800138000', address: '上海1号' } };
  const first = await f.resolve(input); assert.equal(first.data.next, 10); assert.equal(first.data.status, 'running');
  const done = await f.resolve({ requestId: input.requestId, resume: true }); assert.equal(done.data.next, 13); assert.equal(done.data.status, 'completed');
  assert.deepEqual((await f.resolve(input)).data, done.data);
  assert.equal(f.data.customers.length, 2); assert.equal(f.data.customer_aliases.length, 3); assert.equal(f.data.customer_recipient_profiles.length, 1);
  assert.equal(f.data[CANDIDATES][0].pendingCount, 0);
});
test('订单变更、已被关联或成员版本不符记录冲突，不创建孤立客户', async () => {
  const f = fixture(3), { plan, members } = await scanned(f);
  await f.db.collection('orders').doc(members[0].orderId).update({ data: { consigneePhone: '13900139000' } });
  await f.db.collection('orders').doc(members[1].orderId).update({ data: { customerId: 'elsewhere' } });
  const input = { ...plan, mode: 'create', displayName: '不应创建', members: plan.members.map((row, i) => i === 2 ? { ...row, revision: row.revision + 1 } : row) };
  const result = await f.resolve(input);
  assert.equal(result.data.results.every(row => row.status === 'conflict'), true); assert.equal(f.data.customers.length, 1);
  assert.equal(f.data[MEMBERS].every(row => row.status === 'pending'), true);
});
test('重复确认/并发确认不会覆盖先前处理结果，同请求不同载荷明确拒绝', async () => {
  const f = fixture(1), { plan } = await scanned(f);
  const [a, b] = await Promise.all([f.resolve(plan), f.resolve(plan)]); assert.deepEqual(a.data, b.data);
  const other = await f.resolve({ ...plan, requestId: 'archive-test-2', mode: 'ignore', reason: '不同处理' });
  assert.equal(other.data.results[0].status, 'conflict'); assert.equal(f.data.orders[0].customerLinkStatus, 'linked');
  await assert.rejects(f.resolve({ ...plan, customerId: 'different' }), { code: 'IDEMPOTENCY_KEY_REUSED' });
});
test('拒绝推荐保留证据版本且重扫不复活；忽略需原因并持久化订单状态', async () => {
  const f = fixture(2), { plan } = await scanned(f);
  await assert.rejects(f.resolve({ ...plan, mode: 'ignore' }), { code: 'ARCHIVE_REASON_REQUIRED' });
  await f.resolve({ ...plan, mode: 'reject', members: plan.members.slice(0, 1), reason: '同名不是此人' });
  await f.scan({ dryRun: false, taskId: 'scan-test-2' });
  const member = f.data[MEMBERS].find(row => row._id === plan.members[0].memberId);
  assert.deepEqual(member.rejectedCustomerIds, ['customer']); assert.equal(member.status, 'pending');
  const second = await selection(f);
  await f.resolve({ ...second.plan, mode: 'ignore', reason: '无法确认', requestId: 'archive-test-2' });
  await f.scan({ dryRun: false, taskId: 'scan-test-3' });
  assert.equal(f.data.orders.every(row => row.customerLinkStatus === 'ignored'), true);
  assert.equal(f.data[MEMBERS].every(row => row.status === 'ignored'), true);
  assert.equal(f.data[CANDIDATES][0].pendingCount, 0);
});
test('身份改变会移动候选成员并调整两组计数；新证据不继承旧推荐拒绝', async () => {
  const f = fixture(1), { plan } = await scanned(f);
  await f.resolve({ ...plan, mode: 'reject', reason: '不接受' });
  await f.db.collection('orders').doc('o000').update({ data: { customerName: '另一名字' } });
  await f.scan({ dryRun: false, taskId: 'scan-test-2' });
  assert.equal(f.data[MEMBERS].length, 1); assert.equal(f.data[CANDIDATES].length, 2);
  assert.equal(f.data[CANDIDATES].reduce((n, row) => n + row.pendingCount, 0), 1);
  assert.deepEqual(f.data[MEMBERS][0].rejectedCustomerIds, []);
  assert.ok(f.data.customer_operation_audits.find(row => row.action === 'archive_reject').evidenceVersion);
});
test('已有客户新增同名别名/同收货档案会复用，不重复创建', async () => {
  const f = fixture(2), { plan } = await scanned(f);
  await f.resolve({ ...plan, newAlias: { name: '客户甲' }, newRecipient: { consignee: '张三', phone: '13800138000', address: '上海1号' } });
  assert.equal(f.data.customer_aliases.length, 1); assert.equal(f.data.customer_recipient_profiles.length, 1);
  assert.equal(f.data.orders.every(row => row.customerAliasId === 'alias'), true);
});
test('归档查询分页、处理请求仅对操作人可见，未知视图拒绝', async () => {
  const f = fixture(13), { plan } = await scanned(f);
  const list = await f.list({ view: 'members', candidateId: plan.candidateId, pageSize: 5, page: 2 }); assert.equal(list.data.length, 5); assert.equal(list.total, 13);
  await f.resolve(plan);
  const requests = await f.list({ view: 'requests' }); assert.equal(requests.data.length, 1); assert.equal('plan' in requests.data[0], false);
  const other = await createArchiveQueries(f.repo)({ view: 'requests' }, { id: 'other' }); assert.equal(other.total, 0);
  await assert.rejects(f.list({ view: 'unknown' }), { code: 'INVALID_ARCHIVE_VIEW' });
});

test('扫描中断时保存错误及上一游标，恢复后不丢订单不重复计数', async () => {
  let fail = true;
  const f = fixture(3, { beforeCommit(writes) {
    if (fail && writes.some(row => row.collection === MEMBERS && row.data.orderId === 'o001')) throw new Error('injected interruption');
  } });
  const first = await f.scan({ dryRun: false, taskId: 'scan-test-1' });
  assert.equal(first.data.status, 'failed'); assert.equal(first.data.cursor, 'o000'); assert.equal(first.data.errorCount, 1);
  assert.equal(f.data[MEMBERS].length, 1); fail = false;
  const second = await f.scan({ dryRun: false, taskId: 'scan-test-1' });
  assert.equal(second.data.status, 'completed'); assert.equal(second.data.scanned, 3); assert.equal(f.data[CANDIDATES][0].pendingCount, 3);
});
test('归档事务失败连同新客户和订单全部回滚；恢复请求后只补未完成部分', async () => {
  let fail = false;
  const f = fixture(12, { beforeCommit(writes) {
    if (fail && writes.some(row => row.collection === 'orders')) throw new Error('injected archive failure');
  } });
  const { plan } = await scanned(f);
  fail = true;
  await assert.rejects(f.resolve({ ...plan, mode: 'create', displayName: '新客户' }));
  assert.equal(f.data.customers.length, 1); assert.equal(f.data.orders.some(row => row.customerId), false);
  assert.equal(f.data[REQUESTS][0].next, 0);
  fail = false; const first = await f.resolve({ requestId: plan.requestId, resume: true }); assert.equal(first.data.next, 10);
  fail = true; await assert.rejects(f.resolve({ requestId: plan.requestId, resume: true })); assert.equal(f.data[REQUESTS][0].next, 10);
  fail = false; const done = await f.resolve({ requestId: plan.requestId, resume: true }); assert.equal(done.data.next, 12); assert.equal(f.data.customers.length, 2);
});
test('读取异常不能视为空扫描，订单查询失败记录到任务状态', async () => {
  const f = fixture(1, { failCollection: 'orders' });
  const result = await f.scan({ dryRun: false, taskId: 'scan-test-1' });
  assert.equal(result.data.status, 'failed'); assert.equal(result.data.scanned, 0); assert.equal(result.data.errorCount, 1);
  await assert.rejects(f.scan({ dryRun: true }));
});
test('候选证据版本已变化时旧确认不能继续；停用/跨客户资料不能被引用', async () => {
  const f = fixture(1), { plan } = await scanned(f);
  await f.db.collection(CANDIDATES).doc(plan.candidateId).update({ data: { evidenceVersion: 'new-version' } });
  const result = await f.resolve(plan); assert.equal(result.data.results[0].code, 'ARCHIVE_EVIDENCE_CHANGED');
  await f.scan({ dryRun: false, taskId: 'scan-test-2' });
  const next = await selection(f);
  await f.db.collection('customers').doc('customer').update({ data: { status: 'disabled', writeRevision: 1 } });
  assert.equal((await f.resolve({ ...next.plan, requestId: 'archive-test-2' })).data.results[0].code, 'CUSTOMER_UNAVAILABLE');
  assert.equal(f.data.orders[0].customerId, undefined);
});

test('跨客户引用在建别名/档案前失败，记录冲突也不会提交部分资料写入', async () => {
  const f = fixture(1), { plan } = await scanned(f);
  f.data.customers.push({ _id: 'other', displayName: '其它客户', status: 'active' });
  f.data.customer_aliases.push({ _id: 'foreign', customerId: 'other', name: '别名', enabled: true });
  const before = JSON.stringify(f.data.customers);
  const result = await f.resolve({ ...plan, customerAliasId: 'foreign', newRecipient: { consignee: '张三', phone: '13800138000', address: '上海1号' } });
  assert.equal(result.data.results[0].code, 'CUSTOMER_REFERENCE_MISMATCH');
  assert.equal(JSON.stringify(f.data.customers), before); assert.equal(f.data.customer_recipient_profiles.length, 0);
  assert.equal(f.data.orders[0].customerId, undefined);
});

test('扫描保存匹配快照版本，同批共享资料读取；后续客户写入使其失效', async () => {
  const { conditionalMatch } = require('./versionedMatcher');
  const f = fixture(3);
  const { candidate } = await scanned(f);
  assert.equal(candidate.identityRevision, 0);
  assert.equal(f.reads.filter(row => row.collection === 'customers' && !row.id).length, 1);
  assert.equal((await conditionalMatch(f.repo, { knownIdentityRevision: candidate.identityRevision, knownNormalizationVersion: candidate.normalizationVersion })).unchanged, true);
  const { createWriter } = require('./writer');
  await createWriter(f.repo)('create', { requestId: 'revision-create-test', displayName: '新客户' }, { id: 'writer' });
  assert.equal((await conditionalMatch(f.repo, { knownIdentityRevision: candidate.identityRevision, knownNormalizationVersion: candidate.normalizationVersion })).unchanged, undefined);
});
test('匹配资料读取期间版本变化会重读，持续变化时报错，不将旧数据标成新版本', async () => {
  const { identitySnapshot, conditionalMatch } = require('./versionedMatcher');
  const f = fixture(1); let count = 0;
  const wrapped = { ...f.repo, fetchAll: async name => {
    const rows = await f.repo.fetchAll(name);
    if (name === 'customers' && count++ === 0) {
      f.data.system_config = [{ _id: 'customer_identity_revision', revision: 1 }];
      f.data.customers.push({ _id: 'later', displayName: '新增客户', status: 'active' });
    }
    return rows;
  } };
  const result = await conditionalMatch(wrapped, { identity: { customerName: '新增客户' } });
  assert.equal(count, 2); assert.equal(result.identityRevision, 1); assert.equal(result.candidates[0].customerId, 'later');
  let revision = 0;
  await assert.rejects(identitySnapshot({ ...f.repo, getDocById: async () => ({ revision: revision++ }) }), /客户资料正在变化/);
});
