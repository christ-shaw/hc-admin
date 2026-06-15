import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { Table, Button, Input, Select, Tag, Dialog, MessagePlugin, Textarea } from 'tdesign-react';
import { Search, RotateCcw, Upload, Download, Plus, Pencil, Trash2, Minus, X, ChevronRight, ChevronLeft, FileDown, Check } from 'lucide-react';
import { OrderRecord, OrderFilters, OutboundRecord, ORDER_TYPE_MAP, ORDER_SOURCE_MAP, ORDER_ATTRIBUTE_MAP, SALES_CHANNEL_MAP, ORDER_STATUS_MAP, CHANNEL_CATEGORY_MAP, SHIPPING_FEE_MAP, ProductItem, TransferProductItem, OrderAttachment, dictToOptions, getDictLabel } from '../types';
import { useOrders } from '../hooks/useOrders';
import { formatDate } from '../utils/format';
import { parseOrderExcel, exportOrderExcel } from '../utils/orderExcel';
import { BRANDS, getBrandLabel, getProductLabel, getProductsByBrand, getSpecsByProduct, PAYMENT_ACCOUNTS, SALESPERSONS } from '../data/dict';
import { parseConsigneeInfo, callFunction, getCurrentOperatorName, uploadToCloudStorage } from '../lib/cloudbase';

/** ========== 预计算静态 options（模块级常量，避免每次渲染重建） ========== */
const PLACEHOLDER_OPTION = { label: '请选择', value: '' };

const ORDER_SOURCE_OPTIONS = [PLACEHOLDER_OPTION, ...dictToOptions(ORDER_SOURCE_MAP)];
const ORDER_ATTRIBUTE_OPTIONS = [PLACEHOLDER_OPTION, ...dictToOptions(ORDER_ATTRIBUTE_MAP)];
const ORDER_TYPE_OPTIONS = [PLACEHOLDER_OPTION, ...dictToOptions(ORDER_TYPE_MAP)];
const SALES_CHANNEL_OPTIONS = [PLACEHOLDER_OPTION, ...dictToOptions(SALES_CHANNEL_MAP)];
const CHANNEL_CATEGORY_OPTIONS = [PLACEHOLDER_OPTION, ...dictToOptions(CHANNEL_CATEGORY_MAP)];
const SALESPERSON_OPTIONS = [PLACEHOLDER_OPTION, ...SALESPERSONS.map(v => ({ label: v, value: v }))];

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
  postRentalPayment: ['补收差价', '仅退款', '维修费', '快递费'],
  deposit: ['收押金', '退押金'],
};

/** 订单来源 → 可选订单类型白名单 */
const ORDER_SOURCE_ORDER_TYPE_MAP: Partial<Record<string, string[]>> = {
  new: ['newBusiness'],
  service: ['postRentalShip', 'postRentalReturn', 'postRentalPayment', 'deposit'],
};

/** 归还状态字典（租后发货/租后退货时使用） */
const RETURN_STATUS_MAP = {
  returned: '产品已退回入库',
  inTransit: '产品运输途中',
  notReturned: '客户未退回',
} as const;
const RETURN_STATUS_OPTIONS = [PLACEHOLDER_OPTION, ...dictToOptions(RETURN_STATUS_MAP)];

const PAYMENT_ACCOUNT_OPTIONS = [PLACEHOLDER_OPTION, ...PAYMENT_ACCOUNTS.map(v => ({ label: v, value: v }))];
const ORDER_STATUS_OPTIONS = dictToOptions(ORDER_STATUS_MAP);

const SHIPPING_FEE_OPTIONS = [PLACEHOLDER_OPTION, ...dictToOptions(SHIPPING_FEE_MAP)];
const SHIP_CONFIRM_SHIPPING_FEE_OPTIONS = [
  { label: '包邮', value: 'prepaid' },
  { label: '到付', value: 'cod' },
];
const BRAND_OPTIONS = [PLACEHOLDER_OPTION, ...BRANDS.map(v => ({ label: getBrandLabel(v), value: v }))];
const FILTER_SALESPERSON_OPTIONS = [{ label: '全部', value: '' }, ...SALESPERSONS.map(v => ({ label: v, value: v }))];
const FILTER_ORDER_STATUS_OPTIONS = [{ label: '全部', value: '' }, ...dictToOptions(ORDER_STATUS_MAP)];

/** 货品条目默认值 */
const EMPTY_PRODUCT: ProductItem = {
  brand: '',
  productName: '',
  specification: '',
  quantity: 0,
  unitPrice: 0,
  amount: 0,
  paymentAccount: '',
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
};

const STATUS_TAG_THEME: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
  shipped: 'success',
  unknown: 'default',
};

function isPendingShipmentStatus(status: string | undefined): boolean {
  return status === 'unknown' || status === '--';
}

function isExpressApplicableStatus(status: string | undefined): boolean {
  return isPendingShipmentStatus(status);
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
    }],
    attachments: record.attachments || [],
    returnStatus: record.returnStatus || '',
    returnTrackingNumbers: record.returnTrackingNumbers || '',
  };
}

export function Orders() {
  const orders = useOrders();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [filters, setFilters] = useState<OrderFilters>({});
  const [detailVisible, setDetailVisible] = useState(false);
  const [currentRecord, setCurrentRecord] = useState<OrderRecord | null>(null);
  const [importing, setImporting] = useState(false);
  const [importPreviewVisible, setImportPreviewVisible] = useState(false);
  const [importPreviewData, setImportPreviewData] = useState<OrderRecord[]>([]);
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
    orders.fetchRecords();
  }, []);

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

  const handleApplyExpress = useCallback((record: OrderRecord) => {
    MessagePlugin.info(`订单 ${record.serialNumber || ''} 的申请快递功能暂未实现`);
  }, []);

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
      if (addForm.products.some(p => !(addForm.orderAttribute === 'rental1' && p.brand !== '虚拟产品') && (!p.unitPrice || p.unitPrice <= 0))) { MessagePlugin.warning('请填写单价'); return; }
      if (addForm.products.some(p => !(addForm.orderAttribute === 'rental1' && p.brand !== '虚拟产品') && !p.paymentAccount)) { MessagePlugin.warning('请选择收款账户'); return; }
      if (addForm.products.some(p => p.productName === '部分转租赁2' || p.productName === '全部转租赁2') && addForm.transferProducts.some(t => !t.paidPeriod || t.paidPeriod <= 0)) { MessagePlugin.warning('转租赁2请填写已交租期'); return; }
      if (addForm.products.some(p => p.productName === '部分转租赁2' || p.productName === '全部转租赁2') && addForm.transferProducts.some(t => !t.paidRent || t.paidRent <= 0)) { MessagePlugin.warning('转租赁2请填写已交租金'); return; }
    }
    if (addStep === 4) {
      if (addForm.status === 'shipped' && !addForm.shippingFee) { MessagePlugin.warning('已发货状态请选择邮寄结算方式'); return; }
      if (addForm.status === 'shipped' && !addForm.trackingNumber) { MessagePlugin.warning('已发货状态请填写物流单号'); return; }
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
    return addForm.products.some(p => p.brand || p.productName || p.specification || p.quantity || p.unitPrice || p.paymentAccount);
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
        ...product,
        trackingNumber: addForm.trackingNumber,
        consignee: addForm.consignee,
        consigneePhone: addForm.consigneePhone,
        consigneeAddress: addForm.consigneeAddress,
        shippingFee: addForm.shippingFee,
        status: addForm.status,
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

    const result = await callFunction<{ success?: boolean; data?: OutboundRecord[] }>('queryRecords', {
      data: {
        type: 'outbound',
        customerName: keyword,
        limit: 20,
        cursor: null,
      },
    });

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

  const handleSelectShipRecord = useCallback((record: OutboundRecord) => {
    if (!record.trackingNumber) {
      MessagePlugin.warning('该发货记录没有快递单号');
      return;
    }
    setShipShippingFee('prepaid');
    setSelectedShipRecord(record);
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
      if (editForm.products.some(p => !(editForm.orderAttribute === 'rental1' && p.brand !== '虚拟产品') && (!p.unitPrice || p.unitPrice <= 0))) { MessagePlugin.warning('请填写单价'); return; }
      if (editForm.products.some(p => !(editForm.orderAttribute === 'rental1' && p.brand !== '虚拟产品') && !p.paymentAccount)) { MessagePlugin.warning('请选择收款账户'); return; }
      const editHasTransfer = editForm.products.some(p => p.productName === '部分转租赁2' || p.productName === '全部转租赁2');
      if (editHasTransfer && editForm.transferProducts.some(t => !t.paidPeriod || t.paidPeriod <= 0)) { MessagePlugin.warning('转租赁2请填写已交租期'); return; }
      if (editHasTransfer && editForm.transferProducts.some(t => !t.paidRent || t.paidRent <= 0)) { MessagePlugin.warning('转租赁2请填写已交租金'); return; }
    }
    if (editStep === 4) {
      if (editForm.status === 'shipped' && !editForm.shippingFee) { MessagePlugin.warning('已发货状态请选择邮寄结算方式'); return; }
      if (editForm.status === 'shipped' && !editForm.trackingNumber) { MessagePlugin.warning('已发货状态请填写物流单号'); return; }
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
        ...product,
        trackingNumber: editForm.trackingNumber,
        consignee: editForm.consignee,
        consigneePhone: editForm.consigneePhone,
        consigneeAddress: editForm.consigneeAddress,
        shippingFee: editForm.shippingFee,
        status: editForm.status,
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
    { colKey: 'serialNumber', title: '序号', width: 60 },
    { colKey: 'date', title: '日期', width: 100, cell: ({ row }: { row: OrderRecord }) => formatDate(row.date, false) },
    { colKey: 'orderType', title: '订单类型', width: 90, cell: ({ row }: { row: OrderRecord }) => getDictLabel(ORDER_TYPE_MAP, row.orderType) || '-' },
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
      colKey: 'op', title: '操作', width: 240, fixed: 'right' as const,
      cell: ({ row }: { row: OrderRecord }) => (
        <div className="flex gap-1 flex-wrap">
          <Button variant="text" theme="primary" size="small"
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleDetail(row); }}>
            详情
          </Button>
          {isExpressApplicableStatus(row.status) && (
            <Button variant="text" theme="primary" size="small"
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleApplyExpress(row); }}>
              申请快递
            </Button>
          )}
          <Button variant="text" theme="primary" size="small"
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleEditOpen(row); }}>
            编辑
          </Button>
          {isPendingShipmentStatus(row.status) && (
            <Button variant="text" theme="primary" size="small"
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleShipOpen(row); }}>
              发货
            </Button>
          )}
          <Button variant="text" theme="danger" size="small"
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleDeleteConfirm(row); }}>
            删除
          </Button>
        </div>
      ),
    },
  ], [handleDetail, handleApplyExpress, handleEditOpen, handleShipOpen, handleDeleteConfirm]);

  const displayRecords = orders.getPageRecords(orders.currentPage);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">订单管理</h1>
          <p className="text-gray-500 mt-1">管理所有订单</p>
        </div>
        <div className="flex gap-2">
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
          hover
          stripe
          rowClassName={({ row }: { row: OrderRecord }) => {
            const isUnreceived = row.paymentAccount === '未收款';
            const isUnreturned = row.returnStatus === 'notReturned' || row.returnStatus === 'inTransit';
            return (isUnreceived || isUnreturned) ? 'order-row-unreceived' : '';
          }}
        />
        {/* 分页 */}
        <div className="flex justify-center items-center gap-2 py-4 border-t border-gray-100">
          <Button size="small" variant="outline" disabled={orders.currentPage <= 1}
            onClick={() => orders.setCurrentPage(orders.currentPage - 1)}>
            上一页
          </Button>
          <span className="text-sm text-gray-500">第 {orders.currentPage} 页</span>
          <Button size="small" variant="outline" disabled={!orders.hasMore}
            onClick={() => orders.fetchRecords(orders.cursor)}>
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
            {!(currentRecord.orderAttribute === 'rental1' && currentRecord.brand !== '虚拟产品') && <DetailRow label="单价" value={currentRecord.unitPrice ? `¥${currentRecord.unitPrice}` : '-'} />}
            {!(currentRecord.orderAttribute === 'rental1' && currentRecord.brand !== '虚拟产品') && <DetailRow label="金额" value={currentRecord.amount ? `¥${currentRecord.amount}` : '-'} />}
            {!(currentRecord.orderAttribute === 'rental1' && currentRecord.brand !== '虚拟产品') && <DetailRow label="收款账户" value={currentRecord.paymentAccount} />}
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
                <button
                  key={record._id || index}
                  type="button"
                  className="w-full text-left border border-gray-200 rounded-lg p-3 hover:border-blue-400 hover:bg-blue-50/40 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={shipUpdating}
                  onClick={() => handleSelectShipRecord(record)}
                >
                  <div className="text-sm text-gray-800">
                    <span className="text-gray-400">发货时间：</span>{formatDate(record.outboundDate, false) || '-'}
                  </div>
                  <div className="text-sm text-gray-800 mt-1">
                    <span className="text-gray-400">客户名称：</span>{record.customerName || '-'}
                  </div>
                  <div className="text-sm text-gray-800 mt-1">
                    <span className="text-gray-400">发货单号：</span>{record.trackingNumber || '-'}
                  </div>
                </button>
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
  step, form, attachFiles, attachInputRef, onChange, onAttachFilesChange, mode = 'add',
}: {
  step: number;
  form: OrderFormData;
  attachFiles: File[];
  attachInputRef: React.RefObject<HTMLInputElement>;
  onChange: React.Dispatch<React.SetStateAction<OrderFormData>>;
  onAttachFilesChange: React.Dispatch<React.SetStateAction<File[]>>;
  mode?: 'add' | 'edit';
}) {
  const [pasteText, setPasteText] = useState('');
  const [parsing, setParsing] = useState(false);
  const updateField = useCallback(<K extends keyof OrderFormData>(key: K, val: OrderFormData[K]) => {
    onChange(prev => ({ ...prev, [key]: val }));
  }, [onChange]);
  const updateProduct = useCallback((index: number, patch: Partial<ProductItem>) => {
    onChange(prev => {
      const products = [...prev.products];
      products[index] = { ...products[index], ...patch };
      return { ...prev, products };
    });
  }, [onChange]);
  const addProduct = useCallback(() => onChange(prev => ({ ...prev, products: [...prev.products, { ...EMPTY_PRODUCT }] })), [onChange]);
  const removeProduct = useCallback((index: number) => {
    onChange(prev => {
      if (prev.products.length <= 1) return prev;
      return { ...prev, products: prev.products.filter((_, i) => i !== index) };
    });
  }, [onChange]);

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
        let products = getProductsByBrand(p.brand);
        // 虚拟产品/无 品牌下根据订单类型过滤（仅租赁1生效）
        if ((p.brand === '虚拟产品' || p.brand === '无') && form.orderAttribute === 'rental1' && form.orderType && ORDER_TYPE_VIRTUAL_PRODUCTS[form.orderType]) {
          const allowed = new Set(ORDER_TYPE_VIRTUAL_PRODUCTS[form.orderType]!);
          products = products.filter(name => allowed.has(name));
        }
        cache[p.brand] = [PLACEHOLDER_OPTION, ...products.map(v => ({ label: getProductLabel(v), value: v }))];
      }
    }
    return cache;
  }, [form.products.map(p => p.brand).join(','), form.orderType, form.orderAttribute]);
  const specOptionsMap = useMemo(() => {
    const cache: Record<string, { label: string; value: string }[]> = {};
    for (const p of form.products) {
      const key = `${p.brand}|${p.productName}`;
      if (p.brand && p.productName && !cache[key]) {
        cache[key] = [PLACEHOLDER_OPTION, ...getSpecsByProduct(p.brand, p.productName).map(v => ({ label: v, value: v }))];
      }
    }
    return cache;
  }, [form.products.map(p => `${p.brand}|${p.productName}`).join(',')]);

  // 转租赁级联 options（按索引缓存各组）
  const transferProductOptionsMap = useMemo(() => {
    const cache: Record<string, { label: string; value: string }[]> = {};
    for (const t of form.transferProducts) {
      if (t.brand && !cache[t.brand]) {
        cache[t.brand] = [PLACEHOLDER_OPTION, ...getProductsByBrand(t.brand).map(v => ({ label: getProductLabel(v), value: v }))];
      }
    }
    return cache;
  }, [form.transferProducts.map(t => t.brand).join(',')]);
  const transferSpecOptionsMap = useMemo(() => {
    const cache: Record<string, { label: string; value: string }[]> = {};
    for (const t of form.transferProducts) {
      const key = `${t.brand}|${t.productName}`;
      if (t.brand && t.productName && !cache[key]) {
        cache[key] = [PLACEHOLDER_OPTION, ...getSpecsByProduct(t.brand, t.productName).map(v => ({ label: v, value: v }))];
      }
    }
    return cache;
  }, [form.transferProducts.map(t => `${t.brand}|${t.productName}`).join(',')]);

  // 订单类型选项（根据订单来源过滤）
  const filteredOrderTypeOptions = useMemo(() => {
    if (!form.orderSource || !ORDER_SOURCE_ORDER_TYPE_MAP[form.orderSource]) {
      return ORDER_TYPE_OPTIONS;
    }
    const allowed = new Set(ORDER_SOURCE_ORDER_TYPE_MAP[form.orderSource]!);
    return ORDER_TYPE_OPTIONS.filter(o => !o.value || allowed.has(o.value));
  }, [form.orderSource]);

  // 是否有货品名称为「部分转租赁2」或「全部转租赁2」
  const hasTransferProduct = useMemo(() => {
    return form.products.some(p => p.productName === '部分转租赁2' || p.productName === '全部转租赁2');
  }, [form.products.map(p => p.productName).join(',')]);

  // 是否显示归还状态（订单类型为租后发货或租后退货时）
  const showReturnStatus = useMemo(() => {
    return form.orderType === 'postRentalShip' || form.orderType === 'postRentalReturn';
  }, [form.orderType]);

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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">日期 <span className="text-red-500">*</span></label>
              <input type="date" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
                value={form.date} onChange={e => updateField('date', e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">客户名称 <span className="text-red-500">*</span></label>
              <Input placeholder="请输入客户名称"
                value={form.customerName} onChange={val => updateField('customerName', val as string)} />
            </div>
            <div>
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
                  return updated;
                });
              }} options={ORDER_SOURCE_OPTIONS} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">订单属性 <span className="text-red-500">*</span></label>
              <Select placeholder="请选择" value={form.orderAttribute || ''} onChange={val => updateField('orderAttribute', val as string)} options={ORDER_ATTRIBUTE_OPTIONS} />
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
                  return updated;
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
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-medium text-gray-600">填写货品信息</h4>
            <Button size="small" variant="outline" icon={<Plus size={14} />} onClick={addProduct}>添加货品</Button>
          </div>
          {form.products.map((product, idx) => (
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
                    options={BRAND_OPTIONS} filterable />
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
                    value={product.quantity ? String(product.quantity) : ''} onChange={val => { const q = Math.max(0, Number(val)); updateProduct(idx, { quantity: q, amount: q * product.unitPrice }); }} />
                </div>
                {!(form.orderAttribute === 'rental1' && product.brand !== '虚拟产品') && (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">单价 <span className="text-red-500">*</span></label>
                    <Input type="number" placeholder="单价"
                      value={product.unitPrice ? String(product.unitPrice) : ''} onChange={val => { const p = Math.max(0, Number(val)); updateProduct(idx, { unitPrice: p, amount: product.quantity * p }); }} />
                  </div>
                )}
                {!(form.orderAttribute === 'rental1' && product.brand !== '虚拟产品') && (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">金额</label>
                    <Input type="number" placeholder="自动计算"
                      value={product.amount ? String(product.amount) : ''} readOnly />
                  </div>
                )}
                {!(form.orderAttribute === 'rental1' && product.brand !== '虚拟产品') && (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">收款账户 <span className="text-red-500">*</span></label>
                    <Select placeholder="请选择" value={product.paymentAccount || ''}
                      onChange={val => updateProduct(idx, { paymentAccount: val as string })} options={PAYMENT_ACCOUNT_OPTIONS} />
                  </div>
                )}
              </div>
            </div>
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
                        options={BRAND_OPTIONS} filterable />
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
            <div>
              <label className="block text-xs text-gray-500 mb-1">订单状态</label>
              <Select placeholder="请选择" value={form.status || ''} onChange={val => {
                const newStatus = val as string;
                onChange(prev => ({
                  ...prev,
                  status: newStatus,
                  shippingFee: newStatus === 'shipped' ? prev.shippingFee : '',
                  trackingNumber: newStatus === 'shipped' ? prev.trackingNumber : '',
                }));
              }} options={ORDER_STATUS_OPTIONS} />
            </div>
            {form.status === 'shipped' && (
              <div>
                <label className="block text-xs text-gray-500 mb-1">邮寄结算方式 <span className="text-red-500">*</span></label>
                <Select placeholder="请选择" value={form.shippingFee || ''} onChange={val => updateField('shippingFee', val as string)} options={SHIPPING_FEE_OPTIONS} />
              </div>
            )}
            {form.status === 'shipped' && (
              <div>
                <label className="block text-xs text-gray-500 mb-1">物流单号 <span className="text-red-500">*</span></label>
                <Input placeholder="物流单号"
                  value={form.trackingNumber} onChange={val => updateField('trackingNumber', val as string)} />
              </div>
            )}
          </div>
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
              {form.products.map((p, i) => (
                <div key={i} className="text-xs text-gray-600 ml-2 border-l-2 border-blue-200 pl-2 mb-1">
                  货品{i + 1}：{p.brand ? getBrandLabel(p.brand) : '-'} / {p.productName ? getProductLabel(p.productName) : '-'} / {p.specification || '-'}，
                  数量 {p.quantity || 0}{!(form.orderAttribute === 'rental1' && p.brand !== '虚拟产品') ? `，单价 ¥${p.unitPrice || 0}，金额 ¥${p.amount || 0}，收款账户 ${p.paymentAccount || '-'}` : ''}
                </div>
              ))}
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
