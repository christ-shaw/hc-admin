const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { database } = require('../cloud_functions/manageCustomers/test-support/database.cjs');
const { createRepository } = require('../cloud_functions/manageCustomers/repository');
const { createScanner } = require('../cloud_functions/manageCustomers/archiveScanner');
const { createResolver } = require('../cloud_functions/manageCustomers/archiveResolver');
function transpile(file, requireModule, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve(file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { module, exports: module.exports, require: requireModule, ...globals });
  return module.exports;
}
function client(handler) {
  const storage = new Map();
  const requests = transpile('../src/utils/customerWriteRequest.ts', () => {}, { crypto: require('node:crypto').webcrypto, TextEncoder,
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  });
  const api = transpile('../src/hooks/useCustomerArchive.ts', name => name === '../lib/cloudbase' ? { callFunction: handler } : requests);
  return { ...api, storage };
}
test('前端分批调用真实归档服务：响应丢失后重试原请求，不重复建档', async () => {
  const data = { customers: [], customer_aliases: [], customer_recipient_profiles: [], orders: Array.from({ length: 12 }, (_, i) => ({ _id: `o${String(i).padStart(2,'0')}`, customerName: '测试客户', consignee: '测试人', consigneePhone: '13800138000', consigneeAddress: '测试地址', orderAttribute: 'rental1' })) };
  const { db } = database(data), repo = createRepository(db), actor = { id: 'server-actor' };
  await createScanner(repo)({ dryRun: false, taskId: 'scan-test-1' }, actor);
  const group = data.customer_link_candidates[0], members = data.customer_link_candidate_members;
  let loseReply = true; const calls = [];
  const api = client(async (name, payload) => {
    assert.equal(name, 'manageCustomers'); assert.equal(payload.action, 'resolveLinkCandidate'); calls.push(payload);
    const result = await createResolver(repo)(payload, actor);
    if (payload.resume && loseReply) { loseReply = false; throw new Error('lost reply'); }
    return result;
  });
  const options = { mode: 'create', displayName: '测试客户', candidateId: group._id, evidenceVersion: group.evidenceVersion, members: members.map(row => ({ memberId: row._id, revision: row.revision })) };
  const progress = [];
  await assert.rejects(api.resolveArchive(options, row => progress.push(row.next)), /lost reply/);
  assert.equal(api.storage.size, 1); assert.deepEqual(progress, [10]);
  const completed = await api.resolveArchive(options, row => progress.push(row.next));
  assert.equal(completed.status, 'completed'); assert.equal(completed.total, 12); assert.equal(data.customers.length, 1);
  assert.equal(data.customer_aliases.length, 1); assert.equal(api.storage.size, 0);
  assert.equal(calls[0].requestId, calls[2].requestId);
  assert.deepEqual(Object.keys(calls[1]).sort(), ['action', 'requestId', 'resume']);
});
test('前端扫描必须显式传递 dryRun，服务器错误抛出，列表按查询模式分页', async () => {
  const calls = [];
  const api = client(async (_, payload) => { calls.push(payload); return { success: false, errMsg: '无权访问' }; });
  await assert.rejects(api.scanArchive({ dryRun: true }), /无权访问/);
  await assert.rejects(api.listArchive({ view: 'members', candidateId: 'group', page: 2 }), /无权访问/);
  assert.equal(calls[0].dryRun, true); assert.equal(calls[0].limit, 20);
  assert.equal(calls[1].view, 'members'); assert.equal(calls[1].page, 2);
});

test('新增扫描使用独立接口并保留任务模式，旧服务不可悄悄退回全量扫描', async () => {
  const data = { orders: Array.from({ length: 25 }, (_, i) => ({
    _id: `new-${String(i).padStart(3, '0')}`, customerName: '新增客户', orderAttribute: 'rental1',
  })) };
  const { db } = database(data), scan = createScanner(createRepository(db));
  const calls = [];
  const api = client(async (_, payload) => {
    calls.push(payload);
    assert.equal(payload.action, 'scanNewOrders');
    return scan(payload, { id: 'operator' });
  });
  const result = await api.scanArchive({ dryRun: false, scanMode: 'new', taskId: 'new-ui-task' });
  assert.equal(result.status, 'completed'); assert.equal(result.scanned, 25);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(row => row.taskId === 'new-ui-task' && row.scanMode === 'new'));
  const old = client(async () => ({ success: false, errMsg: '不支持此操作或查询模式' }));
  await assert.rejects(old.scanArchive({ dryRun: false, scanMode: 'new', taskId: 'old-api-task' }), /不支持/);
});
const quick = transpile('../src/utils/quickCustomerArchive.ts', () => {});
const plain = value => JSON.parse(JSON.stringify(value));
test('快速归档跨页全选只返回同组待处理订单，超过100条或范围漂移时失败', async () => {
  const members = Array.from({ length: 41 }, (_, i) => ({ _id: `m${i}`, candidateId: 'g', status: 'pending' }));
  const calls = [];
  const all = await quick.loadAllPendingMembers('g', async page => { calls.push(page); return { total: 41, data: members.slice((page - 1) * 20, page * 20) }; });
  assert.equal(all.length, 41); assert.deepEqual(calls, [1, 2, 3]);
  await assert.rejects(quick.loadAllPendingMembers('g', async () => ({ total: 101, data: [] })), /超过 100/);
  await assert.rejects(quick.loadAllPendingMembers('g', async page => ({ total: page === 1 ? 41 : 40, data: members.slice((page - 1) * 20, page * 20) })), /范围已变化/);
  await assert.rejects(quick.loadAllPendingMembers('g', async () => ({ total: 2, data: [members[0], members[0]] })), /范围已变化/);
  await assert.rejects(quick.loadAllPendingMembers('g', async () => ({ total: 1, data: [{ ...members[0], status: 'accepted' }] })), /范围已变化/);
});
test('快速建档仅默认保存完整有效的收货资料，原下单名独立保留', () => {
  const recipient = { customerName: '旧下单名', consignee: '测试人', phone: '+86 138-0013-8000', address: '测试地址' };
  assert.equal(quick.completeArchiveRecipient(recipient), true);
  for (const phone of ['', '138****8000', 'x13800138000', '123']) assert.equal(quick.completeArchiveRecipient({ ...recipient, phone }), false);
  const payload = quick.quickArchiveInput({ _id: 'g', evidenceVersion: 'v', observedIdentity: recipient }, [{ _id: 'm', revision: 2 }], ' 新名称 ', true, false, recipient);
  assert.equal(payload.displayName, '新名称'); assert.equal(payload.newAlias.name, '旧下单名'); assert.equal(payload.newRecipient, undefined);
  assert.deepEqual(plain(payload.members), [{ memberId: 'm', revision: 2 }]);
});
test('重复检查合并主名及旧别名的证据，按最终客户去重，异常合并链不视为无重复', () => {
  const candidate = (customerId, score, reasons) => ({ customerId, score, reasons });
  const rows = quick.duplicateCandidates([
    { status: 'no_match', candidates: [candidate('c', 40, ['name_exact'])] },
    { status: 'incomplete', candidates: [candidate('c', 60, ['phone_exact', 'address_exact']), candidate('d', 10, ['consignee_exact'])] },
  ]);
  assert.equal(rows.length, 2); assert.equal(rows[0].customerId, 'c'); assert.equal(rows[0].score, 60);
  assert.deepEqual(plain(rows[0].reasons), ['address_exact', 'name_exact', 'phone_exact']);
  assert.throws(() => quick.duplicateCandidates([{ status: 'invalid_cluster', candidates: [] }]), /合并资料异常/);
});
test('快速建档使用现有服务：仅关联选中订单，同名初始别名复用，重复请求不重复建档', async () => {
  const identity = { customerName: '快建客户', consignee: '测试人', phone: '13800138000', address: '测试地址' };
  const data = { customers: [], customer_aliases: [], customer_recipient_profiles: [], orders: ['o1', 'o2'].map(_id => ({ _id, ...identity, consigneePhone: identity.phone, consigneeAddress: identity.address, orderAttribute: 'rental1' })) };
  const { db } = database(data), repo = createRepository(db), actor = { id: 'actor' };
  await createScanner(repo)({ dryRun: false, taskId: 'quick-scan' }, actor);
  const group = data.customer_link_candidates[0], selected = data.customer_link_candidate_members.slice(0, 1);
  const input = quick.quickArchiveInput(group, selected, identity.customerName, true, true, identity);
  const resolve = createResolver(repo);
  const result = await resolve({ ...input, requestId: 'quick-create-test' }, actor);
  assert.equal(result.data.status, 'completed'); assert.equal(data.customers.length, 1);
  assert.equal(data.customer_aliases.length, 1); assert.equal(data.customer_recipient_profiles.length, 1);
  assert.equal(data.orders.filter(row => row.customerId).length, 1);
  assert.equal(data.orders[0].customerName, identity.customerName);
  await resolve({ ...input, requestId: 'quick-create-test' }, actor); assert.equal(data.customers.length, 1);
});

const bulk = transpile('../src/utils/bulkCustomerArchive.ts', () => quick, { Error });
function bulkFixture(ids = ['a', 'b', 'c']) {
  return ids.map(id => Object.assign(bulk.bulkArchiveEntry({ _id: id, evidenceVersion: 'v', observedIdentity: {
    customerName: `客户${id}`, consignee: `收货人${id}`, phone: '13800138000', address: `地址${id}`,
  } }), { status: 'ready', members: [{ _id: `m${id}`, revision: 1 }], duplicates: { details: [], total: 0, signature: '[]' } }));
}
function bulkDeps(overrides = {}) {
  return { loadMembers: async entry => entry.members, checkDuplicates: async () => ({ details: [], total: 0, signature: '[]' }),
    requestId: () => 'test-request', changed() {}, stopped: () => false, ...overrides };
}
test('跨组批量真实事务：一组响应丢失不阻塞其它组，重试沿用原请求，不重建客户', async () => {
  const data = { customers: [], customer_aliases: [], customer_recipient_profiles: [], orders: ['a', 'b', 'c'].map(id => ({
    _id: id, customerName: `客户${id}`, consignee: `收货人${id}`, consigneePhone: '13800138000', consigneeAddress: `地址${id}`, orderAttribute: 'rental1',
  })) };
  const { db } = database(data), repo = createRepository(db), actor = { id: 'bulk-actor' };
  await createScanner(repo)({ dryRun: false, taskId: 'bulk-scan' }, actor);
  const entries = data.customer_link_candidates.map(group => Object.assign(bulk.bulkArchiveEntry(group), {
    status: 'ready', members: data.customer_link_candidate_members.filter(member => member.candidateId === group._id),
    duplicates: { total: 0, signature: '[]', details: [] },
  }));
  const snapshots = data.orders.map(order => [order.customerName, order.consignee, order.consigneePhone, order.consigneeAddress]);
  let requestNo = 0, fail = true; const calls = [];
  const api = client(async (_, payload) => {
    calls.push(payload);
    const result = await createResolver(repo)(payload, actor);
    if (payload.candidateId === entries[1].group._id && fail) { fail = false; throw new Error('lost response'); }
    return result;
  });
  const deps = bulkDeps({ requestId: () => `bulk-request-${++requestNo}`, resolve: api.resolveArchive });
  await bulk.runBulkArchive(entries, deps);
  assert.deepEqual(entries.map(entry => entry.status), ['completed', 'failed', 'completed']);
  assert.equal(data.customers.length, 3); assert.equal(data.orders.filter(order => order.customerId).length, 3);
  const failedInput = entries[1].input;
  await bulk.runBulkArchive(entries, deps);
  assert.equal(requestNo, 3); assert.equal(entries[1].input, failedInput);
  assert.equal(calls.length, 4); assert.equal(calls[1].requestId, calls[3].requestId);
  assert.equal(data.customers.length, 3); assert.equal(data.customer_aliases.length, 3); assert.equal(data.customer_recipient_profiles.length, 3);
  assert.deepEqual(data.orders.map(order => [order.customerName, order.consignee, order.consigneePhone, order.consigneeAddress]), snapshots);
});
test('每组写入前重新查重：本批新客户出现后暂停相关组，继续无关组，明确选择已有客户后才归入', async () => {
  const entries = bulkFixture(); let created = false; const writes = [];
  const deps = bulkDeps({ checkDuplicates: async entry => created && entry.group._id === 'b'
    ? { total: 1, signature: '[new]', details: [{ _id: 'new', displayName: '客户a', reasons: ['name_exact'] }] }
    : { total: 0, signature: '[]', details: [] },
    resolve: async input => { writes.push(input); created = true; return { status: 'completed', next: 1, total: 1, results: [], requestId: 'r', customerId: 'new' }; },
  });
  await bulk.runBulkArchive(entries, deps);
  assert.deepEqual(entries.map(entry => entry.status), ['completed', 'review', 'completed']);
  assert.equal(entries[1].input, undefined); assert.equal(writes.length, 2); assert.equal(entries[1].acknowledged, false);
  entries[1].target = { _id: 'new', displayName: '客户a' }; entries[1].status = 'ready';
  await bulk.runBulkArchive(entries, deps);
  assert.equal(writes.length, 3); assert.equal(writes[2].mode, 'link'); assert.equal(writes[2].customerId, 'new');
});
test('客户变化使旧的仍然新建确认失效；查重失败、成员变化和未纳入组均不写入', async () => {
  const entries = bulkFixture(['a', 'b', 'c', 'd']);
  entries[0].acknowledged = true; entries[0].duplicates.signature = '[old]';
  entries[3].included = false;
  await bulk.runBulkArchive(entries, bulkDeps({
    loadMembers: async entry => entry.group._id === 'b' ? [{ _id: 'mb', revision: 2 }] : entry.members,
    checkDuplicates: async entry => {
      if (entry.group._id === 'c') throw new Error('查询失败');
      return { total: 1, details: [], signature: '[changed]' };
    }, resolve: async () => assert.fail('must not write'),
  }));
  assert.deepEqual(entries.map(entry => entry.status), ['review', 'review', 'review', 'ready']);
  assert.equal(entries[0].acknowledged, false);
  assert.match(entries[1].error, /范围已变化/); assert.match(entries[2].error, /查询失败/);
  assert.equal(entries.some(entry => entry.input), false);
});
test('批量暂停或卸载后不启动后续组；核对期间暂停也不会开始写入', async () => {
  const entries = bulkFixture(); let stopped = false, writes = 0;
  const deps = bulkDeps({ stopped: () => stopped, resolve: async () => {
    writes++; stopped = true; return { status: 'completed', next: 1, total: 1, results: [], requestId: 'r' };
  } });
  await bulk.runBulkArchive(entries, deps);
  assert.equal(writes, 1); assert.deepEqual(entries.map(entry => entry.status), ['completed', 'ready', 'ready']);
  stopped = false;
  await bulk.runBulkArchive(entries, { ...deps, checkDuplicates: async () => { stopped = true; return { total: 0, signature: '[]', details: [] }; } });
  assert.equal(writes, 1); assert.equal(entries[1].status, 'ready'); assert.equal(entries[1].input, undefined);
});

test('一次扫描500条：复用同一任务发起25批请求，继续旧任务不从头重扫', async () => {
  const calls = [], progress = [];
  const api = client(async (_, payload) => {
    calls.push(payload);
    return { success: true, data: { _id: payload.taskId, status: 'running', cursor: `o${calls.length * 20 + 120}`, scanned: calls.length * 20 + 120, skipped: 0 } };
  });
  const result = await api.scanArchive({ dryRun: false, taskId: 'existing-task' }, (scan, batch) => progress.push([scan.scanned, batch]));
  assert.equal(calls.length, 25); assert.equal(result.scanned, 620);
  assert.equal(calls.every(row => row.taskId === 'existing-task' && row.limit === 20 && row.dryRun === false && !row.cursor), true);
  assert.deepEqual(progress.at(-1), [620, 25]);
});
test('500条预览按游标累加订单与跳过数，到末尾即停；新一轮只累计该轮', async () => {
  const calls = [];
  const api = client(async (_, payload) => {
    calls.push(payload);
    return { success: true, data: { dryRun: true, cursor: `cursor-${calls.length}`, scanned: calls.length === 3 ? 5 : 20,
      skipped: 1, completed: calls.length === 3, previews: [{ orderId: `o${calls.length}` }] } };
  });
  const result = await api.scanArchive({ dryRun: true, cursor: 'previous-round' });
  assert.equal(calls.length, 3); assert.deepEqual(calls.map(row => row.cursor), ['previous-round', 'cursor-1', 'cursor-2']);
  assert.equal(result.scanned, 45); assert.equal(result.skipped, 3); assert.equal(result.previews.length, 3); assert.equal(result.completed, true);
});
test('500条扫描遇到完成、失败、网络中断或页面离开立即停止后续批次', async () => {
  for (const status of ['completed', 'failed']) {
    let count = 0;
    const api = client(async () => ({ success: true, data: { status, scanned: ++count, cursor: 'c', skipped: 0 } }));
    assert.equal((await api.scanArchive({ dryRun: false, taskId: 'task-stop' })).status, status);
    assert.equal(count, 1);
  }
  let count = 0;
  const api = client(async () => {
    if (++count === 2) throw new Error('network interrupted');
    return { success: true, data: { status: 'running', scanned: 20, cursor: 'c', skipped: 0 } };
  });
  const progress = [];
  await assert.rejects(api.scanArchive({ dryRun: false, taskId: 'task-network' }, value => { progress.push(value.scanned); }), /network interrupted/);
  assert.equal(count, 2); assert.deepEqual(progress, [20]);
  count = 0;
  await api.scanArchive({ dryRun: false, taskId: 'task-leave' }, () => false);
  assert.equal(count, 1);
});

test('500条扫描对接真实服务：预览零写入，正式扫描500后续扫余下5条不漏不重', async () => {
  const data = { customers: [], customer_aliases: [], customer_recipient_profiles: [], orders: Array.from({ length: 505 }, (_, index) => ({
    _id: `scan-${String(index).padStart(3, '0')}`, customerName: '批量扫描客户', orderAttribute: 'rental1',
  })) };
  const originalOrders = JSON.stringify(data.orders);
  const { db } = database(data), scan = createScanner(createRepository(db)), actor = { id: 'scan-actor' };
  const api = client(async (_, payload) => scan(payload, actor));
  const preview = await api.scanArchive({ dryRun: true });
  assert.equal(preview.scanned, 500); assert.equal(preview.previews.length, 500); assert.equal(preview.completed, false);
  assert.equal(data.customer_scan_tasks, undefined); assert.equal(data.customer_link_candidate_members, undefined);
  const first = await api.scanArchive({ dryRun: false, taskId: 'scan-500-test' });
  assert.equal(first.scanned, 500); assert.equal(first.status, 'running'); assert.equal(data.customer_link_candidate_members.length, 500);
  const last = await api.scanArchive({ dryRun: false, taskId: 'scan-500-test' });
  assert.equal(last.scanned, 505); assert.equal(last.status, 'completed'); assert.equal(last.eligible, 505);
  assert.equal(data.customer_scan_tasks.length, 1); assert.equal(data.customer_link_candidate_members.length, 505);
  assert.equal(new Set(data.customer_link_candidate_members.map(row => row.orderId)).size, 505);
  assert.equal(JSON.stringify(data.orders), originalOrders);
});

test('跨页勾选100组：第一页面20组后可继续选到第五页，返回仍保留；达到上限可取消后补选', () => {
  const rows = Array.from({ length: 121 }, (_, i) => ({ _id: `g${i}`, pendingCount: i === 120 ? 0 : 1 }));
  let selection = new Map();
  for (let page = 0; page < 5; page++) {
    selection = bulk.selectArchiveGroups(selection, rows.slice(page * 20, page * 20 + 20), true);
    assert.equal(selection.size, (page + 1) * 20);
    assert.equal(selection.has('g0'), true);
  }
  const full = selection;
  selection = bulk.selectArchiveGroups(selection, rows.slice(100), true);
  assert.equal(selection.size, 100); assert.equal(selection.has('g100'), false);
  selection = bulk.selectArchiveGroups(selection, rows.slice(0, 20), false);
  assert.equal(selection.size, 80); assert.equal(selection.has('g20'), true); assert.equal(full.has('g0'), true);
  selection = bulk.selectArchiveGroups(selection, rows.slice(100), true);
  assert.equal(selection.size, 100); assert.equal(selection.has('g119'), true); assert.equal(selection.has('g120'), false);
  selection = bulk.selectArchiveGroups(selection, [{ ...rows[20], pendingCount: 3 }], true);
  assert.equal(selection.size, 100); assert.equal(selection.get('g20').pendingCount, 3);
});

function cachedGroup() {
  return { ...bulkFixture(['cache'])[0].group, normalizationVersion: 'customer-identity-v2', identityRevision: 7,
    matchStatus: 'no_match', matchCount: 1, matches: [{ customerId: 'c', displayName: '已有客户', score: 40, reasons: ['name_exact'] }] };
}
test('批量弹窗直接保留列表匹配证据和名称；版本未变复用结果，不查客户详情', async () => {
  const entry = bulk.bulkArchiveEntry(cachedGroup()), cached = entry.duplicates;
  assert.equal(cached.details[0].displayName, '已有客户'); assert.equal(cached.total, 1); assert.equal(cached.identityRevision, 7);
  let checks = 0;
  const result = await bulk.checkArchiveDuplicates(entry, {
    checkCustomerIdentity: async (_, evidence) => { checks++; assert.equal(evidence, cached); return { unchanged: true, identityRevision: 7, normalizationVersion: 'customer-identity-v2' }; },
    getOrderSelection: () => assert.fail('不重复读取客户详情'),
  });
  assert.equal(checks, 1); assert.equal(result, cached);
});
test('批量输入修改后不携带旧版本命中；新主名和原下单名一起检查，新接口自带名称无需详情查询', async () => {
  const entry = bulk.bulkArchiveEntry(cachedGroup()); entry.displayName = '修改的新名称';
  const calls = [];
  const result = await bulk.checkArchiveDuplicates(entry, {
    checkCustomerIdentity: async (identity, cached) => { calls.push({ identity, cached }); return {
      normalizationVersion: 'customer-identity-v2', identityRevision: 8, status: 'no_match', candidates: [{ customerId: 'new', displayName: '新增客户', score: 30, reasons: ['phone_exact'] }],
    }; }, getOrderSelection: () => assert.fail('已有名称，不再读取档案'),
  });
  assert.equal(calls.length, 2); assert.equal(calls.every(row => row.cached === undefined), true);
  assert.equal(result.identityRevision, 8); assert.equal(result.total, 1); assert.notEqual(result.identityKey, entry.duplicates.identityKey);
});
test('旧扫描、截断候选不可跳过完整检查，旧云函数仍可返回匹配结果；不同快照版本不缓存', async () => {
  const entry = bulk.bulkArchiveEntry({ ...cachedGroup(), identityRevision: undefined });
  let details = 0;
  const result = await bulk.checkArchiveDuplicates(entry, {
    checkCustomerIdentity: async (_, cached) => { assert.equal(cached.identityRevision, undefined); return { status: 'no_match', normalizationVersion: 'customer-identity-v2', candidates: [{ customerId: 'c', score: 40, reasons: ['name_exact'] }] }; },
    getOrderSelection: async () => { details++; return { _id: 'c', displayName: '兼容旧接口' }; },
  });
  assert.equal(details, 1); assert.equal(result.identityRevision, undefined);
  assert.equal(bulk.bulkArchiveEntry({ ...cachedGroup(), matchCount: 51 }).duplicates.identityRevision, undefined);
  entry.displayName = '另一名称'; let revision = 8;
  const mixed = await bulk.checkArchiveDuplicates(entry, {
    checkCustomerIdentity: async () => ({ status: 'no_match', normalizationVersion: 'customer-identity-v2', identityRevision: revision++, candidates: [] }),
    getOrderSelection: () => assert.fail(),
  });
  assert.equal(mixed.identityRevision, undefined);
});
test('匹配查询异常或无依据的版本命中阻止提交，不把失败当作没有重复', async () => {
  const entry = bulk.bulkArchiveEntry(cachedGroup());
  await assert.rejects(bulk.checkArchiveDuplicates(entry, { checkCustomerIdentity: async () => { throw new Error('version unavailable'); }, getOrderSelection: () => assert.fail() }), /version unavailable/);
  await assert.rejects(bulk.checkArchiveDuplicates(entry, { checkCustomerIdentity: async () => ({ unchanged: true, identityRevision: 8, normalizationVersion: 'customer-identity-v2' }), getOrderSelection: () => assert.fail() }), /版本不一致/);
  assert.equal(entry.duplicates.identityRevision, 7);
});
