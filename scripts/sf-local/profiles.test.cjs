const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('./runtime.cjs');
const profiles = require('../../cloud_functions/sfProfile.cjs');
const ok = r => { assert.equal(r.success, true, JSON.stringify(r)); return r; };
const set = (r, activeProfile, env = 'sandbox') => r.invoke('manageSfConfig', { action: 'set', activeProfile, env });
const apply = (r, i) => r.invoke('applySfExpress', { sourceOrderId: `demo-order-${i}` });

test('管理员切换只影响新单，旧单查询/取消/打印仍使用原配置；缓存分区', async () => {
  const r = createRuntime(); const a = ok(await apply(r, 1));
  ok(await set(r, 'huichuan')); const b = ok(await apply(r, 2));
  assert.equal(a.sfConfigProfile, 'hongcheng'); assert.equal(b.sfConfigProfile, 'huichuan');
  ok(await r.invoke('querySfOrderResult', { sfExpressOrderId: a.sfExpressOrderId }));
  assert.equal(r.calls.at(-1).partner, 'demo-hongcheng');
  const print = ok(await r.invoke('manageSfPluginPrint', { action: 'prepare', sfExpressOrderId: a.sfExpressOrderId, operation: 'preview' }));
  assert.equal(print.sfConfigProfile, 'hongcheng'); assert.match(print.templateCode, /HONGCHENG/);
  const boot = ok(await r.invoke('manageSfPluginPrint', { action: 'bootstrap', sfExpressOrderId: a.sfExpressOrderId }));
  assert.equal(boot.partnerID, 'demo-hongcheng');
  ok(await r.invoke('cancelSfExpress', { sfExpressOrderId: a.sfExpressOrderId }));
  assert.equal(r.calls.at(-1).partner, 'demo-hongcheng');
  assert.deepEqual(r.snapshot().tokens.sort(), ['huichuan:sandbox', 'sandbox']);
});
test('保存期间正在发送的订单固定路由，后续 token 刷新沿用原环境', async () => {
  const r = createRuntime();
  r.state.beforeCreate = async () => ok(await set(r, 'huichuan', 'production'));
  const a = ok(await apply(r, 1)); assert.equal(a.sfConfigProfile, 'hongcheng');
  const b = ok(await apply(r, 2)); assert.equal(b.env, 'production'); assert.equal(b.sfConfigProfile, 'huichuan');
  ok(await r.invoke('getSfAccessToken', { sfConfigProfile: 'hongcheng', sfEnv: 'sandbox', forceRefresh: true }));
  ok(await r.invoke('querySfOrderResult', { sfExpressOrderId: a.sfExpressOrderId }));
  assert.equal(r.calls.at(-1).env, 'sandbox');
});
test('顺丰已创建但网络超时，切换后重试查询恢复，不在新账号重复创建', async () => {
  const r = createRuntime(); r.state.timeoutNextCreate = true;
  const failed = await apply(r, 1); assert.equal(failed.success, false);
  ok(await set(r, 'huichuan', 'production'));
  const recovered = ok(await apply(r, 1));
  assert.equal(recovered.sfConfigProfile, 'hongcheng'); assert.equal(recovered.env, 'sandbox');
  assert.equal(r.calls.some(c => c.partner === 'demo-huichuan'), false);
  assert.equal(r.snapshot().records.length, 1);
});
test('没有归属字段的历史记录默认为鸿城；未知配置拒绝', async () => {
  const r = createRuntime(); const a = ok(await apply(r, 1));
  const old = r.snapshot().records[0]; delete old.sfConfigProfile; r.put('sf_express_orders', old);
  ok(await set(r, 'huichuan'));
  assert.equal(ok(await r.invoke('querySfOrderResult', { sfExpressOrderId: a.sfExpressOrderId })).sfConfigProfile, 'hongcheng');
  assert.equal((await set(r, 'invalid')).success, false);
});
test('只有管理员可以切换；过期版本拒绝，切换有审计记录', async () => {
  const r = createRuntime(); r.state.role = 'viewer';
  assert.equal((await set(r, 'huichuan')).success, false);
  r.state.role = 'admin'; ok(await set(r, 'huichuan'));
  const conflict = await r.invoke('manageSfConfig', { action: 'set', activeProfile: 'hongcheng', env: 'sandbox', expectedRevision: 0 });
  assert.equal(conflict.success, false); assert.match(conflict.errMsg, /其他管理员/);
  assert.equal(r.snapshot().config.switchHistory.length, 1);
});
test('插件开关按配置与环境分别保存', async () => {
  const r = createRuntime();
  ok(await r.invoke('manageSfConfig', { action: 'setPluginPrint', activeProfile: 'huichuan', env: 'sandbox', enabled: false }));
  const config = ok(await r.invoke('manageSfConfig', { action: 'get' }));
  assert.equal(config.pluginPrintEnabledByProfile.huichuan.sandbox, false);
  assert.equal(config.pluginPrintEnabledByProfile.hongcheng.sandbox, true);
  assert.equal(config.pluginPrintEnabledByProfile.huichuan.production, true);
});
test('汇川缺少自己的凭据时拒绝，不回退鸿城凭据', async () => {
  const r = createRuntime(); delete r.demoEnv.SF_HUICHUAN_SANDBOX_CLIENT_CODE;
  r.demoEnv.SF_SANDBOX_CLIENT_CODE = 'demo-hongcheng';
  ok(await set(r, 'huichuan')); const result = await apply(r, 1);
  assert.equal(result.success, false); assert.equal(r.calls.length, 0);
});
test('请求级上下文并发隔离，既不修改进程环境也不互串配置', async () => {
  const routes = ['hongcheng', 'huichuan'];
  const values = await Promise.all(routes.map((p, i) => profiles.context.run({ sfConfigProfile: p, env: 'sandbox' }, async () => {
    await new Promise(resolve => setTimeout(resolve, (1 - i) * 10));
    return profiles.tokenId('sandbox');
  })));
  assert.deepEqual(values, ['sandbox', 'huichuan:sandbox']);
});

test('原运单取消后，新申请可使用汇川；原记录保留鸿城归属', async () => {
  const r = createRuntime(); const a = ok(await apply(r, 1));
  ok(await r.invoke('cancelSfExpress', { sfExpressOrderId: a.sfExpressOrderId }));
  ok(await set(r, 'huichuan'));
  const next = ok(await apply(r, 1)); assert.equal(next.sfConfigProfile, 'huichuan');
  assert.equal(r.snapshot().records.find(x => x._id === a.sfExpressOrderId).sfConfigProfile, 'hongcheng');
  assert.notEqual(next.sfExpressOrderId, a.sfExpressOrderId);
});
test('打印准备后切换配置，回调仍归属于原打印会话', async () => {
  const r = createRuntime(); const a = ok(await apply(r, 1));
  const p = ok(await r.invoke('manageSfPluginPrint', { action: 'prepare', sfExpressOrderId: a.sfExpressOrderId, operation: 'preview' }));
  ok(await set(r, 'huichuan', 'production'));
  const result = ok(await r.invoke('manageSfPluginPrint', { action: 'record', requestID: p.requestID, code: 1 }));
  assert.equal(result.sfConfigProfile, 'hongcheng');
});
test('旧客户端只修改接口环境时保留当前账号，不意外切回鸿城', async () => {
  const r = createRuntime(); ok(await set(r, 'huichuan'));
  ok(await r.invoke('manageSfConfig', { action: 'set', env: 'production' }));
  assert.equal(r.snapshot().config.activeProfile, 'huichuan');
});
test('同一订单并发下单只允许一次发送', async () => {
  const r = createRuntime();
  const results = await Promise.all([apply(r, 1), apply(r, 1)]);
  assert.equal(results.filter(x => x.success).length, 1);
  assert.equal(r.calls.filter(x => x.service === 'EXP_RECE_CREATE_ORDER').length, 1);
});

test('过渡缓存支持旧调用写入、新调用复用以及新刷新后旧调用读取', async () => {
  const r = createRuntime();
  r.put('sf_tokens', { _id: 'production', env: 'production', accessToken: 'legacy-cached-token', expiresAt: Date.now() + 7200000, expiresIn: 7200 });
  const reused = ok(await r.invoke('getSfAccessToken', { sfConfigProfile: 'hongcheng', sfEnv: 'production' }));
  assert.equal(reused.cached, true); assert.equal(r.calls.length, 0);
  ok(await r.invoke('getSfAccessToken', { sfConfigProfile: 'hongcheng', sfEnv: 'production', forceRefresh: true }));
  const legacyRead = (await r.db.collection('sf_tokens').doc('production').get()).data;
  assert.equal(legacyRead.accessToken, 'local-token:demo-hongcheng:production');
  const count = r.calls.length;
  const oldCaller = ok(await r.invoke('getSfAccessToken', { sfEnv: 'production' }));
  assert.equal(oldCaller.cached, true); assert.equal(r.calls.length, count);
  assert.deepEqual(r.snapshot().tokens, ['production']);
});
test('全局汇川时，无账号参数的旧调用始终获取鸿城且不覆盖汇川缓存', async () => {
  const r = createRuntime(); ok(await set(r, 'huichuan', 'production'));
  ok(await r.invoke('getSfAccessToken', { sfConfigProfile: 'huichuan', sfEnv: 'production' }));
  const before = (await r.db.collection('sf_tokens').doc('huichuan:production').get()).data;
  const old = ok(await r.invoke('getSfAccessToken', { forceRefresh: true }));
  assert.equal(old.sfConfigProfile, 'hongcheng'); assert.equal(old.env, 'production');
  assert.equal(r.calls.at(-1).partner, 'demo-hongcheng');
  assert.deepEqual((await r.db.collection('sf_tokens').doc('huichuan:production').get()).data, before);
  const pinned = ok(await r.invoke('getSfAccessToken', { sfEnv: 'sandbox', forceRefresh: true }));
  assert.equal(pinned.env, 'sandbox'); assert.equal(pinned.sfConfigProfile, 'hongcheng');
});
test('新版鸿城下单、查询、取消及插件准备兼容实际旧版 token 函数', async () => {
  const r = createRuntime({ legacyToken: true });
  const a = ok(await apply(r, 1));
  ok(await r.invoke('querySfOrderResult', { sfExpressOrderId: a.sfExpressOrderId }));
  ok(await r.invoke('manageSfPluginPrint', { action: 'prepare', sfExpressOrderId: a.sfExpressOrderId, operation: 'preview' }));
  ok(await r.invoke('cancelSfExpress', { sfExpressOrderId: a.sfExpressOrderId }));
  assert.deepEqual(r.snapshot().tokens, ['sandbox']);
  assert.equal(r.calls.every(c => c.partner === 'demo-hongcheng'), true);
});
test('旧版 token 函数未升级时，汇川请求失败而不会用鸿城账号创建', async () => {
  const r = createRuntime({ legacyToken: true }); ok(await set(r, 'huichuan'));
  const result = await apply(r, 1); assert.equal(result.success, false);
  assert.equal(r.calls.some(c => c.service === 'EXP_RECE_CREATE_ORDER'), false);
});
test('过渡期鸿城原变量及原生产别名优先，避免共享缓存对应不同账号', async () => {
  const r = createRuntime();
  r.demoEnv.SF_PRODUCTION_CLIENT_CODE = 'demo-hongcheng';
  r.demoEnv.SF_PRODUCTION_CHECK_WORD = 'legacy-secret';
  r.demoEnv.SF_HONGCHENG_PROD_CLIENT_CODE = 'must-not-be-used';
  ok(await r.invoke('getSfAccessToken', { sfConfigProfile: 'hongcheng', sfEnv: 'production', forceRefresh: true }));
  assert.equal(r.calls.at(-1).partner, 'demo-hongcheng');
});
test('显式账号缺少环境时失败，不从全局猜测环境', async () => {
  const r = createRuntime();
  const result = await r.invoke('getSfAccessToken', { sfConfigProfile: 'huichuan' });
  assert.equal(result.success, false); assert.match(result.errMsg, /sfEnv/);
  assert.equal(r.calls.length, 0);
});
