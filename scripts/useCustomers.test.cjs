const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loadTypescript(relativePath, requireModule = () => { throw new Error('Unexpected dependency'); }, globals = {}) {
  const filename = path.join(__dirname, '..', relativePath);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: requireModule, Error, ...globals });
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

test('录单检查申请可复用结果，普通客户匹配不改变接口范围', async () => {
  const hook = renderCustomers(async () => ({ success: true, data: { archiveCheckId: 'server-check' } }));
  const identity = { customerName: '客户' };
  assert.equal((await hook.current.matchCustomerIdentity(identity, true)).archiveCheckId, 'server-check');
  await hook.current.matchCustomerIdentity(identity);
  assert.deepEqual(hook.calls.map(call => call.data), [
    { action: 'matchIdentity', identity, scope: 'orderArchive' }, { action: 'matchIdentity', identity },
  ]);
});

// Exercise the archive hook with deterministic effects, promises and a fake clock.
function archiveHook() {
  const slots = [], effects = [], timers = new Map(), calls = [];
  let cursor = 0, now = 0, nextTimer = 0, dirty = true, result;
  let props = { enabled: true, identity: { customerName: '' }, choice: undefined };
  const changed = (a, b) => !a || a.length !== b.length || b.some((value, i) => !Object.is(a[i], value));
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => {
        const next = typeof value === 'function' ? value(slots[i]) : value;
        if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; }
      }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useCallback(fn, deps) {
      const i = cursor++;
      if (changed(slots[i]?.deps, deps)) slots[i] = { fn, deps };
      return slots[i].fn;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (changed(slots[i]?.deps, deps)) {
        effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
      }
    },
  };
  const matchCustomerIdentity = (identity, forOrderArchive) => { const request = deferred(); calls.push({ identity, forOrderArchive, ...request }); return request.promise; };
  const { useOrderCustomerArchive } = loadTypescript('src/hooks/useOrderCustomerArchive.ts', id => id === 'react' ? react : { useCustomers: () => ({ matchCustomerIdentity }) }, {
    window: {
      setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { at: now + delay, fn }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
  });
  function flush() {
    for (let i = 0; dirty; i++) {
      assert.ok(i < 30, 'hook must settle'); dirty = false; cursor = 0;
      result = useOrderCustomerArchive(props.enabled, props.identity, props.choice);
      effects.splice(0).forEach(run => run());
    }
  }
  flush();
  return {
    calls,
    get current() { flush(); return result; },
    change(patch) { props = { ...props, ...patch }; dirty = true; flush(); },
    async advance(ms) {
      flush(); const target = now + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); flush();
      }
      now = target;
      // Drain the promise's then/catch/finally handlers as well as effect updates.
      for (let i = 0; i < 6; i++) { await Promise.resolve(); flush(); }
    },
  };
}
const noMatch = { status: 'no_match', candidates: [], archiveCheckId: 'order-check-test' };

test('名称或收货资料输入期间不查重，离开输入区后只核对最新内容', async () => {
  const hook = archiveHook();
  hook.current.beginEditing();
  hook.change({ identity: { customerName: '朱' } });
  await hook.advance(10000);
  hook.change({ identity: { customerName: '朱贵' } });
  await hook.advance(10000);
  assert.equal(hook.calls.length, 0);
  assert.equal(hook.current.waitingForBlur, true);
  hook.current.endEditing();
  await hook.advance(299); assert.equal(hook.calls.length, 0);
  await hook.advance(1); assert.equal(hook.calls.length, 1);
  assert.equal(hook.calls[0].identity.customerName, '朱贵');
  assert.equal(hook.calls[0].forOrderArchive, true);
  hook.calls[0].resolve(noMatch); await hook.advance(0);
  assert.equal(hook.current.checked, true);
  assert.equal(hook.current.archiveCheckId, noMatch.archiveCheckId);
  hook.change({ choice: false }); assert.equal(hook.current.checked, false);
  hook.current.beginEditing();
  hook.change({ identity: { customerName: '朱贵', phone: '138' } });
  await hook.advance(2000); assert.equal(hook.calls.length, 1);
  assert.equal(hook.current.checked, false);
  assert.equal(hook.current.archiveCheckId, undefined);
  hook.current.endEditing(); await hook.advance(300);
  assert.equal(hook.calls.length, 2);
});

test('重复聚焦不重复核对，同一身份的在途请求合并，旧身份响应不能覆盖新身份', async () => {
  const hook = archiveHook();
  hook.change({ identity: { customerName: '旧名称' } }); await hook.advance(300);
  hook.current.beginEditing(); await hook.advance(10);
  hook.current.endEditing(); await hook.advance(300);
  assert.equal(hook.calls.length, 1);
  hook.change({ identity: { customerName: '新名称' } }); await hook.advance(300);
  assert.equal(hook.calls.length, 2);
  hook.calls[0].resolve(noMatch); await hook.advance(0);
  assert.equal(hook.current.checked, false); assert.equal(hook.current.checking, true);
  hook.calls[1].resolve({ status: 'incomplete', candidates: [{ customerId: 'existing', score: 40 }] });
  await hook.advance(0);
  assert.equal(hook.current.candidates[0].customerId, 'existing');
  hook.current.beginEditing(); await hook.advance(1);
  hook.current.endEditing(); await hook.advance(300);
  assert.equal(hook.calls.length, 2); assert.equal(hook.current.checked, false);
});

test('核对失败或超时不自动建档，重试会重新请求，取消录单忽略迟到响应', async () => {
  const hook = archiveHook();
  hook.change({ identity: { customerName: '测试客户' } }); await hook.advance(300);
  await hook.advance(8000);
  assert.equal(hook.current.checking, false); assert.equal(hook.current.checked, false);
  assert.match(hook.current.error, /超时/);
  hook.current.retry(); await hook.advance(300); assert.equal(hook.calls.length, 2);
  hook.calls[0].resolve(noMatch); await hook.advance(0); assert.equal(hook.current.checked, false);
  hook.calls[1].reject(new Error('network')); await hook.advance(0);
  assert.match(hook.current.error, /暂不可用/); assert.equal(hook.current.checked, false);
  hook.current.retry(); await hook.advance(300);
  hook.change({ enabled: false }); hook.calls[2].resolve(noMatch); await hook.advance(0);
  assert.equal(hook.current.visible, false); assert.equal(hook.current.checked, false);
});

test('没有服务端复用结果不勾选建档；重试成功后使用新的结果', async () => {
  const hook = archiveHook();
  hook.change({ identity: { customerName: '新客户' } }); await hook.advance(300);
  hook.calls[0].resolve({ status: 'no_match', candidates: [] }); await hook.advance(0);
  assert.equal(hook.current.checked, false); assert.equal(hook.current.archiveCheckId, undefined);
  assert.match(hook.current.error, /检查结果暂不可用/);
  hook.current.retry(); await hook.advance(300);
  hook.calls[1].resolve({ ...noMatch, archiveCheckId: 'new-check' }); await hook.advance(0);
  assert.equal(hook.current.checked, true); assert.equal(hook.current.archiveCheckId, 'new-check');
});
