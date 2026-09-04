const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const clone = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const recipient = {
    consignee: '测试收件人',
    consigneePhone: '13800138000',
    consigneeAddress: '测试地址',
    shippingFee: 'prepaid',
  };
  return {
    system_config: { sf_express: { _id: 'sf_express', env: 'sandbox' } },
    user_roles: { mapping: { _id: 'mapping', userId: 'user', roleId: 'role' } },
    roles: { role: { _id: 'role', actionPermissions: ['orders:update'] } },
    orders: {
      primary: {
        ...recipient, _id: 'primary', salesperson: 'XX', status: 'unshipped',
        outboundRecordId: 'primary-out', trackingNumber: 'SF-NEW', sfExpressOrderRecordId: 'active',
      },
      target: {
        ...recipient, _id: 'target', salesperson: 'YY', status: 'unshipped', needsOutbound: true,
        outboundRecordId: 'target-out', trackingNumber: '', sfExpressOrderRecordId: 'cancelled',
        products: [{ brand: '测试品牌', productName: '测试型号', quantity: 2 }],
      },
    },
    outbound_records: {
      'primary-out': { _id: 'primary-out', outboundStatus: 'pending', trackingNumber: 'SF-NEW', sfExpressOrderRecordId: 'active' },
      'target-out': { _id: 'target-out', outboundStatus: 'pending', trackingNumber: '', sfExpressOrderRecordId: 'cancelled' },
    },
    sf_express_orders: {
      active: {
        _id: 'active', sourceOrderId: 'primary', status: 'applied', env: 'sandbox', isCurrent: true,
        waybillNo: 'SF-NEW', sfOrderId: 'HC_primary', attemptNo: 1, shipmentStatus: 'packing',
        linkedOrderIds: ['primary'], linkedOutboundIds: ['primary-out'], shipmentVersion: 2,
        reuseEnabled: true, shipmentHistory: [],
      },
      cancelled: {
        _id: 'cancelled', sourceOrderId: 'target', status: 'cancelled', env: 'sandbox', isCurrent: true,
        waybillNo: 'SF-OLD', sfOrderId: 'HC_target_3', attemptNo: 3, shipmentStatus: 'cancelled',
        linkedOrderIds: ['target'], linkedOutboundIds: ['target-out'], reuseEnabled: false,
      },
    },
  };
}

function loadShipment(data) {
  let tables = clone(data);
  const writes = [];
  function store(getTables) {
    return {
      collection(name) {
        return {
          doc(id) {
            return {
              async get() { return { data: clone(getTables()[name]?.[id] || null) }; },
              async update({ data: update }) {
                assert.ok(getTables()[name]?.[id], 'updating missing document');
                getTables()[name][id] = { ...getTables()[name][id], ...clone(update) };
                writes.push({ name, id });
              },
            };
          },
          where(condition) {
            let limit = Infinity;
            return {
              limit(value) { limit = value; return this; },
              async get() {
                return { data: clone(Object.values(getTables()[name] || {})
                  .filter(record => Object.entries(condition).every(([key, value]) => record[key] === value))
                  .slice(0, limit)) };
              },
            };
          },
        };
      },
    };
  }
  const db = {
    ...store(() => tables),
    serverDate: () => '2026-09-03T08:00:00.000Z',
    async startTransaction() {
      const pending = clone(tables);
      return {
        ...store(() => pending),
        async commit() { tables = pending; },
        async rollback() {},
      };
    },
  };
  const filename = path.join(__dirname, 'index.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    exports: module.exports,
    console: { error() {} },
    process: { env: {} },
    require(id) {
      if (id === 'wx-server-sdk') return { init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => db };
      if (id === './permissionAuth') return { getCurrentUser: async () => ({ id: 'user', ids: ['user'] }) };
      return require(id);
    },
  }, { filename });
  return { main: module.exports.main, get tables() { return tables; }, writes };
}

const listRequest = { data: { action: 'listReusable', sourceOrderId: 'target' } };
const attachRequest = { data: {
  action: 'attach', sourceOrderId: 'target', sfExpressOrderId: 'active',
  shipmentVersion: 2, requestId: 'request-1',
} };

test('已取消订单保留旧关联时可以查询其他可追加包裹，查询不改动历史', async () => {
  const initial = fixture();
  const app = loadShipment(initial);
  const result = await app.main(listRequest);
  assert.equal(result.success, true);
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0]._id, 'active');
  assert.equal(app.writes.length, 0);
  assert.deepEqual(app.tables, initial);
});

test('取消后追加事务回填新运单和关联，旧取消记录保留，重复请求幂等', async () => {
  const initial = fixture();
  const app = loadShipment(initial);
  const result = await app.main(attachRequest);
  assert.equal(result.success, true);
  assert.equal(result.waybillNo, 'SF-NEW');
  assert.equal(app.tables.orders.target.sfExpressOrderRecordId, 'active');
  assert.equal(app.tables.orders.target.trackingNumber, 'SF-NEW');
  assert.equal(app.tables.orders.target.sharedWaybill, true);
  assert.equal(app.tables.orders.primary.sharedWaybill, true);
  assert.equal(app.tables.outbound_records['target-out'].sfExpressOrderRecordId, 'active');
  assert.equal(app.tables.outbound_records['target-out'].trackingNumber, 'SF-NEW');
  assert.deepEqual(app.tables.sf_express_orders.active.linkedOrderIds, ['primary', 'target']);
  assert.deepEqual(app.tables.sf_express_orders.active.linkedOutboundIds, ['primary-out', 'target-out']);
  assert.equal(app.tables.sf_express_orders.active.reuseEnabled, false);
  assert.equal(app.tables.sf_express_orders.active.shipmentHistory[0].action, 'attach_order');
  assert.deepEqual(app.tables.sf_express_orders.cancelled, initial.sf_express_orders.cancelled);
  const writes = app.writes.length;
  const duplicate = await app.main(attachRequest);
  assert.equal(duplicate.success, true);
  assert.equal(duplicate.duplicated, true);
  assert.equal(app.writes.length, writes);
});

test('仍支持没有旧顺丰关联的未下单订单', async () => {
  const initial = fixture();
  initial.orders.target.sfExpressOrderRecordId = '';
  initial.outbound_records['target-out'].sfExpressOrderRecordId = '';
  const app = loadShipment(initial);
  assert.equal((await app.main(listRequest)).data.length, 1);
  assert.equal((await app.main(attachRequest)).success, true);
});

test('不能绕过有效、缺失、跨环境、不属于本订单或被新申请替代的旧关联', async () => {
  for (const change of [
    tables => { tables.sf_express_orders.cancelled.status = 'applied'; },
    tables => { tables.sf_express_orders.cancelled.status = 'applying'; },
    tables => { tables.sf_express_orders.cancelled.status = 'failed'; },
    tables => { delete tables.sf_express_orders.cancelled; },
    tables => { tables.sf_express_orders.cancelled.env = 'production'; },
    tables => { tables.sf_express_orders.cancelled.sourceOrderId = 'another-order'; },
    tables => { tables.sf_express_orders.cancelled.isCurrent = false; },
    tables => { tables.outbound_records['target-out'].sfExpressOrderRecordId = 'active'; },
  ]) {
    const initial = fixture();
    change(initial);
    const app = loadShipment(initial);
    assert.equal((await app.main(listRequest)).success, false);
    assert.equal((await app.main(attachRequest)).success, false);
    assert.deepEqual(app.tables, initial);
  }
});

test('取消不放宽待出库、未发货及没有其他物流单号的限制', async () => {
  for (const change of [
    tables => { tables.orders.target.status = 'shipped'; },
    tables => { tables.orders.target.needsOutbound = false; },
    tables => { tables.orders.target.trackingNumber = 'OTHER'; },
    tables => { tables.outbound_records['target-out'].trackingNumber = 'OTHER'; },
    tables => { tables.outbound_records['target-out'].outboundStatus = 'completed'; },
    tables => { delete tables.outbound_records['target-out']; },
  ]) {
    const initial = fixture();
    change(initial);
    const app = loadShipment(initial);
    assert.equal((await app.main(listRequest)).success, false);
    assert.equal((await app.main(attachRequest)).success, false);
    assert.deepEqual(app.tables, initial);
  }
});

test('取消、已交接或未开放追加的包裹不能作为追加目标', async () => {
  for (const change of [
    tables => { tables.sf_express_orders.active.status = 'cancelled'; },
    tables => { tables.sf_express_orders.active.shipmentStatus = 'handed_over'; },
    tables => { tables.sf_express_orders.active.reuseEnabled = false; },
  ]) {
    const initial = fixture();
    change(initial);
    const app = loadShipment(initial);
    const list = await app.main(listRequest);
    assert.equal(list.success, true);
    assert.equal(list.data.length, 0);
    assert.equal((await app.main(attachRequest)).success, false);
    assert.deepEqual(app.tables, initial);
  }
});

test('收件信息、付款方式或包裹版本冲突时不执行追加', async () => {
  for (const change of [
    tables => { tables.orders.target.consigneeAddress = '不同地址'; },
    tables => { tables.orders.target.shippingFee = 'cod'; },
    tables => { tables.sf_express_orders.active.shipmentVersion = 3; },
  ]) {
    const initial = fixture();
    change(initial);
    const app = loadShipment(initial);
    assert.equal((await app.main(attachRequest)).success, false);
    assert.deepEqual(app.tables, initial);
  }
});

test('取消后追加仍需要原有订单操作权限', async () => {
  const initial = fixture();
  initial.roles.role.actionPermissions = [];
  const app = loadShipment(initial);
  assert.equal((await app.main(listRequest)).success, false);
  assert.equal((await app.main(attachRequest)).success, false);
  assert.deepEqual(app.tables, initial);
});
