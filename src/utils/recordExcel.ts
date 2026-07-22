import * as XLSX from 'xlsx';
import { InboundRecord, OutboundRecord } from '../types';
import { OUTBOUND_STATUS_MAP, SHIPPING_FEE_MAP } from '../data/dict';
import { extractDateString, getTotalQuantity } from './format';

type ChannelLabelGetter = (value: string) => string;

function formatModels(record: { phoneModels?: Array<{ model: string; quantity: number }> }): string {
  return (record.phoneModels || [])
    .map(item => `${item.model} × ${item.quantity}`)
    .join('；');
}

function formatFilename(type: '入库记录' | '出库记录', startDate: string, endDate: string): string {
  return `${type}_${startDate}_${endDate}.xlsx`;
}

function writeWorkbook(rows: Array<Array<string | number>>, columns: number[], sheetName: string, filename: string) {
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet['!cols'] = columns.map(width => ({ wch: width }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  XLSX.writeFile(workbook, filename);
}

export function exportInboundRecordsExcel(
  records: InboundRecord[],
  startDate: string,
  endDate: string,
  getChannelLabel: ChannelLabelGetter,
) {
  const sortedRecords = [...records].sort((a, b) => (
    (extractDateString(b.inboundDate) || '').localeCompare(extractDateString(a.inboundDate) || '')
  ));
  const dataRows = sortedRecords.flatMap(record => {
    const products = record.phoneModels?.length > 0
      ? record.phoneModels
      : [{ model: '', quantity: 0 }];

    return products.map(product => [
      extractDateString(record.inboundDate) || '',
      record.customerName || '',
      getChannelLabel(record.type) || record.type || '',
      record.shopName || '',
      record.trackingNumber || '',
      product.model || '',
      product.quantity || 0,
      record.hasIssue ? '是' : '否',
      record.remark || '',
    ]);
  });
  const rows: Array<Array<string | number>> = [
    ['入库日期', '客户名称', '渠道类型', '渠道名称', '快递单号', '手机型号', '数量', '是否异常', '备注'],
    ...dataRows,
  ];

  writeWorkbook(rows, [12, 20, 12, 16, 22, 28, 10, 10, 30], '入库记录', formatFilename('入库记录', startDate, endDate));
}

export function exportOutboundRecordsExcel(records: OutboundRecord[], startDate: string, endDate: string) {
  const sortedRecords = [...records].sort((a, b) => (
    (extractDateString(b.outboundDate) || '').localeCompare(extractDateString(a.outboundDate) || '')
  ));
  const rows: Array<Array<string | number>> = [
    ['出库日期', '状态', '客户名称', '快递单号', '手机型号及数量', '总数量', '快递方式', '来源', '收货人', '收货电话', '收货地址', '是否异常', '备注'],
    ...sortedRecords.map(record => {
      const status = record.outboundStatus === 'pending' ? 'pending' : 'completed';
      return [
        extractDateString(record.outboundDate) || '',
        OUTBOUND_STATUS_MAP[status],
        record.customerName || '',
        record.trackingNumber || '',
        formatModels(record),
        getTotalQuantity(record),
        SHIPPING_FEE_MAP[record.shippingMethod as keyof typeof SHIPPING_FEE_MAP] || record.shippingMethod || '',
        record.source === 'order' ? '订单生成' : '手工创建',
        record.consignee || '',
        record.consigneePhone || '',
        record.consigneeAddress || '',
        record.hasIssue ? '是' : '否',
        record.remark || '',
      ];
    }),
  ];

  writeWorkbook(rows, [12, 10, 20, 22, 36, 10, 12, 12, 14, 16, 32, 10, 30], '出库记录', formatFilename('出库记录', startDate, endDate));
}
