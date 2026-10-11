import type { InvoiceRecord, InvoiceLinkedOrder, OrderRecord } from '../types';
import { getOrderProducts } from './orderProducts';
export type InvoiceDraft = Omit<InvoiceRecord, '_id' | 'createTime'>;
export const money = (value: number) => `¥${(Number.isFinite(value) ? value : 0).toFixed(2)}`;
export const orderTotal = (orders: InvoiceLinkedOrder[]) => orders.reduce((sum, order) => sum + Math.round(order.amount * 100), 0) / 100;
export function orderSnapshot(order: OrderRecord): InvoiceLinkedOrder {
  const products = getOrderProducts(order);
  return { orderId: order._id, serialNumber: order.serialNumber, onlineOrderNumber: order.onlineOrderNumber || '', customerName: order.customerName || '', salesChannel: order.salesChannel || '', orderDate: order.date || '', productSummary: products.map(p => [p.brand, p.productName, p.specification, p.quantity ? `×${p.quantity}` : ''].filter(Boolean).join(' ')).join('；'), amount: products.reduce((sum, p) => sum + Math.round((Number(p.amount) || 0) * 100), 0) / 100, attachments: order.attachments || [] };
}
export function replaceLinkedOrders(form: InvoiceDraft, orders: InvoiceLinkedOrder[], adjusted: boolean): InvoiceDraft {
  const total = orderTotal(orders);
  return { ...form, linkedOrders: orders, linkedOrderTotal: total, invoiceAmount: adjusted ? form.invoiceAmount : total, amountAdjustmentReason: adjusted ? form.amountAdjustmentReason : '' };
}
export function validateLinkedInvoice(form: InvoiceDraft): string | null {
  if (form.entryMode !== 'linkedOrders') return null;
  if (!form.linkedOrders?.length) return '请至少关联一张订单，或切换手工填写';
  if (!Number.isFinite(form.invoiceAmount) || form.invoiceAmount <= 0 || Math.abs(form.invoiceAmount * 100 - Math.round(form.invoiceAmount * 100)) > 0.00001) return '开票金额必须大于零且最多两位小数';
  if (Math.round(form.invoiceAmount * 100) !== Math.round(orderTotal(form.linkedOrders) * 100) && !form.amountAdjustmentReason?.trim()) return '请填写金额调整原因';
  return null;
}
