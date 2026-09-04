const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createQuery(records, failAt) {
  const calls = [];
  const predicate = fn => Object.assign(fn, { and: other => predicate(value => fn(value) && other(value)) });
  function query(conditions = {}, offset = 0, limit = 100, sorts = []) {
    const matches = () => records.filter(record => Object.entries(conditions).every(([key, condition]) =>
      typeof condition === 'function' ? condition(record[key])
        : condition instanceof RegExp ? condition.test(record[key] || '')
          : record[key] === condition));
    return {
      where: next => query(next, offset, limit, sorts),
      skip: next => query(conditions, next, limit, sorts),
      limit: next => query(conditions, offset, next, sorts),
      orderBy: (key, direction) => query(conditions, offset, limit, [...sorts, [key, direction]]),
      async count() {
        if (failAt === 'count') throw new Error('计数失败');
        calls.push({ action: 'count' });
        return { total: matches().length };
      },
      async get() {
        if (failAt === 'get') throw new Error('分页读取失败');
        calls.push({ action: 'get', offset, limit, sorts });
        const data = matches().sort((a, b) => {
          for (const [key, direction] of sorts) {
            if (a[key] !== b[key]) return (a[key] > b[key] ? 1 : -1) * (direction === 'desc' ? -1 : 1);
          }
          return 0;
        });
        return { data: data.slice(offset, offset + limit) };
      },
    };
  }
  const db = {
    collection: name => { assert.equal(name, 'invoices'); return query(); },
    RegExp: ({ regexp, options }) => new RegExp(regexp, options),
    command: {
      in: values => predicate(value => values.includes(value)),
      gte: value => predicate(candidate => candidate >= value),
      lte: value => predicate(candidate => candidate <= value),
    },
  };
  const filename = path.join(__dirname, 'index.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    exports: module.exports,
    module,
    console: { error() {} },
    require(id) {
      assert.equal(id, 'wx-server-sdk');
      return { init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => db };
    },
  }, { filename });
  return { main: module.exports.main, calls };
}

function invoices(count) {
  return Array.from({ length: count }, (_, index) => ({
    _id: String(index + 1).padStart(3, '0'),
    companyName: '测试公司',
    applicant: '张三',
    status: 'unpaid',
    applyDate: '2026-09-01',
    createTime: '2026-09-01T08:00:00Z',
  }));
}

test('按页查询真实总数，同日期记录用 ID 稳定排序且跨页不重不漏', async () => {
  const { main, calls } = createQuery(invoices(45));
  const pages = [];
  for (let page = 1; page <= 3; page++) {
    const result = await main({ data: { page, pageSize: 20 } });
    assert.equal(result.success, true);
    assert.equal(result.total, 45);
    assert.equal(result.page, page);
    assert.equal(result.pageSize, 20);
    pages.push(result);
  }
  assert.deepEqual(pages.map(item => item.data.length), [20, 20, 5]);
  assert.deepEqual(pages.map(item => item.hasMore), [true, true, false]);
  assert.equal(pages[2].cursor, null);
  const ids = pages.flatMap(item => item.data.map(row => row._id));
  assert.equal(new Set(ids).size, 45);
  assert.deepEqual(ids, invoices(45).map(row => row._id).reverse());
  assert.deepEqual(calls.filter(item => item.action === 'get').map(item => item.offset), [0, 20, 40]);
});

test('整页结束没有空白下一页，页码超界时返回最后有效页', async () => {
  const { main } = createQuery(invoices(40));
  const last = await main({ data: { page: 2, pageSize: 20 } });
  assert.equal(last.hasMore, false);
  assert.equal(last.cursor, null);
  const clamped = await main({ data: { page: 3, pageSize: 20 } });
  assert.equal(clamped.page, 2);
  assert.equal(clamped.data.length, 20);
});

test('删除末页最后一条后回退，删除首页记录后下一页不跳过数据', async () => {
  const records = invoices(21);
  const { main } = createQuery(records);
  records.shift();
  const clamped = await main({ data: { page: 2, pageSize: 20 } });
  assert.equal(clamped.page, 1);
  assert.equal(clamped.total, 20);

  const more = invoices(45);
  const another = createQuery(more);
  more.pop();
  const first = await another.main({ data: { page: 1, pageSize: 20 } });
  const second = await another.main({ data: { page: 2, pageSize: 20 } });
  assert.equal(first.data[19]._id, '025');
  assert.equal(second.data[0]._id, '024');
});

test('空查询返回第 1 页和总数 0', async () => {
  const { main } = createQuery([]);
  const result = await main({ data: { page: 10, pageSize: 20 } });
  assert.equal(result.page, 1);
  assert.equal(result.total, 0);
  assert.equal(result.data.length, 0);
  assert.equal(result.hasMore, false);
});

test('总数和分页使用相同的公司、申请人、状态及日期条件', async () => {
  const records = invoices(40).map((row, index) => ({
    ...row,
    companyName: index < 30 ? '匹配公司' : '其他公司',
    status: index % 2 ? '未开票' : 'unpaid',
  }));
  records[0].applicant = '李四';
  records[1].status = 'paid';
  records[2].applyDate = '2026-08-31';
  records[3].applyDate = '2026-09-03';
  const { main } = createQuery(records);
  const result = await main({ data: {
    page: 2, pageSize: 20, companyName: '匹配', applicant: '张三',
    status: 'unpaid', startDate: '2026-09-01', endDate: '2026-09-02',
  } });
  assert.equal(result.total, 26);
  assert.equal(result.data.length, 6);
  assert.equal(result.page, 2);
  assert.equal(result.hasMore, false);
});

test('带括号等字符的公司名称按文字查询，不破坏分页', async () => {
  const records = invoices(25);
  records[0].companyName = '公司(测试)+';
  const { main } = createQuery(records);
  const result = await main({ data: { page: 1, pageSize: 20, companyName: '(测试)+' } });
  assert.equal(result.success, true);
  assert.equal(result.total, 1);
  assert.equal(result.data[0]._id, '001');
});

test('日期单边筛选也作用于总数和记录', async () => {
  const records = invoices(3);
  records[0].applyDate = '2026-08-31';
  records[2].applyDate = '2026-09-02';
  const { main } = createQuery(records);
  assert.equal((await main({ startDate: '2026-09-01' })).total, 2);
  assert.equal((await main({ endDate: '2026-09-01' })).total, 2);
});

test('兼容旧 limit/cursor 调用以及缺省参数', async () => {
  const { main } = createQuery(invoices(45));
  const first = await main({ data: { limit: 20 } });
  assert.equal(first.cursor, '20');
  const second = await main({ limit: 20, cursor: first.cursor });
  assert.equal(second.data[0]._id, '025');
  assert.equal(second.cursor, '40');
  assert.equal((await main({})).data.length, 10);
  assert.equal((await main()).success, true);
});

test('分页参数限幅并排除非法偏移量', async () => {
  const { main, calls } = createQuery(invoices(150));
  assert.equal((await main({ page: -2, pageSize: 1000 })).pageSize, 100);
  for (const value of ['bad', Infinity, -10, 0]) {
    const result = await main({ page: value, pageSize: value });
    assert.equal(result.page, 1);
    assert.equal(result.pageSize, 10);
  }
  await main({ cursor: 'bad' });
  assert.equal(calls.at(-1).offset, 0);
  await main({ cursor: '-20' });
  assert.equal(calls.at(-1).offset, 0);
});

test('查询异常明确返回失败原因', async () => {
  for (const failAt of ['count', 'get']) {
    const { main } = createQuery(invoices(30), failAt);
    const result = await main({ data: { page: 2, pageSize: 20 } });
    assert.equal(result.success, false);
    assert.match(result.errMsg, /失败/);
  }
});
