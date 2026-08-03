import * as XLSX from 'xlsx';
import type { PurchaseRecord } from '../hooks/usePurchases';

const HEADERS = [
  '采购单号',
  '采购日期',
  '采购属性',
  '供货商',
  '责任人',
  '品牌',
  '型号',
  '规格',
  '采购数量',
  '采购单价',
  '采购总额',
  '已退数量',
  '应付数量',
  '退货扣减',
  '应付金额',
  '付款状态',
  '付款日期',
  '付款账户',
  '付款金额',
  '付款备注',
  '退货记录',
] as const;

const COLUMN_WIDTHS = [16, 12, 10, 20, 12, 12, 22, 14, 12, 12, 14, 12, 12, 14, 14, 12, 12, 26, 14, 24, 36];
const MONEY_COLUMN_INDEXES = [9, 10, 13, 14, 18];

function roundMoney(value: unknown): number {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function paymentStatusLabel(status: PurchaseRecord['paymentStatus']): string {
  if (status === 'paid') return '已付款';
  if (status === 'no_payment') return '无需付款';
  return '待付款';
}

function formatPaymentAccount(record: PurchaseRecord): string {
  const splits = record.payment?.splits || [];
  if (splits.length > 1) {
    return splits.map(item => `${item.account} ¥${roundMoney(item.amount)}`).join('；');
  }
  return record.payment?.account || splits[0]?.account || '';
}

function formatAdjustments(record: PurchaseRecord): string {
  return (record.adjustments || [])
    .map(item => `${item.quantity}台 ${item.reason}${item.remark ? `（${item.remark}）` : ''}`)
    .join('；');
}

export function exportPurchaseRecordsExcel(records: PurchaseRecord[], filename?: string): void {
  const dataRows: Array<Array<string | number>> = records.map(record => [
    record.purchaseNumber || '',
    record.date || '',
    record.purchaseType === 'recycle' ? '回收' : '采购',
    record.supplier || '',
    record.owner || '',
    record.brand || '',
    record.model || '',
    record.specification || '',
    Number(record.quantity || 0),
    roundMoney(record.unitPrice),
    roundMoney(record.totalAmount ?? record.quantity * record.unitPrice),
    Number(record.returnedQuantity || 0),
    Number(record.payableQuantity ?? record.quantity),
    roundMoney(record.returnDeduction),
    roundMoney(record.payableAmount ?? record.quantity * record.unitPrice),
    paymentStatusLabel(record.paymentStatus),
    record.payment?.date || '',
    formatPaymentAccount(record),
    roundMoney(record.payment?.amount),
    record.payment?.remark || '',
    formatAdjustments(record),
  ]);

  const worksheetData: Array<Array<string | number>> = [[...HEADERS], ...dataRows];
  const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);
  worksheet['!cols'] = COLUMN_WIDTHS.map(wch => ({ wch }));

  for (let rowIndex = 1; rowIndex < worksheetData.length; rowIndex += 1) {
    MONEY_COLUMN_INDEXES.forEach(columnIndex => {
      const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
      if (cell?.t === 'n') {
        const scaledValue = Math.round(Number(cell.v) * 100);
        const decimalPlaces = scaledValue % 100 === 0 ? 0 : scaledValue % 10 === 0 ? 1 : 2;
        cell.z = decimalPlaces === 0 ? '0' : decimalPlaces === 1 ? '0.0' : '0.00';
      }
    });
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '采购明细');
  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  XLSX.writeFile(workbook, filename || `采购明细_${date}.xlsx`);
}
