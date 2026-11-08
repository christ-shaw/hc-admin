const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function settingsHarness({ failSave = false } = {}) {
  const state = [], effects = [], calls = [];
  let cursor = 0, tree, component;
  const flags = { hongcheng: { sandbox: true, production: true }, huichuan: { sandbox: false, production: false } };
  const render = () => { cursor = 0; tree = component(); };
  const jsx = (type, props) => ({ type, props });
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial;
      return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value; render(); }];
    },
    useEffect(callback) {
      const i = cursor++;
      if (!(i in state)) { state[i] = true; effects.push(callback); }
    },
  };
  const cloud = {
    AI_MODEL_OPTIONS: [], getAIModelConfig: () => ({ group: 'test', model: 'test' }), setAIModelConfig() {},
    getCurrentPermissionUserPayload: async () => ({}),
    async callFunction(name, payload) {
      calls.push({ name, payload });
      if (name === 'manageCounter') return { success: true, value: 1 };
      assert.equal(name, 'manageSfConfig');
      const p = payload.data;
      if (p.action === 'setPluginPrint') {
        if (failSave) return { success: false, errMsg: 'test save failure' };
        flags[p.activeProfile][p.env] = p.enabled;
        return { success: true, pluginPrintEnabledByEnv: { ...flags[p.activeProfile] } };
      }
      assert.equal(p.action, 'get');
      return { success: true, activeProfile: 'huichuan', env: 'sandbox', source: 'database', profileRoutingVersion: 1,
        pluginPrintEnabledByProfile: structuredClone(flags), pluginPrintEnabledByEnv: { ...flags.huichuan } };
    },
  };
  const mod = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync('src/pages/Settings.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(source, { exports: mod.exports, module: mod, console, window: { confirm: () => true }, require(id) {
    if (id === 'react') return hooks;
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
    if (id === '../lib/cloudbase') return cloud;
    if (id === '../hooks/usePermission') return { usePermission: () => ({ status: 'ready', canInitialize: false, can: () => true, refreshPermissions() {} }) };
    if (id === '../contexts/TabWorkspaceContext') return { useTabDirty() {} };
    if (id === '../utils/constants') return { SF_EXPRESS_UI_ENABLED: true };
    if (id === 'tdesign-react') return { Button: 'Button', Input: 'Input', Select: 'Select', Switch: 'Switch', Tabs: Object.assign(() => {}, { TabPanel: 'TabPanel' }), MessagePlugin: { success() {}, error() {} } };
    return new Proxy({}, { get: (_, key) => String(key) });
  }});
  component = mod.exports.SettingsPage;
  render();
  for (const effect of effects.splice(0)) effect();
  function find(type) {
    const result = [];
    function walk(node) {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      if (node.type === type) result.push(node);
      walk(node.props?.children);
    }
    walk(tree); return result;
  }
  return { find, calls, flags, settle: () => new Promise(resolve => setImmediate(resolve)) };
}

test('saving a profile plugin switch updates the displayed value without a page reload', async () => {
  const h = settingsHarness(); await h.settle();
  assert.equal(h.find('Switch')[0].props.value, false);
  await h.find('Switch')[0].props.onChange(true);
  assert.equal(h.flags.huichuan.sandbox, true);
  assert.equal(h.find('Switch')[0].props.value, true);
  assert.equal(h.find('Switch')[1].props.value, false);
  await h.find('Switch')[0].props.onChange(false);
  assert.equal(h.find('Switch')[0].props.value, false);
  const profile = h.find('Select').find(n => n.props.options?.some(o => o.value === 'huichuan'));
  profile.props.onChange('hongcheng');
  assert.equal(h.find('Switch')[0].props.value, true);
  assert.equal(h.find('Switch')[1].props.value, true);
});

test('a failed switch save keeps the displayed and persisted state unchanged', async () => {
  const h = settingsHarness({ failSave: true }); await h.settle();
  await h.find('Switch')[0].props.onChange(true);
  assert.equal(h.find('Switch')[0].props.value, false);
  assert.equal(h.flags.huichuan.sandbox, false);
});
