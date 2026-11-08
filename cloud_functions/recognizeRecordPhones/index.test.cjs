const test = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('./service');
const { photosOf, normalizeDetection, summarize } = require('./detection');
const { configuration } = require('./provider');
const { database } = require('../manageCustomers/test-support/database.cjs');

const photo = n => `cloud://test.bucket/phone/${n}.jpg`;
const result = { model: 'test-v1', count: 2, detections: [{ confidence: 0.9, box: [0, 0, 0.2, 0.2] }, { confidence: 0.9, box: [0.3, 0.3, 0.5, 0.5] }] };
function fixture({ photos = [photo(1)], detect, auth, ...options } = {}) {
  const data = { inbound_records: [{ _id: 'r1', phonePhotos: photos, phoneModels: [{ model: 'phone', quantity: 3 }] }], outbound_records: [{ _id: 'r2', phonePhotos: photos, phoneModels: [{ model: 'phone', quantity: 2 }] }] };
  const { db } = database(data);
  db.command.set = value => value;
  let calls = 0;
  const permissions = [];
  const call = createService({ db, authorize: async p => { permissions.push(p); return auth || { allowed: true }; }, detector: () => async (...args) => { calls++; return detect ? detect(...args) : structuredClone(result); }, ...options });
  return { data, db, permissions, call: (p = {}) => call({ type: 'inbound', recordId: 'r1', ...p }), calls: () => calls };
}

test('逐张结果持久化，数量差异单独保存，库存型号保持原值', async () => {
  const f = fixture();
  const res = await f.call();
  assert.equal(res.data.totalCount, 2);
  assert.equal(res.data.difference, -1);
  assert.equal(res.data.needsReview, true);
  assert.equal(f.data.inbound_records[0].phoneModels[0].quantity, 3);
  assert.equal(f.data.inbound_records[0].phoneDetection.status, 'succeeded');
});

test('出库记录同样支持识别并校验出库更新权限', async () => {
  const f = fixture();
  const res = await f.call({ type: 'outbound', recordId: 'r2' });
  assert.equal(res.data.totalCount, 2);
  assert.deepEqual(f.permissions, ['outbound:update']);
});

test('默认多图相加，重复文件只识别一次，显式 separate 可分别计数', async () => {
  const f = fixture({ photos: [photo(1), photo(2), photo(1)] });
  const summed = await f.call();
  assert.equal(summed.data.mode, 'distinct');
  assert.equal(summed.data.totalCount, 4);
  assert.equal(summed.data.difference, 1);
  assert.equal(f.calls(), 2);
  const res = await f.call({ mode: 'separate' });
  assert.equal(res.data.totalCount, null);
  assert.equal(res.data.images.length, 2);
});

test('结果缓存、手动重跑与型号数量修改后的重新比较', async () => {
  const f = fixture();
  await f.call();
  f.data.inbound_records[0].phoneModels[0].quantity = 2;
  const cached = await f.call();
  assert.equal(cached.cached, true);
  assert.equal(cached.data.difference, 0);
  assert.equal(f.calls(), 1);
  await f.call({ force: true });
  assert.equal(f.calls(), 2);
});

test('并发请求只运行一次，读状态不会把处理中显示为 0', async () => {
  let release;
  let started;
  const start = new Promise(resolve => { started = resolve; });
  const f = fixture({ detect: () => { started(); return new Promise(resolve => { release = resolve; }); } });
  const first = f.call();
  await start;
  assert.equal((await f.call()).code, 'RECOGNITION_BUSY');
  const processing = await f.call({ action: 'get' });
  assert.equal(processing.data.status, 'processing');
  assert.equal(processing.data.totalCount, null);
  release(result);
  assert.equal((await first).success, true);
  assert.equal(f.calls(), 1);
});

test('识别期间换图，旧结果作废；再次识别使用新照片', async () => {
  let f;
  f = fixture({ detect: async () => {
    await f.db.collection('inbound_records').doc('r1').update({ data: { phonePhotos: [photo(2)] } });
    return result;
  } });
  const res = await f.call();
  assert.equal(res.data.status, 'stale');
  assert.equal(res.data.totalCount, null);
  assert.equal((await f.call({ action: 'get' })).data.stale, true);
  assert.equal((await f.call()).data.status, 'succeeded');
});

test('识别完成后删图，读取旧结果显示过期且不提供总数', async () => {
  const f = fixture();
  await f.call();
  f.data.inbound_records[0].phonePhotos = [];
  const res = await f.call({ action: 'get' });
  assert.equal(res.data.stale, true);
  assert.equal(res.data.totalCount, null);
  assert.equal(res.data.difference, null);
});

test('部分失败保留成功图片，失败不得计为零或返回不完整合计', async () => {
  const f = fixture({ photos: [photo(1), photo(2)], detect: async id => {
    if (id === photo(2)) throw new Error('secret-token-and-image-url');
    return result;
  } });
  const res = await f.call();
  assert.equal(res.data.status, 'partial');
  assert.equal(res.data.images[0].count, 2);
  assert.equal(res.data.images[1].count, null);
  assert.equal(res.data.totalCount, null);
  assert.ok(!JSON.stringify(res).includes('secret-token'));
});

test('所有图片失败时结果为 failed，失败任务允许重试', async () => {
  const f = fixture({ detect: async () => { throw new Error('network'); } });
  assert.equal((await f.call()).data.status, 'failed');
  await f.call();
  assert.equal(f.calls(), 2);
});

test('无权限不读取照片、不调用服务；请求中的 currentUser 不参与鉴权', async () => {
  const f = fixture({ auth: { allowed: false, code: 'PERMISSION_DENIED', errMsg: 'denied' } });
  assert.equal((await f.call({ currentUser: { id: 'admin' } })).code, 'PERMISSION_DENIED');
  assert.equal(f.calls(), 0);
  assert.equal(f.data.inbound_records[0].phoneDetection, undefined);
});

test('无照片、记录不存在和参数错误明确返回', async () => {
  const f = fixture({ photos: [] });
  assert.equal((await f.call()).code, 'NO_PHOTOS');
  assert.equal((await f.call({ recordId: 'missing' })).code, 'RECORD_NOT_FOUND');
  assert.equal((await f.call({ type: 'orders' })).code, 'INVALID_ARGUMENT');
  assert.equal((await f.call({ mode: 'sum' })).code, 'INVALID_ARGUMENT');
  assert.equal((await f.call({ force: 'true' })).code, 'INVALID_ARGUMENT');
});

test('进程中断后的过期租约可以重试', async () => {
  const f = fixture();
  f.data.inbound_records[0].phoneDetection = { status: 'processing', requestId: 'dead', leaseUntil: Date.now() - 1 };
  assert.equal((await f.call()).data.status, 'succeeded');
});

test('get 为只读权限，无结果时为 null，未配置检测服务时仍能读取', async () => {
  const f = fixture({ detector: () => { throw new Error('no config'); } });
  assert.equal((await f.call({ action: 'get' })).data, null);
  assert.deepEqual(f.permissions, ['inbound:read']);
});

test('只接受云文件且限制图片数量', () => {
  assert.throws(() => photosOf({ phonePhotos: ['https://internal'] }), { code: 'INVALID_PHOTOS' });
  assert.throws(() => photosOf({ phonePhotos: Array.from({ length: 10 }, (_, i) => photo(i)) }), { code: 'TOO_MANY_PHOTOS' });
});

test('检测结果过滤非手机、低分框，NMS 去重，并忽略上游 count', () => {
  const detections = [
    { label: 'cell phone', confidence: 0.9, box: [0, 0, 0.2, 0.2] },
    { label: 'phone', confidence: 0.8, box: [0.01, 0.01, 0.2, 0.2] },
    { label: 'phone', confidence: 0.1, box: [0.4, 0.4, 0.5, 0.5] },
    { label: 'book', confidence: 0.99, box: [0.6, 0.6, 0.8, 0.8] },
  ];
  assert.equal(normalizeDetection({ model: 'v1', count: 99, detections }, 0.45).count, 1);
  assert.equal(normalizeDetection({ model: 'v1', detections: [] }, 0.45).count, 0);
});

test('损坏或越界结果不得转换为零数量', () => {
  for (const detections of [undefined, [{ label: 'phone', confidence: 0.9, box: [0, 0, 2, 2] }], [{ label: 'phone', confidence: NaN, box: [0, 0, 1, 1] }]]) {
    assert.throws(() => normalizeDetection({ model: 'v1', detections }, 0.45), { code: 'INVALID_DETECTION' });
  }
});

test('没有有效人工数量时不制造差异；成功识别零台与失败可区分', () => {
  assert.equal(summarize([{ status: 'succeeded', count: 0 }], 'separate', {}).totalCount, 0);
  assert.equal(summarize([{ status: 'succeeded', count: 0 }], 'separate', {}).difference, null);
});

test('检测服务配置必须使用 HTTPS，阈值必须有效', () => {
  assert.throws(() => configuration({}), { code: 'DETECTOR_NOT_CONFIGURED' });
  assert.throws(() => configuration({ PHONE_DETECTOR_URL: 'http://localhost', PHONE_DETECTOR_TOKEN: 'test' }), { code: 'DETECTOR_NOT_CONFIGURED' });
  assert.throws(() => configuration({ PHONE_DETECTOR_URL: 'https://example.com', PHONE_DETECTOR_TOKEN: 'test', PHONE_DETECTOR_THRESHOLD: 'NaN' }), { code: 'DETECTOR_NOT_CONFIGURED' });
  assert.equal(configuration({ PHONE_DETECTOR_URL: 'https://example.com/detect', PHONE_DETECTOR_TOKEN: 'test' }).threshold, 0.45);
});
