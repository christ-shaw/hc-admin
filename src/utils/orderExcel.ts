import * as XLSX from 'xlsx';
import { OrderRecord } from '../types';

/** Excel 列名 → OrderRecord 字段映射 */
const EXCEL_COLUMN_MAP: Record<string, keyof OrderRecord> = {
  '序号': 'serialNumber',
  '日期': 'date',
  '订单来源': 'orderSource',
  '订单属性': 'orderAttribute',
  '订单类型': 'orderType',
  '销售渠道': 'salesChannel',
  '人员': 'salesperson',
  '渠道类别': 'channelCategory',
  '网店订单号': 'onlineOrderNumber',
  '客户名称': 'customerName',
  '品牌': 'brand',
  '货品名称': 'productName',
  '规格': 'specification',
  '数量': 'quantity',
  '单价': 'unitPrice',
  '金额': 'amount',
  '收款账户': 'paymentAccount',
  '物流单号': 'trackingNumber',
  '收/发货人': 'consignee',
  '订单状态': 'status',
  '客服备注': 'customerRemark',
  '转租赁2\n货品名称': 'transferProductName',
  '转租赁2\n规格': 'transferSpecification',
  '已交租期': 'paidPeriod',
  '已交租金': 'paidRent',
};

/** OrderRecord 字段 → Excel 列名映射（导出用，保持原列顺序） */
const EXPORT_COLUMNS: { key: keyof OrderRecord; header: string }[] = [
  { key: 'serialNumber', header: '序号' },
  { key: 'date', header: '日期' },
  { key: 'orderSource', header: '订单来源' },
  { key: 'orderAttribute', header: '订单属性' },
  { key: 'orderType', header: '订单类型' },
  { key: 'salesChannel', header: '销售渠道' },
  { key: 'salesperson', header: '人员' },
  { key: 'channelCategory', header: '渠道类别' },
  { key: 'onlineOrderNumber', header: '网店订单号' },
  { key: 'customerName', header: '客户名称' },
  { key: 'brand', header: '品牌' },
  { key: 'productName', header: '货品名称' },
  { key: 'specification', header: '规格' },
  { key: 'quantity', header: '数量' },
  { key: 'unitPrice', header: '单价' },
  { key: 'amount', header: '金额' },
  { key: 'paymentAccount', header: '收款账户' },
  { key: 'trackingNumber', header: '物流单号' },
  { key: 'consignee', header: '收/发货人' },
  { key: 'status', header: '订单状态' },
  { key: 'customerRemark', header: '客服备注' },
  { key: 'transferProductName', header: '转租赁2\n货品名称' },
  { key: 'transferSpecification', header: '转租赁2\n规格' },
  { key: 'paidPeriod', header: '已交租期' },
  { key: 'paidRent', header: '已交租金' },
];

/** 将 Excel 日期序列号转为 YYYY-MM-DD 字符串（使用 UTC 避免时区偏移） */
function excelDateToString(val: unknown): string {
  if (val instanceof Date) {
    const y = val.getUTCFullYear();
    const m = String(val.getUTCMonth() + 1).padStart(2, '0');
    const d = String(val.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof val === 'number') {
    // Excel 日期序列号：以 1900-01-01 为第1天（含 Lotus 1-2-3 闰年 bug，1900-02-29 为第60天）
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const jsDate = new Date(epoch.getTime() + val * 86400000);
    const y = jsDate.getUTCFullYear();
    const m = String(jsDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(jsDate.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(trimmed)) {
      const [y, m, d] = trimmed.split('-');
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(trimmed)) {
      const [y, m, d] = trimmed.split('/');
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    return trimmed;
  }
  return '';
}

/** 将 Excel 原始值转为目标类型 */
function parseValue(key: keyof OrderRecord, val: unknown): unknown {
  if (val === undefined || val === null || val === '' || val === 0 && (key === 'brand' || key === 'channelCategory')) {
    return '';
  }
  if (key === 'serialNumber' || key === 'quantity' || key === 'amount' || key === 'paidPeriod' || key === 'paidRent' || key === 'unitPrice') {
    const num = Number(val);
    return isNaN(num) ? 0 : num;
  }
  if (key === 'date') {
    return excelDateToString(val);
  }
  return String(val ?? '');
}

/** 从 Excel 文件解析订单数据 */
export function parseOrderExcel(file: File): Promise<OrderRecord[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array', cellDates: false });
        const sheetName = workbook.SheetNames.includes('订单明细') ? '订单明细' : workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });

        const records: OrderRecord[] = json
          .map((row, idx) => {
            const record: Record<string, unknown> = { _id: `import_${idx}` };
            for (const [colName, fieldKey] of Object.entries(EXCEL_COLUMN_MAP)) {
              const rawVal = row[colName];
              record[fieldKey] = parseValue(fieldKey, rawVal);
            }
            return record as unknown as OrderRecord;
          })
          .filter(r => r.date && r.date.trim() !== '');

        resolve(records);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsArrayBuffer(file);
  });
}

/** 将订单数据导出为 Excel 文件并触发下载 */
export function exportOrderExcel(records: OrderRecord[], filename?: string): void {
  const headerRow = EXPORT_COLUMNS.map(c => c.header);
  const dataRows = records.map(r =>
    EXPORT_COLUMNS.map(c => {
      const val = r[c.key];
      if (c.key === 'date') return val || '';
      return val ?? '';
    })
  );

  const wsData = [headerRow, ...dataRows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // 设置列宽
  ws['!cols'] = EXPORT_COLUMNS.map((c) => {
    if (c.header.includes('\n')) return { wch: 14 };
    if (c.key === 'onlineOrderNumber' || c.key === 'trackingNumber') return { wch: 28 };
    if (c.key === 'customerName' || c.key === 'productName') return { wch: 14 };
    return { wch: 10 };
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '订单明细');
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const name = filename || `订单明细_${dateStr}.xlsx`;
  XLSX.writeFile(wb, name);
}
