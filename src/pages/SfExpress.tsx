import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Input, MessagePlugin, Select, Table, Tag } from 'tdesign-react';
import { Link2, LoaderCircle, PackageCheck, Printer, RotateCcw, Search, Truck, Unlink, Unlock } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import type {
  OrderRecord,
  SfExpressWorkbenchRow,
  SfShipmentStatus,
  SfWorkbenchStatus,
} from '../types';
import { callFunction } from '../lib/cloudbase';
import { useDictionaries, DICT_CODES } from '../contexts/DictionaryContext';
import { formatDate } from '../utils/format';
import { getOrderProducts } from '../utils/orderProducts';
import { getBrandLabel, getProductLabel } from '../data/dict';
import { usePermission } from '../hooks/usePermission';
import { SfPrintDialog } from '../components/SfPrintDialog';
import { useTabWorkspace } from '../contexts/TabWorkspaceContext';

interface SfFilters {
  date: string;
  serialNumber?: string;
  onlineOrderNumber?: string;
  consignee?: string;
  salesperson?: string;
  shippingFee?: string;
}

interface SfRouteState {
  filter?: Partial<SfFilters>;
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

interface SfBatchApplyResult extends SfActionResult {
  sourceOrderId: string;
  orderLabel: string;
}

interface SfPrintResult extends SfActionResult {
  fileName?: string;
  mimeType?: string;
  pdfBase64?: string;
  printedAt?: string;
}

interface ReusableShipmentCandidate {
  _id: string;
  waybillNo: string;
  sfOrderId: string;
  shipmentStatus: 'packing' | 'sealed';
  shipmentVersion: number;
  sourceOrderId: string;
  sourceSerialNumber: number;
  sourceOnlineOrderNumber: string;
  salesperson: string;
  consignee: string;
  consigneePhone: string;
  consigneeAddress: string;
  shippingFee: string;
  linkedOrderCount: number;
  linkedOutboundCount: number;
  applyTime: string;
  reuseEnabledAt: string;
}

interface ShipmentActionResult {
  success: boolean;
  data?: ReusableShipmentCandidate[];
  waybillNo?: string;
  shipmentStatus?: SfShipmentStatus;
  shipmentVersion?: number;
  reuseEnabled?: boolean;
  linkedOrderCount?: number;
  linkedOutboundCount?: number;
  duplicated?: boolean;
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

const SHIPMENT_STATUS_META: Record<SfShipmentStatus, {
  label: string;
  theme: 'default' | 'primary' | 'warning' | 'success' | 'danger';
}> = {
  packing: { label: '打包中', theme: 'primary' },
  sealed: { label: '已封箱', theme: 'warning' },
  handed_over: { label: '已交顺丰', theme: 'success' },
  picked_up: { label: '已揽收', theme: 'success' },
  cancelled: { label: '已取消', theme: 'default' },
  legacy_locked: { label: '历史锁定', theme: 'default' },
};

function today(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function createShipmentRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `sf-shipment-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
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

function getOrderLabel(record: OrderRecord) {
  return record.onlineOrderNumber || `序号 ${record.serialNumber}`;
}

function canBatchApply(row: SfExpressWorkbenchRow) {
  return ['not_created', 'failed', 'cancelled'].includes(row.sfStatus)
    && getMissingFields(row.order).length === 0;
}

function canBatchPrint(row: SfExpressWorkbenchRow) {
  return row.sfStatus === 'applied'
    && !!row.currentSfOrder?.waybillNo
    && row.currentSfOrder.sourceOrderId === row.order._id;
}

function createPdfBlob(base64: string, mimeType = 'application/pdf') {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

export function SfExpress() {
  const dictionaries = useDictionaries();
  const location = useLocation();
  const { can } = usePermission();
  const { openTab } = useTabWorkspace();
  const canPrintWaybill = can('sf:print');
  const canReuseWaybill = can('orders:create') || can('orders:update');
  const [filters, setFilters] = useState<SfFilters>({ date: today() });
  const [rows, setRows] = useState<TableRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCursors, setPageCursors] = useState<Array<string | null>>([null]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [selectedRows, setSelectedRows] = useState<Record<string, TableRow>>({});
  const selectedApplyOrders = useMemo(
    () => Object.values(selectedRows).filter(canBatchApply).map(row => row.order),
    [selectedRows],
  );
  const selectedPrintRows = useMemo(
    () => Object.values(selectedRows).filter(canBatchPrint),
    [selectedRows],
  );
  const [sfEnv, setSfEnv] = useState<'sandbox' | 'production' | ''>('');
  const [dataModelVersion, setDataModelVersion] = useState(1);
  const [cutoverDate, setCutoverDate] = useState('');

  const [applyTarget, setApplyTarget] = useState<TableRow | null>(null);
  const [applying, setApplying] = useState(false);
  const [batchApplyVisible, setBatchApplyVisible] = useState(false);
  const [batchApplyTargets, setBatchApplyTargets] = useState<OrderRecord[]>([]);
  const [batchApplying, setBatchApplying] = useState(false);
  const [batchApplyProgress, setBatchApplyProgress] = useState(0);
  const [batchApplyingOrderId, setBatchApplyingOrderId] = useState('');
  const [batchApplyResults, setBatchApplyResults] = useState<SfBatchApplyResult[]>([]);
  const [queryingId, setQueryingId] = useState('');
  const [printingId, setPrintingId] = useState('');
  const [printTarget, setPrintTarget] = useState<TableRow | null>(null);
  const [batchPrintTargets, setBatchPrintTargets] = useState<TableRow[]>([]);
  const [cancelTarget, setCancelTarget] = useState<TableRow | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reuseTarget, setReuseTarget] = useState<TableRow | null>(null);
  const [reuseCandidates, setReuseCandidates] = useState<ReusableShipmentCandidate[]>([]);
  const [reuseLoading, setReuseLoading] = useState(false);
  const [attachingShipmentId, setAttachingShipmentId] = useState('');
  const [shipmentConfirm, setShipmentConfirm] = useState<{
    row: TableRow;
    action: 'enableReuse' | 'disableReuse' | 'detach' | 'confirmHandover';
  } | null>(null);
  const [shipmentActionLoading, setShipmentActionLoading] = useState(false);

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
    const routeFilter = (location.state as SfRouteState | null)?.filter;
    const routeDate = String(routeFilter?.date || '');
    const next: SfFilters = {
      date: /^\d{4}-\d{2}-\d{2}$/.test(routeDate) ? routeDate : today(),
    };
    if (routeFilter?.onlineOrderNumber) next.onlineOrderNumber = String(routeFilter.onlineOrderNumber);
    if (routeFilter?.serialNumber) next.serialNumber = String(routeFilter.serialNumber);

    setFilters(next);
    setSelectedRows({});
    setPageCursors([null]);
    void loadRows(next, null, 0);
  }, [location.key]);

  const resetPaginationAndLoad = (targetFilters: SfFilters) => {
    setSelectedRows({});
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

  const handleOpenMasterShipment = (shipment: NonNullable<TableRow['currentSfOrder']>) => {
    const masterFilters: SfFilters = {
      date: /^\d{4}-\d{2}-\d{2}$/.test(shipment.sourceOrderDate || '')
        ? shipment.sourceOrderDate
        : filters.date,
    };
    if (shipment.sourceOnlineOrderNumber) {
      masterFilters.onlineOrderNumber = shipment.sourceOnlineOrderNumber;
    } else if (shipment.sourceSerialNumber) {
      masterFilters.serialNumber = String(shipment.sourceSerialNumber);
    }
    openTab('/sf-express', { state: { filter: masterFilters } });
  };

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
    setSelectedRows(previous => {
      const next = { ...previous };
      for (const row of rows) {
        if (selectedKeys.has(row._id) && (canBatchApply(row) || canBatchPrint(row))) next[row._id] = row;
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

  const handleOpenBatchApply = () => {
    if (selectedApplyOrders.length < 2) {
      MessagePlugin.warning('请至少勾选 2 条可申请订单');
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
    const invalidOrder = selectedApplyOrders.find(order => getMissingFields(order).length > 0);
    if (invalidOrder) {
      MessagePlugin.warning(
        `${getOrderLabel(invalidOrder)} 请先补全：${getMissingFields(invalidOrder).join('、')}`
      );
      return;
    }
    setBatchApplyTargets([...selectedApplyOrders]);
    setBatchApplyProgress(0);
    setBatchApplyResults([]);
    setBatchApplyVisible(true);
  };

  const closeBatchApply = () => {
    if (batchApplying) return;
    setBatchApplyVisible(false);
    setBatchApplyTargets([]);
    setBatchApplyProgress(0);
    setBatchApplyingOrderId('');
    setBatchApplyResults([]);
  };

  const handleBatchApply = async () => {
    if (!batchApplyTargets.length || batchApplying) return;
    setBatchApplying(true);
    setBatchApplyProgress(0);
    setBatchApplyingOrderId('');
    setBatchApplyResults([]);

    const results = new Array<SfBatchApplyResult>(batchApplyTargets.length);
    try {
      for (let index = 0; index < batchApplyTargets.length; index += 1) {
        const order = batchApplyTargets[index];
        setBatchApplyingOrderId(order._id);
        try {
          const result = await callFunction<SfActionResult>('applySfExpress', {
            data: { sourceOrderId: order._id },
          });
          results[index] = {
            ...result,
            sourceOrderId: order._id,
            orderLabel: getOrderLabel(order),
          };
        } catch (error) {
          results[index] = {
            success: false,
            sourceOrderId: order._id,
            orderLabel: getOrderLabel(order),
            errMsg: error instanceof Error ? error.message : String(error),
          };
        } finally {
          setBatchApplyProgress(index + 1);
          setBatchApplyResults(results.filter((result): result is SfBatchApplyResult => !!result));
        }
      }
      setBatchApplyingOrderId('');

      const succeeded = results.filter(result => result.success);
      const failed = results.filter(result => !result.success);
      const conflicts = succeeded.filter(result => result.outboundSync?.action === 'conflict');
      const succeededIds = new Set(succeeded.map(result => result.sourceOrderId));
      setSelectedRows(previous => Object.fromEntries(
        Object.entries(previous).filter(([orderId]) => !succeededIds.has(orderId))
      ));

      if (failed.length > 0) {
        MessagePlugin.warning(`批量申请完成：成功 ${succeeded.length} 条，失败 ${failed.length} 条`);
      } else if (conflicts.length > 0) {
        MessagePlugin.warning(`已生成 ${succeeded.length} 个运单，其中 ${conflicts.length} 条出库单号存在冲突`);
      } else {
        MessagePlugin.success(`已成功生成 ${succeeded.length} 个顺丰运单号`);
      }
      await reloadCurrentPage();
    } finally {
      setBatchApplyingOrderId('');
      setBatchApplying(false);
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

  const handleOpenReuse = async (row: TableRow) => {
    if (!canReuseWaybill) {
      MessagePlugin.warning('当前角色没有复用顺丰运单的权限');
      return;
    }
    if (!row.order.outboundRecordId) {
      MessagePlugin.warning('请先为该订单生成待出库单');
      return;
    }
    setReuseTarget(row);
    setReuseCandidates([]);
    setReuseLoading(true);
    try {
      const result = await callFunction<ShipmentActionResult>('manageSfShipment', {
        data: { action: 'listReusable', sourceOrderId: row.order._id },
      });
      if (!result.success) throw new Error(result.errMsg || '查询可复用运单失败');
      setReuseCandidates(result.data || []);
      if (!result.data?.length) {
        MessagePlugin.warning('没有找到已开放追加且收件信息完全一致的顺丰包裹');
      }
    } catch (error) {
      setReuseTarget(null);
      MessagePlugin.error(error instanceof Error ? error.message : String(error));
    } finally {
      setReuseLoading(false);
    }
  };

  const handleAttachShipment = async (candidate: ReusableShipmentCandidate) => {
    if (!reuseTarget || attachingShipmentId) return;
    setAttachingShipmentId(candidate._id);
    try {
      const result = await callFunction<ShipmentActionResult>('manageSfShipment', {
        data: {
          action: 'attach',
          sourceOrderId: reuseTarget.order._id,
          sfExpressOrderId: candidate._id,
          shipmentVersion: candidate.shipmentVersion,
          requestId: createShipmentRequestId(),
        },
      });
      if (!result.success) throw new Error(result.errMsg || '复用顺丰运单失败');
      MessagePlugin.success(
        `订单已关联顺丰运单 ${result.waybillNo || candidate.waybillNo}，请完成新增出库单拍照`
      );
      setReuseTarget(null);
      setReuseCandidates([]);
      await reloadCurrentPage();
    } catch (error) {
      MessagePlugin.error(error instanceof Error ? error.message : String(error));
      if (reuseTarget) await handleOpenReuse(reuseTarget);
    } finally {
      setAttachingShipmentId('');
    }
  };

  const handleShipmentAction = async () => {
    if (!shipmentConfirm) return;
    const { row, action } = shipmentConfirm;
    const sfOrder = row.currentSfOrder;
    if (!sfOrder) return;
    setShipmentActionLoading(true);
    try {
      const result = await callFunction<ShipmentActionResult>('manageSfShipment', {
        data: {
          action,
          sfExpressOrderId: sfOrder._id,
          ...(action === 'detach'
            ? { sourceOrderId: row.order._id, requestId: createShipmentRequestId() }
            : {}),
        },
      });
      if (!result.success) throw new Error(result.errMsg || '包裹操作失败');
      const message = action === 'enableReuse'
        ? '该顺丰包裹已开放一次订单追加'
        : action === 'disableReuse'
          ? '已关闭该顺丰包裹的订单追加'
          : action === 'detach'
            ? '已解除该订单的共享运单，请重新安排物流'
            : '已确认包裹交接顺丰，后续不能再追加订单';
      MessagePlugin.success(message);
      setShipmentConfirm(null);
      await reloadCurrentPage();
    } catch (error) {
      MessagePlugin.error(error instanceof Error ? error.message : String(error));
    } finally {
      setShipmentActionLoading(false);
    }
  };

  const handlePdfPrint = async (row: SfExpressWorkbenchRow) => {
    if (!row.currentSfOrder || printingId) return;
    if (row.currentSfOrder.sourceOrderId !== row.order._id) {
      MessagePlugin.warning('子订单不单独打印面单，请在主顺丰单上打印');
      return;
    }
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

  const columns = [
    {
      colKey: 'row-select',
      type: 'multiple' as const,
      width: 46,
      checkProps: ({ row }: { row: TableRow }) => ({
        disabled: batchApplying || (!canBatchApply(row) && !canBatchPrint(row)),
        title: !canBatchApply(row) && !canBatchPrint(row)
          ? '仅资料完整的待申请订单或已生成运单的订单可以勾选'
          : '',
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
    { colKey: 'waybillNo', title: '顺丰运单号', width: 205, cell: ({ row }: { row: TableRow }) => row.currentSfOrder?.waybillNo || '-' },
    {
      colKey: 'shipment',
      title: '包裹关联',
      width: 225,
      cell: ({ row }: { row: TableRow }) => {
        const shipment = row.currentSfOrder;
        if (!shipment) return '-';
        const meta = SHIPMENT_STATUS_META[shipment.shipmentStatus];
        const isSharedShipment = shipment.linkedOrderIds.length > 1;
        const isPrimaryOrder = shipment.sourceOrderId === row.order._id;
        const masterShipmentLabel = shipment.sourceOnlineOrderNumber
          || (shipment.sourceSerialNumber ? `序号 ${shipment.sourceSerialNumber}` : '主顺丰单');
        return (
          <div className="text-xs text-gray-500">
            <Tag theme={meta.theme} variant="light">{meta.label}</Tag>
            {shipment.reuseEnabled && (
              <Tag className="ml-1" theme="success" variant="light">可追加</Tag>
            )}
            <div className="mt-1">
              {shipment.linkedOrderIds.length} 张订单 / {shipment.linkedOutboundIds.length} 张出库单
            </div>
            {isSharedShipment && (
              isPrimaryOrder ? (
                <div className="mt-1 text-primary">主顺丰单：当前订单</div>
              ) : (
                <button
                  type="button"
                  className="mt-1 inline-flex max-w-full items-center gap-1 truncate text-left text-primary hover:underline"
                  title={`点击查看主顺丰单：${masterShipmentLabel}`}
                  onClick={() => handleOpenMasterShipment(shipment)}
                >
                  <Link2 size={12} className="flex-shrink-0" />
                  <span className="truncate">主顺丰单：{masterShipmentLabel}</span>
                </button>
              )
            )}
            {shipment.isLegacyShipment && (
              <div className="mt-1 text-gray-400" title="历史顺丰记录默认禁止追加订单">
                默认不可追加
              </div>
            )}
          </div>
        );
      },
    },
    {
      colKey: 'records',
      title: '记录',
      width: 155,
      cell: ({ row }: { row: TableRow }) => (
        <div className="text-xs text-gray-500">
          {row.currentSfOrder?.sourceOrderId === row.order._id ? (
            <div>导出 {row.exportSummary.count} 次 / 打印 {row.currentSfOrder?.printCount || 0} 次</div>
          ) : (
            <div>面单：由主顺丰单打印</div>
          )}
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
      width: 410,
      fixed: 'right' as const,
      cell: ({ row }: { row: TableRow }) => {
        const canApply = ['not_created', 'cancelled'].includes(row.sfStatus);
        const canRetry = row.sfStatus === 'failed';
        const canQuery = ['applying', 'failed', 'applied'].includes(row.sfStatus) && !!row.currentSfOrder;
        const isPrimaryShipmentOrder = row.currentSfOrder?.sourceOrderId === row.order._id;
        const canPrint = row.sfStatus === 'applied'
          && !!row.currentSfOrder?.waybillNo
          && isPrimaryShipmentOrder;
        const canManageShipment = row.sfStatus === 'applied'
          && !!row.currentSfOrder
          && !row.currentSfOrder.isLegacyShipment
          && ['packing', 'sealed'].includes(row.currentSfOrder.shipmentStatus);
        const canManageReuse = canManageShipment && isPrimaryShipmentOrder;
        const canDetachShipment = canManageShipment
          && !isPrimaryShipmentOrder
          && row.order.sharedWaybill === true;
        const canOpenMasterOrder = !!row.currentSfOrder
          && !isPrimaryShipmentOrder
          && row.currentSfOrder.linkedOrderIds.length > 1
          && !!row.currentSfOrder.sourceOrderId;
        const needsHandoverConfirmation = canManageShipment
          && (
            !!row.currentSfOrder?.reuseEnabledAt
            || (row.currentSfOrder?.linkedOrderIds.length || 0) > 1
          );
        const canCancel = row.sfStatus === 'applied'
          && (row.currentSfOrder?.linkedOrderIds.length || 0) <= 1;
        return (
          <div className="flex flex-wrap items-center gap-1">
            {(canApply || canRetry) && (
              <Button
                size="small"
                theme="primary"
                icon={<Truck size={14} />}
                disabled={applying || batchApplying || dataModelVersion !== 2}
                onClick={() => handleOpenApply(row)}
              >
                {canRetry ? '重试' : row.sfStatus === 'cancelled' ? '重新生成' : '生成顺丰单'}
              </Button>
            )}
            {row.sfStatus === 'not_created' && (
              <Button
                size="small"
                variant="outline"
                icon={<Link2 size={14} />}
                disabled={!canReuseWaybill || !row.order.outboundRecordId}
                title={!row.order.outboundRecordId ? '请先生成待出库单' : ''}
                onClick={() => handleOpenReuse(row)}
              >
                复用运单
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
            {canOpenMasterOrder && row.currentSfOrder && (
              <Button
                size="small"
                theme="primary"
                variant="outline"
                icon={<Link2 size={14} />}
                title={`查看主顺丰单：${row.currentSfOrder.sourceOnlineOrderNumber || `序号 ${row.currentSfOrder.sourceSerialNumber}`}`}
                onClick={() => handleOpenMasterShipment(row.currentSfOrder!)}
              >
                主顺丰单
              </Button>
            )}
            {canManageShipment && (
              <>
                {canManageReuse && (
                  <Button
                    size="small"
                    variant="outline"
                    icon={<Unlock size={14} />}
                    onClick={() => setShipmentConfirm({
                      row,
                      action: row.currentSfOrder?.reuseEnabled ? 'disableReuse' : 'enableReuse',
                    })}
                  >
                    {row.currentSfOrder?.reuseEnabled ? '关闭追加' : '开放追加'}
                  </Button>
                )}
                {needsHandoverConfirmation && isPrimaryShipmentOrder && (
                  <Button
                    size="small"
                    theme="success"
                    variant="outline"
                    icon={<PackageCheck size={14} />}
                    onClick={() => setShipmentConfirm({ row, action: 'confirmHandover' })}
                  >
                    确认交接
                  </Button>
                )}
                {canDetachShipment && (
                  <Button
                    size="small"
                    theme="danger"
                    variant="outline"
                    icon={<Unlink size={14} />}
                    onClick={() => setShipmentConfirm({ row, action: 'detach' })}
                  >
                    解除共享
                  </Button>
                )}
              </>
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
          <Tag theme="primary" variant="light">包裹关联：只读</Tag>
          <Button
            theme="primary"
            icon={<Truck size={16} />}
            disabled={selectedApplyOrders.length < 2 || applying || batchApplying || dataModelVersion !== 2}
            onClick={handleOpenBatchApply}
          >
            批量申请单号（{selectedApplyOrders.length}）
          </Button>
          <Button
            variant="outline"
            icon={<Printer size={16} />}
            disabled={!canPrintWaybill || selectedPrintRows.length < 2 || batchApplying}
            title={!canPrintWaybill ? '当前角色没有顺丰面单打印权限' : ''}
            onClick={() => setBatchPrintTargets([...selectedPrintRows])}
          >
            串行打印面单（{selectedPrintRows.length}）
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
            selectedRowKeys={Object.keys(selectedRows)}
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

      <Dialog
        header={batchApplyResults.length > 0 ? '批量申请结果' : '确认批量申请顺丰单号'}
        visible={batchApplyVisible}
        width="760px"
        onClose={closeBatchApply}
        onConfirm={batchApplyResults.length > 0 ? closeBatchApply : handleBatchApply}
        confirmBtn={{
          content: batchApplyResults.length > 0 ? '关闭' : `确认申请（${batchApplyTargets.length}）`,
          loading: batchApplying,
        }}
        cancelBtn={{
          content: '取消',
          disabled: batchApplying,
          style: batchApplyResults.length > 0 ? { display: 'none' } : undefined,
        }}
      >
        <div className="space-y-4 text-sm">
          <div className={`rounded-lg border px-3 py-2 ${sfEnv === 'production' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
            本次将在<strong>{sfEnv === 'production' ? '生产环境（将生成真实运单）' : '沙箱测试环境'}</strong>
            为 {batchApplyTargets.length} 条订单申请单号，系统将按勾选顺序逐条处理。
          </div>
          {batchApplying && (
            <div className="space-y-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-3 text-blue-700">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <LoaderCircle className="shrink-0 animate-spin" size={16} />
                  <span className="truncate">
                    正在处理：{getOrderLabel(
                      batchApplyTargets.find(order => order._id === batchApplyingOrderId)
                        || batchApplyTargets[Math.min(batchApplyProgress, batchApplyTargets.length - 1)]
                    )}
                  </span>
                </div>
                <span className="shrink-0 font-medium">
                  {batchApplyProgress} / {batchApplyTargets.length}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded bg-blue-100">
                <div
                  className="h-full rounded bg-blue-500 transition-[width] duration-300 ease-out"
                  style={{
                    width: `${batchApplyTargets.length
                      ? Math.round((batchApplyProgress / batchApplyTargets.length) * 100)
                      : 0}%`,
                  }}
                />
              </div>
            </div>
          )}
          <div className="max-h-[48vh] space-y-2 overflow-auto pr-1">
            {batchApplyTargets.map(order => {
              const result = batchApplyResults.find(item => item.sourceOrderId === order._id);
              const isApplying = batchApplying && batchApplyingOrderId === order._id;
              return (
                <div
                  key={order._id}
                  className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 transition-colors ${
                    isApplying ? 'border-blue-300 bg-blue-50/70' : 'border-gray-200'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="font-medium text-gray-800">
                      {result?.orderLabel || getOrderLabel(order)}
                    </div>
                    <div className="mt-1 truncate text-xs text-gray-500">
                      {order.consignee || '-'}，{order.consigneePhone || '-'}
                    </div>
                    {result && !result.success && (
                      <div className="mt-1 text-xs text-rose-600">{result.errMsg || '申请失败'}</div>
                    )}
                    {result?.outboundSync?.action === 'conflict' && (
                      <div className="mt-1 text-xs text-amber-600">
                        待出库记录已有单号 {result.outboundSync.existingTrackingNumber || '-'}，请人工核对
                      </div>
                    )}
                  </div>
                  {isApplying ? (
                    <Tag theme="warning" variant="light">
                      <span className="inline-flex items-center gap-1">
                        <LoaderCircle className="animate-spin" size={13} />申请中
                      </span>
                    </Tag>
                  ) : result ? (
                    <div className="shrink-0 text-right">
                      <Tag theme={result.success ? 'success' : 'danger'} variant="light">
                        {result.success ? '成功' : '失败'}
                      </Tag>
                      {result.success && <div className="mt-1 text-xs text-gray-600">{result.waybillNo || '-'}</div>}
                    </div>
                  ) : (
                    <Tag theme="default" variant="light">待申请</Tag>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </Dialog>

      <SfPrintDialog
        record={printTarget}
        batchRecords={batchPrintTargets}
        onClose={() => {
          setPrintTarget(null);
          setBatchPrintTargets([]);
        }}
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
        header="选择需要复用的顺丰运单"
        visible={!!reuseTarget}
        onClose={() => {
          if (attachingShipmentId) return;
          setReuseTarget(null);
          setReuseCandidates([]);
        }}
        width="780px"
        footer={null}
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-700">
            仅显示已由原订单明确“开放追加”，且收件人、电话、地址、付款方式和人员完全一致的包裹。
            关联成功后，新出库单仍需独立完成拍照。
          </div>
          {reuseTarget && (
            <div className="text-sm text-gray-600">
              目标订单：{reuseTarget.order.onlineOrderNumber || `序号 ${reuseTarget.order.serialNumber}`}
              <span className="ml-3">收件人：{reuseTarget.order.consignee}</span>
            </div>
          )}
          {reuseLoading ? (
            <div className="py-8 text-center text-gray-400">正在查询可复用顺丰包裹...</div>
          ) : reuseCandidates.length === 0 ? (
            <div className="py-8 text-center text-gray-400">
              暂无可复用包裹，请先在原顺丰订单上点击“开放追加”
            </div>
          ) : (
            <div className="max-h-[52vh] space-y-3 overflow-auto pr-1">
              {reuseCandidates.map(candidate => (
                <div key={candidate._id} className="rounded-lg border border-gray-200 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-medium text-gray-900">顺丰运单：{candidate.waybillNo}</div>
                      <div className="mt-1 text-sm text-gray-500">
                        原订单：{candidate.sourceOnlineOrderNumber || `序号 ${candidate.sourceSerialNumber}`}
                        <span className="ml-3">人员：{candidate.salesperson || '-'}</span>
                      </div>
                    </div>
                    <Button
                      theme="primary"
                      icon={<Link2 size={14} />}
                      loading={attachingShipmentId === candidate._id}
                      disabled={!!attachingShipmentId && attachingShipmentId !== candidate._id}
                      onClick={() => handleAttachShipment(candidate)}
                    >
                      使用此运单
                    </Button>
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-2 text-sm text-gray-600 sm:grid-cols-2">
                    <div>收件人：{candidate.consignee}，{candidate.consigneePhone}</div>
                    <div>付款方式：{getPaymentLabel(candidate.shippingFee)}</div>
                    <div className="sm:col-span-2">地址：{candidate.consigneeAddress}</div>
                    <div>已关联：{candidate.linkedOrderCount} 张订单</div>
                    <div>出库单：{candidate.linkedOutboundCount} 张</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Dialog>

      <Dialog
        header={shipmentConfirm?.action === 'confirmHandover'
          ? '确认包裹已交顺丰'
          : shipmentConfirm?.action === 'detach'
            ? '解除共享顺丰运单'
          : shipmentConfirm?.action === 'disableReuse'
            ? '关闭订单追加'
            : '开放订单追加'}
        visible={!!shipmentConfirm}
        onClose={() => !shipmentActionLoading && setShipmentConfirm(null)}
        onConfirm={handleShipmentAction}
        confirmBtn={{
          content: shipmentConfirm?.action === 'confirmHandover' ? '确认交接' : '确认',
          theme: ['confirmHandover', 'detach'].includes(shipmentConfirm?.action || '') ? 'danger' : 'primary',
          loading: shipmentActionLoading,
        }}
        cancelBtn={{ content: '取消', disabled: shipmentActionLoading }}
      >
        <div className="space-y-2 text-sm">
          <p>
            {shipmentConfirm?.action === 'confirmHandover'
              ? '系统会检查全部关联出库单均已完成。确认后该运单永久禁止追加订单。'
              : shipmentConfirm?.action === 'detach'
                ? '仅尚未完成拍照出库的追加订单可以解除。解除后订单和出库单的物流单号将被清空。'
              : shipmentConfirm?.action === 'disableReuse'
                ? '关闭后，新订单将无法再选择此顺丰运单。'
                : '开放后，无需先完成现有出库单拍照；仅收件信息、付款方式和人员完全一致的订单可以选择此运单。'}
          </p>
          <p className="text-gray-500">
            运单号：{shipmentConfirm?.row.currentSfOrder?.waybillNo || '-'}
          </p>
        </div>
      </Dialog>

    </div>
  );
}
