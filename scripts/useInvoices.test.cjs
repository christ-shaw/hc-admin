const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// 仅模拟 React 的状态槽位，执行真实 useInvoices；不访问线上发票数据。
function renderInvoices(handler) {
  const slots = [];
  const calls = [];
  let slot = 0;
  let current;
  let useInvoices;
  const render = () => { slot = 0; current = useInvoices(); };
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
  const filename = path.join(__dirname, '../src/hooks/useInvoices.ts');
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
        callFunction(name, { data }) {
          calls.push({ name, data: JSON.parse(JSON.stringify(data)) });
          return handler(name, data);
        },
      };
      throw new Error('Unexpected module: ' + id);
    },
  }, { filename });
  useInvoices = module.exports.useInvoices;
  render();
  return { get current() { return current; }, calls };
}

function service(count = 45) {
  let records = Array.from({ length: count }, (_, index) => ({
    _id: String(index + 1), companyName: '测试公司', status: 'unpaid',
  }));
  return async (name, data) => {
    if (name === 'deleteInvoice') {
      records = records.filter(row => row._id !== data._id);
      return { success: true };
    }
    if (name === 'updateInvoice') {
      records = records.map(row => row._id === data._id ? { ...row, ...data.updateData } : row);
      return { success: true };
    }
    if (name === 'saveInvoice') {
      records = [{ _id: 'new', ...data.invoice }, ...records];
      return { success: true };
    }
    assert.equal(name, 'queryInvoices');
    const filtered = records.filter(row =>
      (!data.status || row.status === data.status)
      && (!data.companyName || row.companyName.includes(data.companyName)));
    const total = filtered.length;
    const pageSize = data.pageSize;
    const page = Math.max(1, Math.min(data.page, Math.ceil(total / pageSize)));
    return {
      success: true, total, page, pageSize,
      data: filtered.slice((page - 1) * pageSize, page * pageSize),
    };
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('翻页和回翻均按页请求，只保存当前页，显示服务端总数', async () => {
  const hook = renderInvoices(service());
  await hook.current.fetchRecords();
  assert.equal(hook.current.totalRecords, 45);
  assert.equal(hook.current.records.length, 20);
  await hook.current.changePage(3);
  assert.equal(hook.current.currentPage, 3);
  assert.equal(hook.current.records.length, 5);
  assert.equal(hook.current.records[0]._id, '41');
  await hook.current.changePage(1);
  assert.equal(hook.current.records[0]._id, '1');
  assert.deepEqual(hook.calls.map(item => item.data.page), [1, 3, 1]);
});

test('翻页保留已提交筛选，切换每页条数回第一页并继续用新条数查询', async () => {
  const hook = renderInvoices(service(80));
  await hook.current.fetchRecords(1, { companyName: '测试', status: 'unpaid' });
  await hook.current.changePage(3);
  await hook.current.changePage(3, 50);
  assert.equal(hook.current.currentPage, 1);
  assert.equal(hook.current.pageSize, 50);
  assert.equal(hook.current.records.length, 50);
  await hook.current.changePage(2);
  assert.deepEqual(hook.calls.at(-1).data, { companyName: '测试', status: 'unpaid', page: 2, pageSize: 50 });
  assert.equal(hook.current.records.length, 30);
});

test('新筛选和重置从第一页查询，不混入旧记录', async () => {
  const hook = renderInvoices(service());
  await hook.current.fetchRecords(3);
  await hook.current.fetchRecords(1, { companyName: '无结果' });
  assert.equal(hook.current.currentPage, 1);
  assert.equal(hook.current.totalRecords, 0);
  assert.equal(hook.current.records.length, 0);
  await hook.current.fetchRecords(1, {});
  assert.equal(hook.current.totalRecords, 45);
  assert.equal(hook.current.records[0]._id, '1');
});

test('接口失败或响应缺少分页信息时保留原页，并显示错误', async () => {
  const backend = service();
  let response;
  const hook = renderInvoices((name, data) => response || backend(name, data));
  await hook.current.fetchRecords(2);
  response = { success: false, errMsg: '查询暂时不可用', data: [] };
  await hook.current.changePage(3);
  assert.equal(hook.current.currentPage, 2);
  assert.equal(hook.current.totalRecords, 45);
  assert.equal(hook.current.records[0]._id, '21');
  assert.equal(hook.current.error, '查询暂时不可用');
  assert.equal(hook.current.loading, false);
  response = { success: true, data: [] };
  await hook.current.changePage(3);
  assert.match(hook.current.error, /分页数据异常/);
  response = null;
  await hook.current.changePage(3);
  assert.equal(hook.current.currentPage, 3);
  assert.equal(hook.current.error, null);
});

test('慢速旧查询不能覆盖新查询结果', async () => {
  const pending = [];
  const hook = renderInvoices(() => {
    const request = deferred();
    pending.push(request);
    return request.promise;
  });
  const old = hook.current.fetchRecords(1, { companyName: '旧条件' });
  const latest = hook.current.fetchRecords(1, { companyName: '新条件' });
  pending[1].resolve({ success: true, total: 1, page: 1, pageSize: 20, data: [{ _id: 'new' }] });
  await latest;
  pending[0].resolve({ success: true, total: 100, page: 1, pageSize: 20, data: [{ _id: 'old' }] });
  await old;
  assert.equal(hook.current.records[0]._id, 'new');
  assert.equal(hook.current.filters.companyName, '新条件');
  assert.equal(hook.current.totalRecords, 1);
});

test('过期请求失败不能结束新请求的加载状态或显示错误', async () => {
  const pending = [];
  const hook = renderInvoices(() => {
    const request = deferred();
    pending.push(request);
    return request.promise;
  });
  const old = hook.current.fetchRecords();
  const latest = hook.current.fetchRecords(2);
  pending[0].reject(new Error('旧请求失败'));
  await old;
  assert.equal(hook.current.loading, true);
  assert.equal(hook.current.error, null);
  pending[1].resolve({ success: true, total: 21, page: 2, pageSize: 20, data: [{ _id: '21' }] });
  await latest;
  assert.equal(hook.current.loading, false);
});

test('删除末页最后一条后重新查询并接受服务端回退的页码', async () => {
  const hook = renderInvoices(service(21));
  await hook.current.fetchRecords(2);
  assert.equal(await hook.current.deleteInvoice('21'), true);
  assert.equal(hook.current.currentPage, 1);
  assert.equal(hook.current.records.length, 20);
  assert.equal(hook.current.totalRecords, 20);
  assert.equal(hook.calls.at(-1).name, 'queryInvoices');
  assert.equal(hook.calls.at(-1).data.page, 2);
});

test('开票状态变化后按原筛选刷新并修正总数，新增回第一页', async () => {
  const hook = renderInvoices(service(21));
  await hook.current.fetchRecords(2, { status: 'unpaid' });
  assert.equal(await hook.current.updateInvoice('21', { status: 'paid' }), true);
  assert.equal(hook.current.currentPage, 1);
  assert.equal(hook.current.totalRecords, 20);
  assert.ok(hook.current.records.every(row => row.status === 'unpaid'));
  await hook.current.addInvoice({ companyName: '测试公司', status: 'unpaid' });
  assert.equal(hook.current.currentPage, 1);
  assert.equal(hook.current.totalRecords, 21);
  assert.equal(hook.current.records[0]._id, 'new');
});
