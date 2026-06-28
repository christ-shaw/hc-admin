import { useEffect, useMemo, useState, useRef } from 'react';
import { Table, Button, Input, Select, Tag, Dialog, MessagePlugin } from 'tdesign-react';
import { Search, RotateCcw, Plus, Eye, Download, Upload, X, ChevronRight, ChevronLeft, Check } from 'lucide-react';
import { InvoiceRecord, InvoiceFilters, CompanyTemplate, InvoiceFile, dictToOptions, getDictLabel } from '../types';
import { useInvoices } from '../hooks/useInvoices';
import { callFunction, getCurrentOperatorName, uploadToCloudStorage, getCloudFileURLs } from '../lib/cloudbase';
import { formatDate } from '../utils/format';
import { DICT_CODES, useDictionaries } from '../contexts/DictionaryContext';

const STATUS_TAG_THEME: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
  paid: 'success',
  unpaid: 'warning',
  '已开票': 'success',
  '未开票': 'warning',
};

const INVOICE_IMAGE_ACCEPT = '.bmp,.bpm,.png,.jpg,.jpeg,image/bmp,image/x-ms-bmp,image/png,image/jpeg';
const INVOICE_IMAGE_EXTENSIONS = ['bmp', 'bpm', 'png', 'jpg', 'jpeg'];

function isInvoicePaid(status: string | undefined): boolean {
  return status === 'paid' || status === '已开票';
}

function normalizeInvoiceStatus(status: string | undefined): InvoiceRecord['status'] {
  if (status === '已开票') return 'paid';
  if (status === '未开票') return 'unpaid';
  return (status || 'unpaid') as InvoiceRecord['status'];
}

const EMPTY_INVOICE: Omit<InvoiceRecord, '_id' | 'createTime'> = {
  applyDate: '',
  companyName: '',
  applicant: '',
  shopName: '',
  status: 'unpaid',
  taxId: '',
  registeredAddress: '',
  contactPhone: '',
  bankName: '',
  bankAccount: '',
  bankCode: '',
  invoiceCategory: '',
  invoiceAmount: 0,
  phoneModel: '',
  phoneQuantity: 0,
  unitPrice: 0,
  attachments: [],
};

export function Invoices() {
  const invoices = useInvoices();
  const dictionaries = useDictionaries();
  const INVOICE_STATUS_MAP = dictionaries.getMap(DICT_CODES.invoiceStatus);
  const invoiceStatusOptions = useMemo(() => dictToOptions(INVOICE_STATUS_MAP), [INVOICE_STATUS_MAP]);
  const invoiceCategoryOptions = dictionaries.getOptions(DICT_CODES.invoiceCategory);
  const shopNameOptions = dictionaries.getOptions(DICT_CODES.shopName);

  const [filters, setFilters] = useState<InvoiceFilters>({});
  const [detailVisible, setDetailVisible] = useState(false);
  const [currentRecord, setCurrentRecord] = useState<InvoiceRecord | null>(null);
  const [addVisible, setAddVisible] = useState(false);
  const [addForm, setAddForm] = useState<Omit<InvoiceRecord, '_id' | 'createTime'>>(EMPTY_INVOICE);
  const [addStep, setAddStep] = useState(1); // 1=选择店铺, 2=公司信息, 3=开票类目和金额, 4=上传附件
  const [editVisible, setEditVisible] = useState(false);
  const [editForm, setEditForm] = useState<Omit<InvoiceRecord, '_id' | 'createTime'>>(EMPTY_INVOICE);
  const [editId, setEditId] = useState('');
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<InvoiceRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [companySuggestions, setCompanySuggestions] = useState<CompanyTemplate[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [companySelected, setCompanySelected] = useState(false);
  const [companyConfirmVisible, setCompanyConfirmVisible] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // 开票上传相关状态
  const [invoiceUploadVisible, setInvoiceUploadVisible] = useState(false);
  const [uploadTarget, setUploadTarget] = useState<InvoiceRecord | null>(null);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // 新增发票 - 附件上传相关状态
  const [addAttachFiles, setAddAttachFiles] = useState<File[]>([]);
  const addAttachInputRef = useRef<HTMLInputElement>(null);

  // 编辑发票 - 附件上传相关状态
  const [editAttachFiles, setEditAttachFiles] = useState<File[]>([]);
  const [editExistingAttachments, setEditExistingAttachments] = useState<InvoiceFile[]>([]);
  const editAttachInputRef = useRef<HTMLInputElement>(null);

  // 预览相关状态
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewRecord, setPreviewRecord] = useState<InvoiceRecord | null>(null);
  const [previewUrls, setPreviewUrls] = useState<Array<{ fileID: string; tempFileURL: string; fileName: string }>>([]);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    invoices.fetchRecords();
  }, []);

  // 点击外部关闭建议列表
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  /** 搜索公司 */
  const searchCompanies = async (keyword: string) => {
    if (!keyword.trim()) {
      setCompanySuggestions([]);
      setShowSuggestions(false);
      return;
    }
    try {
      const result = await callFunction<{ success?: boolean; data: CompanyTemplate[] }>('queryCompanies', {
        data: { companyName: keyword.trim(), limit: 10 },
      });
      const list = result.data || [];
      setCompanySuggestions(list);
      setShowSuggestions(list.length > 0);
    } catch {
      setCompanySuggestions([]);
    }
  };

  /** 公司名称输入变化 */
  const handleCompanyNameChange = (val: string) => {
    setAddForm(prev => ({
      ...prev,
      companyName: val as string,
      taxId: '',
      registeredAddress: '',
      contactPhone: '',
      bankName: '',
      bankAccount: '',
      bankCode: '',
    }));
    setCompanySelected(false);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => searchCompanies(val as string), 300);
  };

  /** 选中公司建议 */
  const handleSelectCompany = (company: CompanyTemplate) => {
    setAddForm(prev => ({
      ...prev,
      companyName: company.companyName,
      taxId: company.taxId || '',
      registeredAddress: company.registeredAddress || '',
      contactPhone: company.contactPhone || '',
      bankName: company.bankName || '',
      bankAccount: company.bankAccount || '',
      bankCode: company.bankCode || '',
    }));
    setCompanySelected(true);
    setShowSuggestions(false);
    setCompanySuggestions([]);
  };

  const handleSearch = () => {
    invoices.resetFilters();
    const searchFilters: InvoiceFilters = { ...filters };
    if (searchFilters.companyName) searchFilters.companyName = searchFilters.companyName.trim();
    if (searchFilters.applicant) searchFilters.applicant = searchFilters.applicant.trim();
    invoices.fetchRecords(null, searchFilters);
  };

  const handleReset = () => {
    setFilters({});
    invoices.resetFilters();
    invoices.fetchRecords(null, {});
  };

  const handleDetail = (record: InvoiceRecord) => {
    setCurrentRecord(record);
    setDetailVisible(true);
  };

  /** 新增 */
  const handleAddOpen = async () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const applicant = await getCurrentOperatorName();
    setAddForm({ ...EMPTY_INVOICE, applyDate: dateStr, applicant });
    setAddStep(1);
    setAddAttachFiles([]);
    setAddVisible(true);
  };

  /** 新增 - 下一步 */
  const handleAddNext = () => {
    if (addStep === 1 && !addForm.shopName) {
      MessagePlugin.warning('请选择店铺');
      return;
    }
    if (addStep === 2 && !addForm.companyName.trim()) {
      MessagePlugin.warning('请填写单位名称');
      return;
    }
    if (addStep === 3) {
      if (!addForm.invoiceCategory) {
        MessagePlugin.warning('请选择开票类目');
        return;
      }
      if (addForm.invoiceCategory === '二手手机') {
        if (!addForm.phoneModel?.trim()) {
          MessagePlugin.warning('请输入手机型号');
          return;
        }
        if (!addForm.phoneQuantity || addForm.phoneQuantity <= 0) {
          MessagePlugin.warning('请输入手机数量');
          return;
        }
        if (!addForm.unitPrice || addForm.unitPrice <= 0) {
          MessagePlugin.warning('请输入单价');
          return;
        }
      }
      if (!addForm.invoiceAmount || addForm.invoiceAmount <= 0) {
        MessagePlugin.warning('请填写开票金额');
        return;
      }
    }
    setAddStep(prev => Math.min(prev + 1, 4));
  };

  /** 新增 - 上一步 */
  const handleAddPrev = () => {
    setAddStep(prev => Math.max(prev - 1, 1));
  };

  const handleAddSave = async () => {
    setSaving(true);
    try {
      // 先上传附件到云存储
      const attachments: InvoiceFile[] = [];
      for (const file of addAttachFiles) {
        const timestamp = Date.now();
        const ext = file.name.split('.').pop() || 'bin';
        const cloudPath = `invoices/attachments/${timestamp}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const fileID = await uploadToCloudStorage(cloudPath, file);
        attachments.push({ fileID, fileName: file.name });
      }

      const formToSave = { ...addForm, attachments };

      if (!companySelected) {
        const queryResult = await callFunction<{ success?: boolean; data: CompanyTemplate[] }>('queryCompanies', {
          data: { companyName: addForm.companyName.trim(), limit: 1 },
        });
        const existing = queryResult.data || [];
        if (existing.length === 0) {
          setSaving(false);
          setCompanyConfirmVisible(true);
          return;
        }
      }
      await doSaveInvoice(formToSave);
    } catch (err) {
      MessagePlugin.error('新增异常: ' + String(err));
      setSaving(false);
    }
  };

  /** 确认保存公司信息并提交发票 */
  const handleCompanyConfirm = async () => {
    setCompanyConfirmVisible(false);
    setSaving(true);
    try {
      await callFunction('saveCompany', {
        data: {
          company: {
            companyName: addForm.companyName.trim(),
            taxId: addForm.taxId || '',
            registeredAddress: addForm.registeredAddress || '',
            contactPhone: addForm.contactPhone || '',
            bankName: addForm.bankName || '',
            bankAccount: addForm.bankAccount || '',
            bankCode: addForm.bankCode || '',
          },
        },
      });

      // 上传附件
      const attachments: InvoiceFile[] = [];
      for (const file of addAttachFiles) {
        const timestamp = Date.now();
        const ext = file.name.split('.').pop() || 'bin';
        const cloudPath = `invoices/attachments/${timestamp}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const fileID = await uploadToCloudStorage(cloudPath, file);
        attachments.push({ fileID, fileName: file.name });
      }

      await doSaveInvoice({ ...addForm, attachments });
    } catch (err) {
      MessagePlugin.error('新增异常: ' + String(err));
      setSaving(false);
    }
  };

  /** 实际保存发票 */
  const doSaveInvoice = async (formToSave?: Omit<InvoiceRecord, '_id' | 'createTime'>) => {
    const result = await invoices.addInvoice(formToSave || addForm);
    if (result.success) {
      MessagePlugin.success('新增发票申请成功');
      setAddVisible(false);
      setAddForm(EMPTY_INVOICE);
      setAddStep(1);
      setAddAttachFiles([]);
      setCompanySelected(false);
    } else {
      MessagePlugin.error('新增失败: ' + (result.errMsg || '未知错误'));
    }
    setSaving(false);
  };

  /** 编辑 */
  const handleEditOpen = (record: InvoiceRecord) => {
    setEditId(record._id);
    setEditExistingAttachments(record.attachments || []);
    setEditAttachFiles([]);
    setEditForm({
      applyDate: record.applyDate,
      companyName: record.companyName,
      applicant: record.applicant,
      shopName: record.shopName,
      status: normalizeInvoiceStatus(record.status),
      taxId: record.taxId,
      registeredAddress: record.registeredAddress,
      contactPhone: record.contactPhone,
      bankName: record.bankName,
      bankAccount: record.bankAccount,
      bankCode: record.bankCode,
      invoiceCategory: record.invoiceCategory,
      invoiceAmount: record.invoiceAmount,
      phoneModel: record.phoneModel || '',
      phoneQuantity: record.phoneQuantity || 0,
      unitPrice: record.unitPrice || 0,
      invoiceFiles: record.invoiceFiles,
      attachments: record.attachments,
      completedTime: record.completedTime,
    });
    setEditVisible(true);
  };

  const handleEditSave = async () => {
    if (!editForm.companyName.trim()) {
      MessagePlugin.warning('请填写单位名称');
      return;
    }
    setSaving(true);
    try {
      // 上传新增附件
      const newAttachments: InvoiceFile[] = [];
      for (const file of editAttachFiles) {
        const timestamp = Date.now();
        const ext = file.name.split('.').pop() || 'bin';
        const cloudPath = `invoices/attachments/${timestamp}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const fileID = await uploadToCloudStorage(cloudPath, file);
        newAttachments.push({ fileID, fileName: file.name });
      }
      const allAttachments = [...editExistingAttachments, ...newAttachments];
      const success = await invoices.updateInvoice(editId, { ...editForm, attachments: allAttachments });
      if (success) {
        MessagePlugin.success('修改发票成功');
        setEditVisible(false);
      } else {
        MessagePlugin.error('修改失败');
      }
    } catch (err) {
      MessagePlugin.error('修改异常: ' + String(err));
    } finally {
      setSaving(false);
    }
  };

  /** 删除 */
  const handleDeleteConfirm = (record: InvoiceRecord) => {
    setDeleteTarget(record);
    setDeleteConfirmVisible(true);
  };

  const handleDeleteExec = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const success = await invoices.deleteInvoice(deleteTarget._id);
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

  /** 开票 - 打开上传弹窗 */
  const handleOpenInvoice = (record: InvoiceRecord) => {
    setUploadTarget(record);
    setUploadFiles([]);
    setInvoiceUploadVisible(true);
  };

  /** 选择上传文件 */
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const selectedFiles = Array.from(files);
    const validFiles = selectedFiles.filter(isSupportedInvoiceImageFile);
    if (validFiles.length < selectedFiles.length) {
      MessagePlugin.warning('仅支持 BMP、PNG、JPEG 格式图片');
    }
    setUploadFiles(prev => [...prev, ...validFiles]);
    // 重置 input 以便再次选择同一文件
    if (uploadInputRef.current) uploadInputRef.current.value = '';
  };

  /** 移除已选文件 */
  const handleRemoveFile = (index: number) => {
    setUploadFiles(prev => prev.filter((_, i) => i !== index));
  };

  /** 确认开票 - 上传文件并更新状态 */
  const handleConfirmInvoice = async () => {
    if (!uploadTarget || uploadFiles.length === 0) {
      MessagePlugin.warning('请选择要上传的电子发票图片');
      return;
    }
    setUploading(true);
    try {
      const invoiceFiles: InvoiceFile[] = [];
      // 串行上传每张图片
      for (const file of uploadFiles) {
        const timestamp = Date.now();
        const ext = file.name.split('.').pop() || 'png';
        const cloudPath = `invoices/invoices_img/${uploadTarget._id}_${timestamp}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const fileID = await uploadToCloudStorage(cloudPath, file);
        invoiceFiles.push({ fileID, fileName: file.name });
      }

      // 更新发票记录：状态改为已开票，保存文件列表和完成时间
      const now = new Date();
      const completedTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const success = await invoices.updateInvoice(uploadTarget._id, {
        status: 'paid',
        invoiceFiles,
        completedTime,
      });
      if (success) {
        MessagePlugin.success('开票成功');
        setInvoiceUploadVisible(false);
        setUploadTarget(null);
        setUploadFiles([]);
      } else {
        MessagePlugin.error('开票失败');
      }
    } catch (err) {
      MessagePlugin.error('开票异常: ' + String(err));
    } finally {
      setUploading(false);
    }
  };

  // 主预览弹窗灯箱状态
  const [previewLightboxSrc, setPreviewLightboxSrc] = useState<string | null>(null);
  const [previewLightboxAlt, setPreviewLightboxAlt] = useState('');

  /** 预览电子发票 */
  const handlePreview = async (record: InvoiceRecord) => {
    setPreviewRecord(record);
    setPreviewVisible(true);
    setPreviewLoading(true);
    setPreviewUrls([]);
    try {
      if (record.invoiceFiles && record.invoiceFiles.length > 0) {
        const fileIDs = record.invoiceFiles.map(f => f.fileID);
        const urls = await getCloudFileURLs(fileIDs);
        setPreviewUrls(urls.map((u, i) => ({
          ...u,
          fileName: record.invoiceFiles![i]?.fileName || `图片${i + 1}`,
        })));
      }
    } catch (err) {
      MessagePlugin.error('获取图片链接失败');
    } finally {
      setPreviewLoading(false);
    }
  };

  /** 下载单张图片 */
  const handleDownloadImage = (url: string, fileName: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const columns = [
    { colKey: 'applyDate', title: '申请日期', width: 110, cell: ({ row }: { row: InvoiceRecord }) => formatDate(row.applyDate, false) },
    { colKey: 'companyName', title: '公司名称', width: 180, ellipsis: true },
    { colKey: 'shopName', title: '店铺名字', width: 100 },
    {
      colKey: 'invoiceAmount',
      title: '开票金额',
      width: 100,
      cell: ({ row }: { row: InvoiceRecord }) => row.invoiceAmount ? `¥${row.invoiceAmount}` : '-',
    },
    { colKey: 'applicant', title: '开票申请人', width: 90 },
    {
      colKey: 'status', title: '开票状态', width: 90,
      cell: ({ row }: { row: InvoiceRecord }) => {
        const theme = STATUS_TAG_THEME[row.status] || 'default';
        return <Tag theme={theme} variant="light">{getDictLabel(INVOICE_STATUS_MAP, row.status)}</Tag>;
      },
    },
    {
      colKey: 'op', title: '操作', width: 280, fixed: 'right' as const,
      cell: ({ row }: { row: InvoiceRecord }) => (
        <div className="flex gap-1 flex-wrap">
          <Button variant="text" theme="primary" size="small"
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleDetail(row); }}>
            详情
          </Button>
          <Button variant="text" theme="primary" size="small"
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleEditOpen(row); }}>
            编辑
          </Button>
          <Button variant="text" theme="danger" size="small"
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleDeleteConfirm(row); }}>
            删除
          </Button>
          {isInvoicePaid(row.status) ? (
            <Button variant="text" theme="primary" size="small"
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); handlePreview(row); }}>
              <Download size={14} className="mr-0.5" />下载
            </Button>
          ) : (
            <Button variant="text" theme="success" size="small"
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleOpenInvoice(row); }}>
              <Upload size={14} className="mr-0.5" />开票
            </Button>
          )}
        </div>
      ),
    },
  ];

  const displayRecords = invoices.getPageRecords(invoices.currentPage);
  const loadedInvoicePages = Math.max(1, Math.ceil(invoices.records.length / 20));
  const canGoNextInvoicePage = invoices.currentPage < loadedInvoicePages || invoices.hasMore;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">发票管理</h1>
          <p className="text-gray-500 mt-1">管理开票申请</p>
        </div>
        <Button theme="primary" icon={<Plus size={16} />} onClick={handleAddOpen}>
          新增发票申请
        </Button>
      </div>

      {/* 筛选栏 */}
      <div className="glass-card p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="w-48">
            <label className="block text-xs text-gray-500 mb-1">公司名称</label>
            <Input placeholder="请输入公司名称" value={filters.companyName || ''}
              onChange={(val) => setFilters(prev => ({ ...prev, companyName: val as string }))} />
          </div>
          <div className="w-40">
            <label className="block text-xs text-gray-500 mb-1">开票申请人</label>
            <Input placeholder="请输入申请人" value={filters.applicant || ''}
              onChange={(val) => setFilters(prev => ({ ...prev, applicant: val as string }))} />
          </div>
          <div className="w-36">
            <label className="block text-xs text-gray-500 mb-1">开票状态</label>
            <Select placeholder="全部" value={filters.status || undefined}
              onChange={(val) => setFilters(prev => ({ ...prev, status: val as string }))}
              options={[{ label: '全部', value: '' }, ...invoiceStatusOptions]}
              popupProps={{ attach: 'body' }} />
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
          loading={invoices.loading}
          rowKey="_id"
          tableLayout="fixed"
          hover
          stripe
        />
        {/* 分页 */}
        <div className="flex justify-center items-center gap-2 py-4 border-t border-gray-100">
          <Button size="small" variant="outline" disabled={invoices.currentPage <= 1}
            onClick={invoices.goPreviousPage}>
            上一页
          </Button>
          <span className="text-sm text-gray-500">第 {invoices.currentPage} 页</span>
          <Button size="small" variant="outline" disabled={!canGoNextInvoicePage || invoices.loading}
            onClick={invoices.goNextPage}>
            下一页
          </Button>
          <span className="text-sm text-gray-400">共 {invoices.totalRecords} 条</span>
        </div>
      </div>

      {/* 详情弹窗 */}
      <Dialog header="发票详情" visible={detailVisible} onClose={() => setDetailVisible(false)} width="600px"
        footer={<Button onClick={() => setDetailVisible(false)}>关闭</Button>}>
        {currentRecord && (
          <div className="space-y-2 text-sm">
            <DetailRow label="申请日期" value={formatDate(currentRecord.applyDate, false)} />
            <DetailRow label="单位名称" value={currentRecord.companyName} />
            <DetailRow label="店铺名字" value={currentRecord.shopName} />
            <DetailRow label="开票申请人" value={currentRecord.applicant} />
            <DetailRow label="开票状态" value={
              <Tag theme={STATUS_TAG_THEME[currentRecord.status] || 'default'} variant="light">
                {getDictLabel(INVOICE_STATUS_MAP, currentRecord.status)}
              </Tag>
            } />
            <DetailRow label="纳税人识别号" value={currentRecord.taxId} />
            <DetailRow label="注册地址" value={currentRecord.registeredAddress} />
            <DetailRow label="联系电话" value={currentRecord.contactPhone} />
            <DetailRow label="开户行名称" value={currentRecord.bankName} />
            <DetailRow label="账号" value={currentRecord.bankAccount} />
            <DetailRow label="开户行行号" value={currentRecord.bankCode} />
            <DetailRow label="开票类目" value={currentRecord.invoiceCategory} />
            {currentRecord.invoiceCategory === '二手手机' && (
              <>
                <DetailRow label="手机型号" value={currentRecord.phoneModel} />
                <DetailRow label="手机数量" value={currentRecord.phoneQuantity} />
                <DetailRow label="单价" value={currentRecord.unitPrice ? `¥${currentRecord.unitPrice}` : '-'} />
              </>
            )}
            <DetailRow label="开票金额" value={currentRecord.invoiceAmount ? `¥${currentRecord.invoiceAmount}` : '-'} />
            {currentRecord.attachments && currentRecord.attachments.length > 0 && (
              <div className="py-2 border-b border-gray-50">
                <span className="text-gray-500 text-sm mb-2 block">开票附件</span>
                <InvoiceAttachmentPreview files={currentRecord.attachments} />
              </div>
            )}
            {isInvoicePaid(currentRecord.status) && (
              <>
                <div className="border-t border-gray-100 pt-3 mt-3">
                  <h4 className="font-medium text-gray-700 mb-2">开票完成信息</h4>
                </div>
                {currentRecord.invoiceFiles && currentRecord.invoiceFiles.length > 0 && (
                  <DetailRow label="电子发票" value={
                    <InvoiceImagePreview files={currentRecord.invoiceFiles} />
                  } />
                )}
                <DetailRow label="开票完成时间" value={currentRecord.completedTime ? formatDate(currentRecord.completedTime) : '-'} />
              </>
            )}
          </div>
        )}
      </Dialog>

      {/* 新增发票弹窗 - 分步向导 */}
      <Dialog
        header="新增发票申请"
        visible={addVisible}
        onClose={() => setAddVisible(false)}
        width="680px"
        footer={
          <div className="flex justify-between">
            <div>
              {addStep > 1 && (
                <Button variant="outline" icon={<ChevronLeft size={16} />} onClick={handleAddPrev}>上一步</Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button onClick={() => setAddVisible(false)}>取消</Button>
              {addStep < 4 ? (
                <Button theme="primary" icon={<ChevronRight size={16} />} onClick={handleAddNext}>下一步</Button>
              ) : (
                <Button theme="primary" loading={saving} icon={<Check size={16} />} onClick={handleAddSave}>提交申请</Button>
              )}
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          {/* 步骤指示器 */}
          <div className="flex items-center justify-center gap-0 mb-2">
            {[
              { step: 1, label: '选择店铺' },
              { step: 2, label: '公司信息' },
              { step: 3, label: '开票类目' },
              { step: 4, label: '上传附件' },
            ].map((item, idx) => (
              <div key={item.step} className="flex items-center">
                <div className="flex flex-col items-center">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                    addStep > item.step
                      ? 'bg-blue-500 text-white'
                      : addStep === item.step
                        ? 'bg-blue-500 text-white'
                        : 'bg-gray-200 text-gray-500'
                  }`}>
                    {addStep > item.step ? <Check size={16} /> : item.step}
                  </div>
                  <span className={`text-xs mt-1 ${addStep >= item.step ? 'text-blue-600 font-medium' : 'text-gray-400'}`}>
                    {item.label}
                  </span>
                </div>
                {idx < 3 && (
                  <div className={`w-16 h-0.5 mx-2 mb-4 ${addStep > item.step ? 'bg-blue-500' : 'bg-gray-200'}`} />
                )}
              </div>
            ))}
          </div>

          {/* 步骤1: 选择店铺 */}
          {addStep === 1 && (
            <div className="py-4">
              <h4 className="text-sm font-medium text-gray-600 mb-4">请选择开票店铺</h4>
              <div className="w-full">
                <label className="block text-xs text-gray-500 mb-1">店铺名字 <span className="text-red-500">*</span></label>
                <Select placeholder="请选择店铺" value={addForm.shopName || undefined}
                  onChange={val => setAddForm(prev => ({ ...prev, shopName: val as string }))}
                  options={shopNameOptions}
                  popupProps={{ attach: 'body' }}
                  size="large" />
              </div>
            </div>
          )}

          {/* 步骤2: 公司信息 */}
          {addStep === 2 && (
            <div className="max-h-[55vh] overflow-auto px-1">
              <div className="mb-4">
                <h4 className="text-sm font-medium text-gray-600 mb-2">公司信息</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2 relative">
                    <label className="block text-xs text-gray-500 mb-1">单位名称 <span className="text-red-500">*</span></label>
                    <Input placeholder="输入单位名称搜索" value={addForm.companyName}
                      onChange={val => handleCompanyNameChange(val as string)} />
                    {showSuggestions && companySuggestions && companySuggestions.length > 0 && (
                      <div ref={suggestionsRef} className="absolute z-50 left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-sm max-h-48 overflow-auto">
                        {companySuggestions.map(company => (
                          <button key={company._id} type="button"
                            className="w-full px-3 py-2 text-left text-sm hover:bg-blue-50 border-b border-gray-100 last:border-0 cursor-pointer"
                            onClick={() => handleSelectCompany(company)}>
                            <div className="font-medium text-gray-800">{company.companyName}</div>
                            <div className="text-xs text-gray-400">{company.taxId}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-gray-500 mb-1">纳税人识别号</label>
                    <Input placeholder="纳税人识别号" value={addForm.taxId}
                      onChange={val => setAddForm(prev => ({ ...prev, taxId: val as string }))} />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-gray-500 mb-1">注册地址</label>
                    <Input placeholder="注册地址" value={addForm.registeredAddress}
                      onChange={val => setAddForm(prev => ({ ...prev, registeredAddress: val as string }))} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">联系电话</label>
                    <Input placeholder="联系电话" value={addForm.contactPhone}
                      onChange={val => setAddForm(prev => ({ ...prev, contactPhone: val as string }))} />
                  </div>
                </div>
              </div>
              <div>
                <h4 className="text-sm font-medium text-gray-600 mb-2">开户行信息</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className="block text-xs text-gray-500 mb-1">开户行名称</label>
                    <Input placeholder="开户行名称" value={addForm.bankName}
                      onChange={val => setAddForm(prev => ({ ...prev, bankName: val as string }))} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">开户行行号</label>
                    <Input placeholder="开户行行号" value={addForm.bankCode}
                      onChange={val => setAddForm(prev => ({ ...prev, bankCode: val as string }))} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">账号</label>
                    <Input placeholder="账号" value={addForm.bankAccount}
                      onChange={val => setAddForm(prev => ({ ...prev, bankAccount: val as string }))} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 步骤3: 开票类目和金额 */}
          {addStep === 3 && (
            <div className="py-4">
              <h4 className="text-sm font-medium text-gray-600 mb-4">开票类目和金额</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs text-gray-500 mb-1">开票类目 <span className="text-red-500">*</span></label>
                  <Select placeholder="请选择开票类目" value={addForm.invoiceCategory || undefined}
                    onChange={val => setAddForm(prev => ({
                      ...prev,
                      invoiceCategory: val as string,
                      // 切换类目时重置相关字段
                      ...(val !== '二手手机' ? { phoneModel: '', phoneQuantity: 0, unitPrice: 0, invoiceAmount: 0 } : {}),
                    }))}
                    options={invoiceCategoryOptions}
                    popupProps={{ attach: 'body', zIndex: 6000 }}
                    size="large" />
                </div>

                {/* 二手手机 - 动态字段 */}
                {addForm.invoiceCategory === '二手手机' && (
                  <>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">手机型号 <span className="text-red-500">*</span></label>
                      <Input placeholder="请输入手机型号" value={addForm.phoneModel || ''}
                        onChange={val => setAddForm(prev => ({ ...prev, phoneModel: val as string }))} />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">手机数量 <span className="text-red-500">*</span></label>
                      <Input type="number" placeholder="请输入数量" value={addForm.phoneQuantity ? String(addForm.phoneQuantity) : ''}
                        onChange={val => {
                          const qty = Number(val) || 0;
                          setAddForm(prev => ({
                            ...prev,
                            phoneQuantity: qty,
                            invoiceAmount: qty * (prev.unitPrice || 0),
                          }));
                        }} />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">单价 <span className="text-red-500">*</span></label>
                      <Input type="number" placeholder="请输入单价" value={addForm.unitPrice ? String(addForm.unitPrice) : ''}
                        onChange={val => {
                          const price = Number(val) || 0;
                          setAddForm(prev => ({
                            ...prev,
                            unitPrice: price,
                            invoiceAmount: (prev.phoneQuantity || 0) * price,
                          }));
                        }} />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">开票金额</label>
                      <Input type="number" placeholder="自动计算" value={addForm.invoiceAmount ? String(addForm.invoiceAmount) : ''}
                        readonly disabled
                        className="bg-gray-50" />
                    </div>
                  </>
                )}

                {/* 租赁服务费 - 手动输入金额 */}
                {addForm.invoiceCategory === '租赁服务费' && (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">开票金额 <span className="text-red-500">*</span></label>
                    <Input type="number" placeholder="请输入开票金额" value={addForm.invoiceAmount ? String(addForm.invoiceAmount) : ''}
                      onChange={val => setAddForm(prev => ({ ...prev, invoiceAmount: Number(val) }))} />
                  </div>
                )}
              </div>
              {/* 已填信息确认 */}
              <div className="mt-6 p-3 bg-gray-50 rounded-lg">
                <h5 className="text-xs font-medium text-gray-500 mb-2">已填信息确认</h5>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div><span className="text-gray-400">店铺：</span><span className="text-gray-700">{addForm.shopName || '-'}</span></div>
                  <div><span className="text-gray-400">单位：</span><span className="text-gray-700">{addForm.companyName || '-'}</span></div>
                  <div><span className="text-gray-400">申请人：</span><span className="text-gray-700">{addForm.applicant || '-'}</span></div>
                  <div><span className="text-gray-400">类目：</span><span className="text-gray-700">{addForm.invoiceCategory || '-'}</span></div>
                  {addForm.invoiceCategory === '二手手机' && (
                    <>
                      <div><span className="text-gray-400">型号：</span><span className="text-gray-700">{addForm.phoneModel || '-'}</span></div>
                      <div><span className="text-gray-400">数量×单价：</span><span className="text-gray-700">{addForm.phoneQuantity || 0} × {addForm.unitPrice || 0}</span></div>
                    </>
                  )}
                  <div><span className="text-gray-400">金额：</span><span className="text-gray-700 font-medium">¥{addForm.invoiceAmount || 0}</span></div>
                </div>
              </div>
            </div>
          )}

          {/* 步骤4: 上传附件 */}
          {addStep === 4 && (
            <div className="py-4">
              <h4 className="text-sm font-medium text-gray-600 mb-4">上传开票附件（可选）</h4>
              <div>
                <input
                  ref={addAttachInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  title="上传开票附件"
                  aria-label="上传开票附件"
                  onChange={(e) => {
                    const files = e.target.files;
                    if (files) {
                      setAddAttachFiles(prev => [...prev, ...Array.from(files)]);
                    }
                    if (addAttachInputRef.current) addAttachInputRef.current.value = '';
                  }}
                />
                <Button variant="outline" icon={<Upload size={16} />} onClick={() => addAttachInputRef.current?.click()}>
                  选择附件
                </Button>
                <span className="text-xs text-gray-400 ml-2">支持图片、PDF、Word、Excel等文件</span>
              </div>
              {addAttachFiles.length > 0 && (
                <div className="mt-3 space-y-2">
                  {addAttachFiles.map((file, index) => (
                    <div key={index} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <Upload size={14} className="text-gray-400 flex-shrink-0" />
                        <span className="text-sm text-gray-700 truncate">{file.name}</span>
                        <span className="text-xs text-gray-400 flex-shrink-0">({(file.size / 1024).toFixed(1)}KB)</span>
                      </div>
                      <button
                        type="button"
                        className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-red-500 cursor-pointer flex-shrink-0"
                        onClick={() => setAddAttachFiles(prev => prev.filter((_, i) => i !== index))}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {/* 完整信息确认 */}
              <div className="mt-6 p-3 bg-gray-50 rounded-lg">
                <h5 className="text-xs font-medium text-gray-500 mb-2">提交信息确认</h5>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div><span className="text-gray-400">店铺：</span><span className="text-gray-700">{addForm.shopName || '-'}</span></div>
                  <div><span className="text-gray-400">单位：</span><span className="text-gray-700">{addForm.companyName || '-'}</span></div>
                  <div><span className="text-gray-400">申请人：</span><span className="text-gray-700">{addForm.applicant || '-'}</span></div>
                  <div><span className="text-gray-400">类目：</span><span className="text-gray-700">{addForm.invoiceCategory || '-'}</span></div>
                  <div><span className="text-gray-400">金额：</span><span className="text-gray-700 font-medium">¥{addForm.invoiceAmount || 0}</span></div>
                  <div><span className="text-gray-400">附件：</span><span className="text-gray-700">{addAttachFiles.length}个文件</span></div>
                </div>
              </div>
            </div>
          )}
        </div>
      </Dialog>

      {/* 编辑发票弹窗 */}
      <Dialog
        header="编辑发票"
        visible={editVisible}
        onClose={() => { setEditVisible(false); setEditAttachFiles([]); setEditExistingAttachments([]); }}
        width="680px"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => { setEditVisible(false); setEditAttachFiles([]); setEditExistingAttachments([]); }}>取消</Button>
            <Button theme="primary" loading={saving} onClick={handleEditSave}>保存</Button>
          </div>
        }
      >
        <InvoiceFormFields
          form={editForm}
          onChange={setEditForm}
          isEdit
          editExistingAttachments={editExistingAttachments}
          onRemoveExistingAttachment={(index) => setEditExistingAttachments(prev => prev.filter((_, i) => i !== index))}
          editAttachFiles={editAttachFiles}
          onEditAttachFilesChange={setEditAttachFiles}
          editAttachInputRef={editAttachInputRef}
          invoiceCategoryOptions={invoiceCategoryOptions}
          shopNameOptions={shopNameOptions}
          invoiceStatusOptions={invoiceStatusOptions}
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
          确定要删除 <span className="font-medium text-gray-900">{deleteTarget?.companyName}</span> 的发票申请吗？此操作不可撤销。
        </p>
      </Dialog>

      {/* 公司不存在确认弹窗 */}
      <Dialog
        header="提示"
        visible={companyConfirmVisible}
        onClose={() => setCompanyConfirmVisible(false)}
        width="420px"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setCompanyConfirmVisible(false)}>取消</Button>
            <Button theme="primary" onClick={handleCompanyConfirm}>继续</Button>
          </div>
        }
      >
        <p className="text-gray-600">
          公司「<span className="font-medium text-gray-900">{addForm.companyName}</span>」不在系统数据库中，系统将自动保存该公司信息，是否继续？
        </p>
      </Dialog>

      {/* 开票上传弹窗 */}
      <Dialog
        header="上传电子发票"
        visible={invoiceUploadVisible}
        onClose={() => { setInvoiceUploadVisible(false); setUploadTarget(null); setUploadFiles([]); }}
        width="560px"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => { setInvoiceUploadVisible(false); setUploadTarget(null); setUploadFiles([]); }}>取消</Button>
            <Button theme="primary" loading={uploading} onClick={handleConfirmInvoice}>确认开票</Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-500">
            为 <span className="font-medium text-gray-800">{uploadTarget?.companyName}</span> 上传电子发票二维码图片（支持 BMP、PNG、JPEG，多张）
          </p>
          <div>
            <input
              ref={uploadInputRef}
              type="file"
              accept={INVOICE_IMAGE_ACCEPT}
              multiple
              className="hidden"
              title="上传电子发票二维码图片"
              aria-label="上传电子发票二维码图片"
              onChange={handleFileSelect}
            />
            <Button variant="outline" icon={<Upload size={16} />} onClick={() => uploadInputRef.current?.click()}>
              选择图片
            </Button>
          </div>
          {uploadFiles.length > 0 && (
            <div className="grid grid-cols-3 gap-3">
              {uploadFiles.map((file, index) => (
                <div key={index} className="relative group border border-gray-200 rounded-lg overflow-hidden">
                  <LocalInvoiceImagePreview file={file} className="w-full h-28 object-contain bg-gray-50" />
                  <button
                    type="button"
                    className="absolute top-1 right-1 w-6 h-6 bg-black/50 rounded-full flex items-center justify-center text-white opacity-0 group-hover:opacity-100 cursor-pointer"
                    onClick={() => handleRemoveFile(index)}
                  >
                    <X size={14} />
                  </button>
                  <div className="px-2 py-1 text-xs text-gray-500 truncate">{file.name}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Dialog>

      {/* 预览/下载弹窗 */}
      <Dialog
        header="电子发票预览"
        visible={previewVisible}
        onClose={() => { setPreviewVisible(false); setPreviewRecord(null); setPreviewUrls([]); setPreviewLightboxSrc(null); }}
        width="680px"
        footer={<Button onClick={() => { setPreviewVisible(false); setPreviewRecord(null); setPreviewUrls([]); setPreviewLightboxSrc(null); }}>关闭</Button>}
      >
        {previewLoading ? (
          <div className="flex justify-center py-8 text-gray-400">加载中...</div>
        ) : previewUrls.length === 0 ? (
          <div className="flex justify-center py-8 text-gray-400">暂无电子发票图片</div>
        ) : (
          <div className="grid grid-cols-2 gap-4 max-h-[60vh] overflow-auto">
            {previewUrls.map((item, index) => {
              const isImg = isImageFile(item.fileName);
              return (
                <div key={index} className="border border-gray-200 rounded-lg overflow-hidden">
                  {isImg ? (
                    <div className="cursor-pointer" onClick={() => { setPreviewLightboxSrc(item.tempFileURL); setPreviewLightboxAlt(item.fileName); }}>
                      <ImageWithBmpSupport src={item.tempFileURL} alt={item.fileName} className="w-full h-48 object-contain bg-gray-50" />
                    </div>
                  ) : (
                    <div className="w-full h-48 flex flex-col items-center justify-center bg-gray-50">
                      <Download size={32} className="text-gray-300 mb-2" />
                      <span className="text-xs text-gray-400">非图片文件</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between px-3 py-2 bg-gray-50">
                    <span className="text-xs text-gray-500 truncate flex-1">{item.fileName}</span>
                    <Button
                      variant="text"
                      theme="primary"
                      size="small"
                      icon={<Download size={14} />}
                      onClick={() => handleDownloadImage(item.tempFileURL, item.fileName)}
                    >
                      下载
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {previewLightboxSrc && (
          <ImageLightbox src={previewLightboxSrc} alt={previewLightboxAlt} onClose={() => { setPreviewLightboxSrc(null); setPreviewLightboxAlt(''); }} />
        )}
      </Dialog>
    </div>
  );
}

/** 发票表单字段（新增/编辑共用） */
function InvoiceFormFields({ form, onChange, isEdit = false, onCompanyNameChange, companySuggestions, showSuggestions, onSelectCompany, suggestionsRef, editExistingAttachments, onRemoveExistingAttachment, editAttachFiles, onEditAttachFilesChange, editAttachInputRef, invoiceCategoryOptions, shopNameOptions, invoiceStatusOptions }: {
  form: Omit<InvoiceRecord, '_id' | 'createTime'>;
  onChange: React.Dispatch<React.SetStateAction<Omit<InvoiceRecord, '_id' | 'createTime'>>>;
  isEdit?: boolean;
  onCompanyNameChange?: (val: string) => void;
  companySuggestions?: CompanyTemplate[];
  showSuggestions?: boolean;
  onSelectCompany?: (company: CompanyTemplate) => void;
  suggestionsRef?: React.RefObject<HTMLDivElement>;
  editExistingAttachments?: InvoiceFile[];
  onRemoveExistingAttachment?: (index: number) => void;
  editAttachFiles?: File[];
  onEditAttachFilesChange?: React.Dispatch<React.SetStateAction<File[]>>;
  editAttachInputRef?: React.RefObject<HTMLInputElement>;
  invoiceCategoryOptions: Array<{ label: string; value: string }>;
  shopNameOptions: Array<{ label: string; value: string }>;
  invoiceStatusOptions: Array<{ label: string; value: string }>;
}) {
  return (
    <div className="space-y-4 max-h-[70vh] overflow-auto px-1">
      {/* 公司信息 */}
      <div>
        <h4 className="text-sm font-medium text-gray-600 mb-2">公司信息</h4>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 relative">
            <label className="block text-xs text-gray-500 mb-1">单位名称 <span className="text-red-500">*</span></label>
            <Input placeholder="输入单位名称搜索" value={form.companyName}
              onChange={val => {
                if (onCompanyNameChange) {
                  onCompanyNameChange(val as string);
                } else {
                  onChange(prev => ({ ...prev, companyName: val as string }));
                }
              }} />
            {showSuggestions && companySuggestions && companySuggestions.length > 0 && (
              <div ref={suggestionsRef} className="absolute z-50 left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-sm max-h-48 overflow-auto">
                {companySuggestions.map(company => (
                  <button key={company._id} type="button"
                    className="w-full px-3 py-2 text-left text-sm hover:bg-blue-50 border-b border-gray-100 last:border-0 cursor-pointer"
                    onClick={() => onSelectCompany?.(company)}>
                    <div className="font-medium text-gray-800">{company.companyName}</div>
                    <div className="text-xs text-gray-400">{company.taxId}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="col-span-2">
            <label className="block text-xs text-gray-500 mb-1">纳税人识别号</label>
            <Input placeholder="纳税人识别号" value={form.taxId}
              onChange={val => onChange(prev => ({ ...prev, taxId: val as string }))} />
          </div>
          <div className="col-span-2">
            <label className="block text-xs text-gray-500 mb-1">注册地址</label>
            <Input placeholder="注册地址" value={form.registeredAddress}
              onChange={val => onChange(prev => ({ ...prev, registeredAddress: val as string }))} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">联系电话</label>
            <Input placeholder="联系电话" value={form.contactPhone}
              onChange={val => onChange(prev => ({ ...prev, contactPhone: val as string }))} />
          </div>
        </div>
      </div>

      {/* 开户行信息 */}
      <div>
        <h4 className="text-sm font-medium text-gray-600 mb-2">开户行信息</h4>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="block text-xs text-gray-500 mb-1">开户行名称</label>
            <Input placeholder="开户行名称" value={form.bankName}
              onChange={val => onChange(prev => ({ ...prev, bankName: val as string }))} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">开户行行号</label>
            <Input placeholder="开户行行号" value={form.bankCode}
              onChange={val => onChange(prev => ({ ...prev, bankCode: val as string }))} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">账号</label>
            <Input placeholder="账号" value={form.bankAccount}
              onChange={val => onChange(prev => ({ ...prev, bankAccount: val as string }))} />
          </div>
        </div>
      </div>

      {/* 开票类目、店铺和金额 */}
      <div>
        <h4 className="text-sm font-medium text-gray-600 mb-2">开票类目和金额</h4>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">开票类目</label>
            <Select placeholder="请选择开票类目" value={form.invoiceCategory || undefined}
              onChange={val => onChange(prev => ({
                ...prev,
                invoiceCategory: val as string,
                ...(val !== '二手手机' ? { phoneModel: '', phoneQuantity: 0, unitPrice: 0, invoiceAmount: 0 } : {}),
              }))}
              options={invoiceCategoryOptions}
              popupProps={{ attach: 'body', zIndex: 6000 }} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">店铺名字 <span className="text-red-500">*</span></label>
            <Select placeholder="请选择店铺" value={form.shopName || undefined}
              onChange={val => onChange(prev => ({ ...prev, shopName: val as string }))}
              options={shopNameOptions}
              popupProps={{ attach: 'body' }} />
          </div>

          {/* 二手手机 - 动态字段 */}
          {form.invoiceCategory === '二手手机' && (
            <>
              <div>
                <label className="block text-xs text-gray-500 mb-1">手机型号</label>
                <Input placeholder="请输入手机型号" value={form.phoneModel || ''}
                  onChange={val => onChange(prev => ({ ...prev, phoneModel: val as string }))} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">手机数量</label>
                <Input type="number" placeholder="请输入数量" value={form.phoneQuantity ? String(form.phoneQuantity) : ''}
                  onChange={val => {
                    const qty = Number(val) || 0;
                    onChange(prev => ({ ...prev, phoneQuantity: qty, invoiceAmount: qty * (prev.unitPrice || 0) }));
                  }} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">单价</label>
                <Input type="number" placeholder="请输入单价" value={form.unitPrice ? String(form.unitPrice) : ''}
                  onChange={val => {
                    const price = Number(val) || 0;
                    onChange(prev => ({ ...prev, unitPrice: price, invoiceAmount: (prev.phoneQuantity || 0) * price }));
                  }} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">开票金额</label>
                <Input type="number" placeholder="自动计算" value={form.invoiceAmount ? String(form.invoiceAmount) : ''}
                  readonly disabled />
              </div>
            </>
          )}

          {/* 租赁服务费 - 手动输入金额 */}
          {form.invoiceCategory === '租赁服务费' && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">开票金额</label>
              <Input type="number" placeholder="开票金额" value={form.invoiceAmount ? String(form.invoiceAmount) : ''}
                onChange={val => onChange(prev => ({ ...prev, invoiceAmount: Number(val) }))} />
            </div>
          )}

          {/* 未选择类目 - 显示金额输入 */}
          {!form.invoiceCategory && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">开票金额</label>
              <Input type="number" placeholder="开票金额" value={form.invoiceAmount ? String(form.invoiceAmount) : ''}
                onChange={val => onChange(prev => ({ ...prev, invoiceAmount: Number(val) }))} />
            </div>
          )}
        </div>
      </div>

      {/* 编辑时才显示开票状态和完成信息 */}
      {isEdit && (
        <div>
          <h4 className="text-sm font-medium text-gray-600 mb-2">开票状态</h4>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">状态</label>
              <Select placeholder="请选择" value={form.status || undefined}
                onChange={val => onChange(prev => ({ ...prev, status: val as InvoiceRecord['status'] }))}
                options={invoiceStatusOptions}
                popupProps={{ attach: 'body' }} />
            </div>
            {form.status === 'paid' && (
              <div>
                <label className="block text-xs text-gray-500 mb-1">开票完成时间</label>
                <input type="datetime-local" className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
                  value={form.completedTime || ''} onChange={e => onChange(prev => ({ ...prev, completedTime: e.target.value }))} />
              </div>
            )}
          </div>
          {form.status === 'paid' && form.invoiceFiles && form.invoiceFiles.length > 0 && (
            <div className="mt-3">
              <label className="block text-xs text-gray-500 mb-1">已上传电子发票（{form.invoiceFiles.length}张）</label>
              <InvoiceImagePreview files={form.invoiceFiles} />
            </div>
          )}
        </div>
      )}

      {/* 编辑时支持修改附件 */}
      {isEdit && editExistingAttachments !== undefined && (
        <div>
          <h4 className="text-sm font-medium text-gray-600 mb-3">开票附件</h4>
          {/* 已有附件 */}
          {editExistingAttachments.length > 0 && (
            <div className="mb-3 space-y-2">
              <label className="block text-xs text-gray-500 mb-1">已有附件（点击可删除）</label>
              {editExistingAttachments.map((att, index) => (
                <div key={index} className="flex items-center justify-between px-3 py-2 bg-blue-50 rounded-lg">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <Upload size={14} className="text-blue-400 flex-shrink-0" />
                    <span className="text-sm text-gray-700 truncate">{att.fileName}</span>
                  </div>
                  <button type="button" className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-red-500 cursor-pointer flex-shrink-0"
                    onClick={() => onRemoveExistingAttachment?.(index)}>
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* 新增附件 */}
          <div>
            <input ref={editAttachInputRef} type="file" multiple className="hidden"
              title="添加发票附件"
              aria-label="添加发票附件"
              onChange={(e) => {
                const files = e.target.files;
                if (files) onEditAttachFilesChange?.(prev => [...prev, ...Array.from(files)]);
                if (editAttachInputRef?.current) editAttachInputRef.current.value = '';
              }} />
            <Button variant="outline" icon={<Upload size={16} />} onClick={() => editAttachInputRef?.current?.click()}>
              添加附件
            </Button>
            <span className="text-xs text-gray-400 ml-2">支持图片、PDF、Word、Excel等文件</span>
          </div>
          {(editAttachFiles && editAttachFiles.length > 0) && (
            <div className="mt-3 space-y-2">
              {editAttachFiles.map((file, index) => (
                <div key={index} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <Upload size={14} className="text-gray-400 flex-shrink-0" />
                    <span className="text-sm text-gray-700 truncate">{file.name}</span>
                    <span className="text-xs text-gray-400 flex-shrink-0">({(file.size / 1024).toFixed(1)}KB)</span>
                  </div>
                  <button type="button" className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-red-500 cursor-pointer flex-shrink-0"
                    onClick={() => onEditAttachFilesChange?.(prev => prev.filter((_, i) => i !== index))}>
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 详情弹窗中展示发票图片（预览+放大） */
function InvoiceImagePreview({ files }: { files: InvoiceFile[] }) {
  const [urls, setUrls] = useState<Array<{ fileID: string; tempFileURL: string; fileName: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxAlt, setLightboxAlt] = useState('');

  useEffect(() => {
    let cancelled = false;
    const fetchUrls = async () => {
      try {
        const fileIDs = files.map(f => f.fileID);
        console.log('[InvoiceImagePreview] fetching URLs for:', fileIDs);
        const result = await getCloudFileURLs(fileIDs);
        console.log('[InvoiceImagePreview] result:', result);
        if (!cancelled) {
          setUrls(result.map((u, i) => ({
            ...u,
            fileName: files[i]?.fileName || `图片${i + 1}`,
          })));
        }
      } catch (err) {
        console.error('[InvoiceImagePreview] error:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchUrls();
    return () => { cancelled = true; };
  }, [files]);

  if (loading) return <span className="text-xs text-gray-400">加载中...</span>;
  if (urls.length === 0) return <span className="text-xs text-gray-400">暂无图片</span>;

  return (
    <>
      <div className="flex gap-2 flex-wrap">
        {urls.map((item, i) => (
          <div
            key={i}
            className="relative group cursor-pointer"
            onClick={() => { setLightboxSrc(item.tempFileURL); setLightboxAlt(item.fileName); }}
          >
            <ImageWithBmpSupport
              src={item.tempFileURL}
              alt={item.fileName}
              fileName={item.fileName}
              className="w-20 h-20 object-cover border rounded hover:border-blue-400"
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 rounded flex items-center justify-center">
              <Eye size={16} className="text-white opacity-0 group-hover:opacity-100" />
            </div>
          </div>
        ))}
      </div>
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} alt={lightboxAlt} onClose={() => { setLightboxSrc(null); setLightboxAlt(''); }} />
      )}
    </>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  const display = value === undefined || value === null || value === '' || value === 0 ? '-' : value;
  return (
    <div className="flex py-1.5 border-b border-gray-50">
      <span className="w-28 text-gray-500 flex-shrink-0">{label}</span>
      <div className="flex-1 min-w-0 text-gray-800">{display}</div>
    </div>
  );
}

/** 判断文件是否为图片 */
function isImageFile(fileName: string) {
  const ext = getFileExtension(fileName);
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'bpm', 'svg'].includes(ext);
}

/** 判断是否为发票上传支持的图片格式 */
function isSupportedInvoiceImageFile(file: File) {
  const ext = getFileExtension(file.name);
  const type = file.type.toLowerCase();
  return INVOICE_IMAGE_EXTENSIONS.includes(ext)
    || ['image/bmp', 'image/x-ms-bmp', 'image/png', 'image/jpeg', 'image/pjpeg'].includes(type);
}

/** 判断文件是否为 BMP 格式 */
function isBmpFile(fileName: string) {
  const ext = getFileExtension(fileName);
  return ext === 'bmp' || ext === 'bpm';
}

function getFileExtension(fileName: string) {
  return fileName.split('.').pop()?.toLowerCase() || '';
}

function LocalInvoiceImagePreview({ file, className }: { file: File; className?: string }) {
  const [src, setSrc] = useState('');

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setSrc(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return <ImageWithBmpSupport src={src} alt={file.name} fileName={file.name} className={className} />;
}

/** 支持 BMP 格式的图片组件 - BMP 文件通过 Canvas 转 PNG 确保兼容性 */
function ImageWithBmpSupport({ src, alt, className, fileName }: { src: string; alt: string; className?: string; fileName?: string }) {
  const [convertedSrc, setConvertedSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const isBmp = fileName ? isBmpFile(fileName) : isBmpFile(alt);

  useEffect(() => {
    setError(false);
    setConvertedSrc(null);
    if (!src) {
      setError(true);
      return;
    }
    if (!isBmp) return;
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0);
          const pngUrl = canvas.toDataURL('image/png');
          setConvertedSrc(pngUrl);
        } else {
          setConvertedSrc(src);
        }
      } catch {
        // Canvas 转换失败则直接用原始 URL
        setConvertedSrc(src);
      }
    };
    img.onerror = () => {
      if (!cancelled) setError(true);
    };
    img.src = src;
    return () => { cancelled = true; };
  }, [src, isBmp]);

  if (error) {
    return (
      <div className={`${className} flex flex-col items-center justify-center`}>
        <Download size={24} className="text-gray-300 mb-1" />
        <span className="text-xs text-gray-400 text-center px-1">图片链接获取失败</span>
      </div>
    );
  }

  // 非 BMP 文件直接用 img 标签
  if (!isBmp) {
    return <img src={src} alt={alt} className={className} onError={() => setError(true)} />;
  }

  // BMP 文件：等待 Canvas 转换完成
  if (!convertedSrc) {
    return <div className={`${className} flex items-center justify-center bg-gray-50`}><span className="text-xs text-gray-400">转换中...</span></div>;
  }

  return <img src={convertedSrc} alt={alt} className={className} />;
}

/** 图片灯箱组件（支持 BMP） */
function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = ''; };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="relative max-w-[90vw] max-h-[90vh]" onClick={e => e.stopPropagation()}>
        <ImageWithBmpSupport src={src} alt={alt} fileName={alt} className="max-w-full max-h-[85vh] object-contain rounded shadow" />
        <button
          type="button"
          className="absolute -top-3 -right-3 w-8 h-8 bg-white rounded-full flex items-center justify-center shadow-sm text-gray-600 hover:text-gray-900 cursor-pointer"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <div className="absolute bottom-0 left-0 right-0 flex justify-center gap-3 py-3">
          <button
            type="button"
            className="px-4 py-1.5 bg-white/90 rounded-lg text-sm text-gray-700 hover:bg-white shadow cursor-pointer"
            onClick={() => {
              const a = document.createElement('a');
              a.href = src;
              a.download = alt;
              a.target = '_blank';
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
            }}
          >
            <Download size={14} className="inline mr-1" />下载
          </button>
        </div>
      </div>
    </div>
  );
}

/** 详情弹窗中展示附件列表（预览+放大） */
function InvoiceAttachmentPreview({ files }: { files: InvoiceFile[] }) {
  const [urls, setUrls] = useState<Array<{ fileID: string; tempFileURL: string; fileName: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxAlt, setLightboxAlt] = useState('');

  useEffect(() => {
    let cancelled = false;
    const fetchUrls = async () => {
      try {
        const fileIDs = files.map(f => f.fileID);
        console.log('[InvoiceAttachmentPreview] fetching URLs for:', fileIDs);
        const result = await getCloudFileURLs(fileIDs);
        console.log('[InvoiceAttachmentPreview] getCloudFileURLs result:', result);
        if (!cancelled) {
          const mapped = result.map((u, i) => ({
            ...u,
            fileName: files[i]?.fileName || `附件${i + 1}`,
          }));
          console.log('[InvoiceAttachmentPreview] mapped urls:', mapped);
          setUrls(mapped);
        }
      } catch (err) {
        console.error('[InvoiceAttachmentPreview] getCloudFileURLs error:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchUrls();
    return () => { cancelled = true; };
  }, [files]);

  if (loading) return <span className="text-xs text-gray-400">加载中...</span>;
  if (urls.length === 0) return <span className="text-xs text-gray-400">暂无附件</span>;

  const handleDownload = (url: string, fileName: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        {urls.map((item, i) => {
          const isImg = isImageFile(item.fileName);
          if (isImg) {
            return (
              <div
                key={i}
                className="relative group border border-gray-200 rounded-lg overflow-hidden cursor-pointer hover:border-blue-400"
                onClick={() => { setLightboxSrc(item.tempFileURL); setLightboxAlt(item.fileName); }}
              >
                <ImageWithBmpSupport src={item.tempFileURL} alt={item.fileName} fileName={item.fileName} className="w-full h-24 object-cover" />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 flex items-center justify-center">
                  <Eye size={20} className="text-white opacity-0 group-hover:opacity-100" />
                </div>
                <div className="px-2 py-1 text-xs text-gray-500 truncate bg-gray-50">{item.fileName}</div>
              </div>
            );
          }
          return (
            <div key={i} className="flex flex-col items-center justify-center border border-gray-200 rounded-lg p-3 hover:border-blue-400 hover:bg-blue-50/30 cursor-pointer"
              onClick={() => handleDownload(item.tempFileURL, item.fileName)}>
              <Download size={24} className="text-gray-400 mb-1" />
              <span className="text-xs text-gray-600 truncate w-full text-center">{item.fileName}</span>
            </div>
          );
        })}
      </div>
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} alt={lightboxAlt} onClose={() => { setLightboxSrc(null); setLightboxAlt(''); }} />
      )}
    </>
  );
}
