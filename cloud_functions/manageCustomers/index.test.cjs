const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {
  NORMALIZATION_VERSION, normalizeName, normalizePhone, normalizeAddress,
  isCompletePhone, isCompleteIdentity, identityFingerprint,
} = require('./normalizers');
const { permissionsFor, hasAnyPermission } = require('./permissions');

const plain = value => JSON.parse(JSON.stringify(value));

test('新增订单扫描沿用管理员权限，普通客户维护权限不可执行', () => {
  assert.deepEqual(permissionsFor('scanNewOrders'), ['*']);
  assert.equal(hasAnyPermission({ actionPermissions: ['customers:write'] }, permissionsFor('scanNewOrders')), false);
  assert.equal(hasAnyPermission({ actionPermissions: ['*'] }, permissionsFor('scanNewOrders')), true);
});

test('名称统一全半角、大小写和分隔边界，空白不会消失造成误匹配', () => {
  assert.equal(normalizeName(' Ａlice—租赁  1 '), 'alice 租赁 1');
  assert.equal(normalizeName('张·三'), normalizeName('张 • 三'));
  assert.notEqual(normalizeName('A B'), normalizeName('AB'));
  assert.equal(normalizeName(' 张\t\n三 '), '张 三');
  assert.equal(normalizeName(null), '');
  assert.equal(normalizeName('。 _ -'), '');
});

test('完整电话判定独立于仅保留数字的标准化，不删除国家码', () => {
  assert.equal(normalizePhone('+８６ 138-0013-8000'), '8613800138000');
  for (const phone of ['13800138000', '+86 138-0013-8000', '８６１３８００１３８０００']) assert.equal(isCompletePhone(phone), true, phone);
  for (const phone of ['', '138****8000', 'x13800138000', '13800138000转1', '1380013800', '+1 4155551234', '021-12345678', '+13800138000']) assert.equal(isCompletePhone(phone), false, phone);
  assert.notEqual(normalizePhone('+86 13800138000'), normalizePhone('13800138000'));
});

test('地址去无意义标点但保留楼栋、单元及房号边界', () => {
  assert.equal(normalizeAddress('上海市， 浦东新区；世纪大道 １ 号：A座 1-2/301室'), '上海市浦东新区世纪大道1号a座1-2/301室');
  assert.notEqual(normalizeAddress('1-203室'), normalizeAddress('1203室'));
  assert.equal(normalizeAddress(undefined), '');
});

test('身份指纹确定、带规则版本、避免字段拼接歧义；不完整观察值不能自动匹配', () => {
  const identity = { customerName: ' Ａ Ｂ ', consignee: '张三', phone: '138-0013-8000', address: '地址 1号' };
  assert.match(identityFingerprint(identity), /^[a-f0-9]{64}$/);
  assert.equal(identityFingerprint(identity), identityFingerprint({ customerName: 'a b', consignee: '张三', consigneePhone: '13800138000', consigneeAddress: '地址1号' }));
  assert.notEqual(identityFingerprint(identity), identityFingerprint({ ...identity, customerName: 'AB' }));
  assert.notEqual(identityFingerprint({ customerName: 'ab', consignee: 'c' }), identityFingerprint({ customerName: 'a', consignee: 'bc' }));
  assert.equal(isCompleteIdentity(identity), true);
  assert.equal(isCompleteIdentity({ ...identity, consignee: '' }), false);
  assert.equal(isCompleteIdentity({ ...identity, phone: '138****8000' }), false);
  assert.equal(identityFingerprint({}), null);
  assert.equal(NORMALIZATION_VERSION, 'customer-identity-v2');
});

function fixture() {
  return {
    system_config: [{ _id: 'permission_system', initialized: true }],
    user_roles: [{ _id: 'ur', userId: 'user', roleId: 'role' }],
    roles: [{ _id: 'role' }],
    customers: [
      { _id: 'c1', displayName: 'Ａ Ｂ', normalizedDisplayName: 'ab', status: 'active', remark: 'private remark' },
      { _id: 'c2', displayName: '第二客户', status: 'disabled' },
      { _id: 'c3', displayName: '合并客户', status: 'merged', mergedIntoCustomerId: 'c1' },
    ],
    customer_aliases: [
      { _id: 'a1', customerId: 'c1', name: ' Ｏld—Name ', normalizedName: 'oldname', salesChannel: '平台', enabled: true, remark: 'private alias remark' },
      { _id: 'a2', customerId: 'c1', name: '停用名', enabled: false },
      { _id: 'a3', customerId: 'c2', name: '停用客户别名', enabled: true },
    ],
    customer_recipient_profiles: [
      { _id: 'r1', customerId: 'c1', label: '公司', consignee: '张三', phone: '+86 138-0013-8000', address: '上海市， 浦东新区 １ 号', enabled: true, useCount: 6, createdBy: 'private actor' },
      { _id: 'r2', customerId: 'c1', consignee: '停用人', phone: '13900139000', address: '停用地址', enabled: false },
    ],
    orders: [{ _id: 'o1', customerId: 'c1', customerName: '原订单下单名', consigneePhone: 'original phone', date: '2026-09-01', privateOrder: true }],
  };
}

function loadService(actions = ['customers:read'], { loggedIn = true, data = fixture(), failCollection } = {}) {
  data.roles[0].actionPermissions = actions;
  const { db, reads, writes, errors } = require('./test-support/database.cjs').database(data, { failCollection });
  const module = { exports: {} };
  const filename = path.join(__dirname, 'index.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    exports: module.exports, module, console: { error: (...args) => errors.push(args) },
    require(id) {
      if (id === 'wx-server-sdk') return { init() {}, database: () => db };
      if (id === './permissionAuth') return { getCurrentUser: async () => loggedIn ? { id: 'user' } : null };
      return require(id);
    },
  }, { filename });
  return { call: async payload => plain(await module.exports.main({ data: { requestId: `test-${writes.length}-request`, ...payload } })), data, reads, writes, errors };
}

test('匿名、订单只读和未初始化角色无法读取客户数据', async () => {
  const anonymous = loadService(['*'], { loggedIn: false });
  assert.equal((await anonymous.call({ action: 'list' })).code, 'LOGIN_REQUIRED');
  assert.equal(anonymous.reads.length, 0);
  for (const action of ['list', 'get', 'search']) {
    const service = loadService(['orders:read']);
    assert.equal((await service.call({ action, customerId: 'c1', keyword: 'Ａ' })).code, 'ACCESS_DENIED');
    assert.equal(service.reads.some(row => row.collection === 'customers'), false);
  }
  const data = fixture(); data.system_config = [];
  assert.equal((await loadService(['*'], { data }).call({ action: 'list' })).code, 'PERMISSION_UNINITIALIZED');
});

test('订单新增/编辑角色仅能读取受限搜索和选择详情，不能读取列表或管理详情', async () => {
  for (const permission of ['orders:create', 'orders:update']) {
    const service = loadService([permission]);
    const search = await service.call({ action: 'search', keyword: 'old name' });
    assert.deepEqual(search.data, [{ _id: 'c1', displayName: 'Ａ Ｂ' }]);
    assert.equal((await service.call({ action: 'list' })).code, 'ACCESS_DENIED');
    assert.equal((await service.call({ action: 'get', customerId: 'c1' })).code, 'ACCESS_DENIED');
    const detail = await service.call({ action: 'get', scope: 'orderSelection', customerId: 'c1' });
    assert.equal(detail.success, true);
    assert.deepEqual(Object.keys(detail.data).sort(), ['_id', 'displayName', 'aliases', 'recipients', 'aliasPage', 'recipientPage', 'pageSize', 'aliasTotal', 'recipientTotal'].sort());
    assert.deepEqual(detail.data.aliases, [{ _id: 'a1', name: ' Ｏld—Name ', salesChannel: '平台' }]);
    assert.deepEqual(detail.data.recipients, [{ _id: 'r1', label: '公司', consignee: '张三', phone: '+86 138-0013-8000', address: '上海市， 浦东新区 １ 号' }]);
    assert.equal(service.reads.some(row => row.collection === 'orders'), false);
    assert.equal((await service.call({ action: 'create', displayName: 'new' })).code, 'ACCESS_DENIED');
    assert.equal((await service.call({ action: 'createAlias', customerId: 'c1', name: 'new' })).code, 'ACCESS_DENIED');
    assert.equal(service.writes.length, 0);
  }
});

test('管理员的受限详情仍按白名单返回，停用或合并客户不能供新单选择', async () => {
  const service = loadService(['*']);
  const result = await service.call({ action: 'get', scope: 'orderSelection', customerId: 'c1' });
  assert.equal('remark' in result.data, false);
  assert.equal('useCount' in result.data.recipients[0], false);
  for (const id of ['c2', 'c3']) assert.equal((await service.call({ action: 'get', scope: 'orderSelection', customerId: id })).code, 'CUSTOMER_UNAVAILABLE');
  assert.deepEqual((await service.call({ action: 'search', keyword: '客户', includeDisabled: true })).data, []);
});

test('Top3 推荐查询在真实入口按订单权限授权，仍不返回客户管理字段', async () => {
  const service = loadService(['orders:update']);
  const result = await service.call({ action: 'search', scope: 'orderSuggestions', keyword: 'old name' });
  assert.equal(result.success, true); assert.equal(result.data[0]._id, 'c1');
  assert.equal(result.data[0].recipients[0].address, fixture().customer_recipient_profiles[0].address);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal((await loadService(['orders:read']).call({ action: 'search', scope: 'orderSuggestions', keyword: 'old' })).code, 'ACCESS_DENIED');
});

test('未知查询模式、伪造内部动作以及旧计数入口无法绕过权限', async () => {
  const service = loadService(['*']);
  for (const payload of [
    { action: 'get', scope: 'admin' }, { action: 'list', scope: 'orderSelection' },
    { action: 'touchRecipient', recipientId: 'r1' }, { action: 'ingestOrder', internal: true, currentUser: { id: 'admin' } },
    { action: 'toString' }, { action: '__proto__' },
  ]) assert.equal((await service.call(payload)).code, 'ACTION_NOT_ALLOWED');
  assert.equal(service.reads.length, 0);
  assert.equal(service.writes.length, 0);
});

test('归档、关系、合并及运维权限互不越权，阶段 1 未实现动作不产生写入', async () => {
  for (const [action, permitted, forbidden] of [
    ['confirmRelation', 'customers:write', 'customers:read'],
    ['rejectRelation', 'customers:write', 'customers:merge'],
    ['removeRelation', 'customers:write', 'customers:read'],
    ['merge', 'customers:merge', 'customers:write'],
    ['unmerge', 'customers:merge', 'customers:write'],
    ['rebuildStats', '*', 'customers:merge'],
  ]) {
    assert.equal(hasAnyPermission({ actionPermissions: [permitted] }, permissionsFor(action)), true);
    const denied = loadService([forbidden]);
    assert.equal((await denied.call({ action })).code, 'ACCESS_DENIED');
    const allowed = loadService([permitted]);
    assert.equal((await allowed.call({ action })).code, 'ACTION_NOT_IMPLEMENTED');
    assert.equal(allowed.writes.length, 0);
  }
});

test('标准化字段未回填时，主名、别名、电话、地址搜索仍兼容且纯分隔符不匹配所有客户', async () => {
  const service = loadService(['customers:read']);
  for (const keyword of ['a b', 'old name', '8613800138000', '上海市浦东新区1号']) {
    assert.equal((await service.call({ action: 'search', keyword })).data[0]._id, 'c1');
  }
  assert.deepEqual((await service.call({ action: 'search', keyword: '---' })).data, []);
  assert.equal((await service.call({ action: 'search', keyword: ' ' })).code, 'KEYWORD_REQUIRED');
});

test('服务端分页限制搜索 50、列表 100、档案 50，跨页可以完整选择资料', async () => {
  const data = fixture();
  data.customers = Array.from({ length: 121 }, (_, i) => ({ _id: `c${String(i).padStart(3, '0')}`, displayName: `测试客户${i}`, status: 'active' }));
  data.customer_aliases = Array.from({ length: 61 }, (_, i) => ({ _id: `a${String(i).padStart(3, '0')}`, customerId: 'c000', name: `别名${i}`, enabled: true }));
  data.customer_recipient_profiles = Array.from({ length: 61 }, (_, i) => ({ _id: `r${String(i).padStart(3, '0')}`, customerId: 'c000', consignee: '测试', phone: '13800138000', address: `${i}号`, enabled: true }));
  const service = loadService(['*'], { data });
  const list = await service.call({ action: 'list', pageSize: 5000 });
  assert.equal(list.data.length, 100); assert.equal(list.total, 121);
  const search = await service.call({ action: 'search', keyword: '测试', pageSize: 5000 });
  assert.equal(search.data.length, 50);
  const detail = await service.call({ action: 'get', scope: 'orderSelection', customerId: 'c000', pageSize: 5000, aliasPage: 2, recipientPage: 2 });
  assert.equal(detail.data.aliases.length, 11); assert.equal(detail.data.recipients.length, 11);
  assert.equal(detail.data.aliasTotal, 61); assert.equal(detail.data.aliases[0]._id, 'a050');
  const invalidPage = await service.call({ action: 'list', pageSize: 'Infinity', page: -1 });
  assert.equal(invalidPage.pageSize, 20); assert.equal(invalidPage.page, 1);
});

test('客户维护仍可用，后端生成审计及规则版本，不修改订单快照', async () => {
  const service = loadService(['customers:write']);
  const ordersBefore = plain(service.data.orders);
  const created = await service.call({ action: 'create', displayName: ' Ｎew—Name ', createdBy: 'forged' });
  assert.equal(created.success, true);
  const customer = service.data.customers.find(row => row._id === created.data._id);
  assert.equal(customer.normalizedDisplayName, 'new name');
  assert.equal(customer.normalizationVersion, NORMALIZATION_VERSION);
  assert.equal(customer.createdBy, 'user');
  assert.equal((await service.call({ action: 'update', customerId: 'c1', displayName: '新名字', updatedBy: 'forged' })).success, true);
  assert.equal((await service.call({ action: 'createAlias', customerId: 'c1', name: 'Old Name', salesChannel: '平台' })).success, false);
  assert.equal((await service.call({ action: 'createRecipient', customerId: 'c1', consignee: '新收件人', phone: '13800138000', address: '新地址1号' })).success, true);
  assert.equal((await service.call({ action: 'disable', customerId: 'c1' })).success, true);
  assert.equal((await service.call({ action: 'enable', customerId: 'c1' })).success, true);
  assert.equal((await service.call({ action: 'enable', customerId: 'c3' })).success, false);
  assert.deepEqual(service.data.orders, ordersBefore);
});

test('异步查询失败统一返回错误，不泄露底层完整身份信息', async () => {
  const service = loadService(['orders:create'], { failCollection: 'customer_aliases' });
  const result = await service.call({ action: 'get', scope: 'orderSelection', customerId: 'c1' });
  assert.equal(result.success, false);
  assert.equal(result.code, 'CUSTOMER_MANAGE_FAILED');
  assert.equal(JSON.stringify([result, service.errors]).includes('13800138000'), false);
});

test('matchIdentity 权限按客户读取能力执行，不能以订单选择权限或伪造内部标记越权', async () => {
  for (const permission of ['orders:create', 'orders:update', 'orders:read']) {
    const service = loadService([permission]);
    assert.equal((await service.call({ action: 'matchIdentity', identity: {}, internal: true })).code, 'ACCESS_DENIED');
    assert.equal(service.reads.some(row => row.collection === 'customers'), false);
  }
  for (const permission of ['customers:read', 'customers:write', 'customers:merge']) {
    const service = loadService([permission]);
    const result = await service.call({ action: 'matchIdentity', identity: {} });
    assert.equal(result.success, true); assert.equal(result.data.status, 'incomplete'); assert.equal(service.writes.length, 0);
  }
});

test('阶段3扫描只对通配管理员开放，归档写权限独立，伪造内部身份无效', async () => {
  for (const permission of ['customers:read', 'customers:write', 'customers:merge', 'orders:update']) {
    const service = loadService([permission]);
    assert.equal((await service.call({ action: 'scanUnlinkedOrders', dryRun: true, internal: true })).code, 'ACCESS_DENIED');
    assert.equal((await service.call({ action: 'scanNewOrders', taskId: 'new-admin-scan', internal: true })).code, 'ACCESS_DENIED');
    if (permission !== 'customers:write') assert.equal((await service.call({ action: 'resolveLinkCandidate' })).code, 'ACCESS_DENIED');
    assert.equal(service.writes.length, 0);
  }
  const admin = loadService(['*']);
  assert.equal((await admin.call({ action: 'scanUnlinkedOrders', dryRun: true })).success, true);
  assert.equal(admin.writes.length, 0);
  assert.equal((await loadService(['orders:update']).call({ action: 'listLinkCandidates' })).code, 'ACCESS_DENIED');
});

test('新增扫描真实入口固定为新增模式，已完成全量任务保持完成且不被复用', async () => {
  const data = fixture();
  data.orders = [{ _id: 'new-order', customerName: '新增客户', orderAttribute: 'rental1' }];
  const admin = loadService(['*'], { data });
  const result = await admin.call({ action: 'scanNewOrders', scanMode: 'all', taskId: 'new-admin-scan' });
  assert.equal(result.success, true); assert.equal(result.data.scanMode, 'new');
  assert.equal(result.data.status, 'completed'); assert.equal(result.data.eligible, 1);
  const wrongMode = await admin.call({ action: 'scanUnlinkedOrders', dryRun: false, taskId: 'new-admin-scan' });
  assert.equal(wrongMode.code, 'SCAN_MODE_CHANGED');
});

test('匹配版本未变只读版本号，变化、旧版本或缺少版本才重新读取客户资料', async () => {
  const service = loadService(['customers:write']);
  const initial = await service.call({ action: 'matchIdentity', identity: { customerName: 'Ａ Ｂ' } });
  assert.equal(initial.data.identityRevision, 0); assert.equal(initial.data.candidates[0].displayName, 'Ａ Ｂ');
  service.reads.length = 0;
  const unchanged = await service.call({ action: 'matchIdentity', identity: { customerName: 'Ａ Ｂ' }, knownIdentityRevision: 0, knownNormalizationVersion: NORMALIZATION_VERSION });
  assert.equal(unchanged.data.unchanged, true);
  assert.equal(service.reads.some(row => ['customers', 'customer_aliases', 'customer_recipient_profiles'].includes(row.collection)), false);
  service.data.system_config.push({ _id: 'customer_identity_revision', revision: 1 });
  service.reads.length = 0;
  const changed = await service.call({ action: 'matchIdentity', knownIdentityRevision: 0, knownNormalizationVersion: NORMALIZATION_VERSION });
  assert.equal(changed.data.unchanged, undefined); assert.equal(changed.data.identityRevision, 1);
  assert.equal(service.reads.some(row => row.collection === 'customers'), true);
  for (const cached of [{ knownIdentityRevision: 1, knownNormalizationVersion: 'old-rules' }, {}, { knownIdentityRevision: -1, knownNormalizationVersion: NORMALIZATION_VERSION }]) {
    assert.equal((await service.call({ action: 'matchIdentity', ...cached })).data.unchanged, undefined);
  }
  const denied = loadService(['orders:update']);
  assert.equal((await denied.call({ action: 'matchIdentity', knownIdentityRevision: 0, knownNormalizationVersion: NORMALIZATION_VERSION })).success, false);
});
