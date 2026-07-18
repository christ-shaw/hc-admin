import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { OrderRecord } from '../types';
import { getBrandLabel, getProductLabel } from '../data/dict';
import { getOrderProducts } from './orderProducts';

export interface SfExportConfig {
  senderName: string;
  senderMobile: string;
  senderPhone: string;
  senderAddress: string;
}

export const DEFAULT_SF_EXPORT_CONFIG: SfExportConfig = {
  senderName: '汇创',
  senderMobile: '18123809373',
  senderPhone: '',
  senderAddress: '深圳龙岗区横岗街道亿立方大厦915',
};

const SF_EXPORT_CONFIG_KEY = 'hc-admin:sf-export-config';
const TEMPLATE_FILE_NAME = 'sf-offline-order-template.xlsx';

function normalizeText(value: unknown, maxLength: number): string {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, maxLength);
}

export function loadSfExportConfig(): SfExportConfig {
  if (typeof window === 'undefined') return { ...DEFAULT_SF_EXPORT_CONFIG };
  try {
    const stored = JSON.parse(window.localStorage.getItem(SF_EXPORT_CONFIG_KEY) || '{}') as Partial<SfExportConfig>;
    return {
      senderName: stored.senderName || DEFAULT_SF_EXPORT_CONFIG.senderName,
      senderMobile: stored.senderMobile || DEFAULT_SF_EXPORT_CONFIG.senderMobile,
      senderPhone: stored.senderPhone || '',
      senderAddress: stored.senderAddress || DEFAULT_SF_EXPORT_CONFIG.senderAddress,
    };
  } catch {
    return { ...DEFAULT_SF_EXPORT_CONFIG };
  }
}

export function saveSfExportConfig(config: SfExportConfig): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SF_EXPORT_CONFIG_KEY, JSON.stringify(config));
}

function getTemplateUrl(): string {
  const baseUrl = import.meta.env.BASE_URL || '/';
  return `${baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`}templates/${TEMPLATE_FILE_NAME}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSfRow(record: OrderRecord, config: SfExportConfig): string[] {
  const payment = getSfPayment(record.shippingFee);
  return [
    normalizeText(record.consignee, 100),
    normalizeText(record.consigneePhone, 20),
    '',
    normalizeText(record.consigneeAddress, 200),
    normalizeText(config.senderName, 100),
    normalizeText(config.senderMobile, 20),
    normalizeText(config.senderPhone, 20),
    normalizeText(config.senderAddress, 200),
    '电子产品',
    '顺丰标快',
    payment.method,
    payment.monthlyCard,
    '',
    '',
    '',
    buildSfRemark(record),
  ];
}

function getSfPayment(shippingFee: string): { method: string; monthlyCard: string } {
  const normalized = String(shippingFee || '').trim();
  if (['prepaid', '包邮', '寄付月结'].includes(normalized)) {
    return { method: '寄付月结', monthlyCard: '7555396782' };
  }
  if (['cod', '到付', '收方付'].includes(normalized)) {
    return { method: '收方付', monthlyCard: '' };
  }
  throw new Error(`订单快递方式“${normalized || '未设置'}”无法导入顺丰模板`);
}

function buildSfRemark(record: OrderRecord): string {
  const models = getOrderProducts(record).map(item => {
    const specification = item.specification && item.specification !== '默认' ? item.specification : '';
    const model = [getBrandLabel(item.brand), getProductLabel(item.productName), specification]
      .filter(Boolean)
      .join(' ');
    const quantity = Number(item.quantity) > 0 ? `×${Number(item.quantity)}` : '';
    return `${model}${quantity}`.trim();
  }).filter(Boolean).join('、');

  return normalizeText([
    record.customerRemark,
    models ? `发货型号：${models}` : '',
  ].filter(Boolean).join('；'), 200);
}

const SF_COLUMNS = 'ABCDEFGHIJKLMNOP'.split('');
const DATA_CELL_STYLES: Record<string, string> = { A: '47', B: '47', D: '48' };

function buildInlineCell(column: string, rowNumber: number, value: string): string {
  const style = DATA_CELL_STYLES[column] ? ` s="${DATA_CELL_STYLES[column]}"` : '';
  return `<x:c r="${column}${rowNumber}"${style} t="inlineStr"><x:is><x:t xml:space="preserve">${escapeXml(value)}</x:t></x:is></x:c>`;
}

function fillTemplateSheet(sheetXml: string, records: OrderRecord[], config: SfExportConfig): string {
  const sheetDataMatch = sheetXml.match(/<x:sheetData>([\s\S]*?)<\/x:sheetData>/);
  if (!sheetDataMatch) throw new Error('顺丰模板的工作表结构无法识别');

  const headerRows = (sheetDataMatch[1].match(/<x:row\b[\s\S]*?<\/x:row>/g) || [])
    .filter(rowXml => /\br="(?:1|2)"/.test(rowXml))
    .join('');
  if (!headerRows) throw new Error('顺丰模板缺少表头');

  const dataRows = records.map((record, index) => {
    const rowNumber = index + 3;
    const cells = buildSfRow(record, config)
      .map((value, columnIndex) => buildInlineCell(SF_COLUMNS[columnIndex], rowNumber, value))
      .join('');
    return `<x:row r="${rowNumber}">${cells}</x:row>`;
  }).join('');

  const filledSheetData = `<x:sheetData>${headerRows}${dataRows}</x:sheetData>`;
  return sheetXml
    .replace(sheetDataMatch[0], filledSheetData)
    .replace(/<x:dimension\b[^>]*\/>/, `<x:dimension ref="A1:P${records.length + 2}" />`)
    .replace(/<x:hyperlinks>[\s\S]*?<\/x:hyperlinks>/, '');
}

function downloadWorkbook(bytes: Uint8Array, fileName: string): void {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** 将勾选的待发货订单写入顺丰线下订单模板并触发下载。 */
export async function exportSfOfflineOrders(records: OrderRecord[], config: SfExportConfig): Promise<void> {
  const response = await fetch(getTemplateUrl());
  if (!response.ok) throw new Error(`顺丰模板加载失败（HTTP ${response.status}）`);

  const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const worksheetPath = 'xl/worksheets/sheet1.xml';
  const worksheet = files[worksheetPath];
  if (!worksheet) throw new Error('顺丰模板缺少“填写模板”工作表');
  files[worksheetPath] = strToU8(fillTemplateSheet(strFromU8(worksheet), records, config));

  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  downloadWorkbook(zipSync(files, { level: 6 }), `顺丰待发货订单_${date}_${records.length}条.xlsx`);
}
