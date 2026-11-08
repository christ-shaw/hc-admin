const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function harness({ canEdit = true, conflict = false } = {}) {
  const slots = [], effects = [], calls = [];
  let cursor = 0, tree, component;
  const draft = { hh: { contact: 'HH', tel: '18025412746', company: '', country: 'CN', province: '广东省', city: '深圳市', county: '龙岗区', address: '示例地址' } };
  const render = () => { cursor = 0; tree = component({ canEdit, onDirtyChange }); };
  const onDirtyChange = value => { h.dirty = value; };
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; render(); }]; },
    useRef(value) { const i = cursor++; if (!(i in slots)) slots[i] = { current: value }; return slots[i]; },
    useEffect(fn, deps) { const i = cursor++; const old = slots[i]; if (!old || deps.some((v, j) => !Object.is(v, old.deps[j]))) { slots[i] = { deps }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = fn(); }); } },
  };
  const mod = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync('src/components/SfSenderSettings.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(js, { exports: mod.exports, module: mod, window: { confirm: () => false }, require(id) {
    if (id === 'react') return hooks;
    if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (id === 'tdesign-react') return { Input: 'Input', Select: 'Select', Button: 'Button', MessagePlugin: { success() {}, warning() {} } };
    if (id === '../lib/cloudbase') return { callFunction: async (_, { data }) => { calls.push(data); return data.action === 'setSenders' && conflict ? { success: false, errMsg: '其他管理员已修改，请重新加载' } : { success: true, initialized: true, revision: data.action === 'setSenders' ? 2 : 1, senderMap: data.senderMap || structuredClone(draft) }; } };
    throw Error(id);
  } });
  component = mod.exports.SfSenderSettings;
  const h = { calls, dirty: false, find(type) { const nodes = []; function walk(n) { if (Array.isArray(n)) return n.forEach(walk); if (!n || typeof n !== 'object') return; if (n.type === type) nodes.push(n); walk(n.props?.children); } walk(tree); return nodes; }, async settle() { for (let i = 0; i < 6; i++) { while (effects.length) effects.shift()(); await new Promise(r => setImmediate(r)); } } };
  render(); return h;
}
test('显示现有寄件人并编辑保存，保留具体配置范围和版本', async () => {
  const h = harness(); await h.settle();
  const phone = h.find('Input').find(n => n.props['aria-label'] === 'HH 寄件电话');
  assert.equal(phone.props.value, '18025412746');
  phone.props.onChange('13800138000'); await h.settle(); assert.equal(h.dirty, true);
  h.find('Button').find(n => n.props.children === '保存寄件人配置').props.onClick(); await h.settle();
  const saved = h.calls.find(c => c.action === 'setSenders');
  assert.equal(saved.profile, 'hongcheng'); assert.equal(saved.env, 'production'); assert.equal(saved.expectedRevision, 1); assert.equal(saved.senderMap.hh.tel, '13800138000'); assert.equal(h.dirty, false);
});
test('保存冲突保留草稿，取消切换不丢失修改', async () => {
  const h = harness({ conflict: true }); await h.settle();
  h.find('Input').find(n => n.props['aria-label'] === 'HH 寄件电话').props.onChange('13800138000'); await h.settle();
  h.find('Select')[0].props.onChange('huichuan'); await h.settle(); assert.equal(h.calls.length, 1);
  h.find('Button').find(n => n.props.children === '保存寄件人配置').props.onClick(); await h.settle();
  assert.equal(h.dirty, true); assert.equal(h.find('Input').find(n => n.props['aria-label'] === 'HH 寄件电话').props.value, '13800138000');
});
test('只有读取权限的用户不能编辑保存', async () => {
  const h = harness({ canEdit: false }); await h.settle();
  assert.equal(h.find('Input').every(n => n.props.readonly), true);
  assert.equal(h.find('Button').find(n => n.props.children === '保存寄件人配置').props.disabled, true);
});
