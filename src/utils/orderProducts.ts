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

/** 订单是否存在未收款货品（订单列表红行、首页/顶栏消息提醒共用） */
export function hasUnreceivedPayment(record: OrderProductSource): boolean {
  return getOrderProducts(record).some(item =>
    item.paymentAccount === '未收款' ||
    (parseSplits(item.paymentSplits) || []).some(split => split?.account === '未收款')
  );
}
