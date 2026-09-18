const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(storage = new Map()) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve('../src/utils/customerWriteRequest.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
    module, exports: module.exports, crypto: require('node:crypto').webcrypto, TextEncoder,
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  });
  return { run: module.exports.customerWriteRequest, storage };
}
test('失败及页面重载后保留请求 ID，成功后新操作使用新 ID，不持久化身份原文', async () => {
  const first = load(); const ids = [];
  const data = { displayName: '私有姓名', phone: '13800138000' };
  await assert.rejects(first.run('create', data, async id => { ids.push(id); throw new Error('lost reply'); }));
  assert.equal(JSON.stringify([...first.storage]).includes('私有姓名'), false);
  assert.equal(JSON.stringify([...first.storage]).includes(data.phone), false);
  const reloaded = load(first.storage);
  await reloaded.run('create', data, async id => { ids.push(id); return 'saved'; });
  assert.equal(ids[0], ids[1]); assert.equal(first.storage.size, 0);
  await reloaded.run('create', data, async id => { ids.push(id); return 'new'; });
  assert.notEqual(ids[1], ids[2]);
});
test('并发点击共享同一个在途请求，显式请求 ID 原样传递', async () => {
  const { run } = load(); let calls = 0; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const send = async () => { calls++; await gate; return 'saved'; };
  const a = run('create', { displayName: 'a' }, send), b = run('create', { displayName: 'a' }, send);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 1); release(); assert.deepEqual(await Promise.all([a, b]), ['saved', 'saved']);
  assert.equal(await run('update', { requestId: 'external-id' }, async id => id), 'external-id');
});
