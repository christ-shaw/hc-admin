const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// 仅模拟 React 的状态槽位，执行真实 useInbound；不访问线上入库数据。
function renderInbound(handler) {
  const slots = [];
  const calls = [];
  let slot = 0;
  let current;
  let useInbound;
  const render = () => { slot = 0; current = useInbound(); };
  const react = {
    useState(initial) {
      const index = slot++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], update => {
        slots[index] = typeof update === 'function' ? update(slots[index]) : update;
        render();
      }];
    },
    useRef(initial) {
      const index = slot++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback(fn, deps) {
      const index = slot++;
      const previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        slots[index] = { fn, deps };
      }
      return slots[index].fn;
    },
  };
  const filename = process.env.INBOUND_HOOK_SOURCE || path.join(__dirname, '../src/hooks/useInbound.ts');
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, {
    exports: module.exports,
    module,
    Error,
    console: { error() {} },
    require(id) {
      if (id === 'react') return react;
      if (id === '../utils/constants') return { PAGE_SIZE: 20 };
      if (id === '../lib/cloudbase') return {
        getCurrentPermissionUserPayload: async () => null,
        callFunction(name, { data }) {
          calls.push({ name, data: JSON.parse(JSON.stringify(data)) });
          return handler(name, data);
        },
      };
      throw new Error('Unexpected module: ' + id);
    },
  }, { filename });
  useInbound = module.exports.useInbound;
  render();
  return { get current() { return current; }, calls };
}

const allRecords = Array.from({ length: 45 }, (_, i) => ({ _id: String(i + 1), customerName: i < 25 ? '大汉烟酒（肖）' : '其他客户' }));
function response(data) {
  const matches = allRecords.filter(row => !data.customerName || row.customerName.includes(data.customerName));
  const start = Number(data.cursor) || 0;
  return { success: true, data: matches.slice(start, start + 20), total: matches.length,
    cursor: start + 20 < matches.length ? start + 20 : null, hasMore: start + 20 < matches.length };
}
const ids = hook => Array.from(hook.current.records, row => row._id);

test('姓名查询替换旧列表，空结果清空记录及总数', async () => {
  const hook = renderInbound((_, data) => response(data));
  await hook.current.fetchRecords();
  assert.equal(hook.current.totalRecords, 45);
  await hook.current.fetchRecords(null, { customerName: '大汉' });
  assert.equal(hook.current.totalRecords, 25);
  assert.ok(hook.current.records.every(row => row.customerName.includes('大汉')));
  await hook.current.fetchRecords(null, { customerName: '无匹配客户' });
  assert.equal(hook.current.records.length, 0);
  assert.equal(hook.current.totalRecords, 0);
  assert.equal(hook.current.hasMore, false);
  assert.equal(hook.current.currentPage, 1);
});

test('上一页再下一页仍为同一页，不追加重复数据或跳页', async () => {
  const hook = renderInbound((_, data) => response(data));
  await hook.current.fetchRecords(null, { customerName: '大汉' });
  await hook.current.changePage(2);
  const secondPage = ids(hook);
  assert.equal(secondPage.length, 5);
  await hook.current.changePage(1);
  await hook.current.changePage(2);
  assert.deepEqual(ids(hook), secondPage);
  assert.equal(hook.current.currentPage, 2);
  assert.equal(hook.current.totalRecords, 25);
  assert.equal(hook.current.hasMore, false);
  assert.ok(hook.calls.every(call => call.data.customerName === '大汉'));
});

test('旧姓名查询慢返回不得覆盖新查询的空结果', async () => {
  let finishOld;
  const hook = renderInbound((_, data) => data.customerName === '大汉'
    ? new Promise(resolve => { finishOld = () => resolve(response(data)); }) : response(data));
  const old = hook.current.fetchRecords(null, { customerName: '大汉' });
  await new Promise(resolve => setImmediate(resolve));
  await hook.current.fetchRecords(null, { customerName: '无匹配客户' });
  finishOld();
  await old;
  assert.equal(hook.current.records.length, 0);
  assert.equal(hook.current.filters.customerName, '无匹配客户');
  assert.equal(hook.current.loading, false);
});

test('旧请求报错不覆盖重置后的成功状态；新查询失败显示错误', async () => {
  let failOld;
  const hook = renderInbound((_, data) => data.customerName === '超时'
    ? new Promise((_, reject) => { failOld = () => reject(new Error('请求超时')); }) : response(data));
  const old = hook.current.fetchRecords(null, { customerName: '超时' });
  await new Promise(resolve => setImmediate(resolve));
  await hook.current.fetchRecords(null, {});
  failOld();
  await old;
  assert.equal(hook.current.error, null);
  assert.equal(hook.current.totalRecords, 45);
  const failed = hook.current.fetchRecords(null, { customerName: '超时' });
  assert.equal(hook.current.records.length, 0);
  await new Promise(resolve => setImmediate(resolve));
  failOld();
  await failed;
  assert.equal(hook.current.error, '请求超时');
  assert.equal(hook.current.records.length, 0);
});

test('重复记录不会向表格传入重复行标识', async () => {
  const hook = renderInbound(() => ({ success: true, data: [allRecords[0], allRecords[0]], total: 1, cursor: null, hasMore: false }));
  await hook.current.fetchRecords();
  assert.deepEqual(ids(hook), ['1']);
});

test('导出分页始终保留列表的人名及其他筛选条件', async () => {
  const hook = renderInbound((_, data) => response(data));
  const filters = {
    customerName: '大汉',
    channelType: 'return',
    trackingNumber: 'SF',
    startDate: '2026-01-01',
    endDate: '2026-06-30',
  };
  const records = await hook.current.fetchAllRecords(filters);
  assert.equal(records.length, 25);
  assert.ok(records.every(row => row.customerName.includes('大汉')));
  assert.ok(hook.calls.length >= 2);
  assert.ok(hook.calls.every(call => Object.entries(filters).every(([key, value]) => call.data[key] === value)));
});
