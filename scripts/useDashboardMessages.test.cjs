const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// Execute the real hook with controlled React state and network responses.
function renderMessages(handler) {
  const slots = [];
  const calls = [];
  const effects = [];
  let timer;
  let cleanup;
  let slot = 0;
  let current;
  let useDashboardMessages;
  const render = () => { slot = 0; current = useDashboardMessages(); };
  const react = {
    useEffect(fn) { const index = slot++; if (!(index in slots)) { slots[index] = true; effects.push(fn); } },
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
  const filename = process.env.DASHBOARD_HOOK_SOURCE || path.join(__dirname, '../src/hooks/useDashboardMessages.ts');
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, {
    exports: module.exports,
    module,
    Error,
    window: { setInterval(fn) { timer = fn; return 1; }, clearInterval() { timer = null; } },
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
  useDashboardMessages = module.exports.useDashboardMessages;
  render();
  for (const effect of effects) cleanup = effect();
  return { get current() { return current; }, calls, tick: () => timer(), unmount: () => cleanup() };
}


const flush = () => new Promise(resolve => setImmediate(resolve));
const result = { success: true, data: { unreturned: { total: 35, orders: [] }, unreceived: { total: 8, orders: [] } } };
test('mount uses one summary request; concurrent refresh and timer do not overlap', async () => {
  let finish;
  const hook = renderMessages(() => new Promise(resolve => { finish = resolve; }));
  await flush();
  const first = hook.current.refresh();
  hook.tick();
  assert.equal(hook.calls.length, 1);
  assert.deepEqual(hook.calls[0], { name: 'queryOrders', data: { action: 'dynamicMessages' } });
  assert.equal(hook.current.summary, null);
  finish(result);
  await first;
  assert.equal(hook.current.summary.unreturned.total, 35);
  assert.equal(hook.current.loading, false);
});
test('failed refresh retains previous results; invalid response never becomes zero counts', async () => {
  let response = result;
  const hook = renderMessages(() => response);
  await flush();
  response = { success: false, data: [] };
  await hook.current.refresh();
  assert.equal(hook.current.summary.unreceived.total, 8);
  assert.ok(hook.current.error);
  assert.equal(hook.current.loading, false);
});
test('first request failure leaves counts unknown and a retry can recover', async () => {
  let failed = true;
  const hook = renderMessages(() => { if (failed) throw new Error('timeout'); return result; });
  await flush();
  assert.equal(hook.current.summary, null);
  assert.ok(hook.current.error);
  failed = false;
  await hook.current.refresh();
  assert.equal(hook.current.error, null);
  assert.equal(hook.current.summary.unreturned.total, 35);
});
test('response after unmount does not update state', async () => {
  let finish;
  const hook = renderMessages(() => new Promise(resolve => { finish = resolve; }));
  await flush();
  hook.unmount();
  finish(result);
  await flush();
  assert.equal(hook.current.summary, null);
});
