const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { derivePatch, updateCommand, preview } = require('./customerNormalizationBackfill.cjs');
const { parseArgs, readCollections, applyBackfill } = require('./backfill-customer-normalization.cjs');

function fixture() {
  return {
    customers: [{ _id: 'c1', displayName: 'Ａ Ｂ', normalizedDisplayName: 'ab' }],
    customer_aliases: [
      { _id: 'a1', customerId: 'c1', name: 'Old-Name', normalizedName: 'oldname', salesChannel: '平台', enabled: true },
      { _id: 'a2', customerId: 'c1', name: 'old name', normalizedName: 'oldname', salesChannel: '平台', enabled: true },
      { _id: 'a3', customerId: 'c2', name: 'old name', salesChannel: '平台' },
    ],
    customer_recipient_profiles: [{ _id: 'r1', consignee: '张三', phone: '13800138000', address: '私人地址1号' }],
  };
}

test('回填只生成派生字段差异，重复运行无变化；不修改原值和订单', () => {
  const data = fixture();
  const before = JSON.stringify(data);
  const report = preview(data);
  assert.equal(report.counts.customers.changed, 1);
  assert.deepEqual(report.aliasCollisions, [{ customerId: 'c1', aliasIds: ['a1', 'a2'] }]);
  assert.equal(JSON.stringify(report).includes('13800138000'), false);
  assert.equal(JSON.stringify(report).includes('私人地址'), false);
  assert.equal(JSON.stringify(data), before);
  const patch = derivePatch('customers', data.customers[0]);
  assert.deepEqual(Object.keys(patch).sort(), ['normalizationVersion', 'normalizedDisplayName']);
  assert.deepEqual(derivePatch('customers', { ...data.customers[0], ...patch }), {});
  assert.throws(() => derivePatch('orders', {}));
});

test('条件更新比较原始值及旧派生值，缺失字段使用 exists，不允许 upsert 或批量覆盖', () => {
  const row = fixture().customers[0];
  const command = updateCommand('customers', row, derivePatch('customers', row));
  const update = JSON.parse(command.Command).updates[0];
  assert.deepEqual(update.q.displayName, { $eq: 'Ａ Ｂ' });
  assert.deepEqual(update.q.normalizedDisplayName, { $eq: 'ab' });
  assert.deepEqual(update.q.normalizationVersion, { $exists: false });
  assert.equal(update.upsert, false);
  assert.equal(update.multi, false);
  assert.equal('displayName' in update.u.$set, false);
});

test('回填读取以 ID 游标每批最多 100 条，仅访问三个客户集合', () => {
  const calls = [];
  const result = readCollections('test-env', commands => {
    const command = commands[0];
    const query = JSON.parse(command.Command);
    calls.push({ collection: command.TableName, query });
    if (command.TableName !== 'customers' || query.filter._id) return [[]];
    return [Array.from({ length: 100 }, (_, i) => ({ _id: `id-${String(i).padStart(3, '0')}` }))];
  });
  assert.equal(result.customers.length, 100);
  assert.deepEqual(calls[1].query.filter, { _id: { $gt: 'id-099' } });
  assert.equal(calls.every(call => call.query.limit === 100), true);
  assert.equal(calls.some(call => call.collection === 'orders'), false);
});

test('遇到并发资料修改不覆盖新值，记录冲突并允许下次重新计算', () => {
  const data = { customers: fixture().customers };
  const result = applyBackfill(data, 'test-env', commands => {
    if (commands[0].CommandType === 'UPDATE') return [{}];
    return [[{ _id: 'c1', displayName: '并发新名字', normalizedDisplayName: 'ab' }]];
  });
  assert.equal(result[0].status, 'conflict_retry_required');
  const patch = derivePatch('customers', { _id: 'c1', displayName: '并发新名字', normalizedDisplayName: 'ab' });
  assert.equal(patch.normalizedDisplayName, '并发新名字');
});

test('写入需显式环境确认，默认本地 dry-run 不调用云服务且报告不含身份值', () => {
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(['--env', 'prod', '--apply']));
  assert.throws(() => parseArgs(['--env', 'prod', '--apply', '--confirm', 'test']));
  assert.throws(() => parseArgs(['--input', 'fixture.json', '--apply']));
  assert.equal(parseArgs(['--env', 'test', '--apply', '--confirm', 'test']).apply, true);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-normalization-'));
  try {
    const input = path.join(directory, 'input.json');
    const output = path.join(directory, 'report.json');
    fs.writeFileSync(input, JSON.stringify(fixture()));
    execFileSync(process.execPath, [path.join(__dirname, 'backfill-customer-normalization.cjs'), '--input', input, '--output', output], { env: { ...process.env, PATH: '' } });
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(report.dryRun, true);
    assert.equal(report.counts.customer_aliases.scanned, 3);
    assert.equal(JSON.stringify(report).includes('13800138000'), false);
    assert.equal(fs.readFileSync(input, 'utf8'), JSON.stringify(fixture()));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
