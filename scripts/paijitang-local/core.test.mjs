import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELDS, dueDate, shiftDate, validateRange, validatePage, matchesBill, digest } from './core.mjs';

const row = (overrides = {}) => ({
  ...Object.fromEntries(FIELDS.map(([, key]) => [key, 0])),
  tradeType: '售后', settleDocumentNo: 'same-order', productNo: '20260921184324251712',
  imei: '863934072132885', productCombineSkuName: '测试物品', fillDt: '2026-10-14 11:30:55',
  ...overrides,
});
test('Shanghai 02:00 boundary, month and year rollover', () => {
  assert.equal(dueDate(new Date('2026-10-31T17:59:59Z')), '2026-10-30');
  assert.equal(dueDate(new Date('2026-10-31T18:00:00Z')), '2026-10-31');
  assert.equal(dueDate(new Date('2026-12-31T18:00:00Z')), '2026-12-31');
  assert.equal(shiftDate('2024-03-01', -1), '2024-02-29');
  assert.throws(() => shiftDate('2026-02-30', -1));
});
test('reject invalid and oversized query ranges', () => {
  assert.throws(() => validateRange('2020-02-30', '2020-03-01'));
  assert.throws(() => validateRange('2020-01-01', '2020-02-01'));
  assert.throws(() => validateRange('2020-01-03', '2020-01-01'));
});
test('only accept a response to the exact account-page query parameters', () => {
  const request = (patch = {}, url = 'https://sjapi-h5.paijitang.com/opt-decision/bill/recycler/v2') => ({
    url: () => url, method: () => 'POST', postDataJSON: () => ({
      pageIndex: 0, pageSize: 20, startDt: '2026-10-14 00:00:00', endDt: '2026-10-14 23:59:59', ...patch,
    }),
  });
  assert.equal(matchesBill(request(), '2026-10-14', '2026-10-14', 0), true);
  assert.equal(matchesBill(request({ pageIndex: 1 }), '2026-10-14', '2026-10-14', 0), false);
  assert.equal(matchesBill(request({}, 'https://example.com/opt-decision/bill/recycler/v2'), '2026-10-14', '2026-10-14', 0), false);
});
test('preserve separate refunds with identical order/item/type/time', () => {
  const rows = [row({ refundAmount: 720, total: 720 }), row({ refundServiceFeeAmount: 19.9, total: 19.9 })];
  const body = { code: 200, page: 0, pageSize: 20, totalCount: 2, data: rows };
  assert.equal(validatePage(body, 0, '2026-10-14', '2026-10-14').length, 2);
  assert.notEqual(digest(rows), digest(rows.slice(0, 1)));
  assert.equal(digest(rows), digest([...rows].reverse()));
  assert.notEqual(digest([rows[0], rows[0]]), digest([rows[0]]));
});
test('empty data is valid only with a successful complete response', () => {
  assert.deepEqual(validatePage({ code: 200, page: 0, pageSize: 20, totalCount: 0 }, 0, '2026-10-24', '2026-10-24'), []);
  assert.throws(() => validatePage({ code: 10000010 }, 0, '2026-10-24', '2026-10-24'), /AUTH_REQUIRED/);
  assert.throws(() => validatePage({ code: 200, page: 0, pageSize: 20, totalCount: 1 }, 0, '2026-10-24', '2026-10-24'));
});
test('reject stale page, total changes, missing fields, and date leakage', () => {
  const body = { code: 200, page: 0, pageSize: 20, totalCount: 1, data: [row()] };
  assert.throws(() => validatePage(body, 1, '2026-10-14', '2026-10-14'));
  assert.throws(() => validatePage(body, 0, '2026-10-14', '2026-10-14', 2));
  assert.throws(() => validatePage(body, 0, '2026-10-15', '2026-10-15'));
  const missing = row(); delete missing.refundAmount;
  assert.throws(() => validatePage({ ...body, data: [missing] }, 0, '2026-10-14', '2026-10-14'));
  assert.throws(() => validatePage({ ...body, data: [row({ productNo: 20260921184324251712 })] }, 0, '2026-10-14', '2026-10-14'));
});
