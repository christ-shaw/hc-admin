#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { manifest, planSchema, applySchema } = require('./customerSchema.cjs');
function parseArgs(argv) {
  const args = { apply: false, region: 'ap-shanghai' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') args.apply = true;
    else if (['--env', '--confirm', '--input', '--region'].includes(argv[i])) {
      const key = argv[i].slice(2), value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('缺少参数值');
      args[key] = value;
    } else throw new Error('未知参数');
  }
  if (Boolean(args.env) === Boolean(args.input)) throw new Error('必须指定 --env 或 --input');
  if (args.apply && (!args.env || args.confirm !== args.env)) throw new Error('写入要求 --confirm 与 --env 相同');
  return args;
}
function liveAdapter(args, execute = execFileSync) {
  function call(service, action, body, version) {
    const stdout = execute('cloudbase', ['-e', args.env, '-r', args.region, 'api', service, action, '--api-version', version, '--body', JSON.stringify(body), '--json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024,
    });
    // CLI 3.3 emits an informational line even with --json. Parse the JSON envelope only.
    const start = stdout.search(/^\s*\{/m);
    if (start < 0) throw new Error('CloudBase 未返回 JSON');
    const result = JSON.parse(stdout.slice(start));
    if (result.error || result.data?.Error || !result.data) throw new Error('CloudBase 结构操作失败');
    return result.data;
  }
  const environment = call('tcb', 'DescribeEnvs', { EnvId: args.env }, '2018-06-08').EnvList?.find(row => row.EnvId === args.env);
  const tag = environment?.Databases?.[0]?.InstanceId;
  if (!tag) throw new Error('无法确认目标环境数据库');
  const flex = (action, body) => call('flexdb', action, { Tag: tag, ...body }, '2018-11-27');
  return {
    async read() {
      const names = new Set();
      for (let offset = 0; ; offset += 100) {
        const tables = flex('ListTables', { MgoOffset: offset, MgoLimit: 100 }).Tables;
        if (!Array.isArray(tables) && tables !== null) throw new Error('集合列表格式无效');
        for (const table of tables || []) names.add(table.TableName);
        if (!tables || tables.length < 100) break;
      }
      const structure = {};
      for (const collection of Object.keys(manifest)) if (names.has(collection)) {
        const indexes = flex('DescribeTable', { TableName: collection }).Indexes;
        if (!Array.isArray(indexes)) throw new Error('索引列表格式无效');
        structure[collection] = indexes;
      }
      return structure;
    },
    async create(collection) { flex('CreateTable', { TableName: collection }); },
    async index(collection, index) { flex('UpdateTable', { TableName: collection, CreateIndexes: [{
      IndexName: index.Name, MgoKeySchema: { MgoIndexKeys: index.Keys, MgoIsUnique: index.Unique },
    }] }); },
  };
}
async function main(argv) {
  const args = parseArgs(argv);
  const adapter = args.env ? liveAdapter(args) : null;
  const structure = adapter ? await adapter.read() : JSON.parse(fs.readFileSync(args.input, 'utf8'));
  const report = args.apply ? await applySchema(structure, adapter) : planSchema(structure);
  console.log(JSON.stringify({ dryRun: !args.apply, ...report }, null, 2));
  if (report.conflicts.length || (args.apply && report.operations.length)) process.exitCode = 2;
}
if (require.main === module) main(process.argv.slice(2)).catch(() => { console.error('客户集合/索引检查失败，请核对参数、CLI 登录及目标环境；未核验成功前勿部署写入功能。'); process.exitCode = 1; });
module.exports = { parseArgs, liveAdapter, main };
