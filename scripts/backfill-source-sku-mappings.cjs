#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { buildColdStartMappings } = require('./skuMappingBackfill.cjs');

const ROOT = path.resolve(__dirname, '..');
const PAGE_SIZE = 100;
const BATCH_SIZE = 20;

function parseArgs(argv) {
  const args = { apply: false, confirm: '', envId: '', output: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--apply') args.apply = true;
    else if (token === '--confirm') args.confirm = String(argv[++index] || '').trim();
    else if (token === '--env') args.envId = String(argv[++index] || '').trim();
    else if (token === '--output') args.output = String(argv[++index] || '').trim();
    else throw new Error(`未知参数: ${token}`);
  }
  if (!args.envId) {
    args.envId = String(JSON.parse(fs.readFileSync(path.join(ROOT, 'cloudbaserc.json'), 'utf8')).envId || '').trim();
  }
  if (!args.envId) throw new Error('缺少 CloudBase 环境 ID，请传 --env');
  if (args.apply && args.confirm !== args.envId) {
    throw new Error(`正式写入必须同时传入 --confirm ${args.envId}`);
  }
  return args;
}

function execute(commands, envId) {
  const stdout = execFileSync('cloudbase', [
    '-e', envId, 'db', 'nosql', 'execute', '--command', JSON.stringify(commands), '--json',
  ], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 50 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
  return parsed.data && parsed.data.results || [];
}

function queryCommand(tableName, filter, projection, skip, limit) {
  return {
    TableName: tableName,
    CommandType: 'QUERY',
    Command: JSON.stringify({ find: tableName, filter, projection, sort: { _id: 1 }, skip, limit }),
  };
}

function fetchAll(tableName, filter, projection, envId) {
  const all = [];
  for (let skip = 0; ; skip += PAGE_SIZE) {
    const results = execute([queryCommand(tableName, filter, projection, skip, PAGE_SIZE)], envId);
    const page = results[0] || [];
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return all;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function fetchOrders(orderIds, envId) {
  return chunks([...new Set(orderIds)].filter(Boolean), PAGE_SIZE).flatMap(ids => {
    if (ids.length === 0) return [];
    const results = execute([queryCommand('orders', { _id: { $in: ids } }, {
      _id: 1, onlineOrderNumber: 1, importSource: 1, products: 1,
      brand: 1, productName: 1, specification: 1, quantity: 1, sourceOrderItemNo: 1,
    }, 0, PAGE_SIZE)], envId);
    return results[0] || [];
  });
}

function fetchExistingMappingIds(mappingIds, envId) {
  return chunks(mappingIds, PAGE_SIZE).flatMap(ids => {
    if (ids.length === 0) return [];
    const results = execute([queryCommand('source_sku_mapping', { _id: { $in: ids } }, { _id: 1 }, 0, PAGE_SIZE)], envId);
    return (results[0] || []).map(item => item._id);
  });
}

function insertMappings(mappings, envId) {
  for (const batch of chunks(mappings, BATCH_SIZE)) {
    execute([{
      TableName: 'source_sku_mapping',
      CommandType: 'UPDATE',
      Command: JSON.stringify({
        update: 'source_sku_mapping',
        updates: batch.map(mapping => ({
          q: { _id: mapping._id },
          u: { $setOnInsert: mapping },
          upsert: true,
          multi: false,
        })),
      }),
    }], envId);
  }
}

function defaultOutputPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(ROOT, 'output', `sku-mapping-backfill-${stamp}.json`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const logs = fetchAll('order_import_logs', { source: 'zanchenzu', status: 'success' }, {
    _id: 1, source: 1, status: 1, sourceOrderNo: 1, sourceOrderItemNo: 1, createdOrderId: 1,
    'rawPayload.goodsTitle': 1,
  }, args.envId);
  const productModelDocs = fetchAll('product_models', {}, {
    brand: 1, enabled: 1, products: 1,
  }, args.envId);
  const orders = fetchOrders(logs.map(log => log.createdOrderId), args.envId);

  const preview = buildColdStartMappings({ logs, orders, productModelDocs });
  const existingMappingIds = fetchExistingMappingIds(preview.mappings.map(item => item._id), args.envId);
  const result = buildColdStartMappings({ logs, orders, productModelDocs, existingMappingIds });
  if (args.apply && result.mappings.length > 0) insertMappings(result.mappings, args.envId);

  const report = {
    mappingVersion: 'v2',
    envId: args.envId,
    dryRun: !args.apply,
    generatedAt: new Date().toISOString(),
    stats: result.stats,
    mappings: result.mappings,
    skipped: result.skipped,
  };
  const outputPath = path.resolve(ROOT, args.output || defaultOutputPath());
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({ success: true, outputPath, dryRun: !args.apply, stats: result.stats }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error && error.stack || error);
  process.exitCode = 1;
}
