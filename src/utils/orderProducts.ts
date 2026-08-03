import { OrderRecord, ProductItem, PaymentSplit } from '../types';

/** 货品读取所需的最小订单字段集，便于 Layout 等只取部分字段的记录复用 */
export type OrderProductSource = Pick<
  OrderRecord,
  'products' | 'brand' | 'productName' | 'specification' | 'quantity' | 'unitPrice' | 'amount' | 'paymentAccount' | 'paymentSplits'
>;

function parseSplits(value: OrderRecord['paymentSplits']): PaymentSplit[] | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 读取订单货品明细的唯一入口。
 * 新结构订单返回 products 数组；未迁移的旧扁平订单回退为单货品数组。
 */
export function getOrderProducts(record: OrderProductSource): ProductItem[] {
  if (Array.isArray(record.products) && record.products.length > 0) {
    return record.products;
  }
  if (record.brand || record.productName || record.quantity || record.amount || record.paymentAccount) {
    return [{
      brand: record.brand || '',
      productName: record.productName || '',
      specification: record.specification || '',
      quantity: Number(record.quantity) || 0,
      unitPrice: Number(record.unitPrice) || 0,
      amount: Number(record.amount) || 0,
      paymentAccount: record.paymentAccount || '',
      paymentSplits: parseSplits(record.paymentSplits),
    }];
  }
  return [];
}

export function getOrderTotalQuantity(record: OrderProductSource): number {
  return getOrderProducts(record).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
}

export function getOrderTotalAmount(record: OrderProductSource): number {
  return getOrderProducts(record).reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
}

/**
 * 读取订单收款拆分的唯一入口。
 * 新结构收款在订单级（paymentAccount/paymentSplits）；旧数据回退为各货品收款合并（同账户金额累加）。
 */
export function getOrderPaymentSplits(record: OrderProductSource): PaymentSplit[] {
  const orderSplits = (parseSplits(record.paymentSplits) || [])
    .map(split => ({ account: String(split?.account || '').trim(), amount: Math.max(0, Number(split?.amount) || 0) }))
    .filter(split => split.account || split.amount > 0);
  if (orderSplits.length > 0) return orderSplits;
  if (record.paymentAccount) {
    return [{ account: record.paymentAccount, amount: getOrderTotalAmount(record) }];
  }

  // 旧结构：货品级收款合并
  const merged = new Map<string, number>();
  const order: string[] = [];
  for (const item of Array.isArray(record.products) ? record.products : []) {
    const itemSplits = parseSplits(item.paymentSplits) || [];
    const entries = itemSplits.length > 0
      ? itemSplits.map(split => ({ account: String(split?.account || '').trim(), amount: Math.max(0, Number(split?.amount) || 0) }))
      : (item.paymentAccount ? [{ account: item.paymentAccount, amount: Math.max(0, Number(item.amount) || 0) }] : []);
    for (const entry of entries) {
      if (!entry.account && entry.amount <= 0) continue;
      if (merged.has(entry.account)) {
        merged.set(entry.account, merged.get(entry.account)! + entry.amount);
      } else {
        merged.set(entry.account, entry.amount);
        order.push(entry.account);
      }
    }
  }
  return order.map(account => ({ account, amount: merged.get(account)! }));
}

/** 订单是否存在未收款（订单列表红行、首页/顶栏消息提醒共用；订单级与旧货品级均判定） */
export function hasUnreceivedPayment(record: OrderProductSource): boolean {
  if (record.paymentAccount === '未收款') return true;
  if ((parseSplits(record.paymentSplits) || []).some(split => split?.account === '未收款')) return true;
  return getOrderProducts(record).some(item =>
    item.paymentAccount === '未收款' ||
    (parseSplits(item.paymentSplits) || []).some(split => split?.account === '未收款')
  );
}
