const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const FUNCTION_NAMES = ['manageSfConfig', 'applySfExpress', 'getSfAccessToken', 'querySfOrderResult', 'cancelSfExpress', 'manageSfPluginPrint', 'printSfWaybill', 'querySfExpressOrders', 'manageSfShipment'];
const clone = value => value === undefined ? undefined : structuredClone(value);
const valueAt = (obj, key) => key.split('.').reduce((v, k) => v?.[k], obj);
function matches(row, query) {
  return Object.entries(query || {}).every(([key, value]) => {
    const actual = valueAt(row, key);
    if (value?.$op === 'in') return value.values.includes(actual);
    if (value?.$op === 'neq') return actual !== value.value;
    if (value?.$op === 'gte') return actual >= value.value;
    if (value?.$op === 'lte') return actual <= value.value;
    if (value instanceof RegExp) return value.test(actual);
    return Array.isArray(actual) ? actual.includes(value) : actual === value;
  });
}
function applyFields(row, fields) {
  for (const [key, value] of Object.entries(fields)) {
    const parts = key.split('.'); let target = row;
    for (const part of parts.slice(0, -1)) target = target[part] ||= {};
    const leaf = parts.at(-1);
    target[leaf] = value?.$op === 'inc' ? Number(target[leaf] || 0) + value.value : clone(value);
  }
}
function createRuntime({ legacyToken = false } = {}) {
  const tables = new Map(); const calls = []; const cache = new Map(); const sfOrders = new Map();
  const state = { role: 'admin', timeoutNextCreate: false, beforeCreate: null };
  const demoEnv = { SF_ENV: 'sandbox' };
  for (const p of ['HONGCHENG', 'HUICHUAN']) for (const e of ['SANDBOX', 'PROD']) {
    const prefix = `SF_${p}_${e}_`;
    Object.assign(demoEnv, {
      [prefix + 'CLIENT_CODE']: `demo-${p.toLowerCase()}`,
      [prefix + 'CHECK_WORD']: `dummy-${p}-${e}`,
      [prefix + 'MONTHLY_CARD']: 'LOCAL-MONTHLY',
      [prefix + 'SENDER_CONTACT']: '本地寄件人',
      [prefix + 'SENDER_TEL']: '13800000000',
      [prefix + 'SENDER_ADDRESS']: '本地模拟寄件地址',
      [prefix + 'PRINT_TEMPLATE_CODE']: `demo-template-${p}-${e}`,
    });
  }
  if (legacyToken) {
    for (const [name, value] of Object.entries(demoEnv)) {
      if (name.startsWith('SF_HONGCHENG_')) demoEnv[name.replace('SF_HONGCHENG_', 'SF_')] = value;
    }
  }
  const table = (store, name) => { if (!store.has(name)) store.set(name, new Map()); return store.get(name); };
  const put = (name, row) => table(tables, name).set(row._id, clone(row));
  put('system_config', { _id: 'sf_express', env: 'sandbox', activeProfile: 'hongcheng', dataModelVersion: 2, dataModelCutoverDate: '2020-01-01', pluginPrintEnabledByProfile: { hongcheng: { sandbox: true, production: true }, huichuan: { sandbox: true, production: true } } });
  put('system_config', { _id: 'permission_system', initialized: true });
  put('roles', { _id: 'admin', actionPermissions: ['*'], pagePermissions: ['/orders'] });
  put('roles', { _id: 'viewer', actionPermissions: ['settings:read', 'orders:read'], pagePermissions: ['/orders'] });
  put('user_roles', { _id: 'local-admin', userId: 'local-admin', roleId: 'admin' });
  put('user_roles', { _id: 'local-viewer', userId: 'local-viewer', roleId: 'viewer' });
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  for (let i = 1; i <= 4; i++) put('orders', {
    _id: `demo-order-${i}`, date, serialNumber: i, status: 'unshipped', shippingFee: 'cod',
    consignee: `测试收件人 ${i}`, consigneePhone: '13900000000', consigneeAddress: '本地模拟地址',
    salesperson: '本地管理员', products: [{ productName: '模拟商品', quantity: 1 }],
  });
  function database(store = tables, dirty = null) {
    const mark = (name, id) => dirty?.set(`${name}/${id}`, [name, id]);
    function collection(name, query = {}, offset = 0, limit = 100, order = null) {
      const rows = () => {
        let found = [...table(store, name).values()].filter(r => matches(r, query));
        if (order) found.sort((a, b) => String(a[order[0]] || '').localeCompare(String(b[order[0]] || '')) * (order[1] === 'desc' ? -1 : 1));
        return found.slice(offset, offset + limit);
      };
      return {
        where(q) { return collection(name, q, offset, limit, order); },
        skip(n) { return collection(name, query, n, limit, order); },
        limit(n) { return collection(name, query, offset, n, order); },
        orderBy(key, direction) { return collection(name, query, offset, limit, [key, direction]); },
        field() { return this; },
        async get() { return { data: clone(rows()) }; },
        async count() { return { total: rows().length }; },
        async update({ data }) { const selected = rows(); for (const r of selected) { applyFields(r, data); mark(name, r._id); } return { stats: { updated: selected.length } }; },
        async add({ data }) {
          const row = clone(data); row._id ||= crypto.randomUUID();
          if (table(store, name).has(row._id)) throw new Error('document already exists');
          table(store, name).set(row._id, row); mark(name, row._id); return { _id: row._id };
        },
        doc(id) {
          return {
            async get() { const row = table(store, name).get(id); if (!row) { const e = new Error('document does not exist'); e.errCode = -1; throw e; } return { data: clone(row) }; },
            async update({ data }) { const row = table(store, name).get(id); if (!row) { const e = new Error('document does not exist'); e.errCode = -1; throw e; } applyFields(row, data); mark(name, id); return { stats: { updated: 1 } }; },
            async set({ data }) { table(store, name).set(id, { ...clone(data), _id: id }); mark(name, id); },
          };
        },
      };
    }
    return {
      collection, serverDate: () => new Date().toISOString(), RegExp: ({ regexp, options }) => new RegExp(regexp, options),
      command: { in: values => ({ $op: 'in', values }), inc: value => ({ $op: 'inc', value }), neq: value => ({ $op: 'neq', value }), gte: value => ({ $op: 'gte', value }), lte: value => ({ $op: 'lte', value }) },
      async createCollection(name) { table(store, name); },
      async startTransaction() {
        const snapshot = clone(tables), changed = new Map();
        return { ...database(snapshot, changed), async rollback() {}, async commit() {
          for (const [name, id] of changed.values()) table(tables, name).set(id, clone(table(snapshot, name).get(id)));
        } };
      },
    };
  }
  const db = database();
  const cloud = { init() {}, DYNAMIC_CURRENT_ENV: 'local-only', database: () => db,
    getWXContext: () => ({ OPENID: `local-${state.role}`, UID: `local-${state.role}` }),
    callFunction: async ({ name, data }) => ({ result: await invoke(name, data) }),
  };
  const response = result => ({ ok: true, status: 200, text: async () => JSON.stringify(result) });
  async function mockFetch(url, options) {
    if (!options?.body) throw new Error('本地模拟不下载外部文件；PDF 下载需沙箱联调验证');
    const body = new URLSearchParams(options.body);
    const partner = body.get('partnerID');
    if (!['demo-hongcheng', 'demo-huichuan'].includes(partner)) throw new Error('本地模拟拒绝真实账号');
    const env = String(url).includes('sbox') ? 'sandbox' : 'production';
    const token = `local-token:${partner}:${env}`;
    const service = body.get('serviceCode') || 'accessToken';
    calls.push({ partner, env, service });
    if (service === 'accessToken') return response({ apiResultCode: 'A1000', accessToken: token, expiresIn: 7200 });
    if (body.get('accessToken') !== token) throw new Error('检测到跨配置或跨环境 token 混用');
    const msg = JSON.parse(body.get('msgData') || '{}');
    const key = `${partner}:${env}:${msg.orderId}`;
    if (service === 'EXP_RECE_CREATE_ORDER') {
      if (state.beforeCreate) { const hook = state.beforeCreate; state.beforeCreate = null; await hook(); }
      if (sfOrders.has(key)) return response({ apiResultCode: 'A1000', apiResultData: { success: false, errorCode: '8016', errorMsg: '重复客户订单号' } });
      sfOrders.set(key, { orderId: msg.orderId, waybillNoInfoList: [{ waybillType: 1, waybillNo: `LOCAL-${partner.endsWith('huichuan') ? 'HCN' : 'HCH'}-${sfOrders.size + 1}` }] });
      if (state.timeoutNextCreate) { state.timeoutNextCreate = false; throw new Error('模拟网络超时（顺丰侧已创建）'); }
    }
    if (service === 'COM_RECE_CLOUD_PRINT_PARSEDDATA') return response({ apiResultCode: 'A1000', apiResultData: { success: true, errorCode: 'S0000', obj: { files: [{ url: 'https://local.invalid/demo.pdf', token: 'local-file' }] } } });
    if (!sfOrders.has(key)) return response({ apiResultCode: 'A1000', apiResultData: { success: false, errorCode: '8018', errorMsg: '未查询到订单' } });
    return response({ apiResultCode: 'A1000', apiResultData: { success: true, errorCode: 'S0000', msgData: { ...sfOrders.get(key), resStatus: '2' } } });
  }
  const root = path.resolve(__dirname, '../../cloud_functions');
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} }; cache.set(file, mod);
    const sandbox = {
      module: mod, exports: mod.exports, Buffer, URL, URLSearchParams, Intl, setTimeout, clearTimeout,
      process: { env: demoEnv }, console: { ...console, error() {} }, fetch: mockFetch,
      require(id) {
        if (id === 'wx-server-sdk') return cloud;
        if (id === './permissionAuth') return { getCurrentUser: async () => ({ id: `local-${state.role}`, ids: [`local-${state.role}`] }) };
        if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id.endsWith('.js') ? id : id + '.js'));
        if (id.startsWith('node:')) return require(id);
        throw new Error(`本地调试不支持模块 ${id}`);
      },
    };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
    return mod.exports;
  }
  async function invoke(name, data = {}) {
    if (!FUNCTION_NAMES.includes(name)) throw new Error('本地调试只允许顺丰相关函数');
    const file = legacyToken && name === 'getSfAccessToken'
      ? path.join(__dirname, 'legacy-token.fixture.cjs') : path.join(root, name, 'index.js');
    return load(file).main({ data });
  }
  function snapshot() {
    return { localOnly: true, role: state.role, config: clone(table(tables, 'system_config').get('sf_express')),
      orders: clone([...table(tables, 'orders').values()]), records: clone([...table(tables, 'sf_express_orders').values()]),
      tokens: [...table(tables, 'sf_tokens').keys()], calls: clone(calls) };
  }
  return { invoke, snapshot, state, db, put, calls, demoEnv };
}
module.exports = { createRuntime };
