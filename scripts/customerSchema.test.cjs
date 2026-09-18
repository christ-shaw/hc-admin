const test = require('node:test');
const assert = require('node:assert/strict');
const { manifest, planSchema, applySchema } = require('./customerSchema.cjs');
const { parseArgs, liveAdapter } = require('./initialize-customer-schema.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
test('结构清单覆盖设计索引及任务、审计、幂等存储；重复初始化无操作', async () => {
  const structure = {}, calls = [];
  const adapter = {
    async create(name) { structure[name] = []; calls.push('create'); },
    async index(name, index) { structure[name].push(clone(index)); calls.push('index'); },
    async read() { return structure; },
  };
  const result = await applySchema(structure, adapter);
  assert.deepEqual(result, { operations: [], conflicts: [] });
  assert.equal(Object.keys(structure).length, 12);
  assert.equal(planSchema(structure).operations.length, 0);
  for (const name of ['customer_operation_audits', 'customer_write_requests', 'customer_scan_tasks', 'customer_link_candidate_members']) assert.ok(name in structure);
  const count = calls.length;
  await applySchema(structure, adapter); assert.equal(calls.length, count);
});
test('同名不同定义阻止写入，不删除或替换现有索引；同定义不同名可复用', async () => {
  const structure = clone(manifest);
  structure.customers[0].Keys.reverse();
  let writes = 0;
  await assert.rejects(applySchema(structure, { async create() { writes++; }, async index() { writes++; } }));
  assert.equal(writes, 0);
  const same = clone(manifest); same.customers[0].Name = 'existing_index';
  same.customers[0].Keys = same.customers[0].Keys.map(key => ({ Direction: 1, Name: key.Name }));
  assert.equal(planSchema(same).operations.length, 0);
});
test('初始化不把异步未完成的索引报告为成功，默认只读且写入需环境确认', async () => {
  assert.equal(parseArgs(['--env', 'test']).apply, false);
  assert.throws(() => parseArgs(['--env', 'test', '--apply']));
  assert.throws(() => parseArgs(['--input', 'x.json', '--apply', '--confirm', 'test']));
  const result = await applySchema({}, { async create() {}, async index() {}, async read() { return {}; } });
  assert.ok(result.operations.length > 0);
});
test('CLI 适配器从目标环境解析数据库、分页读结构、仅使用结构 API', async () => {
  const calls = [];
  const execute = (command, argv) => {
    assert.equal(command, 'cloudbase');
    const action = argv[6], body = JSON.parse(argv[argv.indexOf('--body') + 1]); calls.push({ action, body });
    const replies = { DescribeEnvs: { EnvList: [{ EnvId: 'test', Databases: [{ InstanceId: 'verified-tag' }] }] }, ListTables: { Tables: [{ TableName: 'customers' }] }, DescribeTable: { Indexes: clone(manifest.customers) }, CreateTable: {}, UpdateTable: {} };
    return 'ℹ → TCB.API\n' + JSON.stringify({ data: replies[action] });
  };
  const adapter = liveAdapter({ env: 'test', region: 'ap-shanghai' }, execute);
  const result = await adapter.read(); assert.deepEqual(result.customers, manifest.customers);
  await adapter.create('customer_write_requests'); await adapter.index('customers', manifest.customers[0]);
  assert.equal(calls.slice(1).every(call => call.body.Tag === 'verified-tag'), true);
  assert.ok(calls.find(call => call.action === 'UpdateTable').body.CreateIndexes[0].MgoKeySchema);
});
