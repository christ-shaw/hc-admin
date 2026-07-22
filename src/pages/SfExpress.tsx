import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, Input, MessagePlugin, Select, Table, Tabs, Tag } from 'tdesign-react';
import { FileDown, RotateCcw, Search, Truck } from 'lucide-react';
import type { OrderRecord } from '../types';
import { callFunction } from '../lib/cloudbase';
import { useDictionaries, DICT_CODES } from '../contexts/DictionaryContext';
import { formatDate } from '../utils/format';
import { getOrderProducts } from '../utils/orderProducts';
import { getBrandLabel, getProductLabel } from '../data/dict';
import {
  exportSfOfflineOrders,
  loadSfExportConfig,
  saveSfExportConfig,
  type SfExportConfig,
} from '../utils/sfOrderExcel';
import { useTabDirty } from '../contexts/TabWorkspaceContext';

type SfView = 'pending' | 'history';

interface SfFilters {
  serialNumber?: string;
  onlineOrderNumber?: string;
  consignee?: string;
  salesperson?: string;
  startDate?: string;
  endDate?: string;
  shippingFee?: string;
  expressApplyStatus?: string;
}

interface QueryResult {
  success?: boolean;
  data?: OrderRecord[];
  cursor?: string | null;
  hasMore?: boolean;
  errMsg?: string;
}

interface SfActionResult {
  success: boolean;
  env?: string;
  sfOrderId?: string;
  waybillNo?: string;
  errMsg?: string;
}

interface SfConfigResult {
  success?: boolean;
  env?: string;
  errMsg?: string;
}

const EMPTY_FILTERS: SfFilters = {};
const PAGE_SIZE = 20;

const APPLY_STATUS_META: Record<string, { label: string; theme: 'default' | 'primary' | 'warning' | 'success' | 'danger' }> = {
  applying: { label: '申请中', theme: 'warning' },
  applied: { label: '申请成功', theme: 'success' },
  failed: { label: '申请失败', theme: 'danger' },
  cancelled: { label: '已取消', theme: 'default' },
};

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

function canQuerySfOrder(record: OrderRecord) {
  const hasSfTrace = !!(record.sfOrderId || record.sfWaybillNo || record.expressProvider === 'sf');
  return hasSfTrace && record.expressApplyStatus !== 'cancelled';
}

function canCancelSfOrder(record: OrderRecord) {
  const hasSfTrace = !!(record.sfOrderId || record.sfWaybillNo || (record.expressProvider === 'sf' && record.trackingNumber));
  return hasSfTrace && !['applying', 'cancelled'].includes(record.expressApplyStatus || '');
}

function getProductSummary(record: OrderRecord) {
  return getOrderProducts(record).map(item => {
    const name = [getBrandLabel(item.brand), getProductLabel(item.productName), item.specification === '默认' ? '' : item.specification]
      .filter(Boolean)
      .join(' ');
    return `${name || '-'} ×${Number(item.quantity) || 0}`;
  }).join('、') || '-';
}

export function SfExpress() {
  const dictionaries = useDictionaries();
  const [view, setView] = useState<SfView>('pending');
  const [filters, setFilters] = useState<SfFilters>({});
  const [records, setRecords] = useState<OrderRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCursors, setPageCursors] = useState<Array<string | null>>([null]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [selectedRecords, setSelectedRecords] = useState<Record<string, OrderRecord>>({});

  const [sfEnv, setSfEnv] = useState<'sandbox' | 'production' | ''>('');
  const [sfEnvError, setSfEnvError] = useState('');
  const [applyTarget, setApplyTarget] = useState<OrderRecord | null>(null);
  const [applying, setApplying] = useState(false);
  const [queryingId, setQueryingId] = useState('');
  const [cancelTarget, setCancelTarget] = useState<OrderRecord | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const [exportVisible, setExportVisible] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportConfig, setExportConfig] = useState<SfExportConfig>(loadSfExportConfig);
  const exportInitialRef = useRef('');
  useTabDirty(
    exportVisible && !!exportInitialRef.current && JSON.stringify(exportConfig) !== exportInitialRef.current,
    '顺丰快递',
  );

  const salespersonOptions = useMemo(() => [
    { label: '全部人员', value: '' },
    ...dictionaries.getItems(DICT_CODES.salesperson).map(item => ({ label: item.label, value: item.value })),
  ], [dictionaries]);

  const loadRecords = async (
    targetView: SfView,
    targetFilters: SfFilters,
    cursor: string | null,
    targetPageIndex: number,
  ) => {
    setLoading(true);
    try {
      const result = await callFunction<QueryResult>('querySfExpressOrders', {
        data: { view: targetView, limit: PAGE_SIZE, cursor, ...targetFilters },
      });
      if (result.success === false) throw new Error(result.errMsg || '查询失败');
      setRecords(result.data || []);
      setNextCursor(result.cursor || null);
      setHasMore(!!result.hasMore && !!result.cursor);
      setPageIndex(targetPageIndex);
    } catch (error) {
      setRecords([]);
      setNextCursor(null);
      setHasMore(false);
      MessagePlugin.error('顺丰订单查询失败：' + (error instanceof Error ? error.message : String(error)));
    } finally {
      setLoading(false);
    }
  };

  const loadSfEnvironment = async () => {
    try {
      const result = await callFunction<SfConfigResult>('manageSfConfig', { data: { action: 'get' } });
      if (!result.success || !result.env) throw new Error(result.errMsg || '无法读取顺丰环境');
      setSfEnv(result.env === 'production' ? 'production' : 'sandbox');
      setSfEnvError('');
    } catch (error) {
      setSfEnv('');
      setSfEnvError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    loadRecords('pending', EMPTY_FILTERS, null, 0);
    loadSfEnvironment();
  }, []);

  const resetPaginationAndLoad = (targetView: SfView, targetFilters: SfFilters) => {
    setSelectedRecords({});
    setPageCursors([null]);
    loadRecords(targetView, targetFilters, null, 0);
  };

  const handleViewChange = (value: string | number) => {
    const nextView = value as SfView;
    setView(nextView);
    resetPaginationAndLoad(nextView, filters);
  };

  const handleSearch = () => {
    const nextFilters = Object.fromEntries(
      Object.entries(filters).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value])
    ) as SfFilters;
    setFilters(nextFilters);
    resetPaginationAndLoad(view, nextFilters);
  };

  const handleReset = () => {
    setFilters({});
    resetPaginationAndLoad(view, {});
  };

  const handleNextPage = () => {
    if (!hasMore || !nextCursor) return;
    const cursors = [...pageCursors.slice(0, pageIndex + 1), nextCursor];
    setPageCursors(cursors);
    loadRecords(view, filters, nextCursor, pageIndex + 1);
  };

  const handlePrevPage = () => {
    if (pageIndex <= 0) return;
    loadRecords(view, filters, pageCursors[pageIndex - 1] || null, pageIndex - 1);
  };

  const handleSelectionChange = (keys: Array<string | number>) => {
    const selectedKeys = new Set(keys.map(String));
    setSelectedRecords(previous => {
      const next = { ...previous };
      for (const record of records) {
        if (selectedKeys.has(record._id) && getMissingFields(record).length === 0) next[record._id] = record;
        else delete next[record._id];
      }
      return next;
    });
  };

  const handleOpenExport = () => {
    const selected = Object.values(selectedRecords);
    if (selected.length === 0) {
      MessagePlugin.warning('请先勾选需要导入顺丰模板的订单');
      return;
    }
    const config = loadSfExportConfig();
    setExportConfig(config);
    exportInitialRef.current = JSON.stringify(config);
    setExportVisible(true);
  };

  const handleExport = async () => {
    const selected = Object.values(selectedRecords);
    if (!exportConfig.senderName.trim()) return void MessagePlugin.warning('请填写寄件人');
    if (!exportConfig.senderMobile.trim() && !exportConfig.senderPhone.trim()) return void MessagePlugin.warning('请填写寄件人手机或电话');
    if (exportConfig.senderMobile.trim() && !/^\d{6,20}$/.test(exportConfig.senderMobile.trim())) return void MessagePlugin.warning('寄件人手机格式不正确');
    if (!exportConfig.senderAddress.trim()) return void MessagePlugin.warning('请填写寄件人详细地址');

    setExporting(true);
    try {
      saveSfExportConfig(exportConfig);
      await exportSfOfflineOrders(selected, exportConfig);
      MessagePlugin.success(`已生成 ${selected.length} 条顺丰待发货数据`);
      setExportVisible(false);
      setSelectedRecords({});
    } catch (error) {
      MessagePlugin.error('顺丰模板导出失败：' + (error instanceof Error ? error.message : String(error)));
    } finally {
      setExporting(false);
    }
  };

  const handleOpenApply = (record: OrderRecord) => {
    const missing = getMissingFields(record);
    if (missing.length > 0) {
      MessagePlugin.warning(`请先在订单中补全：${missing.join('、')}`);
      return;
    }
    if (!sfEnv) {
      MessagePlugin.error(`无法确认顺丰环境：${sfEnvError || '环境尚未加载'}`);
      return;
    }
    setApplyTarget(record);
  };

  const handleApply = async () => {
    if (!applyTarget) return;
    setApplying(true);
    try {
      const result = await callFunction<SfActionResult>('applySfExpress', { data: { orderId: applyTarget._id } });
      if (!result.success) throw new Error(result.errMsg || '顺丰下单失败');
      MessagePlugin.success(`顺丰下单成功，运单号：${result.waybillNo || '-'}`);
      setApplyTarget(null);
      setSelectedRecords({});
      await loadRecords(view, filters, pageCursors[pageIndex] || null, pageIndex);
    } catch (error) {
      MessagePlugin.error(error instanceof Error ? error.message : String(error));
      await loadRecords(view, filters, pageCursors[pageIndex] || null, pageIndex);
    } finally {
      setApplying(false);
    }
  };

  const handleQuery = async (record: OrderRecord) => {
    if (!canQuerySfOrder(record) || queryingId) return;
    setQueryingId(record._id);
    try {
      const result = await callFunction<SfActionResult>('querySfOrderResult', { data: { orderId: record._id } });
      if (!result.success) throw new Error(result.errMsg || '查询顺丰订单失败');
      MessagePlugin.success(`顺丰订单已更新，运单号：${result.waybillNo || '-'}`);
      await loadRecords(view, filters, pageCursors[pageIndex] || null, pageIndex);
    } catch (error) {
      MessagePlugin.error(error instanceof Error ? error.message : String(error));
    } finally {
      setQueryingId('');
    }
  };

  const handleCancel = async () => {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      const result = await callFunction<SfActionResult>('cancelSfExpress', { data: { orderId: cancelTarget._id } });
      if (!result.success) throw new Error(result.errMsg || '取消顺丰订单失败');
      MessagePlugin.success('顺丰发货已取消，订单已恢复为待处理');
      setCancelTarget(null);
      await loadRecords(view, filters, pageCursors[pageIndex] || null, pageIndex);
    } catch (error) {
      MessagePlugin.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCancelling(false);
    }
  };

  const commonColumns = [
    { colKey: 'serialNumber', title: '序号', width: 70 },
    { colKey: 'date', title: '订单日期', width: 105, cell: ({ row }: { row: OrderRecord }) => formatDate(row.date, false) },
    { colKey: 'onlineOrderNumber', title: '网店订单号', width: 145, ellipsis: true, cell: ({ row }: { row: OrderRecord }) => row.onlineOrderNumber || '-' },
    { colKey: 'consignee', title: '收件人', width: 100, ellipsis: true, cell: ({ row }: { row: OrderRecord }) => row.consignee || '-' },
    { colKey: 'consigneePhone', title: '电话', width: 125, cell: ({ row }: { row: OrderRecord }) => row.consigneePhone || '-' },
    { colKey: 'consigneeAddress', title: '收件地址', width: 220, ellipsis: true, cell: ({ row }: { row: OrderRecord }) => row.consigneeAddress || '-' },
    { colKey: 'products', title: '货品', width: 210, ellipsis: true, cell: ({ row }: { row: OrderRecord }) => getProductSummary(row) },
    { colKey: 'salesperson', title: '人员', width: 75, cell: ({ row }: { row: OrderRecord }) => row.salesperson || '-' },
    { colKey: 'shippingFee', title: '顺丰付款', width: 100, cell: ({ row }: { row: OrderRecord }) => getPaymentLabel(row.shippingFee) },
  ];

  const columns = view === 'pending' ? [
    {
      colKey: 'row-select', type: 'multiple' as const, width: 46,
      checkProps: ({ row }: { row: OrderRecord }) => ({
        disabled: getMissingFields(row).length > 0,
        title: getMissingFields(row).length > 0 ? `缺少：${getMissingFields(row).join('、')}` : '',
      }),
    },
    ...commonColumns,
    {
      colKey: 'readiness', title: '资料状态', width: 145,
      cell: ({ row }: { row: OrderRecord }) => {
        const missing = getMissingFields(row);
        return missing.length === 0
          ? <Tag theme="success" variant="light">可导出</Tag>
          : <span className="text-xs text-rose-600">缺少：{missing.join('、')}</span>;
      },
    },
  ] : [
    ...commonColumns,
    { colKey: 'sfOrderId', title: '顺丰客户订单号', width: 170, ellipsis: true, cell: ({ row }: { row: OrderRecord }) => row.sfOrderId || '-' },
    { colKey: 'trackingNumber', title: '顺丰运单号', width: 145, cell: ({ row }: { row: OrderRecord }) => row.sfWaybillNo || row.trackingNumber || '-' },
    { colKey: 'sfEnv', title: '环境', width: 85, cell: ({ row }: { row: OrderRecord }) => row.sfEnv === 'production' ? <Tag theme="danger" variant="light">生产</Tag> : <Tag theme="success" variant="light">沙箱</Tag> },
    {
      colKey: 'expressApplyStatus', title: '申请状态', width: 100,
      cell: ({ row }: { row: OrderRecord }) => {
        const meta = APPLY_STATUS_META[row.expressApplyStatus || ''] || { label: row.expressApplyStatus || '未知', theme: 'default' as const };
        return <Tag theme={meta.theme} variant="light">{meta.label}</Tag>;
      },
    },
    { colKey: 'expressApplyTime', title: '申请时间', width: 150, cell: ({ row }: { row: OrderRecord }) => row.expressApplyTime ? formatDate(row.expressApplyTime) : '-' },
    { colKey: 'expressErrorMsg', title: '错误信息', width: 220, ellipsis: true, cell: ({ row }: { row: OrderRecord }) => row.expressErrorMsg || '-' },
  ];

  const selectedList = Object.values(selectedRecords);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-gray-800"><Truck size={24} />顺丰快递</h1>
          <p className="mt-1 text-gray-500">集中处理顺丰模板导出、直接下单、查询和取消</p>
        </div>
        <div className="flex items-center gap-2">
          {sfEnv ? (
            <Tag theme={sfEnv === 'production' ? 'danger' : 'success'} variant="light">
              当前环境：{sfEnv === 'production' ? '生产环境' : '沙箱测试'}
            </Tag>
          ) : (
            <Tag theme="warning" variant="light">顺丰环境读取失败</Tag>
          )}
          {view === 'pending' && (
            <Button theme="primary" icon={<FileDown size={16} />} disabled={selectedList.length === 0} onClick={handleOpenExport}>
              导出顺丰模板（{selectedList.length}）
            </Button>
          )}
        </div>
      </div>

      <div className="glass-card px-4 pt-2">
        <Tabs value={view} onChange={handleViewChange} list={[
          { value: 'pending', label: '待处理订单' },
          { value: 'history', label: '顺丰订单记录' },
        ]} />
      </div>

      <div className="glass-card p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Input placeholder="序号" type="number" value={filters.serialNumber || ''} onChange={value => setFilters(prev => ({ ...prev, serialNumber: value as string }))} />
          <Input placeholder="网店订单号" value={filters.onlineOrderNumber || ''} onChange={value => setFilters(prev => ({ ...prev, onlineOrderNumber: value as string }))} />
          <Input placeholder="收件人" value={filters.consignee || ''} onChange={value => setFilters(prev => ({ ...prev, consignee: value as string }))} />
          <Select placeholder="人员" clearable value={filters.salesperson || ''} options={salespersonOptions} onChange={value => setFilters(prev => ({ ...prev, salesperson: value as string }))} />
          <input type="date" aria-label="开始日期" className="rounded-md border border-gray-300 px-3 text-sm" value={filters.startDate || ''} onChange={event => setFilters(prev => ({ ...prev, startDate: event.target.value }))} />
          <input type="date" aria-label="结束日期" className="rounded-md border border-gray-300 px-3 text-sm" value={filters.endDate || ''} onChange={event => setFilters(prev => ({ ...prev, endDate: event.target.value }))} />
          <Select placeholder="顺丰付款" clearable value={filters.shippingFee || ''} options={[
            { label: '全部付款方式', value: '' },
            { label: '寄付月结', value: 'prepaid' },
            { label: '收方付', value: 'cod' },
          ]} onChange={value => setFilters(prev => ({ ...prev, shippingFee: value as string }))} />
          {view === 'history' && (
            <Select placeholder="申请状态" clearable value={filters.expressApplyStatus || ''} options={[
              { label: '全部状态', value: '' },
              { label: '申请中', value: 'applying' },
              { label: '申请成功', value: 'applied' },
              { label: '申请失败', value: 'failed' },
              { label: '已取消', value: 'cancelled' },
            ]} onChange={value => setFilters(prev => ({ ...prev, expressApplyStatus: value as string }))} />
          )}
          <div className="flex gap-2">
            <Button theme="primary" icon={<Search size={16} />} onClick={handleSearch}>查询</Button>
            <Button variant="outline" icon={<RotateCcw size={16} />} onClick={handleReset}>重置</Button>
          </div>
        </div>
      </div>

      <div className="glass-card min-w-0 overflow-hidden">
        <div className="max-w-full overflow-x-auto">
          <Table
            data={records}
            columns={columns}
            loading={loading}
            rowKey="_id"
            tableLayout="fixed"
            selectedRowKeys={Object.keys(selectedRecords)}
            onSelectChange={view === 'pending' ? handleSelectionChange : undefined}
            hover
            stripe
          />
        </div>
        <div className="flex items-center justify-center gap-3 border-t border-gray-100 py-4">
          <Button size="small" variant="outline" disabled={pageIndex === 0 || loading} onClick={handlePrevPage}>上一页</Button>
          <span className="text-sm text-gray-500">第 {pageIndex + 1} 页</span>
          <Button size="small" variant="outline" disabled={!hasMore || loading} onClick={handleNextPage}>下一页</Button>
        </div>
      </div>

      <Dialog
        header="确认生成顺丰单"
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
            <div><span className="text-gray-500">订单：</span>{applyTarget.onlineOrderNumber || `序号 ${applyTarget.serialNumber}`}</div>
            <div><span className="text-gray-500">收件人：</span>{applyTarget.consignee}，{applyTarget.consigneePhone}</div>
            <div><span className="text-gray-500">地址：</span>{applyTarget.consigneeAddress}</div>
            <div><span className="text-gray-500">付款方式：</span>{getPaymentLabel(applyTarget.shippingFee)}</div>
            <div><span className="text-gray-500">货品：</span>{getProductSummary(applyTarget)}</div>
          </div>
        )}
      </Dialog>

      <Dialog
        header="确认取消顺丰单"
        visible={!!cancelTarget}
        onClose={() => !cancelling && setCancelTarget(null)}
        onConfirm={handleCancel}
        confirmBtn={{ content: '确认取消', theme: 'danger', loading: cancelling }}
        cancelBtn={{ content: '暂不取消', disabled: cancelling }}
      >
        <div className="space-y-2 text-sm">
          <p>取消后当前顺丰客户订单号不能再次使用，系统重下时会自动生成新编号。</p>
          <p className="text-gray-500">订单：{cancelTarget?.onlineOrderNumber || `序号 ${cancelTarget?.serialNumber || '-'}`}</p>
          <p className="text-gray-500">运单号：{cancelTarget?.sfWaybillNo || cancelTarget?.trackingNumber || '-'}</p>
        </div>
      </Dialog>

      <Dialog
        header="导出顺丰待发货模板"
        visible={exportVisible}
        onClose={() => !exporting && setExportVisible(false)}
        width="780px"
        footer={
          <div className="flex justify-end gap-2">
            <Button disabled={exporting} onClick={() => setExportVisible(false)}>取消</Button>
            <Button theme="primary" icon={<FileDown size={16} />} loading={exporting} onClick={handleExport}>生成顺丰 Excel</Button>
          </div>
        }
      >
        <div className="max-h-[68vh] space-y-5 overflow-auto pr-1">
          <div className="rounded-lg border border-blue-100 bg-blue-50/60 px-4 py-3 text-sm text-blue-700">
            已选择 <strong>{selectedList.length}</strong> 条待发货订单。导出后订单仍保留在待处理列表，可再次导出。
          </div>
          <div className="max-h-44 overflow-auto rounded-lg border border-gray-200">
            <table className="w-full table-fixed text-left text-xs">
              <thead className="sticky top-0 bg-gray-50 text-gray-500">
                <tr><th className="w-24 px-3 py-2">收件人</th><th className="w-28 px-3 py-2">手机</th><th className="px-3 py-2">地址</th><th className="w-24 px-3 py-2">付款</th></tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {selectedList.map(record => (
                  <tr key={record._id}><td className="px-3 py-2">{record.consignee}</td><td className="px-3 py-2">{record.consigneePhone}</td><td className="px-3 py-2">{record.consigneeAddress}</td><td className="px-3 py-2">{getPaymentLabel(record.shippingFee)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <section>
            <h3 className="mb-3 text-sm font-medium text-gray-800">寄件信息</h3>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Input label="寄件人" value={exportConfig.senderName} maxlength={100} onChange={value => setExportConfig(prev => ({ ...prev, senderName: value as string }))} />
              <Input label="寄件人手机" value={exportConfig.senderMobile} maxlength={20} onChange={value => setExportConfig(prev => ({ ...prev, senderMobile: value as string }))} />
              <Input label="寄件人电话" value={exportConfig.senderPhone} maxlength={20} onChange={value => setExportConfig(prev => ({ ...prev, senderPhone: value as string }))} />
              <Input label="寄件人详细地址" value={exportConfig.senderAddress} maxlength={200} onChange={value => setExportConfig(prev => ({ ...prev, senderAddress: value as string }))} />
            </div>
          </section>
          <div className="rounded-lg bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-500">
            托寄物固定为“电子产品”，物流产品固定为“顺丰标快”。包邮导出为“寄付月结”，到付导出为“收方付”。
          </div>
        </div>
      </Dialog>
    </div>
  );
}
