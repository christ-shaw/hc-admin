import { createHash } from 'node:crypto';

export const BILL_URL = 'https://www.paijitang.com/backend/wallet/bill';
export const BILL_PATH = '/opt-decision/bill/recycler/v2';
export const FIELDS = [
  ['交易类型', 'tradeType'], ['订单号', 'settleDocumentNo'], ['物品编号', 'productNo'],
  ['IMEI', 'imei'], ['物品名称', 'productCombineSkuName'], ['物品金额', 'settleAmountNum'],
  ['交易服务费', 'serviceFee'], ['优惠券减免', 'couponReduceAmount'],
  ['保障服务', 'extendedAfterSaleServiceFee'], ['支出合计', 'tradeTotal'],
  ['物品退款', 'refundAmount'], ['交易服务费退款', 'refundServiceFeeAmount'],
  ['优惠券返回', 'couponRefundAmount'], ['保障服务退款', 'extendedAfterSaleServiceFeeRefund'],
  ['售后补差', 'refundCompensationAmount'], ['售后合计', 'refundTotal'],
  ['订单取消补偿', 'compensationAmount'], ['订单取消罚款', 'actViolateAmount'],
  ['合计', 'total'], ['付款/退款时间', 'fillDt'],
];

export function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error('日期必须是有效的 YYYY-MM-DD');
  }
  return value;
}
export function shiftDate(value, days) {
  return new Date(Date.parse(validateDate(value)) + days * 86400000).toISOString().slice(0, 10);
}
export function shanghaiClock(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
export function dueDate(now = new Date()) {
  const { date, hour } = shanghaiClock(now);
  return shiftDate(date, hour >= 2 ? -1 : -2);
}
export function validateRange(start, end) {
  validateDate(start); validateDate(end);
  if (end < start || (Date.parse(end) - Date.parse(start)) / 86400000 > 30) {
    throw new Error('一次查询需在 31 个自然日以内，且结束日期不能早于开始日期');
  }
  if (end >= shanghaiClock().date) throw new Error('只采集截至昨日的完整自然日');
}
export function matchesBill(request, start, end, index) {
  const url = new URL(request.url());
  if (request.method() !== 'POST' || url.hostname !== 'sjapi-h5.paijitang.com' || url.pathname !== BILL_PATH) return false;
  try {
    const body = request.postDataJSON();
    return body.pageIndex === index && body.pageSize === 20 &&
      body.startDt === `${start} 00:00:00` && body.endDt === `${end} 23:59:59`;
  } catch { return false; }
}
export function validatePage(body, index, start, end, expectedTotal) {
  if (body?.code !== 200) {
    const auth = [10000010, 10000020, 10000600, 60104001, 60104002].includes(body?.code);
    throw new Error(auth ? 'AUTH_REQUIRED: 登录或访问验证需要人工完成' : `接口业务失败，代码 ${Number(body?.code) || 'unknown'}`);
  }
  if (!Number.isInteger(body.totalCount) || body.totalCount < 0 || body.page !== index || body.pageSize !== 20) {
    throw new Error('响应分页元数据不正确');
  }
  if (expectedTotal !== undefined && body.totalCount !== expectedTotal) throw new Error('采集过程中总条数变化，请重新采集');
  const rows = body.data ?? [];
  const expectedLength = Math.min(20, Math.max(0, body.totalCount - index * 20));
  if (!Array.isArray(rows) || rows.length !== expectedLength) throw new Error('响应条数与分页总数不一致');
  for (const row of rows) {
    if (FIELDS.some(([, key]) => !(key in row))) throw new Error('账单字段不完整或来源结构发生变化');
    const day = String(row.fillDt).slice(0, 10);
    if (day < start || day > end) throw new Error('账单日期超出查询范围');
    for (const key of ['settleDocumentNo', 'productNo', 'imei']) {
      if (row[key] !== null && typeof row[key] !== 'string') throw new Error('来源标识不是文本，无法保证精度');
    }
  }
  return rows;
}
// A multiset hash deliberately preserves separate refunds and exact duplicate source rows.
export function digest(rows) {
  const normalized = rows.map(row => JSON.stringify(FIELDS.map(([, key]) => row[key]))).sort();
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
