const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const XLSX = require('xlsx');

function loadExport(handler) {
  const calls = [];
  const files = [];
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const module = { exports: {} };
    cache.set(filename, module.exports);
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    vm.runInNewContext(source, {
      module, exports: module.exports,
      require(id) {
        if (id === 'xlsx') return {
          ...XLSX,
          writeFile(workbook, filename) {
            // 用真实 XLSX 编码再读回，验证最终文件的列、单元格类型和内容。
            const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
            files.push({ filename, workbook: XLSX.read(bytes, { type: 'buffer', cellNF: true }) });
          },
        };
        if (id === '../lib/cloudbase') return {
          async callFunction(name, { data }) {
            assert.equal(name, 'queryInvoices');
            calls.push({ ...data });
            return handler(data);
          },
        };
        if (id.startsWith('.')) return load(path.resolve(path.dirname(filename), `${id}.ts`));
        throw new Error(`Unexpected module: ${id}`);
      },
    }, { filename });
    return module.exports;
  }
  return { ...load(path.resolve(__dirname, '../src/utils/invoiceExcel.ts')), calls, files };
}

function records(count) {
  return Array.from({ length: count }, (_, i) => ({
    _id: `invoice-${i}`, applyDate: '2026-09-01', companyName: '测试公司',
    shopName: '测试店铺', invoiceAmount: i === 0 ? 0 : 1234.56,
    applicant: '张三', status: ['paid', 'unpaid', '已开票', '未开票'][i % 4],
  }));
}

function query(rows) {
  return ({ page, pageSize }) => ({
    success: true, page, pageSize, total: rows.length,
    data: rows.slice((page - 1) * pageSize, page * pageSize),
  });
}

test('导出跨越三页的全部发票，每页保留日期及其他筛选，真实 Excel 包含指定六列', async () => {
  const rows = records(205);
  rows[4].companyName = '=1+1';
  const exporter = loadExport(query(rows));
  const filters = {
    startDate: '2026-09-01', endDate: '2026-09-14',
    companyName: ' 测试 ', applicant: ' 张三 ', status: 'unpaid',
  };
  assert.equal(await exporter.exportInvoicesExcel(filters), 205);
  assert.equal(exporter.calls.length, 3);
  exporter.calls.forEach((call, i) => assert.deepEqual(call, {
    ...filters, companyName: '测试', applicant: '张三', page: i + 1, pageSize: 100,
  }));
  assert.equal(filters.companyName, ' 测试 ');
  assert.equal(exporter.files.length, 1);
  const { filename, workbook } = exporter.files[0];
  assert.equal(filename, '发票明细_2026-09-01_至_2026-09-14.xlsx');
  const sheet = workbook.Sheets['发票明细'];
  const values = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  assert.deepEqual(values[0], ['申请日期', '公司名称', '店铺名字', '开票金额', '开票申请人', '开票状态']);
  assert.equal(values.length, 206);
  assert.deepEqual(values[1], ['2026-09-01', '测试公司', '测试店铺', 0, '张三', '已开票']);
  assert.equal(sheet.D3.t, 'n');
  assert.equal(sheet.D3.v, 1234.56);
  assert.equal(sheet.D3.z, '#,##0.00');
  assert.deepEqual(values.slice(1, 5).map(row => row[5]), ['已开票', '未开票', '已开票', '未开票']);
  assert.equal(sheet.B6.t, 's');
  assert.equal(sheet.B6.v, '=1+1');
  assert.equal(sheet.B6.f, undefined);
});

test('空结果不生成文件，未选日期和单边日期可导出，支持自定义状态字典', async () => {
  const empty = loadExport(query([]));
  assert.equal(await empty.exportInvoicesExcel({}), 0);
  assert.equal(empty.files.length, 0);
  for (const filters of [{}, { startDate: '2026-09-01' }, { endDate: '2026-09-01' },
    { startDate: '2026-09-01', endDate: '2026-09-01' }]) {
    const exporter = loadExport(query(records(1)));
    assert.equal(await exporter.exportInvoicesExcel(filters, { paid: '开票完成' }), 1);
    assert.equal(exporter.calls[0].startDate, filters.startDate);
    assert.equal(exporter.calls[0].endDate, filters.endDate);
    assert.equal(exporter.files[0].workbook.Sheets['发票明细'].F2.v, '开票完成');
  }
});

test('反向日期范围在查询前报错', async () => {
  const exporter = loadExport(query(records(1)));
  await assert.rejects(exporter.exportInvoicesExcel({ startDate: '2026-09-15', endDate: '2026-09-01' }), /开始日期不能晚于结束日期/);
  assert.equal(exporter.calls.length, 0);
  assert.equal(exporter.files.length, 0);
});

test('后续页失败、缺失、重复、总数变化或页码回退时不下载残缺文件', async () => {
  const rows = records(101);
  for (const broken of [
    { success: false, errMsg: '读取失败' },
    { success: true, page: 2, pageSize: 100, total: 101, data: [] },
    { success: true, page: 2, pageSize: 100, total: 101, data: [rows[0]] },
    { success: true, page: 2, pageSize: 100, total: 102, data: [rows[100]] },
    { success: true, page: 1, pageSize: 100, total: 101, data: [rows[100]] },
    { success: true, data: [] },
  ]) {
    const exporter = loadExport(data => data.page === 1 ? query(rows)(data) : broken);
    await assert.rejects(exporter.exportInvoicesExcel({}), /失败|异常|变化/);
    assert.equal(exporter.files.length, 0);
  }
  const exporter = loadExport(() => { throw new Error('网络异常'); });
  await assert.rejects(exporter.exportInvoicesExcel({}), /网络异常/);
  assert.equal(exporter.files.length, 0);
});
