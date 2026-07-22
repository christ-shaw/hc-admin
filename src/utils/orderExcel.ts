import * as XLSX from 'xlsx';
import { OrderRecord, ProductItem } from '../types';
import { getBrandLabel, getDictLabel, getProductLabel, ORDER_SOURCE_MAP, ORDER_ATTRIBUTE_MAP, ORDER_TYPE_MAP, SALES_CHANNEL_MAP, CHANNEL_CATEGORY_MAP, ORDER_STATUS_MAP } from '../data/dict';
import { getOrderProducts, getOrderPaymentSplits } from './orderProducts';

/** 货品级字段（Excel 一行一条货品，其余列为订单公共字段；收款账户在订单级） */
const PRODUCT_FIELD_KEYS = new Set<keyof OrderRecord>(['brand', 'productName', 'specification', 'quantity', 'unitPrice', 'amount']);

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

/** 订单级收款账户展示（旧数据货品级收款由 getOrderPaymentSplits 折算） */
function formatOrderPaymentAccount(record: OrderRecord): string {
  const splits = getOrderPaymentSplits(record);
  if (splits.length === 0) return record.paymentAccount || '';
  if (splits.length === 1) return splits[0].account || record.paymentAccount || '';
  return splits.map(split => `${split.account || '-'} ¥${split.amount || 0}`).join('；');
}

/** 单价导出最多保留两位小数，避免浮点计算产生多余小数位。 */
function formatExportUnitPrice(value: unknown): number | '' {
  if (value === '' || value === undefined || value === null) return '';
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return '';
  return Math.round((numericValue + Number.EPSILON) * 100) / 100;
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

        const flatRows = json
          .map((row, idx) => {
            const record: Record<string, unknown> = { _id: `import_${idx}` };
            for (const [colName, fieldKey] of Object.entries(EXCEL_COLUMN_MAP)) {
              const rawVal = row[colName];
              record[fieldKey] = parseValue(fieldKey, rawVal);
            }
            return record as unknown as OrderRecord;
          })
          .filter(r => r.date && r.date.trim() !== '');

        // 同一序号的多行 = 同一订单的多条货品，归组为一条带 products 数组的记录；
        // 各行的收款账户×金额合并为订单级拆分（同账户累加）
        const grouped: OrderRecord[] = [];
        const bySerial = new Map<string, OrderRecord>();
        const paymentAgg = new Map<string, { accounts: string[]; amounts: Map<string, number> }>();
        for (const row of flatRows) {
          const item: ProductItem = {
            brand: row.brand || '',
            productName: row.productName || '',
            specification: row.specification || '',
            quantity: Number(row.quantity) || 0,
            unitPrice: Number(row.unitPrice) || 0,
            amount: Number(row.amount) || 0,
          };
          // 序号为空/0 的行无法归组，各自成单
          const groupKey = row.serialNumber ? `${row.serialNumber}|${row.date}|${row.customerName}` : `__row_${row._id}`;

          const account = String(row.paymentAccount || '').trim();
          let agg = paymentAgg.get(groupKey);
          if (!agg) {
            agg = { accounts: [], amounts: new Map() };
            paymentAgg.set(groupKey, agg);
          }
          if (account) {
            const amount = Number(row.amount) || 0;
            if (agg.amounts.has(account)) {
              agg.amounts.set(account, agg.amounts.get(account)! + amount);
            } else {
              agg.amounts.set(account, amount);
              agg.accounts.push(account);
            }
          }

          const existing = bySerial.get(groupKey);
          if (existing && existing.products) {
            existing.products.push(item);
          } else {
            const record: OrderRecord = { ...row, products: [item] };
            for (const key of PRODUCT_FIELD_KEYS) {
              delete (record as unknown as Record<string, unknown>)[key];
            }
            bySerial.set(groupKey, record);
            grouped.push(record);
          }
        }

        // 写回订单级收款
        for (const [groupKey, agg] of paymentAgg) {
          const record = bySerial.get(groupKey);
          if (!record) continue;
          const splits = agg.accounts.map(account => ({ account, amount: agg.amounts.get(account)! }));
          record.paymentSplits = splits;
          record.paymentAccount = Array.from(new Set(agg.accounts)).join('、');
        }

        resolve(grouped);
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
  /** 需要做 key→中文 label 转换的字段 */
  const DICT_FIELDS: Partial<Record<keyof OrderRecord, Record<string, string>>> = {
    orderSource: ORDER_SOURCE_MAP,
    orderAttribute: ORDER_ATTRIBUTE_MAP,
    orderType: ORDER_TYPE_MAP,
    salesChannel: SALES_CHANNEL_MAP,
    channelCategory: CHANNEL_CATEGORY_MAP,
    status: ORDER_STATUS_MAP,
  };

  // 一条货品一行：多货品订单展开为多行，公共列重复
  const dataRows = records.flatMap(r => {
    const items = getOrderProducts(r);
    const rows = items.length > 0 ? items : [undefined];
    return rows.map(item =>
      EXPORT_COLUMNS.map(c => {
        const val = PRODUCT_FIELD_KEYS.has(c.key)
          ? (item ? item[c.key as keyof ProductItem] : '')
          : r[c.key];
        if (c.key === 'date') return val || '';
        if (c.key === 'brand' && typeof val === 'string') return getBrandLabel(val);
        if ((c.key === 'productName' || c.key === 'transferProductName') && typeof val === 'string') return getProductLabel(val);
        if (c.key === 'paymentAccount') return formatOrderPaymentAccount(r);
        if (c.key === 'unitPrice') return formatExportUnitPrice(val);
        const dict = DICT_FIELDS[c.key];
        if (dict && typeof val === 'string' && val) return getDictLabel(dict, val);
        return val ?? '';
      })
    );
  });

  const wsData = [headerRow, ...dataRows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // 按实际精度设置单元格格式，避免部分表格软件用 0.## 显示出多余的小数点。
  const unitPriceColumnIndex = EXPORT_COLUMNS.findIndex(column => column.key === 'unitPrice');
  for (let rowIndex = 1; rowIndex < wsData.length; rowIndex += 1) {
    const cell = ws[XLSX.utils.encode_cell({ r: rowIndex, c: unitPriceColumnIndex })];
    if (cell?.t === 'n') {
      const scaledPrice = Math.round(Number(cell.v) * 100);
      const decimalPlaces = scaledPrice % 100 === 0 ? 0 : scaledPrice % 10 === 0 ? 1 : 2;
      cell.z = decimalPlaces === 0 ? '0' : decimalPlaces === 1 ? '0.0' : '0.00';
    }
  }

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
