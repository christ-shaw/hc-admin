const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function renderOutbound(handler) {
  const slots = [];
  const calls = [];
  let slot = 0;
  let current;
  let useOutbound;
  const render = () => { slot = 0; current = useOutbound(); };
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
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) slots[index] = { fn, deps };
      return slots[index].fn;
    },
  };
  const filename = path.join(__dirname, '../src/hooks/useOutbound.ts');
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
      throw new Error(`Unexpected module: ${id}`);
    },
  }, { filename });
  useOutbound = module.exports.useOutbound;
  render();
  return { get current() { return current; }, calls };
}

const allRecords = Array.from({ length: 45 }, (_, index) => ({
  _id: String(index + 1),
  customerName: index < 25 ? '大汉烟酒（肖）' : '其他客户',
}));

function response(data) {
  const matches = allRecords.filter(row => !data.customerName || row.customerName.includes(data.customerName));
  const start = Number(data.cursor) || 0;
  const limit = Number(data.limit) || 20;
  return {
    success: true,
    data: matches.slice(start, start + limit),
    total: matches.length,
    cursor: start + limit < matches.length ? start + limit : null,
    hasMore: start + limit < matches.length,
  };
}

test('出库姓名查询替换旧列表并返回准确总数', async () => {
  const hook = renderOutbound((_, data) => response(data));
  await hook.current.fetchRecords();
  assert.equal(hook.current.totalRecords, 45);
  await hook.current.fetchRecords(null, { customerName: '大汉' });
  assert.equal(hook.current.totalRecords, 25);
  assert.ok(hook.current.records.every(row => row.customerName.includes('大汉')));
  await hook.current.fetchRecords(null, { customerName: '无匹配客户' });
  assert.equal(hook.current.records.length, 0);
  assert.equal(hook.current.totalRecords, 0);
});

test('出库上一页再下一页不重复、不跳页', async () => {
  const hook = renderOutbound((_, data) => response(data));
  await hook.current.fetchRecords(null, { customerName: '大汉' });
  await hook.current.changePage(2);
  const secondPageIds = Array.from(hook.current.records, row => row._id);
  await hook.current.changePage(1);
  await hook.current.changePage(2);
  assert.deepEqual(Array.from(hook.current.records, row => row._id), secondPageIds);
  assert.equal(hook.current.currentPage, 2);
  assert.equal(hook.current.totalRecords, 25);
});

test('出库导出分页始终保留人名及其他列表筛选条件', async () => {
  const hook = renderOutbound((_, data) => response(data));
  const filters = {
    customerName: '大汉',
    trackingNumber: 'SF',
    model: '苹果',
    outboundStatus: 'completed',
    startDate: '2026-01-01',
    endDate: '2026-06-30',
  };
  const records = await hook.current.fetchAllRecords(filters);
  assert.equal(records.length, 25);
  assert.ok(records.every(row => row.customerName.includes('大汉')));
  assert.ok(hook.calls.every(call => Object.entries(filters).every(([key, value]) => call.data[key] === value)));
});
