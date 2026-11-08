const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sender = require('./senderConfig');
const example = () => ({ HH: { contact: 'HH', tel: '18025412746', address: '示例寄件地址', province: '广东省', city: '深圳市', county: '龙岗区' } });
function database() {
  let records = {}, fail = false;
  const collection = data => ({ doc: id => ({ get: async () => { if (fail) throw new Error('网络不可用'); return { data: structuredClone(data[id] || null) }; }, update: async ({ data: patch }) => { data[id] = { ...data[id], ...structuredClone(patch) }; } }), add: async ({ data: row }) => { data[row._id] = structuredClone(row); } });
  return { collection: () => collection(records), fail: () => { fail = true; }, startTransaction: async () => { const next = structuredClone(records); return { collection: () => collection(next), commit: async () => { records = next; }, rollback: async () => {} }; } };
}
test('寄件人规范化保留信息，电话和人员标识校验', () => {
  const map = sender.normalizeMap(example());
  assert.equal(map.hh.tel, '18025412746'); assert.equal(map.hh.country, 'CN');
  assert.throws(() => sender.normalizeMap({ HH: example().HH, hh: example().HH }), /重复/);
  assert.throws(() => sender.normalizeMap({ hh: { ...example().HH, tel: 'abc' } }), /电话/);
  assert.throws(() => sender.normalizeMap({ hh: { ...example().HH, address: '' } }), /详细地址/);
  assert.throws(() => sender.route('other', 'production'), /鸿城/);
});
test('四组配置独立；保存后新下单读取最新电话；旧版本保存被拒绝', async () => {
  const db = database();
  for (const profile of ['hongcheng', 'huichuan']) for (const env of ['sandbox', 'production']) {
    assert.equal((await sender.save(db, { profile, env, senderMap: example(), expectedRevision: 0 }, { id: 'admin' })).revision, 1);
  }
  await sender.save(db, { profile: 'hongcheng', env: 'production', senderMap: { hh: { ...example().HH, tel: '13800138000' } }, expectedRevision: 1 }, { id: 'admin' });
  assert.equal((await sender.resolve(db, 'hongcheng', 'production', 'HH', () => assert.fail())).tel, '13800138000');
  assert.equal((await sender.read(db, 'huichuan', 'production')).senderMap.hh.tel, '18025412746');
  await assert.rejects(sender.save(db, { profile: 'hongcheng', env: 'production', senderMap: example(), expectedRevision: 1 }, { id: 'admin' }), /其他管理员/);
  assert.equal((await sender.read(db, 'hongcheng', 'production')).senderMap.hh.tel, '13800138000');
});
test('无数据库配置时兼容环境变量；数据库故障或未匹配人员时禁止回退错发', async () => {
  const db = database();
  assert.equal(await sender.resolve(db, 'hongcheng', 'sandbox', 'HH', () => 'legacy'), 'legacy');
  await sender.save(db, { profile: 'hongcheng', env: 'sandbox', senderMap: example(), expectedRevision: 0 }, { id: 'admin' });
  await assert.rejects(sender.resolve(db, 'hongcheng', 'sandbox', 'unknown', () => 'legacy'), /未配置人员/);
  db.fail();
  await assert.rejects(sender.resolve(db, 'hongcheng', 'sandbox', 'HH', () => 'legacy'), /网络/);
});
test('共享寄件人模块保持一致', () => {
  assert.equal(fs.readFileSync(__dirname + '/senderConfig.js', 'utf8'), fs.readFileSync(__dirname + '/../applySfExpress/senderConfig.js', 'utf8'));
});
test('寄件人管理接口拒绝未登录请求', async () => {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(__dirname + '/index.js', 'utf8'), { module, exports: module.exports, process: { env: {} }, console: { error() {} }, require: id => {
    if (id === 'wx-server-sdk') return { init() {}, database: () => ({}) };
    if (id === './permissionAuth') return { getCurrentUser: async () => null };
    if (id === './senderConfig') return sender;
    return require('./sfProfile');
  } });
  for (const action of ['getSenders', 'setSenders']) {
    const result = await module.exports.main({ data: { action, profile: 'hongcheng', env: 'production' } });
    assert.equal(result.code, 'LOGIN_REQUIRED');
  }
});
