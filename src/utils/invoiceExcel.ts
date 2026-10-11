import * as XLSX from 'xlsx';
import { callFunction } from '../lib/cloudbase';
import type { InvoiceFilters, InvoiceRecord } from '../types';
import { INVOICE_STATUS_MAP, getDictLabel } from '../data/dict';
import { formatDate } from './format';

interface InvoiceExportPage {
  success: boolean;
  data: InvoiceRecord[];
  total: number;
  page: number;
  pageSize: number;
  errMsg?: string;
}

export function prepareInvoiceFilters(filters: InvoiceFilters): InvoiceFilters {
  if (filters.startDate && filters.endDate && filters.startDate > filters.endDate) {
    throw new Error('开始日期不能晚于结束日期');
  }
  return {
    ...filters,
    companyName: filters.companyName?.trim(),
    applicant: filters.applicant?.trim(),
  };
}

/** 独立读取全部匹配记录，不改变列表的当前页和筛选状态。 */
export async function exportInvoicesExcel(
  filters: InvoiceFilters,
  statusMap: Record<string, string> = INVOICE_STATUS_MAP,
): Promise<number> {
  const exportFilters = prepareInvoiceFilters(filters);
  const records: InvoiceRecord[] = [];
  const ids = new Set<string>();
  const pageSize = 100;
  let total: number | undefined;

  for (let page = 1; ; page++) {
    const result = await callFunction<InvoiceExportPage>('queryInvoices', {
      data: { ...exportFilters, page, pageSize },
    });
    if (!result?.success) throw new Error(result?.errMsg || '查询发票失败');
    if (!Array.isArray(result.data) || !Number.isSafeInteger(result.total) || result.total < 0
      || result.page !== page || result.pageSize !== pageSize) {
      throw new Error('发票分页数据异常，请重试');
    }
    total ??= result.total;
    // 读取期间发生增删或页码回退时停止，避免下载重复或不完整的文件。
    if (result.total !== total || result.data.length !== Math.min(pageSize, total - records.length)) {
      throw new Error('发票数据已变化，请重新导出');
    }
    for (const record of result.data) {
      if (!record._id || ids.has(record._id)) throw new Error('发票数据已变化，请重新导出');
      ids.add(record._id);
      records.push(record);
    }
    if (records.length === total) break;
  }

  if (records.length === 0) return 0;

  const labels = { ...INVOICE_STATUS_MAP, ...statusMap };
  const rows = [
    ['申请日期', '公司名称', '店铺名字', '开票金额', '开票申请人', '开票状态'],
    ...records.map(record => [
      formatDate(record.applyDate, false),
      record.companyName || '',
      record.shopName || '',
      Number.isFinite(Number(record.invoiceAmount)) ? Number(record.invoiceAmount) : '',
      record.applicant || '',
      getDictLabel(labels, record.status),
    ]),
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet['!cols'] = [14, 36, 22, 18, 18, 14].map(wch => ({ wch }));
  worksheet['!autofilter'] = { ref: `A1:F${rows.length}` };
  for (let row = 2; row <= rows.length; row++) {
    if (worksheet[`D${row}`]?.t === 'n') worksheet[`D${row}`].z = '#,##0.00';
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '发票明细');
  const range = exportFilters.startDate || exportFilters.endDate
    ? `${exportFilters.startDate || '不限'}_至_${exportFilters.endDate || '不限'}`
    : `全部日期_${formatDate(new Date(), false)}`;
  XLSX.writeFile(workbook, `发票明细_${range}.xlsx`);
  return records.length;
}
