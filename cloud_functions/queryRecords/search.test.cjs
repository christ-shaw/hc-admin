const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function matchesCondition(row, condition) {
  if (condition && condition.__operator === 'or') {
    return condition.conditions.some(item => matchesCondition(row, item));
  }
  if (condition && condition.__operator === 'and') {
    return condition.conditions.every(item => matchesCondition(row, item));
  }
  return Object.entries(condition || {}).every(([key, value]) =>
    value instanceof RegExp ? value.test(row[key] || '') : row[key] === value);
}

function createSearch(records, type = 'inbound') {
  function query(conditions = {}, offset = 0, limit = 100) {
    const matches = () => records.filter(row => matchesCondition(row, conditions));
    return {
      where: value => query(value, offset, limit),
      orderBy: () => query(conditions, offset, limit),
      skip: value => query(conditions, value, limit),
      limit: value => query(conditions, offset, value),
      get: async () => ({ data: matches().slice(offset, offset + limit) }),
      count: async () => ({ total: matches().length }),
    };
  }
  const db = { command: {
    or: conditions => ({ __operator: 'or', conditions }),
    and: conditions => ({ __operator: 'and', conditions }),
  }, collection(name) {
    assert.equal(name, `${type}_records`);
    return query();
  }, RegExp: ({ regexp, options }) => new RegExp(regexp, options) };
  const module = { exports: {} };
  const filename = path.join(__dirname, 'index.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, console,
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, database: () => db, getWXContext: () => ({ OPENID: 'test' }) };
      if (name === './miniappAuth') return { requireMiniappPermission: async () => ({ allowed: true }) };
      if (name === './permissionAuth') return {};
      throw new Error(`Unexpected dependency: ${name}`);
    },
  }, { filename });
  return async filters => {
    const result = await module.exports.main({ data: { type, ...filters } });
    assert.equal(result.success, true, result.errMsg);
    return result.data.map(row => row._id);
  };
}

const records = [
  { _id: '1', customerName: '李金明（肖）', trackingNumber: 'SF0212737358693' },
  { _id: '2', customerName: '李金明(肖)', trackingNumber: 'SF00001234' },
  { _id: '3', customerName: '其他客户', trackingNumber: 'YT000058693' },
  { _id: '4', customerName: '李金明肖', trackingNumber: 'SF00005678' },
  { _id: '5', customerName: '测试[1].*', trackingNumber: 'AB+12' },
];

test('部分姓名匹配带后缀的客户，忽略输入两端空格', async () => {
  assert.deepEqual(await createSearch(records)({ customerName: ' 金明 ' }), ['1', '2', '4']);
});

test('单号可按尾号查询，字母忽略大小写', async () => {
  const search = createSearch(records);
  assert.deepEqual(await search({ trackingNumber: '58693' }), ['1', '3']);
  assert.deepEqual(await search({ trackingNumber: ' sf021 ' }), ['1']);
});

test('同时填写客户名称和单号时取交集，清空名称可仅按单号查询', async () => {
  const search = createSearch(records);
  assert.deepEqual(await search({ customerName: '金明', trackingNumber: '58693' }), ['1']);
  assert.deepEqual(await search({ customerName: '', trackingNumber: '58693' }), ['1', '3']);
});

test('括号、方括号及正则符号作为普通文本匹配，不扩大查询或抛异常', async () => {
  const search = createSearch(records);
  assert.deepEqual(await search({ customerName: '金明(肖)' }), ['2']);
  assert.deepEqual(await search({ customerName: '[' }), ['5']);
  assert.deepEqual(await search({ customerName: '.*' }), ['5']);
  assert.deepEqual(await search({ trackingNumber: 'AB+' }), ['5']);
});

test('出库人名同时匹配收件人和历史客户名称', async () => {
  const search = createSearch([
    { _id: '1', consignee: '王小明（肖）', customerName: '下单客户甲' },
    { _id: '2', customerName: '王小明（旧记录）' },
    { _id: '3', consignee: '其他收件人', customerName: '其他客户' },
  ], 'outbound');
  assert.deepEqual(await search({ customerName: '小明' }), ['1', '2']);
});
