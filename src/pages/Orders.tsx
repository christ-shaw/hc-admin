import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { Table, Button, Input, Select, Tag, Dialog, MessagePlugin, Textarea, Switch } from 'tdesign-react';
import { Search, RotateCcw, Upload, Download, Plus, Pencil, Trash2, Minus, X, ChevronRight, ChevronLeft, FileDown, Check } from 'lucide-react';
import { OrderRecord, OrderFilters, InboundRecord, OutboundRecord, PhoneBrand, PhoneModelItem, ProductItem, TransferProductItem, OrderAttachment, PaymentSplit, dictToOptions, getDictLabel } from '../types';
import { useOrders } from '../hooks/useOrders';
import { usePhoneModels } from '../hooks/usePhoneModels';
import { formatDate, getTotalQuantity } from '../utils/format';
import { parseOrderExcel, exportOrderExcel } from '../utils/orderExcel';
import { getBrandLabel, getProductLabel } from '../data/dict';
import {
  parseConsigneeInfo,
  callFunction,
  getCloudFileURLs,
  getCurrentOperatorName,
  getCurrentPermissionUserPayload,
  uploadToCloudStorage,
} from '../lib/cloudbase';
import { PAGE_SIZE } from '../utils/constants';
import { DICT_CODES, useDictionaries } from '../contexts/DictionaryContext';

/** ========== 预计算静态 options（模块级常量，避免每次渲染重建） ========== */
const PLACEHOLDER_OPTION = { label: '请选择', value: '' };

/** 平台渠道的 salesChannel key 集合（人人租系列 + 云途/汇租机/租机乐/倬石电子/云界互联/极客矩阵/极速闪租） */
const PLATFORM_CHANNELS = new Set(['aRrz', 'fRrz', 'lRrz', 'jRrz', 'gRrz', 'yuntu', '云途', 'huizuji', 'zujile', '租机乐', 'zhuoshi', 'yunjie', 'jikejuzhen', 'jisushanzu']);

/** 根据 salesChannel key 推算渠道类别 */
function calcChannelCategory(salesChannel: string): 'platform' | 'offline' | '' {
  if (!salesChannel) return '';
  return PLATFORM_CHANNELS.has(salesChannel) ? 'platform' : 'offline';
}

/** 订单类型 → 虚拟产品货品名称白名单 */
const ORDER_TYPE_VIRTUAL_PRODUCTS: Partial<Record<string, string[]>> = {
  newBusiness: ['平台租金', '续期租金'],
  postRentalPayment: ['补收差价', '仅退款', '利润差额', '维修费', '快递费'],
  deposit: ['收押金', '退押金', '押金'],
};

/** 订单来源 → 可选订单类型白名单 */
const ORDER_SOURCE_ORDER_TYPE_MAP: Partial<Record<string, string[]>> = {
  new: ['newBusiness'],
  service: ['postRentalShip', 'postRentalReturn', 'postRentalPayment', 'deposit'],
};

/** 货品条目默认值 */
const EMPTY_PRODUCT: ProductItem = {
  brand: '',
  productName: '',
  specification: '',
  quantity: 0,
  unitPrice: 0,
  amount: 0,
  paymentAccount: '',
  paymentSplits: [],
};

/** 转租赁2货品条目默认值 */
const EMPTY_TRANSFER_PRODUCT: TransferProductItem = {
  brand: '',
  productName: '',
  specification: '',
  paidPeriod: 0,
  paidRent: 0,
};

/** 新增订单表单 — 公共字段 + 货品列表 */
interface OrderFormData {
  serialNumber: number;
  date: string;
  orderSource: string;
  orderAttribute: string;
  orderType: string;
  salesChannel: string;
  salesperson: string;
  channelCategory: string;
  onlineOrderNumber: string;
  customerName: string;
  trackingNumber: string;
  consignee: string;
  consigneePhone: string;
  consigneeAddress: string;
  shippingFee: string;
  status: string;
  customerRemark: string;
  transferProducts: TransferProductItem[];
  products: ProductItem[];
  attachments: OrderAttachment[];
  returnStatus: string;
  returnTrackingNumbers: string;
  needsOutbound: boolean;
}

interface OrderWizardDictionaries {
  ORDER_SOURCE_MAP: Record<string, string>;
  ORDER_ATTRIBUTE_MAP: Record<string, string>;
  ORDER_TYPE_MAP: Record<string, string>;
  SALES_CHANNEL_MAP: Record<string, string>;
  CHANNEL_CATEGORY_MAP: Record<string, string>;
  ORDER_STATUS_MAP: Record<string, string>;
  RETURN_STATUS_MAP: Record<string, string>;
  SHIPPING_FEE_MAP: Record<string, string>;
  ORDER_SOURCE_OPTIONS: Array<{ label: string; value: string }>;
  ORDER_ATTRIBUTE_OPTIONS: Array<{ label: string; value: string }>;
  ORDER_TYPE_OPTIONS: Array<{ label: string; value: string }>;
  SALES_CHANNEL_OPTIONS: Array<{ label: string; value: string }>;
  SALESPERSON_OPTIONS: Array<{ label: string; value: string }>;
  PAYMENT_ACCOUNT_OPTIONS: Array<{ label: string; value: string }>;
  ORDER_STATUS_OPTIONS: Array<{ label: string; value: string }>;
  RETURN_STATUS_OPTIONS: Array<{ label: string; value: string }>;
  SHIPPING_FEE_OPTIONS: Array<{ label: string; value: string }>;
}

const EMPTY_ORDER: OrderFormData = {
  serialNumber: 0,
  date: '',
  orderSource: '',
  orderAttribute: '',
  orderType: '',
  salesChannel: '',
  salesperson: '',
  channelCategory: '',
  onlineOrderNumber: '',
  customerName: '',
  trackingNumber: '',
  consignee: '',
  consigneePhone: '',
  consigneeAddress: '',
  shippingFee: '',
  status: 'unknown',
  customerRemark: '',
  transferProducts: [],
  products: [{ ...EMPTY_PRODUCT }],
  attachments: [],
  returnStatus: '',
  returnTrackingNumbers: '',
  needsOutbound: false,
};

const STATUS_TAG_THEME: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
  shipped: 'success',
  unshipped: 'warning',
  unknown: 'default',
};

function isPendingShipmentStatus(status: string | undefined): boolean {
  return status === 'unknown' || status === '--' || status === 'unshipped';
}

// 终态：不随「需要出库」开关改写的订单状态
const TERMINAL_ORDER_STATUSES = new Set(['shipped', 'returnReceived', 'returnShipped']);

/** 需要出库 → 未发货；不需要 → 不用发货；终态保持不变 */
function deriveOutboundStatus(needsOutbound: boolean, prevStatus: string): string {
  if (TERMINAL_ORDER_STATUSES.has(prevStatus)) return prevStatus;
  return needsOutbound ? 'unshipped' : 'noShip';
}

/** 统一设置 needsOutbound 并联动订单状态、清理发货字段 */
function applyNeedsOutbound(prev: OrderFormData, needsOutbound: boolean): OrderFormData {
  const status = deriveOutboundStatus(needsOutbound, prev.status);
  return {
    ...prev,
    needsOutbound,
    status,
    shippingFee: status === 'shipped' ? prev.shippingFee : '',
    trackingNumber: status === 'shipped' ? prev.trackingNumber : '',
  };
}

function isExpressApplicableStatus(status: string | undefined): boolean {
  return isPendingShipmentStatus(status);
}

function isVirtualProductOrder(products: ProductItem[]): boolean {
  const selectedBrands = products.map(product => product.brand).filter(Boolean);
  return selectedBrands.length > 0 && selectedBrands.every(brand => brand === '虚拟产品');
}

// 需要出库的订单类型（仅按订单类型判定，见 docs/order-outbound-linkage-design.md §4.1）
const OUTBOUND_ORDER_TYPES = new Set(['newBusiness', 'postRentalShip']);

/** 计算「需要出库」默认值：虚拟货品单强制 false，否则按订单类型 */
function defaultNeedsOutbound(orderType: string, products: ProductItem[]): boolean {
  if (isVirtualProductOrder(products)) return false;
  return OUTBOUND_ORDER_TYPES.has(orderType);
}

function applyVirtualProductStatus(prev: OrderFormData, products: ProductItem[]): OrderFormData {
  const wasVirtualProductOrder = isVirtualProductOrder(prev.products);
  const isVirtualOrder = isVirtualProductOrder(products);

  if (isVirtualOrder) {
    return { ...prev, products, status: 'noShip', shippingFee: '', trackingNumber: '', needsOutbound: false };
  }

  if (wasVirtualProductOrder && prev.status === 'noShip') {
    return applyNeedsOutbound({ ...prev, products }, defaultNeedsOutbound(prev.orderType, products));
  }

  return { ...prev, products };
}

function getEffectiveShipmentFields(form: OrderFormData) {
  const status = isVirtualProductOrder(form.products) ? 'noShip' : form.status;
  return {
    status,
    shippingFee: status === 'shipped' ? form.shippingFee : '',
    trackingNumber: status === 'shipped' ? form.trackingNumber : '',
  };
}

function shouldShowProductPaymentFields(orderSource?: string, orderType?: string, orderAttribute?: string, productBrand?: string): boolean {
  if (orderSource === 'new' && orderAttribute === 'rental1' && productBrand !== '虚拟产品') return false;
  if (orderSource === 'service' && (orderType === 'postRentalShip' || orderType === 'postRentalReturn')) return false;
  return true;
}

function formatPhoneModels(phoneModels?: PhoneModelItem[]): string {
  if (!phoneModels || phoneModels.length === 0) return '-';
  return phoneModels.map(item => `${item.model || '-'} x${item.quantity || 0}`).join('，');
}

function getOutboundPhoneTotal(record?: OutboundRecord | null): number {
  return record?.phoneModels?.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0) || 0;
}

function shouldShowAfterSaleInboundConfirm(record: OrderRecord): boolean {
  const needsReturnConfirm = ['postRentalShip', 'postRentalReturn', '租后发货', '租后退货', '售后发货'].includes(record.orderType);
  return needsReturnConfirm && record.returnStatus !== 'returned';
}

function clearHiddenProductPaymentFields(form: Pick<OrderFormData, 'orderSource' | 'orderType' | 'orderAttribute' | 'products'>): ProductItem[] {
  return form.products.map(product => {
    if (shouldShowProductPaymentFields(form.orderSource, form.orderType, form.orderAttribute, product.brand)) return product;
    return {
      ...product,
      unitPrice: 0,
      amount: 0,
      paymentAccount: '',
      paymentSplits: [],
    };
  });
}

function parsePaymentSplits(value: OrderRecord['paymentSplits'] | ProductItem['paymentSplits']): PaymentSplit[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizePaymentSplits(source: Pick<ProductItem, 'paymentAccount' | 'amount' | 'paymentSplits'>): PaymentSplit[] {
  const splits = parsePaymentSplits(source.paymentSplits)
    .map(split => ({ account: String(split.account || '').trim(), amount: Math.max(0, Number(split.amount) || 0) }))
    .filter(split => split.account || split.amount > 0);
  if (splits.length > 0) return splits;
  return source.paymentAccount ? [{ account: source.paymentAccount, amount: Math.max(0, Number(source.amount) || 0) }] : [];
}

function getEditablePaymentSplits(product: ProductItem): PaymentSplit[] {
  const rawSplits = parsePaymentSplits(product.paymentSplits)
    .map(split => ({
      account: String(split.account || ''),
      amount: Math.max(0, Number(split.amount) || 0),
    }));
  if (rawSplits.length > 0) return rawSplits;
  if (product.paymentAccount) return [{ account: product.paymentAccount, amount: Math.max(0, Number(product.amount) || 0) }];
  return [{ account: '', amount: Math.max(0, Number(product.amount) || 0) }];
}

function getPaymentAccountValue(splits: PaymentSplit[]): string {
  const accounts = splits.map(split => split.account).filter(Boolean);
  if (accounts.length === 0) return '';
  return Array.from(new Set(accounts)).join('、');
}

function getPaymentSplitTotal(product: ProductItem): number {
  return normalizePaymentSplits(product).reduce((sum, split) => sum + (Number(split.amount) || 0), 0);
}

function isPaymentSplitValid(product: ProductItem): boolean {
  const splits = normalizePaymentSplits(product);
  if (splits.length === 0 || splits.some(split => !split.account || split.amount <= 0)) return false;
  return Math.abs(getPaymentSplitTotal(product) - (Number(product.amount) || 0)) < 0.01;
}

function formatPaymentSplits(source: Pick<OrderRecord, 'paymentAccount' | 'amount' | 'paymentSplits'>): string {
  const splits = normalizePaymentSplits(source as ProductItem);
  if (splits.length === 0) return source.paymentAccount || '-';
  if (splits.length === 1) return splits[0].account || source.paymentAccount || '-';
  return splits.map(split => `${split.account || '-'} ¥${split.amount || 0}`).join('；');
}

function hasUnreceivedPayment(record: OrderRecord): boolean {
  return record.paymentAccount === '未收款' || normalizePaymentSplits(record as unknown as ProductItem).some(split => split.account === '未收款');
}

function serializeProductForSave(product: ProductItem): ProductItem {
  const paymentSplits = normalizePaymentSplits(product);
  return {
    ...product,
    paymentSplits,
    paymentAccount: getPaymentAccountValue(paymentSplits),
  };
}

function syncSinglePaymentSplitAmount(product: ProductItem, amount: number): PaymentSplit[] {
  const splits = normalizePaymentSplits(product);
  if (splits.length > 1) return splits;
  return [{ account: splits[0]?.account || product.paymentAccount || '', amount }];
}

function buildEditFormFromRecord(record: OrderRecord): OrderFormData {
  let transferProducts: TransferProductItem[] = [];
  if (record.transferItems) {
    try {
      transferProducts = JSON.parse(record.transferItems);
    } catch { /* ignore parse error */ }
  }
  if (transferProducts.length === 0 && (record.transferBrand || record.transferProductName)) {
    transferProducts = [{
      brand: record.transferBrand || '',
      productName: record.transferProductName || '',
      specification: record.transferSpecification || '',
      paidPeriod: record.paidPeriod || 0,
      paidRent: record.paidRent || 0,
    }];
  }

  return {
    serialNumber: record.serialNumber,
    date: record.date,
    orderSource: record.orderSource,
    orderAttribute: record.orderAttribute,
    orderType: record.orderType,
    salesChannel: record.salesChannel,
    salesperson: record.salesperson,
    channelCategory: record.channelCategory,
    onlineOrderNumber: record.onlineOrderNumber,
    customerName: record.customerName,
    trackingNumber: record.trackingNumber,
    consignee: record.consignee,
    consigneePhone: record.consigneePhone || '',
    consigneeAddress: record.consigneeAddress || '',
    shippingFee: record.shippingFee || '',
    status: record.status,
    customerRemark: record.customerRemark,
    transferProducts,
    products: [{
      brand: record.brand,
      productName: record.productName,
      specification: record.specification,
      quantity: record.quantity,
      unitPrice: record.unitPrice,
      amount: record.amount,
      paymentAccount: record.paymentAccount,
      paymentSplits: normalizePaymentSplits(record as unknown as ProductItem),
    }],
    attachments: record.attachments || [],
    returnStatus: record.returnStatus || '',
    returnTrackingNumbers: record.returnTrackingNumbers || '',
    // 旧数据无 needsOutbound 时按订单类型兜底（noShip=虚拟单→false）
    needsOutbound: record.needsOutbound ?? (record.status === 'noShip' ? false : OUTBOUND_ORDER_TYPES.has(record.orderType)),
  };
}

export function Orders() {
  const orders = useOrders();
  const location = useLocation();
  const dictionaries = useDictionaries();
  const productModels = usePhoneModels();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const ORDER_SOURCE_MAP = dictionaries.getMap(DICT_CODES.orderSource);
  const ORDER_ATTRIBUTE_MAP = dictionaries.getMap(DICT_CODES.orderAttribute);
  const ORDER_TYPE_MAP = dictionaries.getMap(DICT_CODES.orderType);
  const SALES_CHANNEL_MAP = dictionaries.getMap(DICT_CODES.salesChannel);
  const CHANNEL_CATEGORY_MAP = dictionaries.getMap(DICT_CODES.channelCategory);
  const ORDER_STATUS_MAP = dictionaries.getMap(DICT_CODES.orderStatus);
  const RETURN_STATUS_MAP = dictionaries.getMap(DICT_CODES.returnStatus);
  const SHIPPING_FEE_MAP = dictionaries.getMap(DICT_CODES.shippingFee);
  const SALESPERSONS = dictionaries.getItems(DICT_CODES.salesperson).map(item => item.value);

  const ORDER_SOURCE_OPTIONS = useMemo(() => [PLACEHOLDER_OPTION, ...dictToOptions(ORDER_SOURCE_MAP)], [ORDER_SOURCE_MAP]);
  const ORDER_ATTRIBUTE_OPTIONS = useMemo(() => [PLACEHOLDER_OPTION, ...dictToOptions(ORDER_ATTRIBUTE_MAP)], [ORDER_ATTRIBUTE_MAP]);
  const ORDER_TYPE_OPTIONS = useMemo(() => [PLACEHOLDER_OPTION, ...dictToOptions(ORDER_TYPE_MAP)], [ORDER_TYPE_MAP]);
  const SALES_CHANNEL_OPTIONS = useMemo(() => [PLACEHOLDER_OPTION, ...dictToOptions(SALES_CHANNEL_MAP)], [SALES_CHANNEL_MAP]);
  const SALESPERSON_OPTIONS = useMemo(() => [PLACEHOLDER_OPTION, ...SALESPERSONS.map(v => ({ label: dictionaries.getLabel(DICT_CODES.salesperson, v), value: v }))], [SALESPERSONS, dictionaries]);
  const PAYMENT_ACCOUNT_OPTIONS = useMemo(() => [PLACEHOLDER_OPTION, ...dictionaries.getOptions(DICT_CODES.paymentAccount)], [dictionaries]);
  const ORDER_STATUS_OPTIONS = useMemo(() => dictToOptions(ORDER_STATUS_MAP), [ORDER_STATUS_MAP]);
  const RETURN_STATUS_OPTIONS = useMemo(() => [PLACEHOLDER_OPTION, ...dictToOptions(RETURN_STATUS_MAP)], [RETURN_STATUS_MAP]);
  const SHIPPING_FEE_OPTIONS = useMemo(() => [PLACEHOLDER_OPTION, ...dictToOptions(SHIPPING_FEE_MAP)], [SHIPPING_FEE_MAP]);
  const FILTER_SALESPERSON_OPTIONS = useMemo(() => [{ label: '全部', value: '' }, ...SALESPERSONS.map(v => ({ label: dictionaries.getLabel(DICT_CODES.salesperson, v), value: v }))], [SALESPERSONS, dictionaries]);
  const FILTER_ORDER_STATUS_OPTIONS = useMemo(() => [{ label: '全部', value: '' }, ...dictToOptions(ORDER_STATUS_MAP)], [ORDER_STATUS_MAP]);
  const SHIP_CONFIRM_SHIPPING_FEE_OPTIONS = useMemo(
    () => dictToOptions(SHIPPING_FEE_MAP).filter(option => option.value === 'prepaid' || option.value === 'cod'),
    [SHIPPING_FEE_MAP]
  );

  useEffect(() => {
    productModels.loadBrands();
  }, [productModels.loadBrands]);

  const wizardDictionaries = useMemo<OrderWizardDictionaries>(() => ({
    ORDER_SOURCE_MAP,
    ORDER_ATTRIBUTE_MAP,
    ORDER_TYPE_MAP,
    SALES_CHANNEL_MAP,
    CHANNEL_CATEGORY_MAP,
    ORDER_STATUS_MAP,
    RETURN_STATUS_MAP,
    SHIPPING_FEE_MAP,
    ORDER_SOURCE_OPTIONS,
    ORDER_ATTRIBUTE_OPTIONS,
    ORDER_TYPE_OPTIONS,
    SALES_CHANNEL_OPTIONS,
    SALESPERSON_OPTIONS,
    PAYMENT_ACCOUNT_OPTIONS,
    ORDER_STATUS_OPTIONS,
    RETURN_STATUS_OPTIONS,
    SHIPPING_FEE_OPTIONS,
  }), [
    ORDER_SOURCE_MAP,
    ORDER_ATTRIBUTE_MAP,
    ORDER_TYPE_MAP,
    SALES_CHANNEL_MAP,
    CHANNEL_CATEGORY_MAP,
    ORDER_STATUS_MAP,
    RETURN_STATUS_MAP,
    SHIPPING_FEE_MAP,
    ORDER_SOURCE_OPTIONS,
    ORDER_ATTRIBUTE_OPTIONS,
    ORDER_TYPE_OPTIONS,
    SALES_CHANNEL_OPTIONS,
    SALESPERSON_OPTIONS,
    PAYMENT_ACCOUNT_OPTIONS,
    ORDER_STATUS_OPTIONS,
    RETURN_STATUS_OPTIONS,
    SHIPPING_FEE_OPTIONS,
  ]);

  const [filters, setFilters] = useState<OrderFilters>({});
  const [detailVisible, setDetailVisible] = useState(false);
  const [currentRecord, setCurrentRecord] = useState<OrderRecord | null>(null);
  const [importing, setImporting] = useState(false);
  const [importPreviewVisible, setImportPreviewVisible] = useState(false);
  const [importPreviewData, setImportPreviewData] = useState<OrderRecord[]>([]);
  const [applyingExpressId, setApplyingExpressId] = useState<string | null>(null);
  const [queryingSfResultId, setQueryingSfResultId] = useState<string | null>(null);
  const [cancelingSfId, setCancelingSfId] = useState<string | null>(null);
  const [addVisible, setAddVisible] = useState(false);
  const [addForm, setAddForm] = useState<OrderFormData>(EMPTY_ORDER);
  const [saving, setSaving] = useState(false);
  const [editVisible, setEditVisible] = useState(false);
  const [editForm, setEditForm] = useState<OrderFormData>(EMPTY_ORDER);
  const [editId, setEditId] = useState('');
  const [shipDialogVisible, setShipDialogVisible] = useState(false);
  const [shipTarget, setShipTarget] = useState<OrderRecord | null>(null);
  const [shipRecords, setShipRecords] = useState<OutboundRecord[]>([]);
  const [selectedShipRecord, setSelectedShipRecord] = useState<OutboundRecord | null>(null);
  const [shipShippingFee, setShipShippingFee] = useState('prepaid');
  const [shipLoading, setShipLoading] = useState(false);
  const [shipUpdating, setShipUpdating] = useState(false);
  const [shipPhotoVisible, setShipPhotoVisible] = useState(false);
  const [shipPhotoLoading, setShipPhotoLoading] = useState(false);
  const [shipPhotoTarget, setShipPhotoTarget] = useState<OutboundRecord | null>(null);
  const [shipPhotoUrls, setShipPhotoUrls] = useState<Array<{ fileID: string; tempFileURL: string }>>([]);
  // 生成出库单弹窗（支持单订单 / 合并多订单）
  const [genOutVisible, setGenOutVisible] = useState(false);
  const [genOutOrders, setGenOutOrders] = useState<OrderRecord[]>([]);
  const [genOutShippingMethod, setGenOutShippingMethod] = useState('prepaid');
  const [genOutRemark, setGenOutRemark] = useState('');
  const [genOutSubmitting, setGenOutSubmitting] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState<Array<string | number>>([]);
  const [afterSaleInboundVisible, setAfterSaleInboundVisible] = useState(false);
  const [afterSaleInboundTarget, setAfterSaleInboundTarget] = useState<OrderRecord | null>(null);
  const [afterSaleInboundCustomerName, setAfterSaleInboundCustomerName] = useState('');
  const [afterSaleInboundTrackingNumber, setAfterSaleInboundTrackingNumber] = useState('');
  const [afterSaleInboundRecords, setAfterSaleInboundRecords] = useState<InboundRecord[]>([]);
  const [afterSaleInboundLoading, setAfterSaleInboundLoading] = useState(false);
  const [afterSaleInboundUpdatingId, setAfterSaleInboundUpdatingId] = useState<string | null>(null);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<OrderRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 编辑订单向导状态
  const [editStep, setEditStep] = useState(1);
  const [editAttachFiles, setEditAttachFiles] = useState<File[]>([]);
  const editAttachInputRef = useRef<HTMLInputElement>(null);

  // 新增订单向导状态
  const [addStep, setAddStep] = useState(1);
  const [addAttachFiles, setAddAttachFiles] = useState<File[]>([]);
  const addAttachInputRef = useRef<HTMLInputElement>(null);
  const [addCloseConfirmVisible, setAddCloseConfirmVisible] = useState(false);

  // 导出引导弹窗状态
  const [exportVisible, setExportVisible] = useState(false);
  const [exportStep, setExportStep] = useState(1); // 1=日期 2=渠道 3=人员
  const [exportDateStart, setExportDateStart] = useState('');
  const [exportDateEnd, setExportDateEnd] = useState('');
  const [exportChannels, setExportChannels] = useState<string[]>([]); // 空=全部
  const [exportSalespersons, setExportSalespersons] = useState<string[]>([]); // 空=全部
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const state = location.state as { filter?: OrderFilters } | null;
    const stateFilter = state?.filter || {};
    const initialFilters: OrderFilters = {};

    if (stateFilter.onlineOrderNumber) {
      initialFilters.onlineOrderNumber = stateFilter.onlineOrderNumber.trim();
    } else if (stateFilter.customerName) {
      initialFilters.customerName = stateFilter.customerName.trim();
    }

    setFilters(initialFilters);
    orders.fetchRecords(null, initialFilters);
  }, [location.state]);

  const handleSearch = () => {
    orders.resetFilters();
    const searchFilters: OrderFilters = { ...filters };
    // trim 字符串字段，避免前后空格导致查不到
    if (searchFilters.customerName) searchFilters.customerName = searchFilters.customerName.trim();
    if (searchFilters.onlineOrderNumber) searchFilters.onlineOrderNumber = searchFilters.onlineOrderNumber.trim();
    orders.fetchRecords(null, searchFilters);
  };

  const handleReset = () => {
    setFilters({});
    orders.resetFilters();
    orders.fetchRecords(null, {});
  };

  const handleDetail = useCallback((record: OrderRecord) => {
    setCurrentRecord(record);
    setDetailVisible(true);
  }, []);

  const handleApplyExpress = useCallback(async (record: OrderRecord) => {
    if (!record._id || applyingExpressId) return;
    if (!isExpressApplicableStatus(record.status)) {
      MessagePlugin.warning('仅订单状态为 -- 的订单可申请快递');
      return;
    }
    if (record.trackingNumber || record.sfWaybillNo) {
      MessagePlugin.warning('订单已存在快递单号，请勿重复申请');
      return;
    }

    setApplyingExpressId(record._id);
    try {
      const result = await orders.applySfExpress(record._id);
      if (result.success) {
        MessagePlugin.success(`顺丰下单成功，运单号：${result.waybillNo || '-'}`);
      } else {
        MessagePlugin.error(result.errMsg || '顺丰下单失败');
      }
    } finally {
      setApplyingExpressId(null);
    }
  }, [applyingExpressId, orders]);

  const handleQuerySfOrderResult = useCallback(async (record: OrderRecord) => {
    if (!record._id || queryingSfResultId) return;

    setQueryingSfResultId(record._id);
    try {
      const result = await orders.querySfOrderResult(record._id);
      if (result.success) {
        MessagePlugin.success(`顺丰下单结果已更新，运单号：${result.waybillNo || '-'}`);
      } else {
        MessagePlugin.error(result.errMsg || '查询顺丰下单结果失败');
      }
    } finally {
      setQueryingSfResultId(null);
    }
  }, [orders, queryingSfResultId]);

  const handleCancelSfExpress = useCallback(async (record: OrderRecord) => {
    if (!record._id || cancelingSfId) return;
    if (!record.sfOrderId && !record.sfWaybillNo && !record.trackingNumber) {
      MessagePlugin.warning('订单缺少顺丰订单信息，无法取消');
      return;
    }
    if (!window.confirm('确认取消这笔顺丰发货吗？取消后的顺丰客户订单号不能重复使用。')) return;

    setCancelingSfId(record._id);
    try {
      const result = await orders.cancelSfExpress(record._id);
      if (result.success) {
        MessagePlugin.success('顺丰发货已取消');
      } else {
        MessagePlugin.error(result.errMsg || '取消顺丰发货失败');
      }
    } finally {
      setCancelingSfId(null);
    }
  }, [cancelingSfId, orders]);

  /** 导入 Excel */
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const records = await parseOrderExcel(file);
      if (records.length === 0) {
        MessagePlugin.warning('未在文件中找到订单数据');
        return;
      }
      setImportPreviewData(records);
      setImportPreviewVisible(true);
    } catch (err) {
      MessagePlugin.error('文件解析失败: ' + String(err));
    }
    // 重置 input，允许再次选择同一文件
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleImportConfirm = async () => {
    setImporting(true);
    try {
      const result = await orders.importOrders(importPreviewData);
      if (result.success) {
        MessagePlugin.success(`成功导入 ${importPreviewData.length} 条订单`);
        setImportPreviewVisible(false);
        setImportPreviewData([]);
      } else {
        MessagePlugin.error('导入失败: ' + (result.errMsg || '未知错误'));
      }
    } catch (err) {
      MessagePlugin.error('导入异常: ' + String(err));
    } finally {
      setImporting(false);
    }
  };

  /** 导出 Excel — 打开引导弹窗 */
  const handleExport = () => {
    // 默认日期：当月1号 ~ 今天，最多半年
    const today = new Date();
    const endDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const sixMonthsAgo = new Date(today);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const startDate = `${sixMonthsAgo.getFullYear()}-${String(sixMonthsAgo.getMonth() + 1).padStart(2, '0')}-01`;
    setExportDateStart(startDate);
    setExportDateEnd(endDate);
    setExportChannels([]);
    setExportSalespersons([]);
    setExportStep(1);
    setExportVisible(true);
  };

  /** 导出日期范围验证（最多半年） */
  const validateExportDate = (): string | null => {
    if (!exportDateStart || !exportDateEnd) return '请选择完整的日期范围';
    const start = new Date(exportDateStart);
    const end = new Date(exportDateEnd);
    if (start > end) return '开始日期不能晚于结束日期';
    const diffMs = end.getTime() - start.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    if (diffDays > 183) return '日期范围不能超过半年（183天）';
    return null;
  };

  /** 执行导出 */
  const handleExportExec = async () => {
    const dateErr = validateExportDate();
    if (dateErr) {
      MessagePlugin.warning(dateErr);
      return;
    }
    setExporting(true);
    try {
      // 构建筛选条件
      const filters: OrderFilters = {
        startDate: exportDateStart,
        endDate: exportDateEnd,
      };
      // 如果不是全选，需要逐渠道/逐人员查询再合并
      // 云函数不支持多选，所以需要多次查询
      const channels = exportChannels.length > 0 ? exportChannels : [undefined];
      const persons = exportSalespersons.length > 0 ? exportSalespersons : [undefined];

      let allRecords: OrderRecord[] = [];
      for (const channel of channels) {
        for (const person of persons) {
          const f: OrderFilters = { ...filters };
          if (channel) f.salesChannel = channel;
          if (person) f.salesperson = person;
          const records = await orders.fetchAllRecords(f);
          allRecords = allRecords.concat(records);
        }
      }

      // 按 _id 去重（同一条记录可能被多次查到）
      const seen = new Set<string>();
      allRecords = allRecords.filter(r => {
        if (seen.has(r._id)) return false;
        seen.add(r._id);
        return true;
      });

      if (allRecords.length === 0) {
        MessagePlugin.warning('所选条件内暂无订单数据');
        setExporting(false);
        return;
      }

      exportOrderExcel(allRecords);
      MessagePlugin.success(`已导出 ${allRecords.length} 条订单`);
      setExportVisible(false);
    } catch (err) {
      MessagePlugin.error('导出失败: ' + String(err));
    } finally {
      setExporting(false);
    }
  };

  /** 新增订单 — 打开向导 Step 1 */
  const handleAddOpen = async () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const operatorName = await getCurrentOperatorName();
    const nickname = operatorName || SALESPERSONS[0];
    setAddForm({ ...EMPTY_ORDER, date: dateStr, salesperson: nickname, products: [{ ...EMPTY_PRODUCT }] });
    setAddAttachFiles([]);
    setAddStep(1);
    setAddVisible(true);
  };

  /** 新增向导 — 下一步校验 */
  const handleAddNext = () => {
    if (addStep === 1) {
      if (!addForm.date) { MessagePlugin.warning('请填写日期'); return; }
      if (!addForm.customerName.trim()) { MessagePlugin.warning('请填写客户名称'); return; }
      if (!addForm.salesperson) { MessagePlugin.warning('请选择销售人员'); return; }
    }
    if (addStep === 2) {
      if (addForm.channelCategory === 'platform' && !addForm.onlineOrderNumber.trim()) { MessagePlugin.warning('平台渠道请填写网店订单号'); return; }
      if (!addForm.orderSource) { MessagePlugin.warning('请选择订单来源'); return; }
      if (!addForm.orderAttribute) { MessagePlugin.warning('请选择订单属性'); return; }
      if (!addForm.salesChannel) { MessagePlugin.warning('请选择销售渠道'); return; }
    }
    if (addStep === 3) {
      if (addForm.products.length === 0) { MessagePlugin.warning('请至少添加一条货品'); return; }
      if (addForm.products.some(p => !p.brand)) { MessagePlugin.warning('请选择货品品牌'); return; }
      if (addForm.products.some(p => !p.productName)) { MessagePlugin.warning('请选择货品名称'); return; }
      if (addForm.products.some(p => !p.specification)) { MessagePlugin.warning('请选择规格'); return; }
      if (addForm.products.some(p => !p.quantity || p.quantity <= 0)) { MessagePlugin.warning('请填写数量'); return; }
      if (addForm.products.some(p => shouldShowProductPaymentFields(addForm.orderSource, addForm.orderType, addForm.orderAttribute, p.brand) && (!p.unitPrice || p.unitPrice <= 0))) { MessagePlugin.warning('请填写单价'); return; }
      if (addForm.products.some(p => shouldShowProductPaymentFields(addForm.orderSource, addForm.orderType, addForm.orderAttribute, p.brand) && !isPaymentSplitValid(p))) { MessagePlugin.warning('请填写收款账户，并确保收款金额合计等于货品金额'); return; }
      if (addForm.products.some(p => p.productName === '部分转租赁2' || p.productName === '全部转租赁2') && addForm.transferProducts.some(t => !t.paidPeriod || t.paidPeriod <= 0)) { MessagePlugin.warning('转租赁2请填写已交租期'); return; }
      if (addForm.products.some(p => p.productName === '部分转租赁2' || p.productName === '全部转租赁2') && addForm.transferProducts.some(t => !t.paidRent || t.paidRent <= 0)) { MessagePlugin.warning('转租赁2请填写已交租金'); return; }
    }
    if (addStep === 4) {
      const { status } = getEffectiveShipmentFields(addForm);
    }
    if (addStep === 5) {
      const needReturnStatus = addForm.orderType === 'postRentalShip' || addForm.orderType === 'postRentalReturn';
      if (needReturnStatus && !addForm.returnStatus) { MessagePlugin.warning('请选择归还状态'); return; }
      if (addForm.returnStatus === 'inTransit' && !addForm.returnTrackingNumbers.trim()) { MessagePlugin.warning('运输途中请填写归还物流单号'); return; }
    }
    setAddStep(prev => Math.min(prev + 1, 6));
  };

  /** 新增向导 — 上一步 */
  const handleAddPrev = () => setAddStep(prev => Math.max(prev - 1, 1));

  /** 判断新建表单是否有已填写的数据 */
  const isAddFormDirty = () => {
    if (addForm.customerName.trim() || addForm.onlineOrderNumber.trim() ||
        addForm.orderSource || addForm.orderAttribute || addForm.orderType ||
        addForm.salesChannel || addForm.channelCategory ||
        addForm.consignee.trim() || addForm.consigneePhone.trim() || addForm.consigneeAddress.trim() ||
        addForm.shippingFee || addForm.trackingNumber.trim() ||
        addForm.customerRemark.trim() ||
        addForm.transferProducts.some(t => t.brand || t.productName || t.specification || t.paidPeriod || t.paidRent) ||
        addAttachFiles.length > 0) return true;
    // 检查货品是否有数据
    return addForm.products.some(p => p.brand || p.productName || p.specification || p.quantity || p.unitPrice || p.paymentAccount || normalizePaymentSplits(p).length > 0);
  };

  const handleRequestCloseAdd = () => {
    if (isAddFormDirty()) {
      setAddCloseConfirmVisible(true);
    } else {
      setAddVisible(false);
      setAddStep(1);
      setAddAttachFiles([]);
    }
  };

  const handleConfirmCloseAdd = () => {
    setAddCloseConfirmVisible(false);
    setAddVisible(false);
    setAddStep(1);
    setAddForm(EMPTY_ORDER);
    setAddAttachFiles([]);
  };

  /** 新增订单 — 预览确认后提交（Step 6） */
  const handleAddSave = async () => {
    setSaving(true);
    try {
      // 上传附件到云存储
      const attachments: OrderAttachment[] = [];
      for (const file of addAttachFiles) {
        const timestamp = Date.now();
        const ext = file.name.split('.').pop() || 'bin';
        const cloudPath = `orders_attachments/${timestamp}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const fileID = await uploadToCloudStorage(cloudPath, file);
        attachments.push({ fileID, fileName: file.name });
      }

      // 获取计数器当前值并自增（原子操作）
      const counterResult = await callFunction<{ success: boolean; value: number; errMsg?: string }>('getAndIncrementCounter', {
        data: { counterName: 'orderSerialNumber' },
      });
      if (!counterResult.success) {
        MessagePlugin.error('获取序号失败: ' + (counterResult.errMsg || '未知错误'));
        setSaving(false);
        return;
      }
      const serialNumber = counterResult.value;

      const firstTransfer = addForm.transferProducts[0];
      const shipmentFields = getEffectiveShipmentFields(addForm);
      const newRecords: OrderRecord[] = addForm.products.map((product, index) => ({
        _id: `manual_${Date.now()}_${index}`,
        serialNumber,
        date: addForm.date,
        orderSource: addForm.orderSource,
        orderAttribute: addForm.orderAttribute,
        orderType: addForm.orderType,
        salesChannel: addForm.salesChannel,
        salesperson: addForm.salesperson,
        channelCategory: addForm.channelCategory,
        onlineOrderNumber: addForm.onlineOrderNumber,
        customerName: addForm.customerName,
        ...serializeProductForSave(product),
        trackingNumber: shipmentFields.trackingNumber,
        consignee: addForm.consignee,
        consigneePhone: addForm.consigneePhone,
        consigneeAddress: addForm.consigneeAddress,
        shippingFee: shipmentFields.shippingFee,
        status: shipmentFields.status,
        customerRemark: addForm.customerRemark,
        transferBrand: firstTransfer?.brand || '',
        transferProductName: firstTransfer?.productName || '',
        transferSpecification: firstTransfer?.specification || '',
        paidPeriod: firstTransfer?.paidPeriod || 0,
        paidRent: firstTransfer?.paidRent || 0,
        transferItems: addForm.transferProducts.length > 0 ? JSON.stringify(addForm.transferProducts) : '',
        attachments,
        returnStatus: addForm.returnStatus || '',
        returnTrackingNumbers: addForm.returnTrackingNumbers || '',
        needsOutbound: addForm.needsOutbound,
        outboundRecordId: '',
      }));
      const result = await orders.importOrders(newRecords);
      if (result.success) {
        MessagePlugin.success(`新增订单成功，共 ${newRecords.length} 条`);
        setAddVisible(false);
        setAddStep(1);
        setAddForm(EMPTY_ORDER);
        setAddAttachFiles([]);
      } else {
        MessagePlugin.error('新增失败: ' + (result.errMsg || '未知错误'));
      }
    } catch (err) {
      MessagePlugin.error('新增异常: ' + String(err));
    } finally {
      setSaving(false);
    }
  };

  /** 编辑订单 */
  const handleEditOpen = useCallback((record: OrderRecord) => {
    setEditId(record._id);
    setEditStep(1);
    setEditAttachFiles([]);
    setEditForm(buildEditFormFromRecord(record));
    setEditVisible(true);
  }, []);

  const findOutboundRecords = useCallback(async (consignee: string) => {
    const keyword = consignee.trim();
    if (!keyword) return [];

    const currentUser = await getCurrentPermissionUserPayload().catch(() => null);
    const result = await callFunction<{ success?: boolean; data?: OutboundRecord[]; errMsg?: string }>('queryRecords', {
      data: {
        type: 'outbound',
        customerName: keyword,
        limit: 20,
        cursor: null,
        currentUser,
      },
    });
    if (result.success === false) {
      throw new Error(result.errMsg || '查询发货记录失败');
    }

    return (result.data || [])
      .filter(item => item.trackingNumber)
      .sort((a, b) => Number(b.customerName === keyword) - Number(a.customerName === keyword));
  }, []);

  const handleShipOpen = useCallback(async (record: OrderRecord) => {
    if (!isPendingShipmentStatus(record.status)) {
      MessagePlugin.warning('仅订单状态为 -- 的订单允许发货');
      return;
    }

    const consignee = record.consignee || '';
    if (!consignee.trim()) {
      MessagePlugin.warning('订单缺少收货人名称，无法匹配发货记录');
      return;
    }

    setShipTarget(record);
    setShipRecords([]);
    setShipDialogVisible(true);
    setShipLoading(true);

    try {
      const records = await findOutboundRecords(consignee);
      setShipRecords(records);
      if (records.length === 0) {
        MessagePlugin.warning(`未找到客户名称为「${consignee}」的发货记录快递单号`);
      }
    } catch (err) {
      MessagePlugin.error('匹配发货记录失败: ' + String(err));
    } finally {
      setShipLoading(false);
    }
  }, [findOutboundRecords]);

  const openGenerateDialog = useCallback((records: OrderRecord[]) => {
    setGenOutOrders(records);
    setGenOutShippingMethod(records[0]?.shippingFee || 'prepaid');
    setGenOutRemark('');
    setGenOutVisible(true);
  }, []);

  const handleGenerateOutboundOpen = useCallback((record: OrderRecord) => {
    openGenerateDialog([record]);
  }, [openGenerateDialog]);

  // 合并多订单生成一个出库单：校验同客户、均需出库、均未生成、均待发货
  const handleMergeGenerateOpen = useCallback(() => {
    const selected = orders.getAllRecords().filter(r => selectedRowKeys.includes(r._id));
    if (selected.length < 2) { MessagePlugin.warning('请至少选择 2 条订单合并'); return; }
    const bad = selected.find(r => !r.needsOutbound || !isPendingShipmentStatus(r.status) || r.outboundRecordId);
    if (bad) { MessagePlugin.warning('所选订单须均为「需要出库 + 未发货 + 未生成出库单」'); return; }
    const customer = (selected[0].customerName || '').trim();
    if (!selected.every(r => (r.customerName || '').trim() === customer)) {
      MessagePlugin.warning('合并的订单必须属于同一客户'); return;
    }
    openGenerateDialog(selected);
  }, [orders, selectedRowKeys, openGenerateDialog]);

  const handleConfirmGenerateOutbound = useCallback(async () => {
    if (genOutOrders.length === 0) return;
    if (!genOutShippingMethod) { MessagePlugin.warning('请选择快递方式'); return; }
    setGenOutSubmitting(true);
    try {
      const result = await orders.generateOutbound(genOutOrders.map(o => o._id), genOutShippingMethod, genOutRemark);
      if (result.success) {
        MessagePlugin.success(genOutOrders.length > 1 ? '已合并生成待出库单' : '已生成待出库单');
        setGenOutVisible(false);
        setGenOutOrders([]);
        setSelectedRowKeys([]);
      } else {
        MessagePlugin.error(result.errMsg || '生成出库单失败');
      }
    } finally {
      setGenOutSubmitting(false);
    }
  }, [genOutOrders, genOutShippingMethod, genOutRemark, orders]);

  const handleSelectShipRecord = useCallback((record: OutboundRecord) => {
    if (!record.trackingNumber) {
      MessagePlugin.warning('该发货记录没有快递单号');
      return;
    }
    setShipShippingFee('prepaid');
    setSelectedShipRecord(record);
  }, []);

  const handlePreviewShipPhotos = useCallback(async (record: OutboundRecord) => {
    const photos = record.phonePhotos || [];
    setShipPhotoTarget(record);
    setShipPhotoUrls([]);
    setShipPhotoVisible(true);

    if (photos.length === 0) return;

    setShipPhotoLoading(true);
    try {
      const urls = await getCloudFileURLs(photos);
      setShipPhotoUrls(urls);
    } catch (err) {
      MessagePlugin.error('发货照片加载失败: ' + String(err));
    } finally {
      setShipPhotoLoading(false);
    }
  }, []);

  const handleConfirmShipRecord = useCallback(async () => {
    if (!shipTarget || !selectedShipRecord) return;
    if (!selectedShipRecord.trackingNumber) {
      MessagePlugin.warning('该发货记录没有快递单号');
      return;
    }
    if (!shipShippingFee) {
      MessagePlugin.warning('请选择邮寄结算方式');
      return;
    }

    setShipUpdating(true);
    try {
      const success = await orders.updateOrder(shipTarget._id, {
        trackingNumber: selectedShipRecord.trackingNumber,
        status: 'shipped',
        shippingFee: shipShippingFee,
      });

      if (success) {
        MessagePlugin.success('发货信息已更新');
        setShipDialogVisible(false);
        setShipTarget(null);
        setShipRecords([]);
        setSelectedShipRecord(null);
        setShipShippingFee('prepaid');
      } else {
        MessagePlugin.error('更新订单发货信息失败');
      }
    } catch (err) {
      MessagePlugin.error('更新订单发货信息异常: ' + String(err));
    } finally {
      setShipUpdating(false);
    }
  }, [orders, selectedShipRecord, shipShippingFee, shipTarget]);

  const searchAfterSaleInboundRecords = useCallback(async (customerName: string, trackingNumber: string) => {
    const trimmedCustomerName = customerName.trim();
    const trimmedTrackingNumber = trackingNumber.trim();
    if (!trimmedCustomerName && !trimmedTrackingNumber) {
      MessagePlugin.warning('请输入客户名称或快递单号');
      return;
    }

    setAfterSaleInboundLoading(true);
    try {
      const currentUser = await getCurrentPermissionUserPayload().catch(() => null);
      const result = await callFunction<{ success?: boolean; data?: InboundRecord[]; errMsg?: string }>('queryRecords', {
        data: {
          type: 'inbound',
          customerName: trimmedCustomerName || undefined,
          trackingNumber: trimmedTrackingNumber || undefined,
          limit: 50,
          cursor: null,
          currentUser,
        },
      });
      if (result.success === false) {
        throw new Error(result.errMsg || '查询入库记录失败');
      }

      const records = (result.data || []).sort((a, b) => {
        const aTime = new Date(a.inboundDate || a.createTime?.$date || 0).getTime();
        const bTime = new Date(b.inboundDate || b.createTime?.$date || 0).getTime();
        return bTime - aTime;
      });
      setAfterSaleInboundRecords(records);
      if (records.length === 0) {
        MessagePlugin.warning('未找到匹配的入库记录');
      }
    } catch (err) {
      MessagePlugin.error('查询入库记录失败: ' + String(err));
    } finally {
      setAfterSaleInboundLoading(false);
    }
  }, []);

  const handleAfterSaleInboundOpen = useCallback((record: OrderRecord) => {
    if (!shouldShowAfterSaleInboundConfirm(record)) {
      MessagePlugin.warning('仅租后发货且未入库的订单可确认回库');
      return;
    }

    const customerName = record.customerName || '';
    const trackingNumber = '';
    setAfterSaleInboundTarget(record);
    setAfterSaleInboundCustomerName(customerName);
    setAfterSaleInboundTrackingNumber(trackingNumber);
    setAfterSaleInboundRecords([]);
    setAfterSaleInboundVisible(true);
    searchAfterSaleInboundRecords(customerName, trackingNumber);
  }, [searchAfterSaleInboundRecords]);

  const handleAfterSaleInboundSearch = useCallback(() => {
    searchAfterSaleInboundRecords(afterSaleInboundCustomerName, afterSaleInboundTrackingNumber);
  }, [afterSaleInboundCustomerName, afterSaleInboundTrackingNumber, searchAfterSaleInboundRecords]);

  const resetAfterSaleInboundDialog = useCallback(() => {
    setAfterSaleInboundVisible(false);
    setAfterSaleInboundTarget(null);
    setAfterSaleInboundCustomerName('');
    setAfterSaleInboundTrackingNumber('');
    setAfterSaleInboundRecords([]);
    setAfterSaleInboundLoading(false);
    setAfterSaleInboundUpdatingId(null);
  }, []);

  const handleConfirmAfterSaleInboundRecord = useCallback(async (record: InboundRecord) => {
    if (!afterSaleInboundTarget || afterSaleInboundUpdatingId) return;
    if (!record.trackingNumber) {
      MessagePlugin.warning('该入库记录没有快递单号，无法写入客服备注');
      return;
    }
    if (!window.confirm(`确认使用快递单号「${record.trackingNumber}」将此订单标记为已入库吗？`)) return;

    setAfterSaleInboundUpdatingId(record._id);
    try {
      const success = await orders.updateOrder(afterSaleInboundTarget._id, {
        returnStatus: 'returned',
        returnTrackingNumbers: record.trackingNumber,
        customerRemark: record.trackingNumber,
      });

      if (success) {
        MessagePlugin.success('售后回库已确认');
        resetAfterSaleInboundDialog();
      } else {
        MessagePlugin.error('更新订单回库状态失败');
      }
    } catch (err) {
      MessagePlugin.error('更新订单回库状态异常: ' + String(err));
    } finally {
      setAfterSaleInboundUpdatingId(null);
    }
  }, [afterSaleInboundTarget, afterSaleInboundUpdatingId, orders, resetAfterSaleInboundDialog]);

  /** 编辑向导 — 下一步校验 */
  const handleEditNext = () => {
    if (editStep === 1) {
      if (!editForm.date) { MessagePlugin.warning('请填写日期'); return; }
      if (!editForm.customerName.trim()) { MessagePlugin.warning('请填写客户名称'); return; }
      if (!editForm.salesperson) { MessagePlugin.warning('请选择销售人员'); return; }
    }
    if (editStep === 2) {
      if (editForm.channelCategory === 'platform' && !editForm.onlineOrderNumber.trim()) { MessagePlugin.warning('平台渠道请填写网店订单号'); return; }
      if (!editForm.orderSource) { MessagePlugin.warning('请选择订单来源'); return; }
      if (!editForm.orderAttribute) { MessagePlugin.warning('请选择订单属性'); return; }
      if (!editForm.salesChannel) { MessagePlugin.warning('请选择销售渠道'); return; }
    }
    if (editStep === 3) {
      if (editForm.products.length === 0) { MessagePlugin.warning('请至少添加一条货品'); return; }
      if (editForm.products.some(p => !p.brand)) { MessagePlugin.warning('请选择货品品牌'); return; }
      if (editForm.products.some(p => !p.productName)) { MessagePlugin.warning('请选择货品名称'); return; }
      if (editForm.products.some(p => !p.specification)) { MessagePlugin.warning('请选择规格'); return; }
      if (editForm.products.some(p => !p.quantity || p.quantity <= 0)) { MessagePlugin.warning('请填写数量'); return; }
      if (editForm.products.some(p => shouldShowProductPaymentFields(editForm.orderSource, editForm.orderType, editForm.orderAttribute, p.brand) && (!p.unitPrice || p.unitPrice <= 0))) { MessagePlugin.warning('请填写单价'); return; }
      if (editForm.products.some(p => shouldShowProductPaymentFields(editForm.orderSource, editForm.orderType, editForm.orderAttribute, p.brand) && !isPaymentSplitValid(p))) { MessagePlugin.warning('请填写收款账户，并确保收款金额合计等于货品金额'); return; }
      const editHasTransfer = editForm.products.some(p => p.productName === '部分转租赁2' || p.productName === '全部转租赁2');
      if (editHasTransfer && editForm.transferProducts.some(t => !t.paidPeriod || t.paidPeriod <= 0)) { MessagePlugin.warning('转租赁2请填写已交租期'); return; }
      if (editHasTransfer && editForm.transferProducts.some(t => !t.paidRent || t.paidRent <= 0)) { MessagePlugin.warning('转租赁2请填写已交租金'); return; }
    }
    if (editStep === 4) {
      const { status } = getEffectiveShipmentFields(editForm);
    }
    if (editStep === 5) {
      const needReturnStatus = editForm.orderType === 'postRentalShip' || editForm.orderType === 'postRentalReturn';
      if (needReturnStatus && !editForm.returnStatus) { MessagePlugin.warning('请选择归还状态'); return; }
      if (editForm.returnStatus === 'inTransit' && !editForm.returnTrackingNumbers.trim()) { MessagePlugin.warning('运输途中请填写归还物流单号'); return; }
    }
    setEditStep(prev => Math.min(prev + 1, 6));
  };

  /** 编辑向导 — 上一步 */
  const handleEditPrev = () => setEditStep(prev => Math.max(prev - 1, 1));

  const handleEditSave = async () => {
    setSaving(true);
    try {
      // 上传新增附件到云存储
      const newAttachments: OrderAttachment[] = [];
      for (const file of editAttachFiles) {
        const timestamp = Date.now();
        const ext = file.name.split('.').pop() || 'bin';
        const cloudPath = `orders_attachments/${timestamp}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const fileID = await uploadToCloudStorage(cloudPath, file);
        newAttachments.push({ fileID, fileName: file.name });
      }
      const allAttachments = [...editForm.attachments, ...newAttachments];

      const firstTransfer = editForm.transferProducts[0];
      const shipmentFields = getEffectiveShipmentFields(editForm);
      const buildFlatData = (product: ProductItem): Omit<OrderRecord, '_id' | 'createTime'> => ({
        serialNumber: editForm.serialNumber,
        date: editForm.date,
        orderSource: editForm.orderSource,
        orderAttribute: editForm.orderAttribute,
        orderType: editForm.orderType,
        salesChannel: editForm.salesChannel,
        salesperson: editForm.salesperson,
        channelCategory: editForm.channelCategory,
        onlineOrderNumber: editForm.onlineOrderNumber,
        customerName: editForm.customerName,
        ...serializeProductForSave(product),
        trackingNumber: shipmentFields.trackingNumber,
        consignee: editForm.consignee,
        consigneePhone: editForm.consigneePhone,
        consigneeAddress: editForm.consigneeAddress,
        shippingFee: shipmentFields.shippingFee,
        status: shipmentFields.status,
        customerRemark: editForm.customerRemark,
        transferBrand: firstTransfer?.brand || '',
        transferProductName: firstTransfer?.productName || '',
        transferSpecification: firstTransfer?.specification || '',
        paidPeriod: firstTransfer?.paidPeriod || 0,
        paidRent: firstTransfer?.paidRent || 0,
        transferItems: editForm.transferProducts.length > 0 ? JSON.stringify(editForm.transferProducts) : '',
        attachments: allAttachments,
        returnStatus: editForm.returnStatus || '',
        returnTrackingNumbers: editForm.returnTrackingNumbers || '',
        needsOutbound: editForm.needsOutbound,
      });

      const flatData = buildFlatData(editForm.products[0] || EMPTY_PRODUCT);
      const success = await orders.updateOrder(editId, flatData);
      if (success) {
        const extraProducts = editForm.products.slice(1);
        if (extraProducts.length > 0) {
          const timestamp = Date.now();
          const extraRecords: OrderRecord[] = extraProducts.map((product, index) => ({
            _id: `manual_${timestamp}_${index}`,
            ...buildFlatData(product),
          }));
          const result = await orders.importOrders(extraRecords);
          if (!result.success) {
            MessagePlugin.error('主订单已修改，但新增货品保存失败: ' + (result.errMsg || '未知错误'));
            return;
          }
        }
        MessagePlugin.success(extraProducts.length > 0 ? `修改订单成功，并新增 ${extraProducts.length} 条货品记录` : '修改订单成功');
        setEditVisible(false);
        setEditStep(1);
        setEditAttachFiles([]);
      } else {
        MessagePlugin.error('修改失败');
      }
    } catch (err) {
      MessagePlugin.error('修改异常: ' + String(err));
    } finally {
      setSaving(false);
    }
  };

  /** 删除订单 */
  const handleDeleteConfirm = useCallback((record: OrderRecord) => {
    setDeleteTarget(record);
    setDeleteConfirmVisible(true);
  }, []);

  const handleDeleteExec = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const success = await orders.deleteOrder(deleteTarget._id);
      if (success) {
        MessagePlugin.success('删除成功');
        setDeleteConfirmVisible(false);
        setDeleteTarget(null);
      } else {
        MessagePlugin.error('删除失败');
      }
    } catch (err) {
      MessagePlugin.error('删除异常: ' + String(err));
    } finally {
      setDeleting(false);
    }
  };

  const columns = useMemo(() => [
    { colKey: 'row-select', type: 'multiple' as const, width: 46 },
    { colKey: 'serialNumber', title: '序号', width: 60 },
    { colKey: 'date', title: '日期', width: 100, cell: ({ row }: { row: OrderRecord }) => formatDate(row.date, false) },
    { colKey: 'orderType', title: '订单类型', width: 90, cell: ({ row }: { row: OrderRecord }) => getDictLabel(ORDER_TYPE_MAP, row.orderType) || '-' },
    {
      colKey: 'importSource', title: '订单来源', width: 90,
      cell: ({ row }: { row: OrderRecord }) => (
        row.importSource === 'hc-order-assist'
          ? <Tag theme="primary" variant="light">赞晨租</Tag>
          : <span>手工</span>
      ),
    },
    { colKey: 'salesChannel', title: '销售渠道', width: 90, cell: ({ row }: { row: OrderRecord }) => getDictLabel(SALES_CHANNEL_MAP, row.salesChannel) || '-' },
    { colKey: 'salesperson', title: '人员', width: 60, cell: ({ row }: { row: OrderRecord }) => row.salesperson || '-' },
    { colKey: 'customerName', title: '客户名称', width: 100, ellipsis: true },
    { colKey: 'orderAttribute', title: '订单属性', width: 80, cell: ({ row }: { row: OrderRecord }) => getDictLabel(ORDER_ATTRIBUTE_MAP, row.orderAttribute) || '-' },
    { colKey: 'trackingNumber', title: '快递单号', width: 130, ellipsis: true, cell: ({ row }: { row: OrderRecord }) => row.trackingNumber || '-' },
    {
      colKey: 'productInfo', title: '货品名称/规格', width: 160,
      cell: ({ row }: { row: OrderRecord }) => {
        const name = row.productName || '';
        const spec = row.specification && row.specification !== '默认' ? ` ${row.specification}` : '';
        return name ? `${getProductLabel(name)}${spec}` : '-';
      },
    },
    { colKey: 'quantity', title: '数量', width: 60, cell: ({ row }: { row: OrderRecord }) => row.quantity || '-' },
    { colKey: 'amount', title: '金额', width: 80, cell: ({ row }: { row: OrderRecord }) => row.amount ? `¥${row.amount}` : '-' },
    {
      colKey: 'status', title: '订单状态', width: 80,
      cell: ({ row }: { row: OrderRecord }) => {
        const theme = STATUS_TAG_THEME[row.status] || 'default';
        return <Tag theme={theme} variant="light">{getDictLabel(ORDER_STATUS_MAP, row.status) || '--'}</Tag>;
      },
    },
    {
      colKey: 'op', title: '操作', width: 330, fixed: 'right' as const,
      cell: ({ row }: { row: OrderRecord }) => (
        <div className="flex gap-1 flex-wrap">
          <Button variant="text" theme="primary" size="small"
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleDetail(row); }}>
            详情
          </Button>
          {false && isExpressApplicableStatus(row.status) && row.expressApplyStatus !== 'cancelled' && (
            <Button variant="text" theme="primary" size="small"
              loading={applyingExpressId === row._id}
              disabled={!!applyingExpressId && applyingExpressId !== row._id}
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleApplyExpress(row); }}>
              申请快递
            </Button>
          )}
          {false && !row.trackingNumber && !['applied', 'cancelled'].includes(row.expressApplyStatus || '') && (
            <Button variant="text" theme="primary" size="small"
              loading={queryingSfResultId === row._id}
              disabled={!!queryingSfResultId && queryingSfResultId !== row._id}
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleQuerySfOrderResult(row); }}>
              查顺丰
            </Button>
          )}
          {row.expressApplyStatus === 'applied' && (row.sfOrderId || row.sfWaybillNo || row.trackingNumber) && (
            <Button variant="text" theme="danger" size="small"
              loading={cancelingSfId === row._id}
              disabled={!!cancelingSfId && cancelingSfId !== row._id}
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleCancelSfExpress(row); }}>
              取消顺丰
            </Button>
          )}
          <Button variant="text" theme="primary" size="small"
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleEditOpen(row); }}>
            编辑
          </Button>
          {row.needsOutbound && isPendingShipmentStatus(row.status) && !row.outboundRecordId && (
            <Button variant="text" theme="primary" size="small"
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleGenerateOutboundOpen(row); }}>
              生成出库单
            </Button>
          )}
          {isPendingShipmentStatus(row.status) && (
            <Button variant="text" theme="primary" size="small"
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleShipOpen(row); }}>
              发货
            </Button>
          )}
          {shouldShowAfterSaleInboundConfirm(row) && (
            <Button variant="text" theme="primary" size="small"
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleAfterSaleInboundOpen(row); }}>
              售后回库确认
            </Button>
          )}
          <Button variant="text" theme="danger" size="small"
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleDeleteConfirm(row); }}>
            删除
          </Button>
        </div>
      ),
    },
  ], [handleDetail, handleApplyExpress, handleQuerySfOrderResult, handleCancelSfExpress, handleEditOpen, handleShipOpen, handleGenerateOutboundOpen, handleAfterSaleInboundOpen, handleDeleteConfirm, applyingExpressId, queryingSfResultId, cancelingSfId, ORDER_TYPE_MAP, SALES_CHANNEL_MAP, ORDER_ATTRIBUTE_MAP, ORDER_STATUS_MAP]);

  const displayRecords = orders.getPageRecords(orders.currentPage);
  const hasLoadedNextPage = orders.currentPage * PAGE_SIZE < orders.records.length;
  const canGoNextPage = hasLoadedNextPage || orders.hasMore;
  const handlePrevPage = useCallback(() => {
    orders.setCurrentPage(orders.currentPage - 1);
  }, [orders]);
  const handleNextPage = useCallback(() => {
    if (hasLoadedNextPage) {
      orders.setCurrentPage(orders.currentPage + 1);
      return;
    }
    orders.fetchRecords(orders.cursor);
  }, [hasLoadedNextPage, orders]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">订单管理</h1>
          <p className="text-gray-500 mt-1">管理所有订单</p>
        </div>
        <div className="flex gap-2">
          {selectedRowKeys.length >= 2 && (
            <Button theme="primary" variant="outline" onClick={handleMergeGenerateOpen}>
              合并生成出库单（{selectedRowKeys.length}）
            </Button>
          )}
          <Button theme="primary" icon={<Plus size={16} />} onClick={handleAddOpen}>
            新增订单
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            title="导入订单 Excel"
            aria-label="导入订单 Excel"
            onChange={handleFileSelect}
          />
          <Button theme="default" icon={<Upload size={16} />} onClick={() => fileInputRef.current?.click()}>
            导入Excel
          </Button>
          <Button theme="default" icon={<Download size={16} />} onClick={handleExport}>
            导出Excel
          </Button>
        </div>
      </div>

      {/* 筛选栏 */}
      <div className="glass-card p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="w-48">
            <label className="block text-xs text-gray-500 mb-1">网店订单号</label>
            <Input placeholder="请输入网店订单号" value={filters.onlineOrderNumber || ''}
              onChange={(val) => setFilters(prev => ({ ...prev, onlineOrderNumber: val as string }))} />
          </div>
          <div className="w-48">
            <label className="block text-xs text-gray-500 mb-1">客户名称</label>
            <Input placeholder="请输入客户名称" value={filters.customerName || ''}
              onChange={(val) => setFilters(prev => ({ ...prev, customerName: val as string }))} />
          </div>
          <div className="w-40">
            <label className="block text-xs text-gray-500 mb-1">人员</label>
            <Select placeholder="请选择人员" value={filters.salesperson || ''}
              onChange={(val) => setFilters(prev => ({ ...prev, salesperson: val as string }))}
              options={FILTER_SALESPERSON_OPTIONS} />
          </div>
          <div className="w-40">
            <label className="block text-xs text-gray-500 mb-1">订单类型</label>
            <Select placeholder="请选择订单类型" value={filters.orderType || ''}
              onChange={(val) => setFilters(prev => ({ ...prev, orderType: val as string }))}
              options={ORDER_TYPE_OPTIONS} />
          </div>
          <div className="w-40">
            <label className="block text-xs text-gray-500 mb-1">订单状态</label>
            <Select placeholder="请选择订单状态" value={filters.status || ''}
              onChange={(val) => setFilters(prev => ({ ...prev, status: val as string }))}
              options={FILTER_ORDER_STATUS_OPTIONS} />
          </div>
          <div className="w-40">
            <label className="block text-xs text-gray-500 mb-1">日期</label>
            <input type="date" className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
              value={filters.startDate || ''}
              onChange={(e) => setFilters(prev => ({ ...prev, startDate: e.target.value }))} />
          </div>
          <div className="flex items-end gap-2">
            <Button theme="primary" icon={<Search size={16} />} onClick={handleSearch}>查询</Button>
            <Button variant="outline" icon={<RotateCcw size={16} />} onClick={handleReset}>重置</Button>
          </div>
        </div>
      </div>

      {/* 表格 */}
      <div className="glass-card">
        <Table
          data={displayRecords}
          columns={columns}
          loading={orders.loading}
          rowKey="_id"
          tableLayout="fixed"
          selectedRowKeys={selectedRowKeys}
          onSelectChange={(keys: Array<string | number>) => setSelectedRowKeys(keys)}
          hover
          stripe
          rowClassName={({ row }: { row: OrderRecord }) => {
            const isUnreceived = hasUnreceivedPayment(row);
            const isUnreturned = row.returnStatus === 'notReturned' || row.returnStatus === 'inTransit';
            return (isUnreceived || isUnreturned) ? 'order-row-unreceived' : '';
          }}
        />
        {/* 分页 */}
        <div className="flex justify-center items-center gap-2 py-4 border-t border-gray-100">
          <Button size="small" variant="outline" disabled={orders.currentPage <= 1}
            onClick={handlePrevPage}>
            上一页
          </Button>
          <span className="text-sm text-gray-500">第 {orders.currentPage} 页</span>
          <Button size="small" variant="outline" disabled={!canGoNextPage || orders.loading}
            onClick={handleNextPage}>
            下一页
          </Button>
          <span className="text-sm text-gray-400">共 {orders.totalRecords} 条</span>
        </div>
      </div>

      {/* 详情弹窗 */}
      <Dialog header="订单详情" visible={detailVisible} onClose={() => setDetailVisible(false)} width="700px"
        footer={<Button onClick={() => setDetailVisible(false)}>关闭</Button>}>
        {currentRecord && (
          <div className="space-y-2 text-sm">
            <DetailRow label="序号" value={currentRecord.serialNumber} />
            <DetailRow label="日期" value={formatDate(currentRecord.date, false)} />
            <DetailRow label="订单来源" value={currentRecord.orderSource} />
            <DetailRow label="订单属性" value={currentRecord.orderAttribute} />
            <DetailRow label="订单类型" value={currentRecord.orderType} />
            <DetailRow label="销售渠道" value={currentRecord.salesChannel} />
            <DetailRow label="人员" value={currentRecord.salesperson} />
            <DetailRow label="渠道类别" value={currentRecord.channelCategory} />
            {currentRecord.channelCategory === 'platform' && <DetailRow label="网店订单号" value={currentRecord.onlineOrderNumber} />}
            <DetailRow label="品牌" value={getBrandLabel(currentRecord.brand)} />
            <DetailRow label="货品名称" value={getProductLabel(currentRecord.productName)} />
            <DetailRow label="规格" value={currentRecord.specification} />
            <DetailRow label="数量" value={currentRecord.quantity} />
            {shouldShowProductPaymentFields(currentRecord.orderSource, currentRecord.orderType, currentRecord.orderAttribute, currentRecord.brand) && <DetailRow label="单价" value={currentRecord.unitPrice ? `¥${currentRecord.unitPrice}` : '-'} />}
            {shouldShowProductPaymentFields(currentRecord.orderSource, currentRecord.orderType, currentRecord.orderAttribute, currentRecord.brand) && <DetailRow label="金额" value={currentRecord.amount ? `¥${currentRecord.amount}` : '-'} />}
            {shouldShowProductPaymentFields(currentRecord.orderSource, currentRecord.orderType, currentRecord.orderAttribute, currentRecord.brand) && <DetailRow label="收款账户" value={formatPaymentSplits(currentRecord)} />}
            <DetailRow label="收货人名称" value={currentRecord.consignee} />
            <DetailRow label="收货人电话" value={currentRecord.consigneePhone} />
            <DetailRow label="收货人地址" value={currentRecord.consigneeAddress} />
            {currentRecord.status === 'shipped' && <DetailRow label="邮寄结算方式" value={getDictLabel(SHIPPING_FEE_MAP, currentRecord.shippingFee)} />}
            {currentRecord.status === 'shipped' && <DetailRow label="物流单号" value={currentRecord.trackingNumber} />}
            <DetailRow label="订单状态" value={
              <Tag theme={STATUS_TAG_THEME[currentRecord.status] || 'default'} variant="light">
                {getDictLabel(ORDER_STATUS_MAP, currentRecord.status) || '--'}
              </Tag>
            } />
            <DetailRow label="客服备注" value={currentRecord.customerRemark} />
            {/* 归还状态（租后发货/租后退货） */}
            {(currentRecord.orderType === 'postRentalShip' || currentRecord.orderType === 'postRentalReturn') && currentRecord.returnStatus && (
              <>
                <DetailRow label="归还状态" value={getDictLabel(RETURN_STATUS_MAP, currentRecord.returnStatus)} />
                {currentRecord.returnStatus === 'inTransit' && (
                  <DetailRow label="归还物流单号" value={currentRecord.returnTrackingNumbers || '-'} />
                )}
              </>
            )}
            {/* 转租赁2多组展示 */}
            {(() => {
              let items: TransferProductItem[] = [];
              if (currentRecord.transferItems) {
                try { items = JSON.parse(currentRecord.transferItems); } catch { /* ignore */ }
              }
              if (items.length === 0 && (currentRecord.transferBrand || currentRecord.transferProductName)) {
                items = [{
                  brand: currentRecord.transferBrand || '',
                  productName: currentRecord.transferProductName || '',
                  specification: currentRecord.transferSpecification || '',
                  paidPeriod: currentRecord.paidPeriod || 0,
                  paidRent: currentRecord.paidRent || 0,
                }];
              }
              if (items.length > 0) {
                return items.map((t, i) => (
                  <div key={i} className="border-l-2 border-blue-300 pl-3 my-1">
                    {items.length > 1 && <div className="text-xs text-blue-500 font-medium mb-1">转租赁2 - 第{i + 1}组</div>}
                    <DetailRow label="转租赁2品牌" value={getBrandLabel(t.brand)} />
                    <DetailRow label="转租赁2货品名称" value={getProductLabel(t.productName)} />
                    <DetailRow label="转租赁2规格" value={t.specification} />
                    <DetailRow label="已交租期" value={t.paidPeriod || '-'} />
                    <DetailRow label="已交租金" value={t.paidRent ? `¥${t.paidRent}` : '-'} />
                  </div>
                ));
              }
              return null;
            })()}
          </div>
        )}
      </Dialog>

      {/* 发货记录匹配弹窗 */}
      <Dialog
        header="选择发货记录"
        visible={shipDialogVisible}
        onClose={() => { if (!shipUpdating) { setShipDialogVisible(false); setShipTarget(null); setShipRecords([]); setSelectedShipRecord(null); setShipShippingFee('prepaid'); } }}
        width="560px"
        footer={<Button disabled={shipUpdating} onClick={() => { setShipDialogVisible(false); setShipTarget(null); setShipRecords([]); setSelectedShipRecord(null); setShipShippingFee('prepaid'); }}>取消</Button>}
      >
        <div className="space-y-3">
          <div className="text-sm text-gray-500">
            根据收件人名称「<span className="font-medium text-gray-800">{shipTarget?.consignee || '-'}</span>」匹配发货记录
          </div>
          {shipLoading ? (
            <div className="py-8 text-center text-gray-400">正在查询发货记录...</div>
          ) : shipRecords.length === 0 ? (
            <div className="py-8 text-center text-gray-400">未找到可用的发货记录</div>
          ) : (
            <div className="max-h-[420px] overflow-auto space-y-2">
              {shipRecords.map((record, index) => (
                <div
                  key={record._id || index}
                  className="w-full border border-gray-200 rounded-lg p-3 hover:border-blue-400 hover:bg-blue-50/40"
                >
                  <div className="grid grid-cols-1 gap-1 text-sm text-gray-800">
                    <div><span className="text-gray-400">发货时间：</span>{formatDate(record.outboundDate, false) || '-'}</div>
                    <div><span className="text-gray-400">客户名称：</span>{record.customerName || '-'}</div>
                    <div><span className="text-gray-400">发货单号：</span>{record.trackingNumber || '-'}</div>
                    <div><span className="text-gray-400">手机型号：</span>{formatPhoneModels(record.phoneModels)}</div>
                    <div><span className="text-gray-400">发货数量：</span>{getOutboundPhoneTotal(record) || '-'}</div>
                  </div>
                  <div className="flex justify-end gap-2 mt-3">
                    <Button
                      size="small"
                      variant="outline"
                      disabled={shipUpdating}
                      onClick={() => handlePreviewShipPhotos(record)}
                    >
                      查看照片
                    </Button>
                    <Button
                      size="small"
                      theme="primary"
                      disabled={shipUpdating}
                      onClick={() => handleSelectShipRecord(record)}
                    >
                      选择
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Dialog>

      {/* 发货确认弹窗 */}
      <Dialog
        header="确认发货"
        visible={!!selectedShipRecord}
        onClose={() => { if (!shipUpdating) setSelectedShipRecord(null); }}
        width="460px"
        footer={
          <div className="flex justify-end gap-2">
            <Button disabled={shipUpdating} onClick={() => setSelectedShipRecord(null)}>取消</Button>
            <Button theme="primary" loading={shipUpdating} onClick={handleConfirmShipRecord}>确认发货</Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="text-gray-600">确认使用以下发货记录更新订单吗？</p>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
            <div><span className="text-gray-400">订单客户：</span><span className="text-gray-800">{shipTarget?.customerName || '-'}</span></div>
            <div><span className="text-gray-400">收件人：</span><span className="text-gray-800">{shipTarget?.consignee || '-'}</span></div>
            <div><span className="text-gray-400">发货时间：</span><span className="text-gray-800">{selectedShipRecord ? formatDate(selectedShipRecord.outboundDate, false) : '-'}</span></div>
            <div><span className="text-gray-400">发货客户：</span><span className="text-gray-800">{selectedShipRecord?.customerName || '-'}</span></div>
            <div><span className="text-gray-400">快递单号：</span><span className="font-medium text-gray-900">{selectedShipRecord?.trackingNumber || '-'}</span></div>
            <div><span className="text-gray-400">手机型号：</span><span className="text-gray-800">{formatPhoneModels(selectedShipRecord?.phoneModels)}</span></div>
            <div><span className="text-gray-400">发货数量：</span><span className="text-gray-800">{getOutboundPhoneTotal(selectedShipRecord) || '-'}</span></div>
            {selectedShipRecord && (
              <Button size="small" variant="outline" onClick={() => handlePreviewShipPhotos(selectedShipRecord)}>
                查看发货照片
              </Button>
            )}
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">邮寄结算方式 <span className="text-red-500">*</span></label>
            <Select
              placeholder="请选择邮寄结算方式"
              value={shipShippingFee}
              onChange={val => setShipShippingFee(val as string)}
              options={SHIP_CONFIRM_SHIPPING_FEE_OPTIONS}
            />
          </div>
          <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-3 text-blue-700">
            确认后将订单状态改为“已发货”，邮寄结算方式设为“{getDictLabel(SHIPPING_FEE_MAP, shipShippingFee)}”，并写入该快递单号。
          </div>
        </div>
      </Dialog>

      {/* 生成出库单弹窗（单订单 / 合并多订单） */}
      <Dialog
        header={genOutOrders.length > 1 ? `合并生成出库单（${genOutOrders.length} 条订单）` : '生成出库单'}
        visible={genOutVisible}
        onClose={() => { if (!genOutSubmitting) { setGenOutVisible(false); setGenOutOrders([]); } }}
        width="480px"
        footer={
          <div className="flex justify-end gap-2">
            <Button disabled={genOutSubmitting} onClick={() => { setGenOutVisible(false); setGenOutOrders([]); }}>取消</Button>
            <Button theme="primary" loading={genOutSubmitting} onClick={handleConfirmGenerateOutbound}>确认生成</Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm">
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
            <div><span className="text-gray-400">客户：</span><span className="text-gray-800">{genOutOrders[0]?.customerName || '-'}</span></div>
            <div><span className="text-gray-400">收货人：</span><span className="text-gray-800">{genOutOrders[0]?.consignee || '-'}</span></div>
            <div>
              <span className="text-gray-400">货品：</span>
              <div className="mt-1 space-y-1">
                {genOutOrders.map(o => (
                  <div key={o._id} className="text-gray-800">
                    {[o.brand, o.productName, o.specification].filter(Boolean).join(' / ') || '-'} × {o.quantity ?? '-'}
                    <span className="text-gray-400 ml-1">（单号 {o.serialNumber}）</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">快递方式 <span className="text-red-500">*</span></label>
            <Select
              placeholder="请选择快递方式"
              value={genOutShippingMethod}
              onChange={val => setGenOutShippingMethod(val as string)}
              options={dictToOptions(SHIPPING_FEE_MAP)}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">备注</label>
            <Textarea placeholder="可填写出库备注（选填）" value={genOutRemark} onChange={val => setGenOutRemark(val as string)} />
          </div>
          <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-3 text-blue-700">
            确认后生成一条<b>待出库</b>记录{genOutOrders.length > 1 ? '（合并上述订单货品）' : ''}，交由小程序端完成发货并回填物流单号。
          </div>
        </div>
      </Dialog>

      {/* 发货照片预览弹窗 */}
      <Dialog
        header="发货照片"
        visible={shipPhotoVisible}
        onClose={() => { setShipPhotoVisible(false); setShipPhotoTarget(null); setShipPhotoUrls([]); }}
        width="720px"
        footer={<Button onClick={() => { setShipPhotoVisible(false); setShipPhotoTarget(null); setShipPhotoUrls([]); }}>关闭</Button>}
      >
        <div className="space-y-3">
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
            <div><span className="text-gray-400">发货客户：</span>{shipPhotoTarget?.customerName || '-'}</div>
            <div className="mt-1"><span className="text-gray-400">手机型号：</span>{formatPhoneModels(shipPhotoTarget?.phoneModels)}</div>
            <div className="mt-1"><span className="text-gray-400">发货数量：</span>{getOutboundPhoneTotal(shipPhotoTarget) || '-'}</div>
          </div>
          {shipPhotoLoading ? (
            <div className="py-8 text-center text-gray-400">正在加载发货照片...</div>
          ) : !shipPhotoTarget?.phonePhotos || shipPhotoTarget.phonePhotos.length === 0 ? (
            <div className="py-8 text-center text-gray-400">该发货记录暂无照片</div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 max-h-[520px] overflow-auto">
              {shipPhotoTarget.phonePhotos.map((photo, index) => {
                const url = shipPhotoUrls.find(item => item.fileID === photo)?.tempFileURL || '';
                return (
                  <div key={photo || index} className="border border-gray-200 rounded-lg overflow-hidden bg-white">
                    {url ? (
                      <button
                        type="button"
                        className="block w-full cursor-pointer"
                        onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
                      >
                        <img src={url} alt={`发货照片 ${index + 1}`} className="w-full h-40 object-cover" />
                      </button>
                    ) : (
                      <div className="h-40 flex items-center justify-center text-xs text-gray-400">照片加载失败</div>
                    )}
                    <div className="px-2 py-1 text-xs text-gray-400 truncate">照片 {index + 1}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Dialog>

      {/* 售后回库确认弹窗 */}
      <Dialog
        header="售后回库确认"
        visible={afterSaleInboundVisible}
        onClose={() => { if (!afterSaleInboundUpdatingId) resetAfterSaleInboundDialog(); }}
        width="720px"
        footer={<Button disabled={!!afterSaleInboundUpdatingId} onClick={resetAfterSaleInboundDialog}>关闭</Button>}
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
            <div><span className="text-gray-400">订单客户：</span>{afterSaleInboundTarget?.customerName || '-'}</div>
            <div className="mt-1"><span className="text-gray-400">订单类型：</span>{afterSaleInboundTarget ? getDictLabel(ORDER_TYPE_MAP, afterSaleInboundTarget.orderType) : '-'}</div>
            <div className="mt-1"><span className="text-gray-400">当前归还状态：</span>{afterSaleInboundTarget?.returnStatus ? getDictLabel(RETURN_STATUS_MAP, afterSaleInboundTarget.returnStatus) : '-'}</div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3 items-end">
            <div>
              <label className="block text-xs text-gray-500 mb-1">客户名称</label>
              <Input
                placeholder="使用当前客户名称查询"
                value={afterSaleInboundCustomerName}
                onChange={val => setAfterSaleInboundCustomerName(val as string)}
                onEnter={handleAfterSaleInboundSearch}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">快递单号</label>
              <Input
                placeholder="输入客户寄回快递单号"
                value={afterSaleInboundTrackingNumber}
                onChange={val => setAfterSaleInboundTrackingNumber(val as string)}
                onEnter={handleAfterSaleInboundSearch}
              />
            </div>
            <Button theme="primary" icon={<Search size={16} />} loading={afterSaleInboundLoading} onClick={handleAfterSaleInboundSearch}>
              查询
            </Button>
          </div>

          {afterSaleInboundLoading ? (
            <div className="py-8 text-center text-gray-400">正在查询入库记录...</div>
          ) : afterSaleInboundRecords.length === 0 ? (
            <div className="py-8 text-center text-gray-400">暂无匹配的入库记录</div>
          ) : (
            <div className="max-h-[420px] overflow-auto space-y-2">
              {afterSaleInboundRecords.map((record, index) => (
                <div
                  key={record._id || index}
                  className="w-full border border-gray-200 rounded-lg p-3 hover:border-blue-400 hover:bg-blue-50/40"
                >
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1 text-sm text-gray-800">
                    <div><span className="text-gray-400">入库日期：</span>{formatDate(record.inboundDate, false) || '-'}</div>
                    <div><span className="text-gray-400">客户名称：</span>{record.customerName || '-'}</div>
                    <div><span className="text-gray-400">渠道类型：</span>{dictionaries.getLabel(DICT_CODES.channelType, record.type)}</div>
                    <div><span className="text-gray-400">渠道名称：</span>{record.shopName || '-'}</div>
                    <div><span className="text-gray-400">快递单号：</span><span className="font-medium text-gray-900">{record.trackingNumber || '-'}</span></div>
                    <div><span className="text-gray-400">入库数量：</span>{getTotalQuantity(record) || '-'}</div>
                    <div className="md:col-span-2"><span className="text-gray-400">手机型号：</span>{formatPhoneModels(record.phoneModels)}</div>
                    {record.remark && <div className="md:col-span-2"><span className="text-gray-400">备注：</span>{record.remark}</div>}
                  </div>
                  <div className="flex justify-end mt-3">
                    <Button
                      size="small"
                      theme="primary"
                      loading={afterSaleInboundUpdatingId === record._id}
                      disabled={!!afterSaleInboundUpdatingId && afterSaleInboundUpdatingId !== record._id}
                      onClick={() => handleConfirmAfterSaleInboundRecord(record)}
                    >
                      确认此记录
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-3 text-sm text-blue-700">
            确认后将订单归还状态改为“产品已退回入库”，并把客服备注改为所选入库记录的快递单号。
          </div>
        </div>
      </Dialog>

      {/* 导入预览弹窗 */}
      <Dialog
        header={`确认导入 (${importPreviewData.length} 条订单)`}
        visible={importPreviewVisible}
        onClose={() => { setImportPreviewVisible(false); setImportPreviewData([]); }}
        width="800px"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => { setImportPreviewVisible(false); setImportPreviewData([]); }}>取消</Button>
            <Button theme="primary" loading={importing} onClick={handleImportConfirm}>确认导入</Button>
          </div>
        }
      >
        <div className="max-h-96 overflow-auto">
          <Table
            data={importPreviewData.slice(0, 50)}
            columns={[
              { colKey: 'serialNumber', title: '序号', width: 60 },
              { colKey: 'date', title: '日期', width: 100 },
              { colKey: 'orderType', title: '订单类型', width: 90 },
              { colKey: 'salesChannel', title: '销售渠道', width: 90 },
              { colKey: 'customerName', title: '客户', width: 100 },
              { colKey: 'productName', title: '货品名称', width: 120 },
              { colKey: 'quantity', title: '数量', width: 60 },
              { colKey: 'amount', title: '金额', width: 80 },
              { colKey: 'status', title: '状态', width: 80 },
            ]}
            rowKey="_id"
            tableLayout="fixed"
            size="small"
            stripe
          />
          {importPreviewData.length > 50 && (
            <p className="text-center text-gray-400 text-xs py-2">仅显示前 50 条，共 {importPreviewData.length} 条</p>
          )}
        </div>
      </Dialog>

      {/* 新增订单弹窗 — 6 步向导 */}
      <Dialog
        header="新增订单"
        visible={addVisible}
        onClose={handleRequestCloseAdd}
        width="760px"
        footer={
          <div className="flex justify-between">
            <div>
              {addStep > 1 && (
                <Button variant="outline" icon={<ChevronLeft size={16} />} onClick={handleAddPrev}>上一步</Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button onClick={handleRequestCloseAdd}>取消</Button>
              {addStep < 6 ? (
                <Button theme="primary" icon={<ChevronRight size={16} />} onClick={handleAddNext}>下一步</Button>
              ) : (
                <Button theme="primary" loading={saving} icon={<Check size={16} />} onClick={handleAddSave}>确认提交</Button>
              )}
            </div>
          </div>
        }
      >
        <AddOrderWizard
          step={addStep}
          form={addForm}
          attachFiles={addAttachFiles}
          attachInputRef={addAttachInputRef}
          onChange={setAddForm}
          onAttachFilesChange={setAddAttachFiles}
          dictionaries={wizardDictionaries}
          productModelBrands={productModels.brands}
          productModelLoading={productModels.loading}
          productModelLoadError={productModels.loadError}
        />
      </Dialog>

      {/* 编辑订单弹窗 — 6 步向导 */}
      <Dialog
        header="编辑订单"
        visible={editVisible}
        onClose={() => { setEditVisible(false); setEditStep(1); setEditAttachFiles([]); }}
        width="760px"
        footer={
          <div className="flex justify-between">
            <div>
              {editStep > 1 && (
                <Button variant="outline" icon={<ChevronLeft size={16} />} onClick={handleEditPrev}>上一步</Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button onClick={() => { setEditVisible(false); setEditStep(1); setEditAttachFiles([]); }}>取消</Button>
              {editStep < 6 ? (
                <Button theme="primary" icon={<ChevronRight size={16} />} onClick={handleEditNext}>下一步</Button>
              ) : (
                <Button theme="primary" loading={saving} icon={<Check size={16} />} onClick={handleEditSave}>保存修改</Button>
              )}
            </div>
          </div>
        }
      >
        <AddOrderWizard
          mode="edit"
          step={editStep}
          form={editForm}
          attachFiles={editAttachFiles}
          attachInputRef={editAttachInputRef}
          onChange={setEditForm}
          onAttachFilesChange={setEditAttachFiles}
          dictionaries={wizardDictionaries}
          productModelBrands={productModels.brands}
          productModelLoading={productModels.loading}
          productModelLoadError={productModels.loadError}
        />
      </Dialog>

      {/* 删除确认弹窗 */}
      <Dialog
        header="确认删除"
        visible={deleteConfirmVisible}
        onClose={() => { setDeleteConfirmVisible(false); setDeleteTarget(null); }}
        width="420px"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => { setDeleteConfirmVisible(false); setDeleteTarget(null); }}>取消</Button>
            <Button theme="danger" loading={deleting} onClick={handleDeleteExec}>确认删除</Button>
          </div>
        }
      >
        <p className="text-gray-600">
          确定要删除客户 <span className="font-medium text-gray-900">{deleteTarget?.customerName}</span> 的订单吗？此操作不可撤销。
        </p>
      </Dialog>

      {/* 关闭新增订单确认弹窗 */}
      <Dialog
        header="提示"
        visible={addCloseConfirmVisible}
        onClose={() => setAddCloseConfirmVisible(false)}
        width="420px"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setAddCloseConfirmVisible(false)}>继续填写</Button>
            <Button theme="danger" onClick={handleConfirmCloseAdd}>确认关闭</Button>
          </div>
        }
      >
        <p className="text-gray-600">确定要关闭吗？已填写的信息将不会保存。</p>
      </Dialog>

      {/* 导出引导弹窗 */}
      <Dialog
        header="导出订单"
        visible={exportVisible}
        onClose={() => setExportVisible(false)}
        width="560px"
        footer={null}
      >
        <div className="space-y-4">
          {/* 步骤指示器 */}
          <div className="flex items-center justify-center gap-0 mb-2">
            {[1, 2, 3].map(step => (
              <div key={step} className="flex items-center">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                  step < exportStep ? 'bg-blue-500 text-white' :
                  step === exportStep ? 'bg-blue-500 text-white' :
                  'bg-gray-200 text-gray-500'
                }`}>
                  {step < exportStep ? '✓' : step}
                </div>
                {step < 3 && (
                  <div className={`w-16 h-0.5 mx-1 ${step < exportStep ? 'bg-blue-500' : 'bg-gray-200'}`} />
                )}
              </div>
            ))}
          </div>
          <div className="text-center text-xs text-gray-400 mb-4">
            {['选择日期范围', '选择销售渠道', '选择人员'][exportStep - 1]}
          </div>

          {/* 步骤1：日期范围 */}
          {exportStep === 1 && (
            <div className="space-y-3">
              <p className="text-sm text-gray-500">选择需要导出的订单日期范围，最多支持半年的数据导出。</p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">开始日期 <span className="text-red-500">*</span></label>
                  <input type="date" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
                    value={exportDateStart} onChange={e => setExportDateStart(e.target.value)} />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">结束日期 <span className="text-red-500">*</span></label>
                  <input type="date" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
                    value={exportDateEnd} onChange={e => setExportDateEnd(e.target.value)} />
                </div>
              </div>
              {/* 快捷选项 */}
              <div className="flex gap-2 flex-wrap">
                {([
                  { label: '近1个月', days: 30 },
                  { label: '近3个月', days: 90 },
                  { label: '近半年', days: 183 },
                ] as const).map(opt => (
                  <Button key={opt.days} size="small" variant="outline"
                    onClick={() => {
                      const today = new Date();
                      const end = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
                      const start = new Date(today);
                      start.setDate(start.getDate() - opt.days);
                      setExportDateEnd(end);
                      setExportDateStart(`${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`);
                    }}>
                    {opt.label}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* 步骤2：销售渠道 */}
          {exportStep === 2 && (
            <div className="space-y-3">
              <p className="text-sm text-gray-500">选择需要导出的销售渠道，默认导出所有渠道。</p>
              <div className="grid grid-cols-3 gap-2">
                {Object.keys(SALES_CHANNEL_MAP).map(channel => {
                  const selected = exportChannels.includes(channel);
                  return (
                    <button key={channel} type="button"
                      className={`px-3 py-2 rounded-lg border text-sm ${
                        selected ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                      }`}
                      onClick={() => {
                        setExportChannels(prev =>
                          selected ? prev.filter(c => c !== channel) : [...prev, channel]
                        );
                      }}>
                      {getDictLabel(SALES_CHANNEL_MAP, channel)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 步骤3：人员 */}
          {exportStep === 3 && (
            <div className="space-y-3">
              <p className="text-sm text-gray-500">选择需要导出的人员，默认导出所有人员。</p>
              <div className="grid grid-cols-4 gap-2">
                {SALESPERSONS.map(person => {
                  const selected = exportSalespersons.includes(person);
                  return (
                    <button key={person} type="button"
                      className={`px-3 py-2 rounded-lg border text-sm ${
                        selected ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                      }`}
                      onClick={() => {
                        setExportSalespersons(prev =>
                          selected ? prev.filter(p => p !== person) : [...prev, person]
                        );
                      }}>
                      {person}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 底部按钮 */}
          <div className="flex items-center justify-between pt-4 border-t border-gray-100">
            <div>
              {exportStep > 1 && (
                <Button variant="outline" icon={<ChevronLeft size={14} />}
                  onClick={() => setExportStep(exportStep - 1)}>
                  上一步
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button onClick={() => setExportVisible(false)}>取消</Button>
              {exportStep < 3 ? (
                <Button theme="primary" icon={<ChevronRight size={14} />}
                  onClick={() => {
                    if (exportStep === 1) {
                      const err = validateExportDate();
                      if (err) { MessagePlugin.warning(err); return; }
                    }
                    setExportStep(exportStep + 1);
                  }}>
                  下一步
                </Button>
              ) : (
                <Button theme="primary" icon={<FileDown size={14} />} loading={exporting}
                  onClick={handleExportExec}>
                  导出 Excel
                </Button>
              )}
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

/** 新增订单 6 步向导 */
function AddOrderWizard({
  step, form, attachFiles, attachInputRef, onChange, onAttachFilesChange, dictionaries, productModelBrands, productModelLoading = false, productModelLoadError = '', mode = 'add',
}: {
  step: number;
  form: OrderFormData;
  attachFiles: File[];
  attachInputRef: React.RefObject<HTMLInputElement>;
  onChange: React.Dispatch<React.SetStateAction<OrderFormData>>;
  onAttachFilesChange: React.Dispatch<React.SetStateAction<File[]>>;
  dictionaries: OrderWizardDictionaries;
  productModelBrands: PhoneBrand[];
  productModelLoading?: boolean;
  productModelLoadError?: string;
  mode?: 'add' | 'edit';
}) {
  const {
    ORDER_SOURCE_MAP,
    ORDER_ATTRIBUTE_MAP,
    ORDER_TYPE_MAP,
    SALES_CHANNEL_MAP,
    CHANNEL_CATEGORY_MAP,
    ORDER_STATUS_MAP,
    RETURN_STATUS_MAP,
    SHIPPING_FEE_MAP,
    ORDER_SOURCE_OPTIONS,
    ORDER_ATTRIBUTE_OPTIONS,
    ORDER_TYPE_OPTIONS,
    SALES_CHANNEL_OPTIONS,
    SALESPERSON_OPTIONS,
    PAYMENT_ACCOUNT_OPTIONS,
    ORDER_STATUS_OPTIONS,
    RETURN_STATUS_OPTIONS,
    SHIPPING_FEE_OPTIONS,
  } = dictionaries;
  const [pasteText, setPasteText] = useState('');
  const [parsing, setParsing] = useState(false);
  const runtimeProductBrandMap = useMemo(() => {
    return Object.fromEntries(
      productModelBrands
        .filter(brand => brand.enabled !== false)
        .map(brand => [brand.brand, brand])
    ) as Record<string, PhoneBrand>;
  }, [productModelBrands]);
  const brandOptions = useMemo(() => {
    return [
      PLACEHOLDER_OPTION,
      ...productModelBrands
        .filter(brand => brand.enabled !== false)
        .sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.brand.localeCompare(b.brand, 'zh-CN'))
        .map(brand => ({ label: getBrandLabel(brand.brand), value: brand.brand })),
    ];
  }, [productModelBrands]);
  const getCatalogProductsByBrand = useCallback((brand: string) => {
    const runtimeBrand = runtimeProductBrandMap[brand];
    if (runtimeBrand) {
      return (runtimeBrand.products || [])
        .filter(product => product.enabled !== false)
        .sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name, 'zh-CN'))
        .map(product => product.name);
    }
    return [];
  }, [runtimeProductBrandMap]);
  const getCatalogSpecsByProduct = useCallback((brand: string, productName: string) => {
    const runtimeProduct = runtimeProductBrandMap[brand]?.products?.find(product => product.name === productName);
    if (runtimeProduct) {
      return (runtimeProduct.specs || [])
        .filter(spec => spec.enabled !== false)
        .sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name, 'zh-CN'))
        .map(spec => spec.name);
    }
    return [];
  }, [runtimeProductBrandMap]);
  const updateField = useCallback(<K extends keyof OrderFormData>(key: K, val: OrderFormData[K]) => {
    onChange(prev => ({ ...prev, [key]: val }));
  }, [onChange]);
  const updateProduct = useCallback((index: number, patch: Partial<ProductItem>) => {
    onChange(prev => {
      const products = [...prev.products];
      products[index] = { ...products[index], ...patch };
      const cleanedProducts = clearHiddenProductPaymentFields({ ...prev, products });
      return applyVirtualProductStatus(prev, cleanedProducts);
    });
  }, [onChange]);
  const addProduct = useCallback(() => {
    onChange(prev => applyVirtualProductStatus(prev, [...prev.products, { ...EMPTY_PRODUCT }]));
  }, [onChange]);
  const removeProduct = useCallback((index: number) => {
    onChange(prev => {
      if (prev.products.length <= 1) return prev;
      return applyVirtualProductStatus(prev, prev.products.filter((_, i) => i !== index));
    });
  }, [onChange]);
  const updateProductPaymentSplits = useCallback((index: number, splits: PaymentSplit[]) => {
    const cleanedSplits = splits.map(split => ({
      account: split.account,
      amount: Math.max(0, Number(split.amount) || 0),
    }));
    updateProduct(index, {
      paymentSplits: cleanedSplits,
      paymentAccount: getPaymentAccountValue(cleanedSplits),
    });
  }, [updateProduct]);
  const addProductPaymentSplit = useCallback((index: number) => {
    const product = form.products[index];
    updateProductPaymentSplits(index, [...getEditablePaymentSplits(product), { account: '', amount: 0 }]);
  }, [form.products, updateProductPaymentSplits]);
  const removeProductPaymentSplit = useCallback((index: number, splitIndex: number) => {
    const product = form.products[index];
    const nextSplits = getEditablePaymentSplits(product).filter((_, i) => i !== splitIndex);
    updateProductPaymentSplits(index, nextSplits.length > 0 ? nextSplits : [{ account: '', amount: product.amount || 0 }]);
  }, [form.products, updateProductPaymentSplits]);

  // 转租赁2货品 CRUD
  const updateTransferProduct = useCallback((index: number, patch: Partial<TransferProductItem>) => {
    onChange(prev => {
      const transferProducts = [...prev.transferProducts];
      transferProducts[index] = { ...transferProducts[index], ...patch };
      return { ...prev, transferProducts };
    });
  }, [onChange]);
  const addTransferProduct = useCallback(() => {
    onChange(prev => ({ ...prev, transferProducts: [...prev.transferProducts, { ...EMPTY_TRANSFER_PRODUCT }] }));
  }, [onChange]);
  const removeTransferProduct = useCallback((index: number) => {
    onChange(prev => {
      return { ...prev, transferProducts: prev.transferProducts.filter((_, i) => i !== index) };
    });
  }, [onChange]);

  // 产品级联 options（支持订单类型→虚拟产品过滤）
  const productOptionsMap = useMemo(() => {
    const cache: Record<string, { label: string; value: string }[]> = {};
    for (const p of form.products) {
      if (p.brand && !cache[p.brand]) {
        let products = getCatalogProductsByBrand(p.brand);
        // 虚拟产品/无 品牌下根据订单类型过滤（仅租赁1生效）
        if ((p.brand === '虚拟产品' || p.brand === '无') && form.orderAttribute === 'rental1' && form.orderType && ORDER_TYPE_VIRTUAL_PRODUCTS[form.orderType]) {
          const allowed = new Set(ORDER_TYPE_VIRTUAL_PRODUCTS[form.orderType]!);
          products = products.filter(name => allowed.has(name));
        }
        cache[p.brand] = [PLACEHOLDER_OPTION, ...products.map(v => ({ label: getProductLabel(v), value: v }))];
      }
    }
    return cache;
  }, [form.products.map(p => p.brand).join(','), form.orderType, form.orderAttribute, getCatalogProductsByBrand]);
  const specOptionsMap = useMemo(() => {
    const cache: Record<string, { label: string; value: string }[]> = {};
    for (const p of form.products) {
      const key = `${p.brand}|${p.productName}`;
      if (p.brand && p.productName && !cache[key]) {
        cache[key] = [PLACEHOLDER_OPTION, ...getCatalogSpecsByProduct(p.brand, p.productName).map(v => ({ label: v, value: v }))];
      }
    }
    return cache;
  }, [form.products.map(p => `${p.brand}|${p.productName}`).join(','), getCatalogSpecsByProduct]);

  // 转租赁级联 options（按索引缓存各组）
  const transferProductOptionsMap = useMemo(() => {
    const cache: Record<string, { label: string; value: string }[]> = {};
    for (const t of form.transferProducts) {
      if (t.brand && !cache[t.brand]) {
        cache[t.brand] = [PLACEHOLDER_OPTION, ...getCatalogProductsByBrand(t.brand).map(v => ({ label: getProductLabel(v), value: v }))];
      }
    }
    return cache;
  }, [form.transferProducts.map(t => t.brand).join(','), getCatalogProductsByBrand]);
  const transferSpecOptionsMap = useMemo(() => {
    const cache: Record<string, { label: string; value: string }[]> = {};
    for (const t of form.transferProducts) {
      const key = `${t.brand}|${t.productName}`;
      if (t.brand && t.productName && !cache[key]) {
        cache[key] = [PLACEHOLDER_OPTION, ...getCatalogSpecsByProduct(t.brand, t.productName).map(v => ({ label: v, value: v }))];
      }
    }
    return cache;
  }, [form.transferProducts.map(t => `${t.brand}|${t.productName}`).join(','), getCatalogSpecsByProduct]);
  // 订单类型选项（根据订单来源过滤）
  const filteredOrderTypeOptions = useMemo(() => {
    if (!form.orderSource || !ORDER_SOURCE_ORDER_TYPE_MAP[form.orderSource]) {
      return ORDER_TYPE_OPTIONS;
    }
    const allowed = new Set(ORDER_SOURCE_ORDER_TYPE_MAP[form.orderSource]!);
    return ORDER_TYPE_OPTIONS.filter(o => !o.value || allowed.has(o.value));
  }, [form.orderSource, ORDER_TYPE_OPTIONS]);

  // 是否有货品名称为「部分转租赁2」或「全部转租赁2」
  const hasTransferProduct = useMemo(() => {
    return form.products.some(p => p.productName === '部分转租赁2' || p.productName === '全部转租赁2');
  }, [form.products.map(p => p.productName).join(',')]);

  // 是否显示归还状态（订单类型为租后发货或租后退货时）
  const showReturnStatus = useMemo(() => {
    return form.orderType === 'postRentalShip' || form.orderType === 'postRentalReturn';
  }, [form.orderType]);

  const virtualProductOrder = useMemo(() => {
    return isVirtualProductOrder(form.products);
  }, [form.products.map(p => p.brand).join(',')]);

  useEffect(() => {
    if (!virtualProductOrder || form.status === 'noShip') return;
    onChange(prev => {
      if (!isVirtualProductOrder(prev.products) || prev.status === 'noShip') return prev;
      return { ...prev, status: 'noShip', shippingFee: '', trackingNumber: '' };
    });
  }, [form.status, onChange, virtualProductOrder]);

  // 当 hasTransferProduct 变为 true 且 transferProducts 为空时，自动添加一组默认条目
  useEffect(() => {
    if (hasTransferProduct && form.transferProducts.length === 0) {
      onChange(prev => ({ ...prev, transferProducts: [{ ...EMPTY_TRANSFER_PRODUCT }] }));
    }
  }, [hasTransferProduct]);

  const handleSmartParse = useCallback(async () => {
    if (!pasteText.trim()) { MessagePlugin.warning('请先粘贴收件人信息'); return; }
    setParsing(true);
    try {
      const result = await parseConsigneeInfo(pasteText.trim());
      if (result) {
        onChange(prev => ({ ...prev, consignee: result.name || prev.consignee, consigneePhone: result.phone || prev.consigneePhone, consigneeAddress: result.address || prev.consigneeAddress }));
        setPasteText('');
        MessagePlugin.success('识别成功');
      } else { MessagePlugin.warning('未能识别出收件人信息，请手动填写'); }
    } catch (err: any) { MessagePlugin.error(String(err?.message || err)); }
    finally { setParsing(false); }
  }, [pasteText, onChange]);

  const stepLabels = ['基础信息', '订单属性', '货品信息', '收件人信息', '备注 & 附件', '确认预览'];

  return (
    <div className="space-y-4">
      {/* 步骤指示器 */}
      <div className="flex items-center justify-center gap-0 mb-2">
        {stepLabels.map((label, i) => (
          <div key={i} className="flex items-center">
            <div className="flex flex-col items-center">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                step > i + 1 ? 'bg-blue-500 text-white' : step === i + 1 ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-500'
              }`}>
                {step > i + 1 ? <Check size={16} /> : i + 1}
              </div>
              <span className={`text-xs mt-1 ${step >= i + 1 ? 'text-blue-600 font-medium' : 'text-gray-400'}`}>{label}</span>
            </div>
            {i < stepLabels.length - 1 && (
              <div className={`w-10 h-0.5 mx-1 mb-4 ${step > i + 1 ? 'bg-blue-500' : 'bg-gray-200'}`} />
            )}
          </div>
        ))}
      </div>

      {/* ========== Step 1：基础信息 ========== */}
      {step === 1 && (
        <div className="py-4">
          <h4 className="text-sm font-medium text-gray-600 mb-4">填写基础信息</h4>
          <div className="order-basic-form-grid grid grid-cols-2 gap-3">
            <div className="order-basic-form-field">
              <label className="block text-xs text-gray-500 mb-1">日期 <span className="text-red-500">*</span></label>
              <input type="date" className="order-basic-date-input w-full px-3 border border-gray-300 text-sm focus:outline-none focus:border-blue-500"
                value={form.date} onChange={e => updateField('date', e.target.value)} />
            </div>
            <div className="order-basic-form-field">
              <label className="block text-xs text-gray-500 mb-1">客户名称 <span className="text-red-500">*</span></label>
              <Input placeholder="请输入客户名称"
                value={form.customerName} onChange={val => updateField('customerName', val as string)} />
            </div>
            <div className="order-basic-form-field">
              <label className="block text-xs text-gray-500 mb-1">销售人员 <span className="text-red-500">*</span></label>
              <Select placeholder="请选择" value={form.salesperson || ''} onChange={val => updateField('salesperson', val as string)} options={SALESPERSON_OPTIONS} />
            </div>
          </div>
        </div>
      )}

      {/* ========== Step 2：订单属性 ========== */}
      {step === 2 && (
        <div className="py-4">
          <h4 className="text-sm font-medium text-gray-600 mb-4">填写订单属性</h4>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">订单来源 <span className="text-red-500">*</span></label>
              <Select placeholder="请选择" value={form.orderSource || ''} onChange={val => {
                const newSource = val as string;
                onChange(prev => {
                  const updated = { ...prev, orderSource: newSource };
                  // 切换订单来源时，若当前订单类型不在新来源允许范围内，清空
                  if (newSource && ORDER_SOURCE_ORDER_TYPE_MAP[newSource]) {
                    const allowed = new Set(ORDER_SOURCE_ORDER_TYPE_MAP[newSource]!);
                    if (prev.orderType && !allowed.has(prev.orderType)) {
                      updated.orderType = '';
                    }
                  }
                  updated.products = clearHiddenProductPaymentFields({ ...updated, products: prev.products });
                  return updated;
                });
              }} options={ORDER_SOURCE_OPTIONS} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">订单属性 <span className="text-red-500">*</span></label>
              <Select placeholder="请选择" value={form.orderAttribute || ''} onChange={val => {
                const newAttribute = val as string;
                onChange(prev => {
                  const updated = { ...prev, orderAttribute: newAttribute };
                  updated.products = clearHiddenProductPaymentFields({ ...updated, products: prev.products });
                  return updated;
                });
              }} options={ORDER_ATTRIBUTE_OPTIONS} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">订单类型</label>
              <Select placeholder="请选择" value={form.orderType || ''} onChange={val => {
                const newType = val as string;
                onChange(prev => {
                  const updated = { ...prev, orderType: newType };
                  // 如果当前有虚拟产品/无品牌的货品，且货品名称不在新订单类型白名单内，清空选择（仅租赁1生效）
                  if (newType && prev.orderAttribute === 'rental1' && ORDER_TYPE_VIRTUAL_PRODUCTS[newType]) {
                    const allowed = new Set(ORDER_TYPE_VIRTUAL_PRODUCTS[newType]!);
                    updated.products = prev.products.map(p => {
                      if ((p.brand === '虚拟产品' || p.brand === '无') && p.productName && !allowed.has(p.productName)) {
                        return { ...p, productName: '', specification: '' };
                      }
                      return p;
                    });
                  }
                  updated.products = clearHiddenProductPaymentFields({ ...updated, products: updated.products || prev.products });
                  // 订单类型联动「需要出库」默认值并驱动订单状态（用户后续可在收件人信息步手动改）
                  return applyNeedsOutbound(updated, defaultNeedsOutbound(newType, updated.products));
                });
              }} options={filteredOrderTypeOptions} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">销售渠道 <span className="text-red-500">*</span></label>
              <Select placeholder="请选择" value={form.salesChannel || ''} onChange={val => {
                const channel = val as string;
                const category = calcChannelCategory(channel);
                const updates: Partial<OrderFormData> = { salesChannel: channel, channelCategory: category };
                if (category === 'offline') updates.onlineOrderNumber = '';
                onChange(prev => ({ ...prev, ...updates }));
              }} options={SALES_CHANNEL_OPTIONS} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">渠道类别</label>
              <Input value={form.channelCategory ? (CHANNEL_CATEGORY_MAP as Record<string, string>)[form.channelCategory] || form.channelCategory : ''} readOnly className="bg-gray-50" />
            </div>
            {form.channelCategory === 'platform' && (
              <div>
                <label className="block text-xs text-gray-500 mb-1">网店订单号 <span className="text-red-500">*</span></label>
                <Input placeholder="请填写网店订单号"
                  value={form.onlineOrderNumber} onChange={val => updateField('onlineOrderNumber', val as string)} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========== Step 3：货品信息 ========== */}
      {step === 3 && (
        <div className="py-4 max-h-[55vh] overflow-auto px-1">
          {(productModelLoading || productModelLoadError || brandOptions.length <= 1) && (
            <div className={`mb-3 rounded border px-3 py-2 text-sm ${
              productModelLoadError ? 'border-red-200 bg-red-50 text-red-600' : 'border-amber-200 bg-amber-50 text-amber-700'
            }`}>
              {productModelLoading
                ? '正在加载云端型号字典...'
                : productModelLoadError || '云端型号字典暂无数据，请先在型号管理中初始化或维护品牌、货品和规格'}
            </div>
          )}
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-medium text-gray-600">填写货品信息</h4>
            <Button size="small" variant="outline" icon={<Plus size={14} />} onClick={addProduct}>添加货品</Button>
          </div>
          {form.products.map((product, idx) => (
            (() => {
              const shouldShowPaymentFields = shouldShowProductPaymentFields(form.orderSource, form.orderType, form.orderAttribute, product.brand);
              return (
                <div key={idx} className={`${idx > 0 ? 'mt-3 pt-3 border-t border-gray-200' : ''} mb-3`}>
                  {form.products.length > 1 && (
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-gray-400">货品 {idx + 1}</span>
                      <Button size="small" variant="text" theme="danger" icon={<Minus size={14} />} onClick={() => removeProduct(idx)}>删除</Button>
                    </div>
                  )}
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">品牌 <span className="text-red-500">*</span></label>
                      <Select placeholder="请选择品牌" value={product.brand || ''}
                        onChange={val => updateProduct(idx, { brand: val as string, productName: '', specification: '' })}
                        options={brandOptions} filterable disabled={productModelLoading || !!productModelLoadError || brandOptions.length <= 1} />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">货品名称 <span className="text-red-500">*</span></label>
                      <Select placeholder="请先选择品牌" value={product.productName || ''}
                        onChange={val => updateProduct(idx, { productName: val as string, specification: '' })}
                        options={productOptionsMap[product.brand] || [PLACEHOLDER_OPTION]} filterable />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">规格 <span className="text-red-500">*</span></label>
                      <Select placeholder="请先选择货品" value={product.specification || ''}
                        onChange={val => updateProduct(idx, { specification: val as string })}
                        options={specOptionsMap[`${product.brand}|${product.productName}`] || [PLACEHOLDER_OPTION]} />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">数量 <span className="text-red-500">*</span></label>
                      <Input type="number" placeholder="数量"
                        value={product.quantity ? String(product.quantity) : ''} onChange={val => {
                          const q = Math.max(0, Number(val));
                          const amount = q * product.unitPrice;
                          updateProduct(idx, { quantity: q, amount, paymentSplits: syncSinglePaymentSplitAmount(product, amount) });
                        }} />
                    </div>
                    {shouldShowPaymentFields && (
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">单价 <span className="text-red-500">*</span></label>
                        <Input type="number" placeholder="单价"
                          value={product.unitPrice ? String(product.unitPrice) : ''} onChange={val => {
                            const p = Math.max(0, Number(val));
                            const amount = product.quantity * p;
                            updateProduct(idx, { unitPrice: p, amount, paymentSplits: syncSinglePaymentSplitAmount(product, amount) });
                          }} />
                      </div>
                    )}
                    {shouldShowPaymentFields && (
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">金额</label>
                        <Input type="number" placeholder="自动计算"
                          value={product.amount ? String(product.amount) : ''} readOnly />
                      </div>
                    )}
                    {shouldShowPaymentFields && (
                      <div className="grid grid-cols-1 gap-2 md:col-span-3">
                        <div className="flex items-center justify-between">
                          <label className="block text-xs text-gray-500">收款账户 <span className="text-red-500">*</span></label>
                          <Button size="small" variant="outline" icon={<Plus size={14} />} onClick={() => addProductPaymentSplit(idx)}>添加收款</Button>
                        </div>
                        {getEditablePaymentSplits(product).map((split, splitIndex) => {
                          const splits = getEditablePaymentSplits(product);
                          const splitTotal = splits.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
                          const diff = (product.amount || 0) - splitTotal;
                          return (
                            <div key={splitIndex} className="grid grid-cols-[1fr_160px_36px] items-center gap-2">
                              <Select placeholder="请选择收款账户" value={split.account || ''}
                                onChange={val => {
                                  const nextSplits = [...splits];
                                  nextSplits[splitIndex] = { ...nextSplits[splitIndex], account: val as string };
                                  updateProductPaymentSplits(idx, nextSplits);
                                }} options={PAYMENT_ACCOUNT_OPTIONS} />
                              <Input type="number" placeholder="金额" value={split.amount ? String(split.amount) : ''}
                                onChange={val => {
                                  const nextSplits = [...splits];
                                  nextSplits[splitIndex] = { ...nextSplits[splitIndex], amount: Math.max(0, Number(val) || 0) };
                                  updateProductPaymentSplits(idx, nextSplits);
                                }} />
                              <Button size="small" variant="text" theme="danger" icon={<Minus size={14} />} disabled={splits.length <= 1} onClick={() => removeProductPaymentSplit(idx, splitIndex)} />
                              {splitIndex === splits.length - 1 && (
                                <div className={`col-span-3 text-xs ${Math.abs(diff) < 0.01 ? 'text-gray-400' : 'text-red-500'}`}>
                                  收款合计 ¥{splitTotal || 0}，货品金额 ¥{product.amount || 0}{Math.abs(diff) >= 0.01 ? `，差额 ¥${diff}` : ''}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()
          ))}

          {/* 条件显示的转租赁字段 */}
          {hasTransferProduct && (
            <div className="mt-4 pt-4 border-t-2 border-blue-200">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-medium text-blue-600">📦 转租赁2 信息</h4>
                <Button size="small" variant="outline" icon={<Plus size={14} />} onClick={addTransferProduct}>添加一组</Button>
              </div>
              {form.transferProducts.map((tp, tIdx) => (
                <div key={tIdx} className={`${tIdx > 0 ? 'mt-3 pt-3 border-t border-blue-100' : ''} mb-3`}>
                  {form.transferProducts.length > 1 && (
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-blue-400">第 {tIdx + 1} 组</span>
                      <Button size="small" variant="text" theme="danger" icon={<Minus size={14} />} onClick={() => removeTransferProduct(tIdx)}>删除</Button>
                    </div>
                  )}
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">品牌 <span className="text-red-500">*</span></label>
                      <Select placeholder="请选择品牌" value={tp.brand || ''}
                        onChange={val => updateTransferProduct(tIdx, { brand: val as string, productName: '', specification: '' })}
                        options={brandOptions} filterable disabled={productModelLoading || !!productModelLoadError || brandOptions.length <= 1} />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">货品名称 <span className="text-red-500">*</span></label>
                      <Select placeholder="请先选择品牌" value={tp.productName || ''}
                        onChange={val => updateTransferProduct(tIdx, { productName: val as string, specification: '' })}
                        options={transferProductOptionsMap[tp.brand] || [PLACEHOLDER_OPTION]} filterable />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">规格 <span className="text-red-500">*</span></label>
                      <Select placeholder="请先选择货品" value={tp.specification || ''}
                        onChange={val => updateTransferProduct(tIdx, { specification: val as string })}
                        options={transferSpecOptionsMap[`${tp.brand}|${tp.productName}`] || [PLACEHOLDER_OPTION]} />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">已交租期 <span className="text-red-500">*</span></label>
                      <Input type="number" placeholder="已交租期"
                        value={tp.paidPeriod ? String(tp.paidPeriod) : ''} onChange={val => updateTransferProduct(tIdx, { paidPeriod: Math.max(0, Number(val)) })} />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">已交租金 <span className="text-red-500">*</span></label>
                      <Input type="number" placeholder="已交租金"
                        value={tp.paidRent ? String(tp.paidRent) : ''} onChange={val => updateTransferProduct(tIdx, { paidRent: Math.max(0, Number(val)) })} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ========== Step 4：收件人信息 ========== */}
      {step === 4 && (
        <div className="py-4">
          <h4 className="text-sm font-medium text-gray-600 mb-4">收件人信息</h4>

          {/* 是否需要出库（驱动订单状态） */}
          <div className="mb-4 p-3 rounded-lg border border-gray-200 bg-gray-50">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-gray-700">需要出库</div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {virtualProductOrder
                    ? '虚拟货品单，无需出库（订单状态：不用发货）'
                    : (form.needsOutbound
                      ? '需生成出库单发货（订单状态：未发货）'
                      : '无需出库（订单状态：不用发货）')}
                </div>
              </div>
              <Switch
                value={!!form.needsOutbound}
                disabled={virtualProductOrder}
                onChange={val => onChange(prev => applyNeedsOutbound(prev, !!val))}
              />
            </div>
          </div>

          {form.needsOutbound ? (
            <>
              <div className="mb-3 p-3 bg-blue-50/50 rounded-lg border border-blue-100">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs text-blue-600 font-medium">🧠 粘贴识别</span>
                  <span className="text-xs text-gray-400">粘贴包含姓名、电话、地址的文本，AI 自动识别填入</span>
                </div>
                <div className="flex gap-2">
                  <Textarea placeholder="例：张三 13800138000 北京市朝阳区建国路88号" value={pasteText}
                    onChange={val => setPasteText(val as string)} autosize={{ minRows: 1, maxRows: 3 }} className="flex-1" />
                  <Button theme="primary" size="small" loading={parsing} onClick={handleSmartParse}>识别</Button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">收货人名称</label>
                  <Input placeholder="收货人名称"
                    value={form.consignee} onChange={val => updateField('consignee', val as string)} />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">收货人电话</label>
                  <Input placeholder="收货人电话"
                    value={form.consigneePhone} onChange={val => updateField('consigneePhone', val as string)} />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-gray-500 mb-1">收货人地址</label>
                  <Input placeholder="收货人地址"
                    value={form.consigneeAddress} onChange={val => updateField('consigneeAddress', val as string)} />
                </div>
              </div>
            </>
          ) : (
            <div className="text-xs text-gray-400 p-3">该订单无需出库，无需填写收件人信息。</div>
          )}
        </div>
      )}

      {/* ========== Step 5：备注 & 附件 ========== */}
      {step === 5 && (
        <div className="py-4">
          <div className="mb-4">
            <h4 className="text-sm font-medium text-gray-600 mb-4">备注信息</h4>
            <div>
              <label className="block text-xs text-gray-500 mb-1">客服备注</label>
              <Textarea placeholder="客服备注" value={form.customerRemark}
                onChange={val => updateField('customerRemark', val as string)} autosize={{ minRows: 2, maxRows: 5 }} />
            </div>
          </div>

          {/* 归还状态：租后发货/租后退货时显示 */}
          {showReturnStatus && (
            <div className="mb-4 p-3 bg-orange-50/50 rounded-lg border border-orange-200">
              <h4 className="text-sm font-medium text-orange-600 mb-3">📦 归还状态</h4>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">归还状态 <span className="text-red-500">*</span></label>
                  <Select placeholder="请选择归还状态" value={form.returnStatus || ''}
                    onChange={val => updateField('returnStatus', val as string)}
                    options={RETURN_STATUS_OPTIONS} />
                </div>
                {form.returnStatus === 'inTransit' && (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">归还物流单号 <span className="text-red-500">*</span></label>
                    <Input placeholder="多个单号请用逗号或空格分隔，如：SF1234567890, YT9876543210"
                      value={form.returnTrackingNumbers}
                      onChange={val => updateField('returnTrackingNumbers', val as string)} />
                    <p className="text-xs text-gray-400 mt-1">多个单号请用逗号或空格分隔</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {mode === 'edit' && form.attachments && form.attachments.length > 0 && (
            <div className="mb-4">
              <h4 className="text-sm font-medium text-gray-600 mb-3">已有附件</h4>
              <div className="space-y-2">
                {form.attachments.map((att, index) => (
                  <div key={index} className="flex items-center justify-between px-3 py-2 bg-blue-50 rounded-lg">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <FileDown size={14} className="text-blue-400 flex-shrink-0" />
                      <span className="text-sm text-gray-700 truncate">{att.fileName}</span>
                    </div>
                    <button type="button" className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-red-500 cursor-pointer flex-shrink-0"
                      onClick={() => onChange(prev => ({ ...prev, attachments: prev.attachments.filter((_, i) => i !== index) }))}>
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div>
            <h4 className="text-sm font-medium text-gray-600 mb-3">附件上传</h4>
            <div className="mb-3">
              <input ref={attachInputRef} type="file" multiple className="hidden"
                title="上传订单附件"
                aria-label="上传订单附件"
                onChange={(e) => {
                  const files = e.target.files;
                  if (files) onAttachFilesChange(prev => [...prev, ...Array.from(files)]);
                  if (attachInputRef.current) attachInputRef.current.value = '';
                }} />
              <Button variant="outline" icon={<Upload size={16} />} onClick={() => attachInputRef.current?.click()}>
                选择附件
              </Button>
              <span className="text-xs text-gray-400 ml-2">支持图片、PDF、Word、Excel等文件</span>
            </div>
            {attachFiles.length > 0 && (
              <div className="space-y-2">
                {attachFiles.map((file, index) => (
                  <div key={index} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <Upload size={14} className="text-gray-400 flex-shrink-0" />
                      <span className="text-sm text-gray-700 truncate">{file.name}</span>
                      <span className="text-xs text-gray-400 flex-shrink-0">({(file.size / 1024).toFixed(1)}KB)</span>
                    </div>
                    <button type="button" className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-red-500 cursor-pointer flex-shrink-0"
                      onClick={() => onAttachFilesChange(prev => prev.filter((_, i) => i !== index))}>
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========== Step 6：确认预览 ========== */}
      {step === 6 && (
        <div>
          <h4 className="text-sm font-medium text-gray-600 mb-3">请确认以下信息无误后提交</h4>
          <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm max-h-[50vh] overflow-auto">
            <PreviewSection title="基础信息">
              <PreviewItem label="日期" value={form.date} />
              <PreviewItem label="客户名称" value={form.customerName} />
              <PreviewItem label="销售人员" value={form.salesperson} />
            </PreviewSection>
            <PreviewSection title="订单属性">
              <PreviewItem label="订单来源" value={getDictLabel(ORDER_SOURCE_MAP, form.orderSource)} />
              <PreviewItem label="订单属性" value={getDictLabel(ORDER_ATTRIBUTE_MAP, form.orderAttribute)} />
              <PreviewItem label="订单类型" value={getDictLabel(ORDER_TYPE_MAP, form.orderType)} />
              <PreviewItem label="销售渠道" value={getDictLabel(SALES_CHANNEL_MAP, form.salesChannel)} />
              <PreviewItem label="渠道类别" value={getDictLabel(CHANNEL_CATEGORY_MAP, form.channelCategory)} />
              {form.channelCategory === 'platform' && <PreviewItem label="网店订单号" value={form.onlineOrderNumber} />}
            </PreviewSection>
            <PreviewSection title="货品信息">
              {form.products.map((p, i) => {
                const shouldShowPaymentFields = shouldShowProductPaymentFields(form.orderSource, form.orderType, form.orderAttribute, p.brand);
                return (
                  <div key={i} className="text-xs text-gray-600 ml-2 border-l-2 border-blue-200 pl-2 mb-1">
                    货品{i + 1}：{p.brand ? getBrandLabel(p.brand) : '-'} / {p.productName ? getProductLabel(p.productName) : '-'} / {p.specification || '-'}，
                    数量 {p.quantity || 0}{shouldShowPaymentFields ? `，单价 ¥${p.unitPrice || 0}，金额 ¥${p.amount || 0}，收款账户 ${formatPaymentSplits(p as unknown as OrderRecord)}` : ''}
                  </div>
                );
              })}
            </PreviewSection>
            {hasTransferProduct && form.transferProducts.length > 0 && (
              <PreviewSection title="转租赁2 信息">
                {form.transferProducts.map((t, i) => (
                  <div key={i} className="text-xs text-gray-600 ml-2 border-l-2 border-blue-200 pl-2 mb-1">
                    {form.transferProducts.length > 1 && <span className="text-blue-500 font-medium">第{i + 1}组：</span>}
                    {t.brand ? getBrandLabel(t.brand) : '-'} / {t.productName ? getProductLabel(t.productName) : '-'} / {t.specification || '-'}，
                    已交租期 {t.paidPeriod || 0}，已交租金 ¥{t.paidRent || 0}
                  </div>
                ))}
              </PreviewSection>
            )}
            <PreviewSection title="收件人信息">
              <PreviewItem label="收货人名称" value={form.consignee} />
              <PreviewItem label="收货人电话" value={form.consigneePhone} />
              <PreviewItem label="收货人地址" value={form.consigneeAddress} />
              {form.status === 'shipped' && <PreviewItem label="邮寄结算方式" value={getDictLabel(SHIPPING_FEE_MAP, form.shippingFee)} />}
              {form.status === 'shipped' && <PreviewItem label="物流单号" value={form.trackingNumber} />}
              <PreviewItem label="订单状态" value={getDictLabel(ORDER_STATUS_MAP, form.status)} />
            </PreviewSection>
            {showReturnStatus && form.returnStatus && (
              <PreviewSection title="归还状态">
                <PreviewItem label="归还状态" value={getDictLabel(RETURN_STATUS_MAP, form.returnStatus)} />
                {form.returnStatus === 'inTransit' && (
                  <PreviewItem label="归还物流单号" value={form.returnTrackingNumbers || '-'} />
                )}
              </PreviewSection>
            )}
            <PreviewSection title="备注 & 附件">
              <PreviewItem label="客服备注" value={form.customerRemark} />
              <PreviewItem label="附件" value={
                mode === 'edit'
                  ? [...form.attachments.map(a => a.fileName), ...attachFiles.map(f => f.name)].join(', ') || '无'
                  : attachFiles.length > 0 ? attachFiles.map(f => f.name).join(', ') : '无'
              } />
            </PreviewSection>
          </div>
        </div>
      )}

    </div>
  );
}

function PreviewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <h5 className="text-xs font-medium text-gray-500 mb-1 uppercase tracking-wide">{title}</h5>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function PreviewItem({ label, value }: { label: string; value: React.ReactNode }) {
  const display = value === undefined || value === null || value === '' ? '-' : value;
  return (
    <div className="flex gap-2">
      <span className="text-gray-400 w-20 flex-shrink-0 text-right">{label}</span>
      <span className="text-gray-700">{display}</span>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  const display = value === undefined || value === null || value === '' || value === 0 ? '-' : value;
  return (
    <div className="flex py-1.5 border-b border-gray-50">
      <span className="w-32 text-gray-500 flex-shrink-0">{label}</span>
      <div className="text-gray-800">{display}</div>
    </div>
  );
}
