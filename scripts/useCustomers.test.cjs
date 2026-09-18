const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loadTypescript(relativePath, requireModule = () => { throw new Error('Unexpected dependency'); }) {
  const filename = path.join(__dirname, '..', relativePath);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: requireModule, Error });
  return module.exports;
}

const { canAccessCustomerPage } = loadTypescript('src/utils/customerPermissions.ts');

test('客户页同时要求独立页面权限和客户操作权限，订单角色不能靠回退进入', () => {
  assert.equal(canAccessCustomerPage(['/orders'], ['orders:create']), false);
  assert.equal(canAccessCustomerPage(['/orders'], ['customers:write']), false);
  assert.equal(canAccessCustomerPage(['/customers'], ['orders:update']), false);
  assert.equal(canAccessCustomerPage(['/customers'], []), false);
  assert.equal(canAccessCustomerPage(['*'], ['orders:read']), false);
  for (const action of ['customers:read', 'customers:write', 'customers:merge', '*']) {
    assert.equal(canAccessCustomerPage(['/customers'], [action]), true);
    assert.equal(canAccessCustomerPage(['*'], [action]), true);
  }
});

function renderCustomers(handler) {
  const slots = [];
  const calls = [];
  let slot = 0;
  let current;
  let useCustomers;
  const render = () => { slot = 0; current = useCustomers(); };
  const react = {
    useState(initial) {
      const index = slot++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], update => { slots[index] = typeof update === 'function' ? update(slots[index]) : update; render(); }];
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
  ({ useCustomers } = loadTypescript('src/hooks/useCustomers.ts', id => {
    if (id === '../utils/customerWriteRequest') return { customerWriteRequest: (_, data, send) => send(data.requestId || 'test-request-id') };
    if (id === 'react') return react;
    if (id === '../lib/cloudbase') return { callFunction(name, data) {
      calls.push({ name, data: JSON.parse(JSON.stringify(data)) });
      return handler(name, data);
    } };
    throw new Error('Unexpected dependency: ' + id);
  }));
  render();
  return { get current() { return current; }, calls };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('订单查询 hook 使用 search 和受限 get 并按页请求，不拉取管理列表', async () => {
  const hook = renderCustomers(async (_, data) => ({ success: true, data: data.action === 'search' ? [] : { _id: 'c1', aliases: [], recipients: [] }, total: 0 }));
  await hook.current.searchCustomers('客户名', 2);
  await hook.current.getOrderSelection('c1', 2, 3);
  assert.deepEqual(hook.calls.map(call => call.data), [
    { action: 'search', keyword: '客户名', page: 2, pageSize: 20 },
    { action: 'get', scope: 'orderSelection', customerId: 'c1', aliasPage: 2, recipientPage: 3, pageSize: 20 },
  ]);
});

test('管理列表仅保留当前页，慢响应不能覆盖新筛选结果', async () => {
  const slow = deferred();
  const hook = renderCustomers(async (_, data) => data.keyword === '旧' ? slow.promise : { success: true, data: [{ _id: 'new' }], total: 41 });
  const older = hook.current.loadCustomers({ keyword: '旧', page: 1 });
  await hook.current.loadCustomers({ keyword: '新', page: 2 });
  slow.resolve({ success: true, data: [{ _id: 'old' }], total: 2 });
  await older;
  assert.equal(hook.current.customers[0]._id, 'new');
  assert.equal(hook.current.total, 41);
  assert.equal(hook.current.loading, false);
  assert.equal(hook.calls[1].data.pageSize, 20);
  assert.equal(hook.calls[1].data.page, 2);
});

test('受限查询失败明确抛出，管理查询失败清空旧数据并显示错误', async () => {
  const hook = renderCustomers(async () => ({ success: false, errMsg: '无权访问' }));
  await assert.rejects(hook.current.getOrderSelection('c1'), /无权访问/);
  await assert.rejects(hook.current.searchCustomers('test'), /无权访问/);
  await hook.current.loadCustomers();
  assert.equal(hook.current.loadError, '无权访问');
  assert.equal(hook.current.customers.length, 0);
  assert.equal(hook.current.loading, false);
});
