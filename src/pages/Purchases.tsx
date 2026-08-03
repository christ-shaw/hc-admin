import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FileDown, FileText, Plus, RotateCcw, Upload, X } from 'lucide-react';
import { Button, Dialog, MessagePlugin } from 'tdesign-react';
import { buildProductModelSeed } from '../data/productDict';
import { getCloudFileURLs, getCurrentOperatorName, uploadToCloudStorage } from '../lib/cloudbase';
import { usePhoneModels } from '../hooks/usePhoneModels';
import { usePermission } from '../contexts/PermissionContext';
import { useSuppliers } from '../hooks/useSuppliers';
import { usePurchases, type PurchaseRecord, type PurchaseType } from '../hooks/usePurchases';
import { useDictionaries } from '../contexts/DictionaryContext';
import { DICT_CODES } from '../data/dict';
import { useTabDirty } from '../contexts/TabWorkspaceContext';
import { exportPurchaseRecordsExcel } from '../utils/purchaseExcel';

interface PurchaseForm {
  date: string;
  purchaseType: PurchaseType;
  supplier: string;
  owner: string;
  brand: string;
  model: string;
  specification: string;
  quantity: number;
  unitPrice: number;
}

interface PaymentForm {
  date: string;
  splits: Array<{ account: string; amount: number }>;
  remark: string;
}

const PAGE_SIZE = 8;
const FALLBACK_CATALOG = buildProductModelSeed();

function localDateValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function formatMoney(value: number) {
  return `¥${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value || 0)}`;
}

function formatDateTime(value: string) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date).replace(/\//g, '-');
}

function emptyForm(owner: string): PurchaseForm {
  return {
    date: localDateValue(),
    purchaseType: 'purchase',
    supplier: '',
    owner,
    brand: '',
    model: '',
    specification: '',
    quantity: 1,
    unitPrice: 0,
  };
}

function FieldLabel({ children, required, hint }: { children: React.ReactNode; required?: boolean; hint?: string }) {
  return (
    <label className="mb-[5px] block text-xs text-[#8A94A6]">
      {children} {required && <span className="text-[#E34D59]">*</span>}
      {hint && <span className="ml-1 font-normal text-[#B5BBC5]">（{hint}）</span>}
    </label>
  );
}

const fieldClass = 'h-9 w-full rounded-lg border border-[#E1E4E8] bg-white px-2.5 text-[13px] text-[#374151] outline-none transition focus:border-[#0052D9] focus:ring-1 focus:ring-[#0052D9]/10 disabled:bg-[#FAFBFC] disabled:text-[#8A94A6]';

export function Purchases() {
  const dictionaries = useDictionaries();
  const { brands, loadBrands } = usePhoneModels();
  const { suppliers, loading: suppliersLoading, loadError: suppliersError, loadSuppliers } = useSuppliers();
  const {
    records,
    loading: purchasesLoading,
    errorMessage: purchasesError,
    fetchPurchases,
    createPurchase,
    updatePurchase,
    returnToSupplier,
    deletePurchase,
    confirmPayment,
  } = usePurchases();
  const { can } = usePermission();
  const [search, setSearch] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [brandFilter, setBrandFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [purchaseTypeFilter, setPurchaseTypeFilter] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [currentOwner, setCurrentOwner] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editingPurchase, setEditingPurchase] = useState<PurchaseRecord | null>(null);
  const [detail, setDetail] = useState<PurchaseRecord | null>(null);
  const [form, setForm] = useState<PurchaseForm>(() => emptyForm(''));
  const [saving, setSaving] = useState(false);
  const [paymentTarget, setPaymentTarget] = useState<PurchaseRecord | null>(null);
  const [paymentForm, setPaymentForm] = useState<PaymentForm>({ date: localDateValue(), splits: [{ account: '', amount: 0 }], remark: '' });
  const [voucherFiles, setVoucherFiles] = useState<File[]>([]);
  const [voucherUrls, setVoucherUrls] = useState<Array<{ fileID: string; fileName: string; tempFileURL: string }>>([]);
  const [voucherPreview, setVoucherPreview] = useState<{ fileName: string; tempFileURL: string } | null>(null);
  const [paymentSaving, setPaymentSaving] = useState(false);
  const [voucherLoading, setVoucherLoading] = useState(false);
  const [paymentStep, setPaymentStep] = useState<1 | 2>(1);
  const [returnTarget, setReturnTarget] = useState<PurchaseRecord | null>(null);
  const [returnForm, setReturnForm] = useState({ quantity: 1, reason: '', remark: '' });
  const [returnSaving, setReturnSaving] = useState(false);
  const [exportVisible, setExportVisible] = useState(false);
  const [exportStep, setExportStep] = useState<1 | 2 | 3>(1);
  const [exportDateStart, setExportDateStart] = useState('');
  const [exportDateEnd, setExportDateEnd] = useState('');
  const [exportSuppliers, setExportSuppliers] = useState<string[]>([]);
  const [exportOwners, setExportOwners] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  const voucherInputRef = useRef<HTMLInputElement>(null);
  const createInitialRef = useRef('');
  const paymentInitialRef = useRef('');
  const returnInitialRef = useRef('');
  const exportInitialRef = useRef('');
  const exportState = JSON.stringify({
    startDate: exportDateStart,
    endDate: exportDateEnd,
    suppliers: exportSuppliers,
    owners: exportOwners,
    step: exportStep,
  });

  useTabDirty(
    (createOpen && !!createInitialRef.current && JSON.stringify(form) !== createInitialRef.current)
      || (!!paymentTarget && !!paymentInitialRef.current && (
        JSON.stringify(paymentForm) !== paymentInitialRef.current || voucherFiles.length > 0
      ))
      || (!!returnTarget && !!returnInitialRef.current && JSON.stringify(returnForm) !== returnInitialRef.current)
      || (exportVisible && !!exportInitialRef.current && exportState !== exportInitialRef.current),
    '采购管理',
  );

  const canCreate = can('purchases:create') || can('orders:create');
  const canEdit = can('purchases:update');
  const canReturn = can('purchases:update');
  const canDelete = can('purchases:delete') || can('orders:delete');
  const canConfirmPayment = can('purchases:payment_confirm');
  const catalog = brands.length > 0 ? brands.filter(item => item.enabled !== false) : FALLBACK_CATALOG;
  const paymentAccountOptions = useMemo(
    () => dictionaries.getOptions(DICT_CODES.paymentAccount),
    [dictionaries],
  );
  const paymentSplitTotal = Math.round(paymentForm.splits.reduce((sum, item) => sum + Number(item.amount || 0), 0) * 100) / 100;
  const paymentExpectedAmount = paymentTarget?.payableAmount ?? (paymentTarget ? paymentTarget.quantity * paymentTarget.unitPrice : 0);
  const paymentRemaining = Math.round((paymentExpectedAmount - paymentSplitTotal) * 100) / 100;

  useEffect(() => {
    loadBrands();
    loadSuppliers(true);
    fetchPurchases();
    getCurrentOperatorName().then(name => {
      const normalized = name && name !== '未知用户' ? name : '';
      setCurrentOwner(normalized);
      setForm(prev => ({ ...prev, owner: normalized }));
    });
  }, [fetchPurchases, loadBrands, loadSuppliers]);

  const ownerOptions = useMemo(
    () => Array.from(new Set([currentOwner, ...records.map(record => record.owner)]).values()).filter(Boolean),
    [currentOwner, records],
  );
  const exportSupplierOptions = useMemo(
    () => Array.from(new Set([
      ...records.map(record => record.supplier),
      ...suppliers.map(supplier => supplier.name),
    ])).filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-CN')),
    [records, suppliers],
  );
  const selectedBrand = catalog.find(item => item.brand === form.brand);
  const productOptions = (selectedBrand?.products || []).filter(item => item.enabled !== false);
  const selectedProduct = productOptions.find(item => item.name === form.model);
  const specOptions = (selectedProduct?.specs || []).filter(item => item.enabled !== false);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return records.filter(record => {
      if (keyword && !`${record.purchaseNumber} ${record.supplier}`.toLowerCase().includes(keyword)) return false;
      if (startDate && record.date < startDate) return false;
      if (endDate && record.date > endDate) return false;
      if (purchaseTypeFilter && record.purchaseType !== purchaseTypeFilter) return false;
      if (brandFilter && record.brand !== brandFilter) return false;
      if (ownerFilter && record.owner !== ownerFilter) return false;
      return true;
    });
  }, [records, search, startDate, endDate, purchaseTypeFilter, brandFilter, ownerFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const hasFilters = !!(search || startDate || endDate || purchaseTypeFilter || brandFilter || ownerFilter);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const setFilter = (setter: (value: string) => void, value: string) => {
    setter(value);
    setPage(1);
  };

  const clearFilters = () => {
    setSearch('');
    setStartDate('');
    setEndDate('');
    setPurchaseTypeFilter('');
    setBrandFilter('');
    setOwnerFilter('');
    setPage(1);
  };

  const openCreate = () => {
    const nextForm = emptyForm(currentOwner);
    setEditingPurchase(null);
    setForm(nextForm);
    createInitialRef.current = JSON.stringify(nextForm);
    setCreateOpen(true);
  };

  const openEdit = (record: PurchaseRecord) => {
    if (record.paymentStatus !== 'pending') {
      MessagePlugin.warning('该采购单已完成结算，不能修改');
      return;
    }
    const nextForm: PurchaseForm = {
      date: record.date,
      purchaseType: record.purchaseType || 'purchase',
      supplier: record.supplier,
      owner: record.owner,
      brand: record.brand,
      model: record.model,
      specification: record.specification,
      quantity: record.quantity,
      unitPrice: record.unitPrice,
    };
    setEditingPurchase(record);
    setForm(nextForm);
    createInitialRef.current = JSON.stringify(nextForm);
    setDetail(null);
    setCreateOpen(true);
  };

  const closePurchaseForm = () => {
    setCreateOpen(false);
    setEditingPurchase(null);
    createInitialRef.current = '';
  };

  const openReturn = (record: PurchaseRecord) => {
    if (record.paymentStatus !== 'pending') {
      MessagePlugin.warning('该采购单已完成结算，不能再登记退货');
      return;
    }
    const nextForm = { quantity: 1, reason: '', remark: '' };
    setReturnTarget(record);
    setReturnForm(nextForm);
    returnInitialRef.current = JSON.stringify(nextForm);
  };

  const updateBrand = (brand: string) => {
    const firstProduct = catalog.find(item => item.brand === brand)?.products?.find(item => item.enabled !== false);
    const firstSpec = firstProduct?.specs?.find(item => item.enabled !== false);
    setForm(prev => ({
      ...prev,
      brand,
      model: firstProduct?.name || '',
      specification: firstSpec?.name || '',
    }));
  };

  const updateModel = (model: string) => {
    const firstSpec = productOptions.find(item => item.name === model)?.specs?.find(item => item.enabled !== false);
    setForm(prev => ({ ...prev, model, specification: firstSpec?.name || '' }));
  };

  const submitPurchase = async () => {
    const missing: string[] = [];
    if (!form.date) missing.push('采购日期');
    if (!form.purchaseType) missing.push('采购属性');
    if (!form.supplier) missing.push('供货商名称');
    if (!form.owner) missing.push('采购责任人');
    if (!form.brand) missing.push('采购货品品牌');
    if (!form.model) missing.push('采购型号');
    if (!form.specification) missing.push('规格');
    if (!(form.quantity > 0)) missing.push('数量');
    if (!(form.unitPrice > 0)) missing.push('采购单价');
    if (missing.length > 0) {
      MessagePlugin.warning(`请填写：${missing.join('、')}`);
      return;
    }
    if (editingPurchase && form.quantity < (editingPurchase.returnedQuantity || 0)) {
      MessagePlugin.warning(`采购数量不能小于已退数量 ${editingPurchase.returnedQuantity}`);
      return;
    }
    setSaving(true);
    const selectedSupplier = suppliers.find(item => item.name === form.supplier);
    const input = { ...form, supplierId: selectedSupplier?._id || '', operatorName: currentOwner };
    const result = editingPurchase
      ? await updatePurchase(editingPurchase._id, input)
      : await createPurchase(input);
    setSaving(false);
    if (!result.success) {
      MessagePlugin.error(result.errMsg || (editingPurchase ? '修改采购单失败' : '新增采购单失败'));
      return;
    }
    const purchaseNumber = result.data?.purchaseNumber || editingPurchase?.purchaseNumber || '';
    closePurchaseForm();
    setPage(1);
    MessagePlugin.success(editingPurchase
      ? `采购单 ${purchaseNumber} 已修改`
      : `采购单 ${purchaseNumber} 已创建`);
  };

  const openExport = () => {
    const today = new Date();
    const endDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const sixMonthsAgo = new Date(today);
    sixMonthsAgo.setDate(sixMonthsAgo.getDate() - 183);
    const startDate = `${sixMonthsAgo.getFullYear()}-${String(sixMonthsAgo.getMonth() + 1).padStart(2, '0')}-${String(sixMonthsAgo.getDate()).padStart(2, '0')}`;
    setExportDateStart(startDate);
    setExportDateEnd(endDate);
    setExportSuppliers([]);
    setExportOwners([]);
    setExportStep(1);
    exportInitialRef.current = JSON.stringify({
      startDate,
      endDate,
      suppliers: [],
      owners: [],
      step: 1,
    });
    setExportVisible(true);
  };

  const validateExportDate = (): string | null => {
    if (!exportDateStart || !exportDateEnd) return '请选择完整的日期范围';
    const start = new Date(`${exportDateStart}T00:00:00`);
    const end = new Date(`${exportDateEnd}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '日期格式不正确';
    if (start > end) return '开始日期不能晚于结束日期';
    if ((end.getTime() - start.getTime()) / 86_400_000 > 183) return '日期范围不能超过半年（183天）';
    return null;
  };

  const exportPurchases = async () => {
    const dateError = validateExportDate();
    if (dateError) {
      MessagePlugin.warning(dateError);
      return;
    }

    setExporting(true);
    try {
      const exportRecords = records.filter(record => {
        if (record.date < exportDateStart || record.date > exportDateEnd) return false;
        if (exportSuppliers.length > 0 && !exportSuppliers.includes(record.supplier)) return false;
        if (exportOwners.length > 0 && !exportOwners.includes(record.owner)) return false;
        return true;
      });
      if (exportRecords.length === 0) {
        MessagePlugin.warning('所选条件内暂无采购单数据');
        return;
      }
      exportPurchaseRecordsExcel(exportRecords);
      MessagePlugin.success(`已导出 ${exportRecords.length} 条采购单`);
      setExportVisible(false);
    } catch (error) {
      MessagePlugin.error('导出失败: ' + String(error));
    } finally {
      setExporting(false);
    }
  };

  const submitReturn = async () => {
    if (!returnTarget) return;
    if (!Number.isInteger(returnForm.quantity) || returnForm.quantity <= 0) {
      MessagePlugin.warning('退回数量必须为正整数');
      return;
    }
    if (returnForm.quantity > returnTarget.payableQuantity) {
      MessagePlugin.warning(`最多可退回 ${returnTarget.payableQuantity} 台`);
      return;
    }
    if (!returnForm.reason) {
      MessagePlugin.warning('请选择退货原因');
      return;
    }
    setReturnSaving(true);
    const result = await returnToSupplier(returnTarget._id, returnForm.quantity, returnForm.reason, returnForm.remark.trim(), currentOwner);
    setReturnSaving(false);
    if (!result.success || !result.data) {
      MessagePlugin.error(result.errMsg || '退货调整失败');
      return;
    }
    setDetail(current => current?._id === returnTarget._id ? result.data! : current);
    setReturnTarget(null);
    MessagePlugin.success('退货调整已记录，应付清单已更新');
  };

  const removePurchase = async (record: PurchaseRecord) => {
    if (record.paymentStatus !== 'pending') {
      MessagePlugin.warning('已完成结算的采购单不能删除');
      return;
    }
    if (!window.confirm(`确认删除采购单 ${record.purchaseNumber}？`)) return;
    const result = await deletePurchase(record._id);
    if (!result.success) {
      MessagePlugin.error(result.errMsg || '删除采购单失败');
      return;
    }
    setDetail(current => current?._id === record._id ? null : current);
    MessagePlugin.success('采购单已删除');
  };

  const openPayment = async (record: PurchaseRecord) => {
    setPaymentTarget(record);
    setPaymentStep(record.paymentStatus === 'paid' ? 2 : 1);
    setVoucherFiles([]);
    setVoucherUrls([]);
    setVoucherLoading(false);
    const nextPaymentForm = {
      date: record.payment?.date || localDateValue(),
      splits: record.payment?.splits?.length
        ? record.payment.splits.map(item => ({ ...item }))
        : [{ account: record.payment?.account || '', amount: record.payment?.amount || record.payableAmount || record.totalAmount || record.quantity * record.unitPrice }],
      remark: record.payment?.remark || '',
    };
    setPaymentForm(nextPaymentForm);
    paymentInitialRef.current = JSON.stringify(nextPaymentForm);

    const vouchers = record.payment?.vouchers || [];
    if (vouchers.length > 0) {
      setVoucherLoading(true);
      try {
        const urls = await getCloudFileURLs(vouchers.map(item => item.fileID));
        setVoucherUrls(vouchers.map((item, index) => ({
          ...item,
          tempFileURL: urls[index]?.tempFileURL || '',
        })));
      } catch (error) {
        MessagePlugin.error('付款凭证加载失败: ' + String(error));
      } finally {
        setVoucherLoading(false);
      }
    }
  };

  const handleVoucherSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files || []);
    event.target.value = '';
    const valid = selected.filter(file => {
      const supported = file.type.startsWith('image/') || file.type === 'application/pdf';
      if (!supported) MessagePlugin.warning(`${file.name} 不是图片或 PDF`);
      if (file.size > 10 * 1024 * 1024) MessagePlugin.warning(`${file.name} 超过 10MB`);
      return supported && file.size <= 10 * 1024 * 1024;
    });
    setVoucherFiles(prev => [...prev, ...valid].slice(0, 5));
    if (voucherFiles.length + valid.length > 5) MessagePlugin.warning('最多上传 5 份付款凭证');
  };

  const submitPayment = async () => {
    if (!paymentTarget) return;
    const paymentSplits = paymentForm.splits
      .map(item => ({ account: item.account.trim(), amount: Number(item.amount || 0) }))
      .filter(item => item.account || item.amount > 0);
    if (!paymentForm.date || paymentSplits.length === 0 || paymentSplits.some(item => !item.account || !(item.amount > 0))) {
      MessagePlugin.warning('请填写完整的付款日期、付款账户和付款金额');
      return;
    }
    if (new Set(paymentSplits.map(item => item.account)).size !== paymentSplits.length) {
      MessagePlugin.warning('同一个付款账户不能重复选择');
      return;
    }
    const paymentAmount = Math.round(paymentSplits.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
    const expectedAmount = paymentTarget.payableAmount ?? paymentTarget.quantity * paymentTarget.unitPrice;
    if (Math.abs(paymentAmount - expectedAmount) > 0.001) {
      MessagePlugin.warning(`多账户付款合计必须等于 ${formatMoney(expectedAmount)}`);
      return;
    }
    if (voucherFiles.length === 0) {
      MessagePlugin.warning('请上传至少一份付款凭证');
      return;
    }

    setPaymentSaving(true);
    try {
      const vouchers = [];
      for (const file of voucherFiles) {
        const extension = (file.name.split('.').pop() || 'bin').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        const cloudPath = `purchase-payments/${paymentTarget.purchaseNumber}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extension}`;
        const fileID = await uploadToCloudStorage(cloudPath, file);
        vouchers.push({ fileID, fileName: file.name });
      }
      const result = await confirmPayment(paymentTarget._id, {
        paymentDate: paymentForm.date,
        paymentAccount: paymentSplits.map(item => item.account).join('、'),
        paymentAmount,
        paymentSplits,
        remark: paymentForm.remark.trim(),
        vouchers,
        confirmedByName: currentOwner,
      });
      if (!result.success || !result.data) {
        MessagePlugin.error(result.errMsg || '付款确认失败');
        return;
      }
      setDetail(current => current?._id === paymentTarget._id ? result.data! : current);
      setPaymentTarget(null);
      setVoucherFiles([]);
      MessagePlugin.success('付款确认已提交');
    } catch (error) {
      MessagePlugin.error('付款确认失败: ' + String(error));
    } finally {
      setPaymentSaving(false);
    }
  };

  return (
    <div className="min-w-0 space-y-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-0.5">
        <div>
          <h1 className="text-xl font-semibold text-[#1F2733]">采购管理</h1>
          <p className="mt-0.5 text-[13px] text-[#8A94A6]">管理所有采购单，共 {filtered.length} 条</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={records.length === 0}
            onClick={openExport}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#B8CDF5] bg-white px-3.5 text-[13px] font-medium text-[#0052D9] transition hover:bg-[#F0F4FE] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <FileDown size={15} /> 导出 Excel
          </button>
          <button
            type="button"
            disabled={!canCreate}
            onClick={openCreate}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#0052D9] px-4 text-[13px] font-medium text-white shadow-sm transition hover:bg-[#266FE8] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus size={15} /> 新增采购单
          </button>
        </div>
      </div>

      <section className="rounded-2xl border border-[#EEF0F2] bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(16,24,40,0.03)]">
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            aria-label="搜索采购单号或供货商"
            value={search}
            onChange={event => setFilter(setSearch, event.target.value)}
            placeholder="搜索采购单号 / 供货商"
            className={`${fieldClass} sm:basis-[220px] sm:shrink-0`}
          />
          <input aria-label="开始日期" type="date" value={startDate} onChange={event => setFilter(setStartDate, event.target.value)} className={`${fieldClass} basis-[142px] shrink-0`} />
          <span className="text-xs text-[#C4CAD3]">至</span>
          <input aria-label="结束日期" type="date" value={endDate} onChange={event => setFilter(setEndDate, event.target.value)} className={`${fieldClass} basis-[142px] shrink-0`} />
          <button type="button" onClick={() => setFiltersOpen(value => !value)} className="inline-flex h-9 items-center gap-1 rounded-lg px-2.5 text-[13px] text-[#0052D9] hover:bg-[#F0F4FE]">
            更多筛选 {filtersOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {hasFilters && (
            <button type="button" onClick={clearFilters} className="inline-flex h-9 items-center gap-1 rounded-lg px-2.5 text-[13px] text-[#8A94A6] hover:bg-[#F0F1F3] hover:text-[#374151]">
              <RotateCcw size={13} /> 清除筛选
            </button>
          )}
        </div>
        {filtersOpen && (
          <div className="mt-2.5 flex flex-wrap gap-2.5 border-t border-dashed border-[#EEF0F2] pt-2.5">
            <select aria-label="采购属性筛选" value={purchaseTypeFilter} onChange={event => setFilter(setPurchaseTypeFilter, event.target.value)} className={`${fieldClass} w-[150px]`}>
              <option value="">全部采购属性</option>
              <option value="purchase">采购</option>
              <option value="recycle">回收</option>
            </select>
            <select aria-label="品牌筛选" value={brandFilter} onChange={event => setFilter(setBrandFilter, event.target.value)} className={`${fieldClass} w-[150px]`}>
              <option value="">全部品牌</option>
              {catalog.map(item => <option key={item.brand} value={item.brand}>{item.brand}</option>)}
            </select>
            <select aria-label="责任人筛选" value={ownerFilter} onChange={event => setFilter(setOwnerFilter, event.target.value)} className={`${fieldClass} w-[150px]`}>
              <option value="">全部责任人</option>
              {ownerOptions.map(owner => <option key={owner} value={owner}>{owner}</option>)}
            </select>
          </div>
        )}
      </section>

      <section className="min-w-0 overflow-hidden rounded-2xl border border-[#EEF0F2] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.03)]">
        {purchasesError && (
          <div className="border-b border-[#F3C0C5] bg-[#FDECEE] px-4 py-2.5 text-[13px] text-[#C9353F]">{purchasesError}</div>
        )}
        <div className="max-w-full overflow-x-auto">
          <div className="min-w-[1472px]">
            <div className="grid grid-cols-[120px_100px_72px_84px_140px_80px_60px_92px_104px_140px_80px_90px_270px] border-b border-[#EEF0F2] bg-[#FAFBFC] text-xs font-medium text-[#8A94A6]">
              {['采购单号', '采购日期', '属性', '品牌', '型号', '规格', '数量', '采购单价', '采购总价', '供货商', '责任人', '付款状态', '操作'].map(label => (
                <div key={label} className="px-3 py-[11px]">{label}</div>
              ))}
            </div>
            {pageRows.map(record => (
              <div key={record._id} className="grid grid-cols-[120px_100px_72px_84px_140px_80px_60px_92px_104px_140px_80px_90px_270px] border-b border-[#F0F1F3] bg-white text-[13px] transition hover:bg-[#F8FAFF]">
                <div className="px-3 py-3 font-medium text-[#1F2733]">{record.purchaseNumber}</div>
                <div className="px-3 py-3 text-[#4B5563]">{record.date}</div>
                <div className="px-3 py-3">
                  <span className={`rounded-full px-2 py-1 text-[11.5px] ${
                    record.purchaseType === 'recycle' ? 'bg-[#E8F8F2] text-[#168267]' : 'bg-[#EDF3FF] text-[#0052D9]'
                  }`}>
                    {record.purchaseType === 'recycle' ? '回收' : '采购'}
                  </span>
                </div>
                <div className="px-3 py-3 text-[#4B5563]">{record.brand}</div>
                <div className="truncate px-3 py-3 text-[#4B5563]" title={record.model}>{record.model}</div>
                <div className="px-3 py-3 text-[#4B5563]">{record.specification}</div>
                <div className="px-3 py-3 text-[#4B5563]">{record.quantity}</div>
                <div className="px-3 py-3 text-[#4B5563]">{formatMoney(record.unitPrice)}</div>
                <div className="px-3 py-3 font-medium text-[#1F2733]">{formatMoney(record.quantity * record.unitPrice)}</div>
                <div className="truncate px-3 py-3 text-[#4B5563]" title={record.supplier}>{record.supplier}</div>
                <div className="px-3 py-3 text-[#4B5563]">{record.owner}</div>
                <div className="px-3 py-3">
                  <span className={`rounded-full px-2 py-1 text-[11.5px] ${record.paymentStatus === 'paid' ? 'bg-[#E8F8F2] text-[#168267]' : record.paymentStatus === 'no_payment' ? 'bg-[#F0F1F3] text-[#6B7280]' : 'bg-[#FFF3E0] text-[#B56700]'}`}>
                    {record.paymentStatus === 'paid' ? '已付款' : record.paymentStatus === 'no_payment' ? '无需付款' : '待付款'}
                  </span>
                </div>
                <div className="flex items-center gap-0.5 px-2 py-2">
                  <button type="button" onClick={() => setDetail(record)} className="rounded px-1.5 py-1 text-[12.5px] text-[#0052D9] hover:bg-[#F0F4FE]">详情</button>
                  <button type="button" disabled={!canEdit || record.paymentStatus !== 'pending'} onClick={() => openEdit(record)} className="rounded px-1.5 py-1 text-[12.5px] text-[#0052D9] hover:bg-[#F0F4FE] disabled:cursor-not-allowed disabled:opacity-40">编辑</button>
                  <button type="button" disabled={!canReturn || record.paymentStatus !== 'pending'} onClick={() => openReturn(record)} className="rounded px-1.5 py-1 text-[12.5px] text-[#6B7280] hover:bg-[#F0F1F3] disabled:cursor-not-allowed disabled:opacity-40">退货调整</button>
                  <button type="button" disabled={record.paymentStatus === 'pending' && !canConfirmPayment} onClick={() => openPayment(record)} className="rounded px-1.5 py-1 text-[12.5px] text-[#168267] hover:bg-[#E8F8F2] disabled:cursor-not-allowed disabled:opacity-40">
                    {record.paymentStatus === 'paid' ? '付款信息' : record.paymentStatus === 'no_payment' ? '应付清单' : '付款确认'}
                  </button>
                  <button type="button" disabled={!canDelete || record.paymentStatus !== 'pending'} onClick={() => removePurchase(record)} className="rounded px-1.5 py-1 text-[12.5px] text-[#E34D59] hover:bg-[#FDECEE] disabled:cursor-not-allowed disabled:opacity-40">删除</button>
                </div>
              </div>
            ))}
            {purchasesLoading && <div className="py-[60px] text-center text-[13px] text-[#8A94A6]">正在加载采购单...</div>}
            {!purchasesLoading && pageRows.length === 0 && <div className="py-[60px] text-center text-[13px] text-[#B5BBC5]">没有匹配的采购单</div>}
          </div>
        </div>
        <div className="flex items-center justify-center gap-2 border-t border-[#F3F4F6] py-4">
          <Button
            size="small"
            variant="outline"
            disabled={page <= 1}
            onClick={() => setPage(previous => Math.max(1, previous - 1))}
          >
            上一页
          </Button>
          <span className="text-sm text-gray-500">第 {page} 页</span>
          <Button
            size="small"
            variant="outline"
            disabled={page >= totalPages || purchasesLoading}
            onClick={() => setPage(previous => Math.min(totalPages, previous + 1))}
          >
            下一页
          </Button>
          <span className="text-sm text-gray-400">共 {filtered.length} 条</span>
        </div>
      </section>

      {createOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(15,23,42,0.45)] p-4" role="presentation" onMouseDown={event => event.target === event.currentTarget && closePurchaseForm()}>
          <section role="dialog" aria-modal="true" aria-labelledby="purchase-form-title" className="flex max-h-[90vh] w-[640px] max-w-[94vw] flex-col overflow-hidden rounded-2xl bg-white shadow-[0_24px_64px_rgba(0,0,0,0.24)]">
            <div className="flex flex-shrink-0 items-center justify-between border-b border-[#EEF0F2] px-5 py-4">
              <h2 id="purchase-form-title" className="text-base font-semibold text-[#1F2733]">{editingPurchase ? '修改采购单' : '新增采购单'}</h2>
              <button type="button" aria-label="关闭采购单表单" onClick={closePurchaseForm} className="flex h-7 w-7 items-center justify-center rounded-lg text-[#8A94A6] hover:bg-[#F0F1F3] hover:text-[#374151]"><X size={16} /></button>
            </div>
            <div className="flex-1 overflow-auto px-6 py-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <FieldLabel>采购单号</FieldLabel>
                  <div className="flex h-9 items-center rounded-lg border border-[#EEF0F2] bg-[#FAFBFC] px-2.5 text-[13px] text-[#6B7280]">{editingPurchase?.purchaseNumber || '保存后自动生成'}</div>
                </div>
                <div>
                  <FieldLabel required>采购日期</FieldLabel>
                  <input type="date" value={form.date} onChange={event => setForm(prev => ({ ...prev, date: event.target.value }))} className={fieldClass} />
                </div>
                <div>
                  <FieldLabel required>采购属性</FieldLabel>
                  <div className="grid h-9 grid-cols-2 rounded-lg bg-[#F0F1F3] p-0.5">
                    {([
                      { value: 'purchase', label: '采购' },
                      { value: 'recycle', label: '回收' },
                    ] as const).map(option => (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={form.purchaseType === option.value}
                        onClick={() => setForm(previous => ({ ...previous, purchaseType: option.value }))}
                        className={`rounded-md text-[13px] font-medium transition ${
                          form.purchaseType === option.value
                            ? 'bg-white text-[#0052D9] shadow-sm'
                            : 'text-[#6B7280] hover:text-[#374151]'
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <FieldLabel required>供货商名称</FieldLabel>
                  <select
                    value={form.supplier}
                    onChange={event => setForm(prev => ({ ...prev, supplier: event.target.value }))}
                    className={fieldClass}
                    disabled={suppliersLoading || suppliers.length === 0}
                  >
                    <option value="">
                      {suppliersLoading ? '正在加载供应商' : suppliers.length > 0 ? '请选择供应商' : '请先在系统设置中配置供应商'}
                    </option>
                    {form.supplier && !suppliers.some(item => item.name === form.supplier) && <option value={form.supplier}>{form.supplier}（历史供应商）</option>}
                    {suppliers.map(item => <option key={item._id} value={item.name}>{item.name}</option>)}
                  </select>
                  {suppliersError && <p className="mt-1 text-[11px] text-[#E34D59]">{suppliersError}</p>}
                </div>
                <div>
                  <FieldLabel required hint="默认当前登录用户">采购责任人</FieldLabel>
                  <select value={form.owner} onChange={event => setForm(prev => ({ ...prev, owner: event.target.value }))} className={fieldClass}>
                    <option value="">请选择责任人</option>
                    {ownerOptions.map(item => <option key={item} value={item}>{item}</option>)}
                  </select>
                </div>
                <div>
                  <FieldLabel required>采购货品品牌</FieldLabel>
                  <select value={form.brand} onChange={event => updateBrand(event.target.value)} className={fieldClass}>
                    <option value="">请选择品牌</option>
                    {form.brand && !catalog.some(item => item.brand === form.brand) && <option value={form.brand}>{form.brand}（历史品牌）</option>}
                    {catalog.map(item => <option key={item.brand} value={item.brand}>{item.brand}</option>)}
                  </select>
                </div>
                <div>
                  <FieldLabel required>采购型号</FieldLabel>
                  <select value={form.model} disabled={!form.brand} onChange={event => updateModel(event.target.value)} className={fieldClass}>
                    <option value="">{form.brand ? '请选择型号' : '请先选择品牌'}</option>
                    {form.model && !productOptions.some(item => item.name === form.model) && <option value={form.model}>{form.model}（历史型号）</option>}
                    {productOptions.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
                  </select>
                </div>
                <div>
                  <FieldLabel required>规格</FieldLabel>
                  <select value={form.specification} disabled={!form.model} onChange={event => setForm(prev => ({ ...prev, specification: event.target.value }))} className={fieldClass}>
                    <option value="">{form.model ? '请选择规格' : '请先选择型号'}</option>
                    {form.specification && !specOptions.some(item => item.name === form.specification) && <option value={form.specification}>{form.specification}（历史规格）</option>}
                    {specOptions.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
                  </select>
                </div>
                <div>
                  <FieldLabel required>数量</FieldLabel>
                  <input type="number" min={Math.max(1, editingPurchase?.returnedQuantity || 0)} value={form.quantity} onChange={event => setForm(prev => ({ ...prev, quantity: Number(event.target.value) }))} className={fieldClass} />
                  {!!editingPurchase?.returnedQuantity && <p className="mt-1 text-[11px] text-[#8A94A6]">已退 {editingPurchase.returnedQuantity} 台，修改后数量不能低于已退数量</p>}
                </div>
                <div>
                  <FieldLabel required>采购单价</FieldLabel>
                  <input type="number" min={0} step="0.01" value={form.unitPrice} onChange={event => setForm(prev => ({ ...prev, unitPrice: Number(event.target.value) }))} className={fieldClass} />
                </div>
                <div>
                  <FieldLabel>采购总价（自动）</FieldLabel>
                  <div className="flex h-9 items-center rounded-lg border border-[#EEF0F2] bg-[#FAFBFC] px-2.5 text-[13px] font-medium text-[#1F2733]">{formatMoney(form.quantity * form.unitPrice)}</div>
                </div>
              </div>
            </div>
            <div className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-[#EEF0F2] bg-[#FAFBFC] px-5 py-3.5">
              <button type="button" onClick={closePurchaseForm} className="h-9 rounded-lg border border-[#E1E4E8] bg-white px-4 text-[13px] text-[#6B7280] hover:text-[#374151]">取消</button>
              <button type="button" disabled={saving} onClick={submitPurchase} className="h-9 rounded-lg bg-[#0052D9] px-5 text-[13px] font-medium text-white hover:bg-[#266FE8] disabled:cursor-wait disabled:opacity-60">{saving ? '保存中...' : editingPurchase ? '保存修改' : '保存采购单'}</button>
            </div>
          </section>
        </div>
      )}

      {detail && (
        <div className="fixed inset-0 z-40 bg-[rgba(15,23,42,0.35)]" role="presentation" onMouseDown={event => event.target === event.currentTarget && setDetail(null)}>
          <aside role="dialog" aria-modal="true" aria-labelledby="purchase-detail-title" className="absolute inset-y-0 right-0 flex w-[460px] max-w-[92vw] flex-col bg-white shadow-[-8px_0_32px_rgba(0,0,0,0.12)]">
            <div className="flex flex-shrink-0 items-center justify-between border-b border-[#EEF0F2] px-5 py-4">
              <div>
                <h2 id="purchase-detail-title" className="text-base font-semibold text-[#1F2733]">采购单详情</h2>
                <p className="mt-0.5 text-[12.5px] text-[#8A94A6]">{detail.purchaseNumber}</p>
              </div>
              <button type="button" aria-label="关闭采购单详情" onClick={() => setDetail(null)} className="flex h-7 w-7 items-center justify-center rounded-lg text-[#8A94A6] hover:bg-[#F0F1F3] hover:text-[#374151]"><X size={16} /></button>
            </div>
            <div className="flex-1 overflow-auto p-5">
              <div className="mb-[18px] flex items-baseline justify-between rounded-xl border border-[#D6E4FF] bg-[#F5F9FF] px-4 py-3.5">
                <span className="text-[12.5px] text-[#4B72B0]">当前应付金额</span>
                <span className="text-[22px] font-semibold text-[#0052D9]">{formatMoney(detail.payableAmount ?? detail.quantity * detail.unitPrice)}</span>
              </div>
              {[
                { title: '基础信息', items: [['采购单号', detail.purchaseNumber], ['采购日期', detail.date], ['采购属性', detail.purchaseType === 'recycle' ? '回收' : '采购'], ['供货商名称', detail.supplier], ['采购责任人', detail.owner]] },
                { title: '货品信息', items: [['品牌', detail.brand], ['型号', detail.model], ['规格', detail.specification], ['数量', String(detail.quantity)]] },
                { title: '应付清单', items: [
                  ['采购单价', formatMoney(detail.unitPrice)],
                  ['采购原数量', String(detail.quantity)],
                  ['退回供应商', `${detail.returnedQuantity || 0} 台`],
                  ['应付数量', `${detail.payableQuantity ?? detail.quantity} 台`],
                  ['采购原金额', formatMoney(detail.totalAmount || detail.quantity * detail.unitPrice)],
                  ['退货扣减', `-${formatMoney(detail.returnDeduction || 0)}`],
                  ['应付金额', formatMoney(detail.payableAmount ?? detail.quantity * detail.unitPrice)],
                ] },
                { title: '付款信息', items: detail.paymentStatus === 'paid' && detail.payment
                  ? [['付款状态', '已付款'], ['付款日期', detail.payment.date], ['付款金额', formatMoney(detail.payment.amount)], ['付款明细', detail.payment.splits?.length ? detail.payment.splits.map(item => `${item.account} ${formatMoney(item.amount)}`).join('；') : detail.payment.account], ['确认人员', detail.payment.confirmedByName || detail.payment.confirmedBy], ['付款备注', detail.payment.remark || '-']]
                  : [['付款状态', detail.paymentStatus === 'no_payment' ? '全部退回，无需付款' : '待付款']] },
              ].map(section => (
                <section key={section.title} className="mb-[18px]">
                  <h3 className="mb-2 text-[11.5px] font-medium tracking-[0.04em] text-[#9AA3B2]">{section.title}</h3>
                  <div className="overflow-hidden rounded-xl border border-[#EEF0F2]">
                    {section.items.map(([label, value], index) => (
                      <div key={label} className={`flex justify-between gap-3 bg-white px-3.5 py-2.5 text-[13px] ${index < section.items.length - 1 ? 'border-b border-[#F5F6F8]' : ''}`}>
                        <span className="flex-shrink-0 text-[#8A94A6]">{label}</span>
                        <span className="text-right text-[#1F2733]">{value}</span>
                      </div>
                    ))}
                  </div>
                </section>
              ))}

              {(detail.adjustments || []).length > 0 && (
                <section className="mb-[18px]">
                  <h3 className="mb-2 text-[11.5px] font-medium tracking-[0.04em] text-[#9AA3B2]">供应商退货</h3>
                  <div className="space-y-2">
                    {[...(detail.adjustments || [])].reverse().map(item => (
                      <div key={item.id} className="rounded-xl border border-[#F3D8C7] bg-[#FFF9F5] px-3.5 py-3 text-[12.5px]">
                        <div className="flex items-center justify-between gap-3"><span className="font-medium text-[#9A4D18]">退回 {item.quantity} 台 · {item.reason}</span><span className="text-[#9AA3B2]">{formatDateTime(item.operatedAt)}</span></div>
                        {item.remark && <p className="mt-1.5 text-[#6B7280]">{item.remark}</p>}
                        <p className="mt-1 text-[#9AA3B2]">操作用户：{item.operatorName || item.operatorId || '-'}</p>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section className="mb-[18px]">
                <h3 className="mb-2 text-[11.5px] font-medium tracking-[0.04em] text-[#9AA3B2]">操作记录</h3>
                <div className="rounded-xl border border-[#EEF0F2] px-3.5 py-3">
                  {[...(detail.operations || [])]
                    .sort((a, b) => String(b.operatedAt).localeCompare(String(a.operatedAt)))
                    .map((operation, index, list) => (
                      <div key={`${operation.operatedAt}-${index}`} className="relative flex gap-3 pb-4 last:pb-0">
                        <div className="relative mt-1.5 flex w-2.5 shrink-0 justify-center">
                          <span className={`z-10 h-2.5 w-2.5 rounded-full ${operation.action === 'payment_confirmed' ? 'bg-[#168267]' : operation.action === 'supplier_return' ? 'bg-[#ED7B2F]' : 'bg-[#0052D9]'}`} />
                          {index < list.length - 1 && <span className="absolute left-[4px] top-2.5 h-[calc(100%+6px)] w-px bg-[#E1E4E8]" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium text-[#1F2733]">{operation.content}</div>
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-[#8A94A6]">
                            <span>{formatDateTime(operation.operatedAt)}</span>
                            <span>操作用户：{operation.operatorName || operation.operatorId || '-'}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  {(detail.operations || []).length === 0 && <div className="py-2 text-center text-[12.5px] text-[#B5BBC5]">暂无操作记录</div>}
                </div>
              </section>
            </div>
            <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[#EEF0F2] bg-[#FAFBFC] px-5 py-3.5">
              <button type="button" disabled={!canDelete || detail.paymentStatus !== 'pending'} onClick={() => removePurchase(detail)} className="h-9 rounded-lg border border-[#F3C0C5] bg-white px-4 text-[13px] text-[#E34D59] hover:bg-[#FDECEE] disabled:cursor-not-allowed disabled:opacity-40">删除</button>
              <button type="button" disabled={!canEdit || detail.paymentStatus !== 'pending'} onClick={() => openEdit(detail)} className="h-9 rounded-lg border border-[#B8CDF5] bg-white px-4 text-[13px] text-[#0052D9] hover:bg-[#F0F4FE] disabled:cursor-not-allowed disabled:opacity-40">编辑</button>
              <button type="button" disabled={!canReturn || detail.paymentStatus !== 'pending'} onClick={() => openReturn(detail)} className="h-9 rounded-lg border border-[#D5D9E0] bg-white px-4 text-[13px] text-[#6B7280] hover:bg-[#F0F1F3] disabled:cursor-not-allowed disabled:opacity-40">退货调整</button>
              <button type="button" disabled={detail.paymentStatus === 'pending' && !canConfirmPayment} onClick={() => openPayment(detail)} className="h-9 rounded-lg border border-[#A7DCCB] bg-white px-4 text-[13px] text-[#168267] hover:bg-[#E8F8F2] disabled:cursor-not-allowed disabled:opacity-40">
                {detail.paymentStatus === 'paid' ? '查看付款信息' : '查看应付清单'}
              </button>
              <button type="button" onClick={() => setDetail(null)} className="h-9 rounded-lg bg-[#0052D9] px-5 text-[13px] font-medium text-white hover:bg-[#266FE8]">关闭</button>
            </div>
          </aside>
        </div>
      )}

      {returnTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.48)] p-4" role="presentation" onMouseDown={event => event.target === event.currentTarget && setReturnTarget(null)}>
          <section role="dialog" aria-modal="true" aria-labelledby="supplier-return-title" className="w-[560px] max-w-[94vw] overflow-hidden rounded-2xl bg-white shadow-[0_24px_64px_rgba(0,0,0,0.24)]">
            <div className="flex items-center justify-between border-b border-[#EEF0F2] px-5 py-4">
              <div>
                <h2 id="supplier-return-title" className="text-base font-semibold text-[#1F2733]">供应商退货调整</h2>
                <p className="mt-0.5 text-[12.5px] text-[#8A94A6]">{returnTarget.purchaseNumber} · {returnTarget.supplier}</p>
              </div>
              <button type="button" aria-label="关闭退货调整" onClick={() => setReturnTarget(null)} className="flex h-7 w-7 items-center justify-center rounded-lg text-[#8A94A6] hover:bg-[#F0F1F3]"><X size={16} /></button>
            </div>
            <div className="space-y-4 px-6 py-5">
              <div className="grid grid-cols-3 gap-2 rounded-xl border border-[#F3D8C7] bg-[#FFF9F5] px-4 py-3 text-center">
                <div><div className="text-[11.5px] text-[#9AA3B2]">采购数量</div><div className="mt-1 font-medium text-[#1F2733]">{returnTarget.quantity} 台</div></div>
                <div><div className="text-[11.5px] text-[#9AA3B2]">已退数量</div><div className="mt-1 font-medium text-[#ED7B2F]">{returnTarget.returnedQuantity || 0} 台</div></div>
                <div><div className="text-[11.5px] text-[#9AA3B2]">当前可退</div><div className="mt-1 font-medium text-[#0052D9]">{returnTarget.payableQuantity ?? returnTarget.quantity} 台</div></div>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <FieldLabel required>本次退回数量</FieldLabel>
                  <input type="number" min={1} max={returnTarget.payableQuantity} value={returnForm.quantity} onChange={event => setReturnForm(prev => ({ ...prev, quantity: Number(event.target.value) }))} className={fieldClass} />
                </div>
                <div>
                  <FieldLabel required>退货原因</FieldLabel>
                  <select value={returnForm.reason} onChange={event => setReturnForm(prev => ({ ...prev, reason: event.target.value }))} className={fieldClass}>
                    <option value="">请选择原因</option>
                    {['质检不合格', '功能异常', '外观不符', '型号规格不符', '其他'].map(item => <option key={item} value={item}>{item}</option>)}
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <FieldLabel>调整备注</FieldLabel>
                  <textarea value={returnForm.remark} onChange={event => setReturnForm(prev => ({ ...prev, remark: event.target.value }))} placeholder="可填写具体检测问题或退货说明" className="min-h-[76px] w-full resize-y rounded-lg border border-[#E1E4E8] px-2.5 py-2 text-[13px] text-[#374151] outline-none focus:border-[#0052D9]" />
                </div>
              </div>
              <div className="rounded-lg bg-[#F5F6F8] px-3 py-2.5 text-[12.5px] text-[#6B7280]">
                登记后预计应付：{Math.max(0, (returnTarget.payableQuantity ?? returnTarget.quantity) - returnForm.quantity)} 台，{formatMoney(Math.max(0, (returnTarget.payableQuantity ?? returnTarget.quantity) - returnForm.quantity) * returnTarget.unitPrice)}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-[#EEF0F2] bg-[#FAFBFC] px-5 py-3.5">
              <button type="button" onClick={() => setReturnTarget(null)} className="h-9 rounded-lg border border-[#E1E4E8] bg-white px-4 text-[13px] text-[#6B7280]">取消</button>
              <button type="button" disabled={returnSaving} onClick={submitReturn} className="h-9 rounded-lg bg-[#ED7B2F] px-5 text-[13px] font-medium text-white hover:bg-[#D96D24] disabled:cursor-wait disabled:opacity-60">{returnSaving ? '提交中...' : '确认退货调整'}</button>
            </div>
          </section>
        </div>
      )}

      {paymentTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.48)] p-4" role="presentation" onMouseDown={event => event.target === event.currentTarget && setPaymentTarget(null)}>
          <section role="dialog" aria-modal="true" aria-labelledby="payment-confirm-title" className="flex max-h-[90vh] w-[620px] max-w-[94vw] flex-col overflow-hidden rounded-2xl bg-white shadow-[0_24px_64px_rgba(0,0,0,0.24)]">
            <div className="flex items-center justify-between border-b border-[#EEF0F2] px-5 py-4">
              <div>
                <h2 id="payment-confirm-title" className="text-base font-semibold text-[#1F2733]">{paymentTarget.paymentStatus === 'paid' ? '付款信息' : paymentStep === 1 ? '核对付款清单' : '确认付款'}</h2>
                <p className="mt-0.5 text-[12.5px] text-[#8A94A6]">{paymentTarget.purchaseNumber} · {paymentTarget.supplier}</p>
              </div>
              <button type="button" aria-label="关闭付款确认" onClick={() => setPaymentTarget(null)} className="flex h-7 w-7 items-center justify-center rounded-lg text-[#8A94A6] hover:bg-[#F0F1F3]"><X size={16} /></button>
            </div>

            <div className="flex-1 overflow-auto px-6 py-5">
              {paymentStep === 1 && paymentTarget.paymentStatus !== 'paid' ? (
                <div className="space-y-4">
                  <div className="rounded-lg border border-[#D6E4FF] bg-[#F5F9FF] px-3.5 py-3 text-[12.5px] text-[#4B72B0]">请先核对采购数量、供应商退货和最终应付金额。确认清单无误后，才能进入付款操作。</div>
                  <div className="overflow-hidden rounded-xl border border-[#EEF0F2]">
                    {[
                      ['供应商', paymentTarget.supplier],
                      ['采购货品', `${paymentTarget.brand} ${paymentTarget.model} ${paymentTarget.specification}`],
                      ['采购原数量', `${paymentTarget.quantity} 台`],
                      ['退回供应商', `${paymentTarget.returnedQuantity || 0} 台`],
                      ['应付数量', `${paymentTarget.payableQuantity ?? paymentTarget.quantity} 台`],
                      ['采购单价', formatMoney(paymentTarget.unitPrice)],
                      ['采购原金额', formatMoney(paymentTarget.totalAmount || paymentTarget.quantity * paymentTarget.unitPrice)],
                      ['退货扣减', `-${formatMoney(paymentTarget.returnDeduction || 0)}`],
                    ].map(([label, value]) => (
                      <div key={label} className="flex justify-between gap-4 border-b border-[#F3F4F6] px-4 py-2.5 text-[13px] last:border-b-0"><span className="text-[#8A94A6]">{label}</span><span className="text-right text-[#1F2733]">{value}</span></div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between rounded-xl border border-[#A7DCCB] bg-[#F0FAF6] px-4 py-3.5">
                    <span className="text-[13px] font-medium text-[#397D68]">最终应付金额</span>
                    <span className="text-[22px] font-semibold text-[#168267]">{formatMoney(paymentTarget.payableAmount ?? paymentTarget.quantity * paymentTarget.unitPrice)}</span>
                  </div>
                  {paymentTarget.paymentStatus === 'no_payment' && <div className="rounded-lg border border-[#D5D9E0] bg-[#F5F6F8] px-3.5 py-3 text-[13px] text-[#6B7280]">该采购单商品已全部退回供应商，无需付款。</div>}
                </div>
              ) : (
                <>
                  <div className="mb-4 flex items-center justify-between rounded-xl border border-[#D6E4FF] bg-[#F5F9FF] px-4 py-3">
                    <span className="text-[13px] text-[#4B72B0]">清单确认应付</span>
                    <span className="text-xl font-semibold text-[#0052D9]">{formatMoney(paymentTarget.payableAmount ?? paymentTarget.quantity * paymentTarget.unitPrice)}</span>
                  </div>
                  <div><FieldLabel required>付款日期</FieldLabel><input type="date" value={paymentForm.date} disabled={paymentTarget.paymentStatus === 'paid'} onChange={event => setPaymentForm(prev => ({ ...prev, date: event.target.value }))} className={`${fieldClass} max-w-[220px]`} /></div>
                  <div className="mt-4">
                    <div className="mb-2 flex items-center justify-between">
                      <FieldLabel required>多账户付款明细</FieldLabel>
                      {paymentTarget.paymentStatus !== 'paid' && <button type="button" onClick={() => setPaymentForm(prev => ({ ...prev, splits: [...prev.splits, { account: '', amount: 0 }] }))} className="inline-flex items-center gap-1 text-[12.5px] text-[#0052D9]"><Plus size={14} /> 添加账户</button>}
                    </div>
                    <div className="space-y-2">
                      {paymentForm.splits.map((split, index) => (
                        <div key={index} className="grid grid-cols-[minmax(0,1fr)_140px_28px] gap-2">
                          <select value={split.account} disabled={paymentTarget.paymentStatus === 'paid'} onChange={event => setPaymentForm(prev => ({ ...prev, splits: prev.splits.map((item, itemIndex) => itemIndex === index ? { ...item, account: event.target.value } : item) }))} className={fieldClass}>
                            <option value="">请选择收款账户</option>
                            {split.account && !paymentAccountOptions.some(item => item.value === split.account) && <option value={split.account}>{split.account}（历史账户）</option>}
                            {paymentAccountOptions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                          </select>
                          <input type="number" min={0.01} step="0.01" value={split.amount} disabled={paymentTarget.paymentStatus === 'paid'} onChange={event => setPaymentForm(prev => ({ ...prev, splits: prev.splits.map((item, itemIndex) => itemIndex === index ? { ...item, amount: Number(event.target.value) } : item) }))} className={fieldClass} aria-label={`账户 ${index + 1} 付款金额`} />
                          <button type="button" aria-label={`移除账户 ${index + 1}`} disabled={paymentTarget.paymentStatus === 'paid' || paymentForm.splits.length === 1} onClick={() => setPaymentForm(prev => ({ ...prev, splits: prev.splits.filter((_, itemIndex) => itemIndex !== index) }))} className="flex h-9 items-center justify-center rounded-lg text-[#E34D59] hover:bg-[#FDECEE] disabled:opacity-30"><X size={15} /></button>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex flex-wrap justify-end gap-x-4 gap-y-1 rounded-lg bg-[#F5F6F8] px-3 py-2 text-[12.5px]">
                      <span className="text-[#6B7280]">付款合计：<strong className="text-[#1F2733]">{formatMoney(paymentSplitTotal)}</strong></span>
                      <span className={Math.abs(paymentRemaining) < 0.001 ? 'text-[#168267]' : 'text-[#E34D59]'}>{paymentRemaining >= 0 ? '待分配' : '超出'}：{formatMoney(Math.abs(paymentRemaining))}</span>
                    </div>
                  </div>
                  <div className="mt-4"><FieldLabel>付款备注</FieldLabel><textarea value={paymentForm.remark} disabled={paymentTarget.paymentStatus === 'paid'} onChange={event => setPaymentForm(prev => ({ ...prev, remark: event.target.value }))} placeholder="可填写流水号、付款说明等" className="min-h-[76px] w-full resize-y rounded-lg border border-[#E1E4E8] bg-white px-2.5 py-2 text-[13px] text-[#374151] outline-none focus:border-[#0052D9] disabled:bg-[#FAFBFC]" /></div>
                  <div className="mt-4">
                    <FieldLabel required>付款凭证</FieldLabel>
                    {paymentTarget.paymentStatus !== 'paid' ? (
                      <>
                        <input ref={voucherInputRef} type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={handleVoucherSelect} />
                        <button type="button" onClick={() => voucherInputRef.current?.click()} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#B8CDF5] bg-white px-3 text-[13px] text-[#0052D9] hover:bg-[#F0F4FE]"><Upload size={15} /> 选择凭证</button>
                        <span className="ml-2 text-[11.5px] text-[#9AA3B2]">支持图片或 PDF，单个不超过 10MB，最多 5 份</span>
                        {voucherFiles.length > 0 && <div className="mt-3 space-y-2">{voucherFiles.map((file, index) => <div key={`${file.name}-${index}`} className="flex items-center justify-between rounded-lg border border-[#EEF0F2] bg-[#FAFBFC] px-3 py-2 text-[13px]"><span className="flex min-w-0 items-center gap-2 text-[#4B5563]"><FileText size={15} className="shrink-0 text-[#8A94A6]" /><span className="truncate">{file.name}</span></span><button type="button" onClick={() => setVoucherFiles(prev => prev.filter((_, itemIndex) => itemIndex !== index))} className="ml-3 shrink-0 text-[12px] text-[#E34D59]">移除</button></div>)}</div>}
                      </>
                    ) : voucherLoading ? <div className="rounded-lg border border-[#EEF0F2] px-3 py-4 text-center text-[13px] text-[#8A94A6]">正在加载凭证...</div> : (
                      <div className="space-y-2">{voucherUrls.map(item => <button key={item.fileID} type="button" disabled={!item.tempFileURL} onClick={() => setVoucherPreview(item)} className="flex w-full items-center justify-between gap-2 rounded-lg border border-[#EEF0F2] bg-[#FAFBFC] px-3 py-2 text-left text-[13px] text-[#0052D9] hover:border-[#B8CDF5] disabled:text-[#9AA3B2]"><span className="flex min-w-0 items-center gap-2"><FileText size={15} className="shrink-0" /><span className="truncate">{item.fileName}</span></span><span className="shrink-0 text-[12px]">预览</span></button>)}{voucherUrls.length === 0 && <div className="rounded-lg border border-[#EEF0F2] px-3 py-4 text-center text-[13px] text-[#B5BBC5]">暂无付款凭证</div>}</div>
                    )}
                  </div>
                  {paymentTarget.paymentStatus === 'paid' && paymentTarget.payment && <p className="mt-4 text-[12px] text-[#8A94A6]">由 {paymentTarget.payment.confirmedByName || paymentTarget.payment.confirmedBy || '-'} 于 {formatDateTime(paymentTarget.payment.confirmedAt)} 确认</p>}
                </>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-[#EEF0F2] bg-[#FAFBFC] px-5 py-3.5">
              <button type="button" onClick={() => setPaymentTarget(null)} className="h-9 rounded-lg border border-[#E1E4E8] bg-white px-4 text-[13px] text-[#6B7280]">关闭</button>
              {paymentTarget.paymentStatus === 'pending' && paymentStep === 1 && <button type="button" onClick={() => setPaymentStep(2)} className="h-9 rounded-lg bg-[#0052D9] px-5 text-[13px] font-medium text-white hover:bg-[#266FE8]">确认清单，继续付款</button>}
              {paymentTarget.paymentStatus === 'pending' && paymentStep === 2 && <><button type="button" onClick={() => setPaymentStep(1)} className="h-9 rounded-lg border border-[#E1E4E8] bg-white px-4 text-[13px] text-[#6B7280]">返回清单</button><button type="button" disabled={paymentSaving} onClick={submitPayment} className="h-9 rounded-lg bg-[#168267] px-5 text-[13px] font-medium text-white hover:bg-[#13735A] disabled:cursor-wait disabled:opacity-60">{paymentSaving ? '提交中...' : '确认已付款'}</button></>}
            </div>
          </section>
        </div>
      )}

      <Dialog
        header="导出采购单"
        visible={exportVisible}
        onClose={() => setExportVisible(false)}
        width="560px"
        footer={null}
      >
        <div className="space-y-4">
          <div className="mb-2 flex items-center justify-center gap-0">
            {[1, 2, 3].map(step => (
              <div key={step} className="flex items-center">
                <div className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium ${
                  step <= exportStep ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-500'
                }`}>
                  {step < exportStep ? '✓' : step}
                </div>
                {step < 3 && <div className={`mx-1 h-0.5 w-16 ${step < exportStep ? 'bg-blue-500' : 'bg-gray-200'}`} />}
              </div>
            ))}
          </div>
          <div className="mb-4 text-center text-xs text-gray-400">
            {['选择日期范围', '选择供货商', '选择责任人'][exportStep - 1]}
          </div>

          {exportStep === 1 && (
            <div className="space-y-3">
              <p className="text-sm text-gray-500">选择需要导出的采购日期范围，最多支持半年的数据导出。</p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-xs text-gray-500">开始日期 <span className="text-red-500">*</span></label>
                  <input
                    type="date"
                    value={exportDateStart}
                    onChange={event => setExportDateStart(event.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">结束日期 <span className="text-red-500">*</span></label>
                  <input
                    type="date"
                    value={exportDateEnd}
                    onChange={event => setExportDateEnd(event.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {([
                  { label: '近1个月', days: 30 },
                  { label: '近3个月', days: 90 },
                  { label: '近半年', days: 183 },
                ] as const).map(option => (
                  <Button
                    key={option.days}
                    size="small"
                    variant="outline"
                    onClick={() => {
                      const today = new Date();
                      const end = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
                      const start = new Date(today);
                      start.setDate(start.getDate() - option.days);
                      setExportDateEnd(end);
                      setExportDateStart(`${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`);
                    }}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {exportStep === 2 && (
            <div className="space-y-3">
              <p className="text-sm text-gray-500">选择需要导出的供货商，不选择则导出全部供货商。</p>
              <div className="grid max-h-[240px] grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3">
                {exportSupplierOptions.map(supplier => {
                  const selected = exportSuppliers.includes(supplier);
                  return (
                    <button
                      key={supplier}
                      type="button"
                      title={supplier}
                      className={`truncate rounded-lg border px-3 py-2 text-sm ${
                        selected ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                      }`}
                      onClick={() => setExportSuppliers(previous =>
                        selected ? previous.filter(item => item !== supplier) : [...previous, supplier]
                      )}
                    >
                      {supplier}
                    </button>
                  );
                })}
              </div>
              {exportSupplierOptions.length === 0 && <div className="py-8 text-center text-sm text-gray-400">暂无供货商</div>}
            </div>
          )}

          {exportStep === 3 && (
            <div className="space-y-3">
              <p className="text-sm text-gray-500">选择需要导出的责任人，不选择则导出全部责任人。</p>
              <div className="grid max-h-[240px] grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-4">
                {ownerOptions.map(owner => {
                  const selected = exportOwners.includes(owner);
                  return (
                    <button
                      key={owner}
                      type="button"
                      title={owner}
                      className={`truncate rounded-lg border px-3 py-2 text-sm ${
                        selected ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                      }`}
                      onClick={() => setExportOwners(previous =>
                        selected ? previous.filter(item => item !== owner) : [...previous, owner]
                      )}
                    >
                      {owner}
                    </button>
                  );
                })}
              </div>
              {ownerOptions.length === 0 && <div className="py-8 text-center text-sm text-gray-400">暂无责任人</div>}
            </div>
          )}

          <div className="flex items-center justify-between border-t border-gray-100 pt-4">
            <div>
              {exportStep > 1 && (
                <Button
                  variant="outline"
                  icon={<ChevronLeft size={14} />}
                  onClick={() => setExportStep(previous => (previous - 1) as 1 | 2)}
                >
                  上一步
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button onClick={() => setExportVisible(false)}>取消</Button>
              {exportStep < 3 ? (
                <Button
                  theme="primary"
                  icon={<ChevronRight size={14} />}
                  onClick={() => {
                    if (exportStep === 1) {
                      const error = validateExportDate();
                      if (error) {
                        MessagePlugin.warning(error);
                        return;
                      }
                    }
                    setExportStep(previous => (previous + 1) as 2 | 3);
                  }}
                >
                  下一步
                </Button>
              ) : (
                <Button
                  theme="primary"
                  icon={<FileDown size={14} />}
                  loading={exporting}
                  onClick={exportPurchases}
                >
                  导出 Excel
                </Button>
              )}
            </div>
          </div>
        </div>
      </Dialog>

      {voucherPreview && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(15,23,42,0.62)] p-4" role="presentation" onMouseDown={event => event.target === event.currentTarget && setVoucherPreview(null)}>
          <section role="dialog" aria-modal="true" aria-labelledby="voucher-preview-title" className="flex h-[86vh] w-[900px] max-w-[96vw] flex-col overflow-hidden rounded-2xl bg-white shadow-[0_24px_72px_rgba(0,0,0,0.32)]">
            <div className="flex items-center justify-between gap-4 border-b border-[#EEF0F2] px-5 py-3.5">
              <div className="min-w-0">
                <h2 id="voucher-preview-title" className="truncate text-[15px] font-semibold text-[#1F2733]">付款凭证预览</h2>
                <p className="mt-0.5 truncate text-[12px] text-[#8A94A6]">{voucherPreview.fileName}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button type="button" onClick={() => window.open(voucherPreview.tempFileURL, '_blank', 'noopener,noreferrer')} className="h-8 rounded-lg border border-[#D6E4FF] bg-white px-3 text-[12.5px] text-[#0052D9] hover:bg-[#F0F4FE]">单独打开</button>
                <button type="button" aria-label="关闭凭证预览" onClick={() => setVoucherPreview(null)} className="flex h-8 w-8 items-center justify-center rounded-lg text-[#8A94A6] hover:bg-[#F0F1F3]"><X size={17} /></button>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[#F5F6F8] p-4">
              {voucherPreview.fileName.toLowerCase().endsWith('.pdf') ? (
                <iframe title={voucherPreview.fileName} src={voucherPreview.tempFileURL} className="h-full w-full rounded-lg border-0 bg-white" />
              ) : (
                <img src={voucherPreview.tempFileURL} alt={voucherPreview.fileName} className="max-h-full max-w-full rounded-lg object-contain shadow-sm" />
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
