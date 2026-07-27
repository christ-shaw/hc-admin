import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, Input, MessagePlugin, Select, Switch, Table, Tag } from 'tdesign-react';
import { FileDown, Printer, RotateCcw, Search, Truck } from 'lucide-react';
import type {
  OrderRecord,
  SfExpressWorkbenchRow,
  SfWorkbenchStatus,
} from '../types';
import { callFunction } from '../lib/cloudbase';
import { useDictionaries, DICT_CODES } from '../contexts/DictionaryContext';
import { formatDate } from '../utils/format';
import { getOrderProducts } from '../utils/orderProducts';
import { getBrandLabel, getProductLabel } from '../data/dict';
import {
  exportSfOfflineOrders,
  buildSfExportGroups,
  loadSfExportConfig,
  saveSfExportConfig,
  type SfExportConfig,
} from '../utils/sfOrderExcel';
import { useTabDirty } from '../contexts/TabWorkspaceContext';
import { usePermission } from '../hooks/usePermission';
import { SfPrintDialog } from '../components/SfPrintDialog';

interface SfFilters {
  date: string;
  serialNumber?: string;
  onlineOrderNumber?: string;
  consignee?: string;
  salesperson?: string;
  shippingFee?: string;
}

type TableRow = SfExpressWorkbenchRow & { _id: string };

interface QueryResult {
  success?: boolean;
  data?: SfExpressWorkbenchRow[];
  cursor?: string | null;
  hasMore?: boolean;
  env?: 'sandbox' | 'production';
  dataModelVersion?: number;
  dataModelCutoverDate?: string;
  errMsg?: string;
}

interface SfActionResult {
  success: boolean;
  env?: string;
  sourceOrderId?: string;
  sfExpressOrderId?: string;
  sfOrderId?: string;
  waybillNo?: string;
  outboundSync?: {
    action?: string;
    outboundRecordId?: string;
    existingTrackingNumber?: string;
    targetTrackingNumber?: string;
  };
  errMsg?: string;
}

interface SfPrintResult extends SfActionResult {
  fileName?: string;
  mimeType?: string;
  pdfBase64?: string;
  printedAt?: string;
}

interface SfExportRecordResult {
  success: boolean;
  insertedCount?: number;
  duplicatedCount?: number;
  exportedAt?: string;
  errMsg?: string;
}

const PAGE_SIZE = 20;

const STATUS_META: Record<SfWorkbenchStatus, {
  label: string;
  theme: 'default' | 'primary' | 'warning' | 'success' | 'danger';
}> = {
  not_required: { label: '无需顺丰', theme: 'default' },
  not_created: { label: '未下单', theme: 'primary' },
  applying: { label: '申请中', theme: 'warning' },
  applied: { label: '申请成功', theme: 'success' },
  failed: { label: '申请失败', theme: 'danger' },
  cancelled: { label: '已取消', theme: 'default' },
  other_express: { label: '其他快递', theme: 'default' },
  legacy_unmanaged: { label: '历史未纳入', theme: 'warning' },
};

function today(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function createExportBatchId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `sf-export-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function normalizeShippingFee(value: unknown): 'prepaid' | 'cod' | 'pickup' | '' {
  const normalized = String(value || '').trim();
  if (['prepaid', '包邮', '寄付月结'].includes(normalized)) return 'prepaid';
  if (['cod', '到付', '收方付'].includes(normalized)) return 'cod';
  if (['pickup', '自提'].includes(normalized)) return 'pickup';
  return '';
}

function getPaymentLabel(value: unknown) {
  const normalized = normalizeShippingFee(value);
  if (normalized === 'prepaid') return '寄付月结';
  if (normalized === 'cod') return '收方付';
  if (normalized === 'pickup') return '自提';
  return '未设置';
}

function getMissingFields(record: OrderRecord): string[] {
  const missing: string[] = [];
  if (!record.consignee?.trim()) missing.push('收件人');
  if (!record.consigneePhone?.trim() || !/^\d{6,20}$/.test(record.consigneePhone.trim())) missing.push('有效电话');
  if (!record.consigneeAddress?.trim()) missing.push('地址');
  if (!['prepaid', 'cod'].includes(normalizeShippingFee(record.shippingFee))) missing.push('付款方式');
  if (!getOrderProducts(record).some(item => String(item.productName || '').trim())) missing.push('货品');
  return missing;
}

function getProductSummary(record: OrderRecord) {
  return getOrderProducts(record).map(item => {
    const name = [
      getBrandLabel(item.brand),
      getProductLabel(item.productName),
      item.specification === '默认' ? '' : item.specification,
    ].filter(Boolean).join(' ');
    return `${name || '-'} ×${Number(item.quantity) || 0}`;
  }).join('、') || '-';
}

function canExport(row: SfExpressWorkbenchRow) {
  return ['not_created', 'failed', 'cancelled'].includes(row.sfStatus)
    && getMissingFields(row.order).length === 0;
}

function createPdfBlob(base64: string, mimeType = 'application/pdf') {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

export function SfExpress() {
  const dictionaries = useDictionaries();
  const { can } = usePermission();
  const canPrintWaybill = can('sf:print');
  const [filters, setFilters] = useState<SfFilters>({ date: today() });
  const [rows, setRows] = useState<TableRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCursors, setPageCursors] = useState<Array<string | null>>([null]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [selectedOrders, setSelectedOrders] = useState<Record<string, OrderRecord>>({});
  const selectedList = useMemo(() => Object.values(selectedOrders), [selectedOrders]);
  const [sfEnv, setSfEnv] = useState<'sandbox' | 'production' | ''>('');
  const [dataModelVersion, setDataModelVersion] = useState(1);
  const [cutoverDate, setCutoverDate] = useState('');

  const [applyTarget, setApplyTarget] = useState<TableRow | null>(null);
  const [applying, setApplying] = useState(false);
  const [queryingId, setQueryingId] = useState('');
  const [printingId, setPrintingId] = useState('');
  const [printTarget, setPrintTarget] = useState<TableRow | null>(null);
  const [cancelTarget, setCancelTarget] = useState<TableRow | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const [exportVisible, setExportVisible] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportConfig, setExportConfig] = useState<SfExportConfig>(loadSfExportConfig);
  const [mergeSameRecipient, setMergeSameRecipient] = useState(true);
  const exportInitialRef = useRef('');
  const exportGroups = useMemo(
    () => buildSfExportGroups(selectedList, mergeSameRecipient),
    [selectedList, mergeSameRecipient],
  );
  useTabDirty(
    exportVisible
      && !!exportInitialRef.current
      && JSON.stringify({ exportConfig, mergeSameRecipient }) !== exportInitialRef.current,
    '顺丰快递',
  );

  const salespersonOptions = useMemo(() => [
    { label: '全部人员', value: '' },
    ...dictionaries.getItems(DICT_CODES.salesperson).map(item => ({ label: item.label, value: item.value })),
  ], [dictionaries]);

  const loadRows = async (targetFilters: SfFilters, cursor: string | null, targetPageIndex: number) => {
    setLoading(true);
    try {
      const result = await callFunction<QueryResult>('querySfExpressOrders', {
        data: { limit: PAGE_SIZE, cursor, ...targetFilters },
      });
      if (result.success === false) throw new Error(result.errMsg || '查询失败');
      setRows((result.data || []).map(row => ({ ...row, _id: row.order._id })));
      setNextCursor(result.cursor || null);
      setHasMore(!!result.hasMore && !!result.cursor);
      setPageIndex(targetPageIndex);
      setSfEnv(result.env || '');
      setDataModelVersion(Number(result.dataModelVersion || 1));
      setCutoverDate(result.dataModelCutoverDate || '');
    } catch (error) {
      setRows([]);
      setNextCursor(null);
      setHasMore(false);
      MessagePlugin.error('顺丰订单查询失败：' + (error instanceof Error ? error.message : String(error)));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadRows({ date: today() }, null, 0);
  }, []);

  const resetPaginationAndLoad = (targetFilters: SfFilters) => {
    setSelectedOrders({});
    setPageCursors([null]);
    void loadRows(targetFilters, null, 0);
  };

  const handleSearch = () => {
    const next = Object.fromEntries(
      Object.entries(filters).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value])
    ) as unknown as SfFilters;
    setFilters(next);
    resetPaginationAndLoad(next);
  };

  const handleReset = () => {
    const next = { date: today() };
    setFilters(next);
    resetPaginationAndLoad(next);
  };

  const reloadCurrentPage = () => loadRows(filters, pageCursors[pageIndex] || null, pageIndex);

  const handleNextPage = () => {
    if (!hasMore || !nextCursor) return;
    const cursors = [...pageCursors.slice(0, pageIndex + 1), nextCursor];
    setPageCursors(cursors);
    void loadRows(filters, nextCursor, pageIndex + 1);
  };

  const handlePrevPage = () => {
    if (pageIndex <= 0) return;
    void loadRows(filters, pageCursors[pageIndex - 1] || null, pageIndex - 1);
  };

  const handleSelectionChange = (keys: Array<string | number>) => {
    const selectedKeys = new Set(keys.map(String));
    setSelectedOrders(previous => {
      const next = { ...previous };
      for (const row of rows) {
        if (selectedKeys.has(row._id) && canExport(row)) next[row._id] = row.order;
        else delete next[row._id];
      }
      return next;
    });
  };

  const handleOpenApply = (row: TableRow) => {
    const missing = getMissingFields(row.order);
    if (missing.length > 0) {
      MessagePlugin.warning(`请先在订单中补全：${missing.join('、')}`);
      return;
    }
    if (!sfEnv) {
      MessagePlugin.error('无法确认当前顺丰环境');
      return;
    }
    if (dataModelVersion !== 2) {
      MessagePlugin.error('顺丰独立订单模型尚未启用');
      return;
    }
    setApplyTarget(row);
  };

  const handleApply = async () => {
    if (!applyTarget) return;
    setApplying(true);
    try {
      const result = await callFunction<SfActionResult>('applySfExpress', {
        data: { sourceOrderId: applyTarget.order._id },
      });
      if (!result.success) throw new Error(result.errMsg || '顺丰下单失败');
      if (result.outboundSync?.action === 'conflict') {
        MessagePlugin.warning(
          `顺丰下单成功，运单号：${result.waybillNo || '-'}；但待出库记录已有其他单号 ${result.outboundSync.existingTrackingNumber || '-'}，请人工核对`
        );
      } else {
        MessagePlugin.success(`顺丰下单成功，运单号：${result.waybillNo || '-'}`);
      }
      setApplyTarget(null);
      await reloadCurrentPage();
    } catch (error) {
      MessagePlugin.error(error instanceof Error ? error.message : String(error));
      await reloadCurrentPage();
    } finally {
      setApplying(false);
    }
  };

  const handleQuery = async (row: TableRow) => {
    if (!row.currentSfOrder || queryingId) return;
    setQueryingId(row._id);
    try {
      const result = await callFunction<SfActionResult>('querySfOrderResult', {
        data: { sfExpressOrderId: row.currentSfOrder._id },
      });
      if (!result.success) throw new Error(result.errMsg || '查询顺丰订单失败');
      if (result.outboundSync?.action === 'conflict') {
        MessagePlugin.warning(
          `顺丰订单已更新，运单号：${result.waybillNo || '-'}；但待出库记录已有其他单号 ${result.outboundSync.existingTrackingNumber || '-'}，请人工核对`
        );
      } else {
        MessagePlugin.success(`顺丰订单已更新，运单号：${result.waybillNo || '-'}`);
      }
      await reloadCurrentPage();
    } catch (error) {
      MessagePlugin.error(error instanceof Error ? error.message : String(error));
      await reloadCurrentPage();
    } finally {
      setQueryingId('');
    }
  };

  const handleCancel = async () => {
    if (!cancelTarget?.currentSfOrder) return;
    setCancelling(true);
    try {
      const result = await callFunction<SfActionResult>('cancelSfExpress', {
        data: { sfExpressOrderId: cancelTarget.currentSfOrder._id },
      });
      if (!result.success) throw new Error(result.errMsg || '取消顺丰订单失败');
      MessagePlugin.success('顺丰发货已取消');
      setCancelTarget(null);
      await reloadCurrentPage();
    } catch (error) {
      MessagePlugin.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCancelling(false);
    }
  };

  const handlePdfPrint = async (row: SfExpressWorkbenchRow) => {
    if (!row.currentSfOrder || printingId) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      MessagePlugin.warning('浏览器已拦截打印窗口，请允许本站弹出窗口后重试');
      return;
    }
    printWindow.document.title = '正在生成顺丰丰密面单';
    printWindow.document.body.innerHTML = '<p style="font:14px sans-serif;padding:24px;color:#4b5563">正在生成顺丰丰密面单，请稍候…</p>';
    setPrintingId(row.order._id);
    try {
      const result = await callFunction<SfPrintResult>('printSfWaybill', {
        data: { sfExpressOrderId: row.currentSfOrder._id },
      });
      if (!result.success || !result.pdfBase64) throw new Error(result.errMsg || '顺丰未返回面单 PDF');
      const pdfUrl = URL.createObjectURL(createPdfBlob(result.pdfBase64, result.mimeType));
      printWindow.location.replace(pdfUrl);
      printWindow.addEventListener('load', () => {
        window.setTimeout(() => {
          try { printWindow.focus(); printWindow.print(); } catch { /* PDF 仍可手工打印 */ }
        }, 500);
      }, { once: true });
      window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 5 * 60 * 1000);
      MessagePlugin.success(`丰密面单已生成：${result.waybillNo || row.currentSfOrder.waybillNo}`);
      await reloadCurrentPage();
    } catch (error) {
      printWindow.close();
      MessagePlugin.error('丰密面单打印失败：' + (error instanceof Error ? error.message : String(error)));
    } finally {
      setPrintingId('');
    }
  };

  const handlePluginPrinted = () => {
    void reloadCurrentPage();
  };

  const handleOpenExport = () => {
    if (selectedList.length === 0) {
      MessagePlugin.warning('请先勾选需要导入顺丰模板的订单');
      return;
    }
    const config = loadSfExportConfig();
    setExportConfig(config);
    setMergeSameRecipient(true);
    exportInitialRef.current = JSON.stringify({ exportConfig: config, mergeSameRecipient: true });
    setExportVisible(true);
  };

  const handleExport = async () => {
    if (!exportConfig.senderName.trim()) return void MessagePlugin.warning('请填写寄件人');
    if (!exportConfig.senderMobile.trim() && !exportConfig.senderPhone.trim()) return void MessagePlugin.warning('请填写寄件人手机或电话');
    if (!exportConfig.senderAddress.trim()) return void MessagePlugin.warning('请填写寄件人详细地址');

    setExporting(true);
    try {
      saveSfExportConfig(exportConfig);
      const result = await exportSfOfflineOrders(selectedList, exportConfig, { mergeSameRecipient });
      const recordResult = await callFunction<SfExportRecordResult>('recordSfExport', {
        data: {
          orderIds: selectedList.map(record => record._id),
          exportBatchId: createExportBatchId(),
        },
      });
      if (!recordResult.success) {
        MessagePlugin.warning(`Excel 已生成，但导出记录失败：${recordResult.errMsg || '未知错误'}`);
      }
      MessagePlugin.success(result.rowCount === result.sourceOrderCount
        ? `已生成 ${result.rowCount} 条顺丰待发货数据`
        : `已将 ${result.sourceOrderCount} 条订单合并为 ${result.rowCount} 条顺丰待发货数据`);
      setExportVisible(false);
      setSelectedOrders({});
      await reloadCurrentPage();
    } catch (error) {
      MessagePlugin.error('顺丰模板导出失败：' + (error instanceof Error ? error.message : String(error)));
    } finally {
      setExporting(false);
    }
  };

  const columns = [
    {
      colKey: 'row-select',
      type: 'multiple' as const,
      width: 46,
      checkProps: ({ row }: { row: TableRow }) => ({
        disabled: !canExport(row),
        title: !canExport(row) ? '仅未下单、申请失败或已取消且资料完整的订单可导出' : '',
      }),
    },
    { colKey: 'serialNumber', title: '序号', width: 70, cell: ({ row }: { row: TableRow }) => row.order.serialNumber },
    { colKey: 'onlineOrderNumber', title: '网店订单号', width: 150, ellipsis: true, cell: ({ row }: { row: TableRow }) => row.order.onlineOrderNumber || '-' },
    { colKey: 'consignee', title: '收件人', width: 95, ellipsis: true, cell: ({ row }: { row: TableRow }) => row.order.consignee || '-' },
    { colKey: 'consigneePhone', title: '电话', width: 125, cell: ({ row }: { row: TableRow }) => row.order.consigneePhone || '-' },
    { colKey: 'products', title: '货品', width: 190, ellipsis: true, cell: ({ row }: { row: TableRow }) => getProductSummary(row.order) },
    { colKey: 'salesperson', title: '人员', width: 75, cell: ({ row }: { row: TableRow }) => row.order.salesperson || '-' },
    { colKey: 'shippingFee', title: '付款', width: 95, cell: ({ row }: { row: TableRow }) => getPaymentLabel(row.order.shippingFee) },
    {
      colKey: 'sfStatus',
      title: '顺丰状态',
      width: 150,
      cell: ({ row }: { row: TableRow }) => {
        const meta = STATUS_META[row.sfStatus];
        return (
          <div>
            <Tag theme={meta.theme} variant="light">{meta.label}</Tag>
            {row.otherEnvSummary.map(item => (
              <Tag key={item.env} className="ml-1" theme="warning" variant="light">
                {item.env === 'production' ? '生产' : '沙箱'}有记录
              </Tag>
            ))}
          </div>
        );
      },
    },
    { colKey: 'sfOrderId', title: '顺丰客户订单号', width: 175, ellipsis: true, cell: ({ row }: { row: TableRow }) => row.currentSfOrder?.sfOrderId || '-' },
    { colKey: 'waybillNo', title: '顺丰运单号', width: 145, cell: ({ row }: { row: TableRow }) => row.currentSfOrder?.waybillNo || '-' },
    {
      colKey: 'records',
      title: '记录',
      width: 155,
      cell: ({ row }: { row: TableRow }) => (
        <div className="text-xs text-gray-500">
          <div>导出 {row.exportSummary.count} 次 / 打印 {row.currentSfOrder?.printCount || 0} 次</div>
          {row.currentSfOrder?.errorMessage && (
            <div className="mt-1 truncate text-rose-600" title={row.currentSfOrder.errorMessage}>
              {row.currentSfOrder.errorMessage}
            </div>
          )}
        </div>
      ),
    },
    {
      colKey: 'actions',
      title: '操作',
      width: 280,
      fixed: 'right' as const,
      cell: ({ row }: { row: TableRow }) => {
        const canApply = ['not_created', 'cancelled'].includes(row.sfStatus);
        const canRetry = row.sfStatus === 'failed';
        const canQuery = ['applying', 'failed', 'applied'].includes(row.sfStatus) && !!row.currentSfOrder;
        const canPrint = row.sfStatus === 'applied' && !!row.currentSfOrder?.waybillNo;
        const canCancel = row.sfStatus === 'applied';
        return (
          <div className="flex flex-wrap items-center gap-1">
            {(canApply || canRetry) && (
              <Button
                size="small"
                theme="primary"
                icon={<Truck size={14} />}
                disabled={applying || dataModelVersion !== 2}
                onClick={() => handleOpenApply(row)}
              >
                {canRetry ? '重试' : row.sfStatus === 'cancelled' ? '重新生成' : '生成顺丰单'}
              </Button>
            )}
            {canQuery && (
              <Button
                size="small"
                variant="outline"
                loading={queryingId === row._id}
                disabled={!!queryingId && queryingId !== row._id}
                onClick={() => handleQuery(row)}
              >
                查询
              </Button>
            )}
            {canPrint && (
              <Button
                size="small"
                theme="primary"
                icon={<Printer size={14} />}
                disabled={!canPrintWaybill || !!printingId}
                title={!canPrintWaybill ? '当前角色没有顺丰面单打印权限' : ''}
                onClick={() => setPrintTarget(row)}
              >
                打印
              </Button>
            )}
            {canCancel && (
              <Button size="small" theme="danger" variant="outline" onClick={() => setCancelTarget(row)}>
                取消
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-gray-800">
            <Truck size={24} />顺丰快递
          </h1>
          <p className="mt-1 text-gray-500">按日期查看全部订单及其当前顺丰状态</p>
        </div>
        <div className="flex items-center gap-2">
          <Tag theme={sfEnv === 'production' ? 'danger' : sfEnv === 'sandbox' ? 'success' : 'warning'} variant="light">
            当前环境：{sfEnv === 'production' ? '生产环境' : sfEnv === 'sandbox' ? '沙箱测试' : '读取中'}
          </Tag>
          {cutoverDate && <Tag variant="light">V2 切换日：{cutoverDate}</Tag>}
          {dataModelVersion !== 2 && <Tag theme="warning" variant="light">V2 尚未启用</Tag>}
          <Button theme="primary" icon={<FileDown size={16} />} disabled={!selectedList.length} onClick={handleOpenExport}>
            导出顺丰模板（{selectedList.length}）
          </Button>
        </div>
      </div>

      <div className="glass-card p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <input
            type="date"
            aria-label="订单日期"
            className="rounded-md border border-gray-300 px-3 text-sm"
            value={filters.date}
            onChange={event => setFilters(previous => ({ ...previous, date: event.target.value }))}
          />
          <Input placeholder="序号" type="number" value={filters.serialNumber || ''} onChange={value => setFilters(previous => ({ ...previous, serialNumber: value as string }))} />
          <Input placeholder="网店订单号" value={filters.onlineOrderNumber || ''} onChange={value => setFilters(previous => ({ ...previous, onlineOrderNumber: value as string }))} />
          <Input placeholder="收件人" value={filters.consignee || ''} onChange={value => setFilters(previous => ({ ...previous, consignee: value as string }))} />
          <Select placeholder="人员" clearable value={filters.salesperson || ''} options={salespersonOptions} onChange={value => setFilters(previous => ({ ...previous, salesperson: value as string }))} />
          <Select placeholder="顺丰付款" clearable value={filters.shippingFee || ''} options={[
            { label: '全部付款方式', value: '' },
            { label: '寄付月结', value: 'prepaid' },
            { label: '收方付', value: 'cod' },
            { label: '自提', value: 'pickup' },
          ]} onChange={value => setFilters(previous => ({ ...previous, shippingFee: value as string }))} />
          <div className="flex gap-2">
            <Button theme="primary" icon={<Search size={16} />} onClick={handleSearch}>查询</Button>
            <Button variant="outline" icon={<RotateCcw size={16} />} onClick={handleReset}>重置</Button>
          </div>
        </div>
      </div>

      <div className="glass-card min-w-0 overflow-hidden">
        <div className="max-w-full overflow-x-auto">
          <Table
            data={rows}
            columns={columns}
            loading={loading}
            rowKey="_id"
            tableLayout="fixed"
            selectedRowKeys={Object.keys(selectedOrders)}
            onSelectChange={handleSelectionChange}
            hover
            stripe
          />
        </div>
        <div className="flex items-center justify-center gap-3 border-t border-gray-100 py-4">
          <Button size="small" variant="outline" disabled={pageIndex === 0 || loading} onClick={handlePrevPage}>上一页</Button>
          <span className="text-sm text-gray-500">第 {pageIndex + 1} 页，每页 {PAGE_SIZE} 条</span>
          <Button size="small" variant="outline" disabled={!hasMore || loading} onClick={handleNextPage}>下一页</Button>
        </div>
      </div>

      <Dialog
        header={applyTarget?.sfStatus === 'failed' ? '确认重试顺丰下单' : applyTarget?.sfStatus === 'cancelled' ? '确认重新生成顺丰单' : '确认生成顺丰单'}
        visible={!!applyTarget}
        onClose={() => !applying && setApplyTarget(null)}
        onConfirm={handleApply}
        confirmBtn={{ content: '确认下单', loading: applying }}
        cancelBtn={{ content: '取消', disabled: applying }}
      >
        {applyTarget && (
          <div className="space-y-3 text-sm">
            <div className={`rounded-lg border px-3 py-2 ${sfEnv === 'production' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
              本次将调用<strong>{sfEnv === 'production' ? '生产环境（将生成真实运单）' : '沙箱测试环境'}</strong>。
            </div>
            <div>订单：{applyTarget.order.onlineOrderNumber || `序号 ${applyTarget.order.serialNumber}`}</div>
            <div>收件人：{applyTarget.order.consignee}，{applyTarget.order.consigneePhone}</div>
            <div>付款方式：{getPaymentLabel(applyTarget.order.shippingFee)}</div>
            <div>货品：{getProductSummary(applyTarget.order)}</div>
          </div>
        )}
      </Dialog>

      <SfPrintDialog
        record={printTarget}
        onClose={() => setPrintTarget(null)}
        onPdfPrint={handlePdfPrint}
        onPluginPrinted={handlePluginPrinted}
      />

      <Dialog
        header="确认取消顺丰单"
        visible={!!cancelTarget}
        onClose={() => !cancelling && setCancelTarget(null)}
        onConfirm={handleCancel}
        confirmBtn={{ content: '确认取消', theme: 'danger', loading: cancelling }}
        cancelBtn={{ content: '暂不取消', disabled: cancelling }}
      >
        <div className="space-y-2 text-sm">
          <p>取消后当前顺丰客户订单号不能再次使用，重新生成时会自动使用下一序号。</p>
          <p className="text-gray-500">订单：{cancelTarget?.order.onlineOrderNumber || `序号 ${cancelTarget?.order.serialNumber || '-'}`}</p>
          <p className="text-gray-500">运单号：{cancelTarget?.currentSfOrder?.waybillNo || '-'}</p>
        </div>
      </Dialog>

      <Dialog
        header="导出顺丰待发货模板"
        visible={exportVisible}
        onClose={() => !exporting && setExportVisible(false)}
        width="780px"
        footer={(
          <div className="flex justify-end gap-2">
            <Button disabled={exporting} onClick={() => setExportVisible(false)}>取消</Button>
            <Button theme="primary" icon={<FileDown size={16} />} loading={exporting} onClick={handleExport}>生成顺丰 Excel</Button>
          </div>
        )}
      >
        <div className="max-h-[68vh] space-y-5 overflow-auto pr-1">
          <div className="rounded-lg border border-blue-100 bg-blue-50/60 px-4 py-3 text-sm text-blue-700">
            已选择 <strong>{selectedList.length}</strong> 条订单，将生成 <strong>{exportGroups.length}</strong> 条顺丰订单数据。
          </div>
          <div className="flex items-start justify-between gap-4 rounded-lg border border-gray-200 px-4 py-3">
            <div>
              <div className="text-sm font-medium text-gray-800">合并相同收件人的订单</div>
              <div className="mt-1 text-xs text-gray-500">姓名、电话、地址和付款方式完全一致时合并。</div>
            </div>
            <Switch value={mergeSameRecipient} onChange={value => setMergeSameRecipient(!!value)} />
          </div>
          <section>
            <h3 className="mb-3 text-sm font-medium text-gray-800">寄件信息</h3>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Input label="寄件人" value={exportConfig.senderName} maxlength={100} onChange={value => setExportConfig(previous => ({ ...previous, senderName: value as string }))} />
              <Input label="寄件人手机" value={exportConfig.senderMobile} maxlength={20} onChange={value => setExportConfig(previous => ({ ...previous, senderMobile: value as string }))} />
              <Input label="寄件人电话" value={exportConfig.senderPhone} maxlength={20} onChange={value => setExportConfig(previous => ({ ...previous, senderPhone: value as string }))} />
              <Input label="寄件人详细地址" value={exportConfig.senderAddress} maxlength={200} onChange={value => setExportConfig(previous => ({ ...previous, senderAddress: value as string }))} />
            </div>
          </section>
        </div>
      </Dialog>
    </div>
  );
}
