#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { COLLECTION_FIELDS, derivePatch, updateCommand, preview } = require('./customerNormalizationBackfill.cjs');

function parseArgs(argv) {
  const args = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') args.apply = true;
    else if (['--env', '--confirm', '--input', '--output'].includes(argv[i])) {
      const key = argv[i].slice(2);
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`缺少参数值: --${key}`);
      args[key] = value;
    } else throw new Error(`未知参数: ${argv[i]}`);
  }
  if (Boolean(args.env) === Boolean(args.input)) throw new Error('必须指定 --env 或 --input，且只能指定一项');
  if (args.apply && (!args.env || args.confirm !== args.env)) throw new Error('写入模式要求 --env 与同值的 --confirm，不支持写入本地输入文件');
  return args;
}

function execute(commands, envId) {
  const stdout = execFileSync('cloudbase', ['-e', envId, 'db', 'nosql', 'execute', '--command', JSON.stringify(commands), '--json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 20 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  if (parsed.error || !Array.isArray(parsed.data?.results)) throw new Error('CloudBase 命令失败或返回格式无效');
  for (const result of parsed.data.results) if (result?.error) throw new Error('CloudBase 子命令失败');
  return parsed.data.results;
}

function query(collection, filter, limit = 100) {
  return { TableName: collection, CommandType: 'QUERY', Command: JSON.stringify({ find: collection, filter, sort: { _id: 1 }, limit }) };
}

function readCollections(envId, run = execute) {
  const collections = {};
  for (const collection of Object.keys(COLLECTION_FIELDS)) {
    const rows = [];
    let cursor = '';
    for (;;) {
      const [page] = run([query(collection, cursor ? { _id: { $gt: cursor } } : {})], envId);
      if (!Array.isArray(page)) throw new Error('CloudBase 查询返回格式无效');
      rows.push(...page);
      if (page.length < 100) break;
      const next = page[page.length - 1]._id;
      if (typeof next !== 'string' || next <= cursor) throw new Error('回填游标未推进');
      cursor = next;
    }
    collections[collection] = rows;
  }
  return collections;
}

function applyBackfill(collections, envId, run = execute) {
  const results = [];
  for (const [collection, rows] of Object.entries(collections)) {
    if (!Object.prototype.hasOwnProperty.call(COLLECTION_FIELDS, collection)) continue;
    for (const row of rows) {
      const patch = derivePatch(collection, row);
      if (!Object.keys(patch).length) continue;
      run([updateCommand(collection, row, patch)], envId);
      const [current] = run([query(collection, { _id: row._id }, 1)], envId);
      if (!Array.isArray(current)) throw new Error('回填验证返回格式无效');
      const upToDate = current.length === 1 && Object.keys(derivePatch(collection, current[0])).length === 0;
      results.push({ collection, id: row._id, status: upToDate ? 'up_to_date' : 'conflict_retry_required' });
    }
  }
  return results;
}

function main(argv) {
  const args = parseArgs(argv);
  const collections = args.input ? JSON.parse(fs.readFileSync(args.input, 'utf8')) : readCollections(args.env);
  const report = { ...preview(collections), dryRun: !args.apply, envId: args.env || null, generatedAt: new Date().toISOString() };
  if (args.apply) report.results = applyBackfill(collections, args.env);
  const output = path.resolve(args.output || `output/customer-normalization-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ output, dryRun: report.dryRun, counts: report.counts, aliasCollisionCount: report.aliasCollisions.length }));
  if (report.results?.some(row => row.status !== 'up_to_date')) process.exitCode = 2;
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (_) { console.error('客户标准化回填失败，请检查参数、CLI 登录及集合状态；可安全重跑。'); process.exitCode = 1; }
}

module.exports = { parseArgs, readCollections, applyBackfill, main };
